/**
 * 业务编排：部件/改型维护、批次事件摄入（校验+幂等+串行化）、
 * 拟合查询（当前/历史时点）、预测、两时点对比、重启恢复重建。
 */

import type { Pool } from 'pg';
import {
  findEventByEventId,
  getAllEvents,
  getEventsForPart,
  insertEvent,
  loadProjectionState,
  lockPart,
  saveProjectionState,
  StoredEvent,
} from './eventStore';
import {
  applyEvent,
  emptyProjection,
  PartProjection,
  replayEvents,
} from './projection';
import {
  BatchDatum,
  DEFAULT_FIT_OPTIONS,
  FitResult,
  fitLearningCurve,
  tQuantile975,
  Z_975,
} from './fit';
import { buildPrior, DEFAULT_PRIOR_STRENGTH, PRIOR_STRENGTH_MAX, PRIOR_STRENGTH_MIN } from './prior';
import { predictPlan, PlanBatch, PredictionResult } from './predict';
import { randomUUID } from 'node:crypto';

export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 400,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

const MAX_UNIT_INDEX = 1e7;
const MAX_CHAIN_DEPTH = 32;

export interface BatchEventInput {
  eventId: string;
  type: 'batch_recorded' | 'batch_corrected' | 'batch_voided';
  batchId: string;
  quantity?: number;
  hours?: number;
  firstUnit?: number;
  allowGap?: boolean;
}

export interface FitResponse {
  partId: string;
  asOf: string | null;
  status: 'ok' | 'insufficient_data';
  t1: number | null;
  learningRate: number | null;
  exponentB: number | null;
  confidence: null | {
    level: 0.95;
    t1: [number, number];
    learningRate: [number, number];
  };
  sigma: number | null;
  sigmaSource: 'estimated' | 'assumed' | null;
  degreesOfFreedom: number;
  batchesUsed: number;
  residuals: unknown[];
  prior: null | {
    parentId: string;
    source: 'parent_fit' | 'explicit' | 'none';
    learningRate: number | null;
    strength: number;
    informationShare: number;
  };
  converged: boolean | null;
  iterations: number | null;
}

export class LCurveService {
  constructor(private pool: Pool) {}

  // ---------- 部件与改型 ----------

  async createPart(input: { partId: string; name?: string }): Promise<{ partId: string; created: boolean }> {
    const partId = requirePartId(input.partId);
    const name = input.name ?? null;
    if (name != null && (typeof name !== 'string' || name.length > 200)) {
      throw new ServiceError('INVALID_NAME', '部件名称过长', 400);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockPart(client, partId);
      const existing = await loadProjectionState(client, partId);
      if (existing?.exists) {
        await client.query('COMMIT');
        return { partId, created: false };
      }
      // 事件编号取确定性值，重试天然幂等
      const eventId = `part_registered:${partId}`;
      const dup = await findEventByEventId(client, eventId);
      if (!dup) {
        const ev = await insertEvent(client, partId, eventId, 'part_registered', { name });
        const proj = applyEvent(emptyProjection(partId), { type: 'part_registered', payload: { name } });
        await saveProjectionState(client, proj, ev.seq);
        await client.query(
          `INSERT INTO parts (part_id, name) VALUES ($1, $2) ON CONFLICT (part_id) DO NOTHING`,
          [partId, name],
        );
      }
      await client.query('COMMIT');
      return { partId, created: !dup };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async declareVariant(
    partId: string,
    input: { parentId: string; priorStrength?: number; priorLearningRate?: number },
  ): Promise<void> {
    requirePartId(partId);
    const parentId = requirePartId(input.parentId, 'parentId');
    if (partId === parentId) {
      throw new ServiceError('VARIANT_CYCLE', '部件不能作为自己的母型', 409);
    }
    const strength = input.priorStrength ?? DEFAULT_PRIOR_STRENGTH;
    if (typeof strength !== 'number' || !(strength >= PRIOR_STRENGTH_MIN && strength <= PRIOR_STRENGTH_MAX)) {
      throw new ServiceError(
        'INVALID_PRIOR_STRENGTH',
        `先验强度（等效批数）须在 [${PRIOR_STRENGTH_MIN}, ${PRIOR_STRENGTH_MAX}] 区间`,
        400,
      );
    }
    const explicitLr = input.priorLearningRate ?? null;
    if (explicitLr != null && (typeof explicitLr !== 'number' || !(explicitLr > 0 && explicitLr <= 1))) {
      throw new ServiceError('INVALID_PRIOR_LEARNING_RATE', '学习率先验须在 (0, 1] 区间', 400);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 两个锁按字典序获取，避免并发声明 A→B 与 B→A 互相死锁
      const [first, second] = [partId, parentId].sort();
      await lockPart(client, first!);
      if (second !== first) await lockPart(client, second!);
      const proj = (await loadProjectionState(client, partId)) ?? emptyProjection(partId);
      const parentProj = await loadProjectionState(client, parentId);
      if (!proj.exists) throw new ServiceError('PART_NOT_FOUND', `部件 ${partId} 不存在`, 404);
      if (!parentProj?.exists) throw new ServiceError('PARENT_NOT_FOUND', `母型 ${parentId} 不存在`, 404);
      // 成环检查：沿母型链向上走，遇到自己即拒收
      await this.assertNoCycle(client, partId, parentId);

      const payload = { parentId, priorStrength: strength, explicitPriorLr: explicitLr };
      const ev = await insertEvent(client, partId, `variant_declared:${partId}:${randomUUID()}`, 'variant_declared', payload);
      applyEvent(proj, { type: 'variant_declared', payload });
      await saveProjectionState(client, proj, ev.seq);
      await client.query(
        `UPDATE parts SET parent_id = $2, prior_strength = $3, explicit_prior_lr = $4 WHERE part_id = $1`,
        [partId, parentId, strength, explicitLr],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async assertNoCycle(client: import('pg').PoolClient, partId: string, parentId: string): Promise<void> {
    let cur: string | null = parentId;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH && cur != null; depth++) {
      if (cur === partId) {
        throw new ServiceError('VARIANT_CYCLE', `改型关系成环：${partId} 已在 ${parentId} 的母型链上`, 409);
      }
      const r: { rows: Array<{ parent_id: string | null }> } = await client.query(
        'SELECT parent_id FROM parts WHERE part_id = $1',
        [cur],
      );
      cur = r.rows[0]?.parent_id ?? null;
    }
  }

  // ---------- 批次事件 ----------

  async submitBatchEvent(
    partId: string,
    input: BatchEventInput,
  ): Promise<{ seq: number; recordedAt: string; duplicate: boolean }> {
    requirePartId(partId);
    const eventId = requireEventId(input.eventId);
    if (!['batch_recorded', 'batch_corrected', 'batch_voided'].includes(input.type)) {
      throw new ServiceError('INVALID_EVENT_TYPE', `未知事件类型 ${String(input.type)}`, 400);
    }
    requireBatchId(input.batchId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockPart(client, partId);

      // 幂等：相同事件编号只生效一次（编号全局唯一，跨部件重号视为冲突）
      const dup = await findEventByEventId(client, eventId);
      if (dup) {
        if (dup.partId !== partId) {
          await client.query('ROLLBACK');
          throw new ServiceError('EVENT_ID_CONFLICT', `事件编号 ${eventId} 已用于其他部件`, 409);
        }
        await client.query('COMMIT');
        return { seq: dup.seq, recordedAt: dup.recordedAt, duplicate: true };
      }

      const proj = (await loadProjectionState(client, partId)) ?? emptyProjection(partId);
      if (!proj.exists) throw new ServiceError('PART_NOT_FOUND', `部件 ${partId} 不存在`, 404);

      const payload = this.validateAndNormalize(proj, input);
      let ev: StoredEvent;
      try {
        ev = await insertEvent(client, partId, eventId, input.type, payload);
      } catch (e: any) {
        // 事件编号全局唯一：并发下（或跨部件重号）可能撞唯一约束
        if (e?.code === '23505') {
          await client.query('ROLLBACK');
          const existing = await findEventByEventId(this.pool, eventId);
          if (existing && existing.partId === partId) {
            return { seq: existing.seq, recordedAt: existing.recordedAt, duplicate: true };
          }
          throw new ServiceError('EVENT_ID_CONFLICT', `事件编号 ${eventId} 已用于其他部件`, 409);
        }
        throw e;
      }
      applyEvent(proj, { type: input.type, payload });
      await saveProjectionState(client, proj, ev.seq);
      await client.query('COMMIT');
      return { seq: ev.seq, recordedAt: ev.recordedAt, duplicate: false };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** 依据当前投影校验事件并规范化 payload（录入时把 firstUnit 换算成 gap） */
  private validateAndNormalize(proj: PartProjection, input: BatchEventInput): Record<string, unknown> {
    if (input.type === 'batch_recorded') {
      if (proj.seenBatchIds.includes(input.batchId)) {
        throw new ServiceError('BATCH_ID_EXISTS', `批次号 ${input.batchId} 已使用过（含已作废）`, 409);
      }
      const quantity = requirePositiveInt(input.quantity, 'quantity', '件数');
      const hours = requirePositiveNumber(input.hours, 'hours', '工时');
      let gap = 0;
      if (input.firstUnit != null) {
        const first = requirePositiveInt(input.firstUnit, 'firstUnit', '起始件号');
        gap = first - proj.nextUnit;
        if (gap < 0) {
          throw new ServiceError(
            'BATCH_OVERLAP',
            `批次区间与已有批次重叠：起始件号 ${first} < 下一件 ${proj.nextUnit}`,
            409,
          );
        }
        if (gap > 0 && !input.allowGap) {
          throw new ServiceError(
            'BATCH_GAP',
            `批次区间出现空档：起始件号 ${first}，预期 ${proj.nextUnit}；如确为跳号请置 allowGap`,
            409,
          );
        }
      }
      return { batchId: input.batchId, quantity, hours, gap };
    }

    const active = proj.batches.find((b) => b.batchId === input.batchId);
    if (!active) {
      if (proj.seenBatchIds.includes(input.batchId)) {
        throw new ServiceError('BATCH_VOIDED', `批次 ${input.batchId} 已作废`, 409);
      }
      throw new ServiceError('BATCH_NOT_FOUND', `批次 ${input.batchId} 不存在`, 404);
    }

    if (input.type === 'batch_corrected') {
      if (input.quantity == null && input.hours == null) {
        throw new ServiceError('EMPTY_CORRECTION', '更正事件须至少给出件数或工时', 400);
      }
      const payload: Record<string, unknown> = { batchId: input.batchId };
      if (input.quantity != null) payload.quantity = requirePositiveInt(input.quantity, 'quantity', '件数');
      if (input.hours != null) payload.hours = requirePositiveNumber(input.hours, 'hours', '工时');
      return payload;
    }

    // batch_voided
    return { batchId: input.batchId };
  }

  // ---------- 投影查询 ----------

  /** 当前投影（快照），或按"截至 asOf 的事件"回放的当时投影 */
  async getProjection(partId: string, asOf?: string): Promise<PartProjection> {
    requirePartId(partId);
    if (asOf) {
      assertTimestamp(asOf);
      const events = await getEventsForPart(this.pool, partId, asOf);
      return replayEvents(partId, events);
    }
    const snap = await loadProjectionState(this.pool, partId);
    if (snap) return snap;
    return replayEvents(partId, await getEventsForPart(this.pool, partId));
  }

  async listEvents(partId: string, asOf?: string): Promise<StoredEvent[]> {
    requirePartId(partId);
    if (asOf) assertTimestamp(asOf);
    return getEventsForPart(this.pool, partId, asOf);
  }

  async listParts(): Promise<unknown[]> {
    const r = await this.pool.query(
      'SELECT part_id AS "partId", name, parent_id AS "parentId", prior_strength AS "priorStrength", explicit_prior_lr AS "explicitPriorLr" FROM parts ORDER BY part_id',
    );
    return r.rows;
  }

  // ---------- 拟合 ----------

  /** 内部：计算投影 + 拟合 + 先验（递归取母型，同一时点对齐） */
  private async computeFit(
    partId: string,
    asOf: string | undefined,
    depth: number,
  ): Promise<{
    proj: PartProjection;
    fit: FitResult | null;
    priorInfo: FitResponse['prior'];
    /** 有效学习率：自身拟合值；无拟合时沿链取先验均值（供下游改型继承） */
    effectiveLr: number | null;
  }> {
    if (depth > MAX_CHAIN_DEPTH) throw new ServiceError('VARIANT_CYCLE', '改型链过深', 500);
    const proj = await this.getProjection(partId, asOf);
    if (!proj.exists) throw new ServiceError('PART_NOT_FOUND', `部件 ${partId} 不存在`, 404);

    const batches: BatchDatum[] = proj.batches.map((b) => ({
      batchId: b.batchId,
      firstUnit: b.firstUnit,
      lastUnit: b.lastUnit,
      hours: b.hours,
    }));

    let priorSpec = null;
    let priorInfo: FitResponse['prior'] = null;
    if (proj.parentId) {
      let parentLr: number | null = null;
      try {
        parentLr = (await this.computeFit(proj.parentId, asOf, depth + 1)).effectiveLr;
      } catch {
        parentLr = null; // 母型不存在时退化为显式先验/无先验
      }
      const built = buildPrior(parentLr, {
        parentId: proj.parentId,
        priorStrength: proj.priorStrength ?? DEFAULT_PRIOR_STRENGTH,
        explicitPriorLr: proj.explicitPriorLr,
      });
      priorSpec = built.prior;
      priorInfo = {
        parentId: proj.parentId,
        source: built.source,
        learningRate: built.learningRate,
        strength: proj.priorStrength ?? DEFAULT_PRIOR_STRENGTH,
        informationShare: 0,
      };
    }

    const fit = fitLearningCurve(batches, priorSpec, DEFAULT_FIT_OPTIONS);
    if (priorInfo && fit?.prior) priorInfo.informationShare = fit.prior.informationShare;
    const effectiveLr =
      fit?.learningRate ?? (priorSpec ? Math.pow(2, priorSpec.bMean) : null);
    return { proj, fit, priorInfo, effectiveLr };
  }

  async getFit(partId: string, asOf?: string): Promise<FitResponse> {
    const { fit, priorInfo } = await this.computeFit(partId, asOf, 0);
    return toFitResponse(partId, asOf ?? null, fit, priorInfo);
  }

  // ---------- 预测 ----------

  async predict(partId: string, plan: PlanBatch[], asOf?: string): Promise<PredictionResult> {
    validatePlan(plan);
    const { proj, fit } = await this.computeFit(partId, asOf, 0);
    if (!fit) {
      throw new ServiceError('INSUFFICIENT_DATA', '数据不足，无法拟合（无先验至少需 2 批，有先验至少需 1 批）', 409);
    }
    return predictPlan(fit, proj.nextUnit, plan);
  }

  // ---------- 两时点对比 ----------

  async compare(partId: string, from: string, to: string, plan?: PlanBatch[]) {
    assertTimestamp(from, 'from');
    assertTimestamp(to, 'to');
    const [a, b] = await Promise.all([
      this.computeFit(partId, from, 0),
      this.computeFit(partId, to, 0),
    ]);
    const fitFrom = toFitResponse(partId, from, a.fit, a.priorInfo);
    const fitTo = toFitResponse(partId, to, b.fit, b.priorInfo);
    const result: Record<string, unknown> = {
      partId,
      from: fitFrom,
      to: fitTo,
      delta: fitDelta(fitFrom, fitTo),
    };
    if (plan) {
      validatePlan(plan);
      const pFrom = a.fit ? predictPlan(a.fit, a.proj.nextUnit, plan) : null;
      const pTo = b.fit ? predictPlan(b.fit, b.proj.nextUnit, plan) : null;
      result.predictionFrom = pFrom;
      result.predictionTo = pTo;
      result.predictionDelta =
        pFrom && pTo
          ? {
              totalHours: pTo.total.hours - pFrom.total.hours,
              totalHoursRel: pFrom.total.hours > 0 ? pTo.total.hours / pFrom.total.hours - 1 : null,
            }
          : null;
    }
    return result;
  }

  // ---------- 重启恢复 ----------

  /** 从事件流整体重建 parts 与 projections 读模型（服务启动时调用）。 */
  async rebuildProjections(): Promise<{ parts: number; events: number }> {
    const events = await getAllEvents(this.pool);
    const projs = new Map<string, PartProjection>();
    const partCreatedAt = new Map<string, string>();
    for (const ev of events) {
      const proj = projs.get(ev.partId) ?? emptyProjection(ev.partId);
      applyEvent(proj, { type: ev.type, payload: ev.payload });
      projs.set(ev.partId, proj);
      if (ev.type === 'part_registered') partCreatedAt.set(ev.partId, ev.recordedAt);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM projections');
      await client.query('DELETE FROM parts');
      let lastSeq = 0;
      for (const ev of events) lastSeq = Math.max(lastSeq, ev.seq);
      for (const proj of projs.values()) {
        if (!proj.exists) continue;
        await client.query(
          `INSERT INTO parts (part_id, name, parent_id, prior_strength, explicit_prior_lr, created_at)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, clock_timestamp()))`,
          [proj.partId, proj.name, proj.parentId, proj.priorStrength, proj.explicitPriorLr, partCreatedAt.get(proj.partId) ?? null],
        );
        await saveProjectionState(client, proj, lastSeq);
      }
      await client.query('COMMIT');
      return { parts: projs.size, events: events.length };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

// ---------- DTO 与校验辅助 ----------

function toFitResponse(
  partId: string,
  asOf: string | null,
  fit: FitResult | null,
  priorInfo: FitResponse['prior'],
): FitResponse {
  if (!fit) {
    return {
      partId,
      asOf,
      status: 'insufficient_data',
      t1: null,
      learningRate: null,
      exponentB: null,
      confidence: null,
      sigma: null,
      sigmaSource: null,
      degreesOfFreedom: 0,
      batchesUsed: 0,
      residuals: [],
      prior: priorInfo,
      converged: null,
      iterations: null,
    };
  }
  const tCrit = fit.sigmaSource === 'estimated' ? tQuantile975(fit.degreesOfFreedom) : Z_975;
  const sdLogT1 = Math.sqrt(Math.max(fit.covariance[0][0], 0));
  const sdB = Math.sqrt(Math.max(fit.covariance[1][1], 0));
  return {
    partId,
    asOf,
    status: 'ok',
    t1: fit.t1,
    learningRate: fit.learningRate,
    exponentB: fit.b,
    confidence: {
      level: 0.95,
      t1: [Math.exp(fit.logT1 - tCrit * sdLogT1), Math.exp(fit.logT1 + tCrit * sdLogT1)],
      learningRate: [Math.pow(2, fit.b - tCrit * sdB), Math.pow(2, fit.b + tCrit * sdB)],
    },
    sigma: fit.sigma,
    sigmaSource: fit.sigmaSource,
    degreesOfFreedom: fit.degreesOfFreedom,
    batchesUsed: fit.batchesUsed,
    residuals: fit.residuals,
    prior: priorInfo,
    converged: fit.converged,
    iterations: fit.iterations,
  };
}

function fitDelta(a: FitResponse, b: FitResponse) {
  if (a.status !== 'ok' || b.status !== 'ok') return null;
  return {
    t1: { abs: b.t1! - a.t1!, rel: a.t1! !== 0 ? b.t1! / a.t1! - 1 : null },
    learningRate: { abs: b.learningRate! - a.learningRate! },
    batchesUsed: { from: a.batchesUsed, to: b.batchesUsed },
  };
}

function requirePartId(partId: unknown, field = 'partId'): string {
  if (typeof partId !== 'string' || partId.length === 0 || partId.length > 64 || !/^[\w.\-]+$/.test(partId)) {
    throw new ServiceError('INVALID_PART_ID', `${field} 须为 1-64 位字母数字或 _.-`, 400);
  }
  return partId;
}

function requireBatchId(batchId: unknown): string {
  if (typeof batchId !== 'string' || batchId.length === 0 || batchId.length > 64) {
    throw new ServiceError('INVALID_BATCH_ID', 'batchId 须为 1-64 位字符串', 400);
  }
  return batchId;
}

function requireEventId(eventId: unknown): string {
  if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 128) {
    throw new ServiceError('INVALID_EVENT_ID', 'eventId 须为 1-128 位字符串', 400);
  }
  return eventId;
}

function requirePositiveInt(v: unknown, field: string, label: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ServiceError('QUANTITY_NOT_POSITIVE_INTEGER', `${label}（${field}）须为正整数`, 400);
  }
  if (v > MAX_UNIT_INDEX) {
    throw new ServiceError('VALUE_TOO_LARGE', `${label}超出允许范围`, 400);
  }
  return v;
}

function requirePositiveNumber(v: unknown, field: string, label: string): number {
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) {
    throw new ServiceError('HOURS_NOT_POSITIVE', `${label}（${field}）须为正数`, 400);
  }
  return v;
}

function assertTimestamp(v: unknown, field = 'asOf'): asserts v is string {
  if (typeof v !== 'string' || isNaN(Date.parse(v))) {
    throw new ServiceError('INVALID_TIMESTAMP', `${field} 须为 ISO 8601 时间戳`, 400);
  }
}

function validatePlan(plan: PlanBatch[]): void {
  if (!Array.isArray(plan) || plan.length === 0 || plan.length > 500) {
    throw new ServiceError('INVALID_PLAN', '交付计划须为 1-500 个批次', 400);
  }
  for (const p of plan) {
    requirePositiveInt(p?.quantity, 'quantity', '计划件数');
  }
}
