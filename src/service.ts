/**
 * 应用服务层：把事件流 → 状态 → 拟合 → 预测串起来，供 HTTP 层调用。
 *
 * 拟合与预测一律从事件流现算（事件流是唯一事实来源）；投影表服务于
 * 状态查询。先验沿继承链递归合成（母型自身也可以有先验）。
 */
import { slopeFromLearningRate } from './curve';
import { InsufficientDataError, NotFoundError } from './errors';
import { BatchPoint, fitCurve, FitResult, PriorSpec } from './fit';
import { MidpointMethod } from './midpoint';
import { PlanBatch, predict, PredictionResult } from './predict';
import { PartState, reduceEvents } from './projection';
import { InheritanceEdge, Store } from './store';
import { PartRow } from './store';

export interface PriorMeta {
  active: boolean;
  source?: 'explicit' | 'parent-fit';
  parentId?: string;
  learningRate?: number;
  strength?: number;
}

export interface FitResponse extends FitResult {
  partId: string;
  asOf: string | null;
  prior: PriorMeta;
}

export interface PartStateResponse {
  part: PartRow;
  inheritance: InheritanceEdge | null;
  state: PartState;
  eventCount: number;
}

export interface PredictionResponse {
  partId: string;
  asOf: string | null;
  fit: FitResponse;
  prediction: PredictionResult;
}

export interface CompareResponse {
  partId: string;
  from: { asOf: string; fit: FitResponse; prediction: PredictionResult | null };
  to: { asOf: string | null; fit: FitResponse; prediction: PredictionResult | null };
  delta: {
    t1: number;
    learningRate: number;
    b: number;
    totalHours: number | null;
    batchHours: { index: number; from: number; to: number; delta: number }[] | null;
  };
}

export class Service {
  constructor(private readonly store: Store) {}

  private async stateAt(partId: string, asOf: Date | null): Promise<PartState> {
    const events = await this.store.listEvents(partId, asOf ?? undefined);
    return reduceEvents(events);
  }

  /** 当前（asOf 缺省）或历史时点的拟合结果。 */
  async getFit(partId: string, asOf?: Date, method: MidpointMethod = 'exact'): Promise<FitResponse> {
    return this.getFitInternal(partId, asOf ?? null, method, new Set([partId]));
  }

  private async getFitInternal(
    partId: string,
    asOf: Date | null,
    method: MidpointMethod,
    visited: Set<string>,
  ): Promise<FitResponse> {
    const part = await this.store.getPart(partId);
    if (!part) throw new NotFoundError(`部件 ${partId} 不存在`);
    const state = await this.stateAt(partId, asOf);
    const active: BatchPoint[] = state.batches
      .filter((b) => b.status === 'active')
      .map((b) => ({
        batchId: b.batchId,
        firstUnit: b.firstUnit,
        lastUnit: b.lastUnit,
        totalHours: b.totalHours,
      }));
    const prior = await this.resolvePrior(partId, asOf, method, visited);
    const fit = fitCurve(active, { method, prior: prior?.spec ?? null });
    return {
      ...fit,
      partId,
      asOf: asOf ? asOf.toISOString() : null,
      prior: prior?.meta ?? { active: false },
    };
  }

  /**
   * 合成学习率先验：显式值优先；否则跟随母型当前（同一时点）的拟合学习率，
   * 沿继承链递归。母型尚无拟合时先验不生效（视为无先验）。
   */
  private async resolvePrior(
    partId: string,
    asOf: Date | null,
    method: MidpointMethod,
    visited: Set<string>,
  ): Promise<{ spec: PriorSpec; meta: PriorMeta } | null> {
    const edge = await this.store.getInheritance(partId);
    if (!edge) return null;
    let learningRate = edge.priorLearningRate;
    let source: 'explicit' | 'parent-fit' = 'explicit';
    if (learningRate === null || learningRate === undefined) {
      source = 'parent-fit';
      if (visited.has(edge.parentId)) return null; // 防御：写入侧已保证无环
      visited.add(edge.parentId);
      try {
        const parentFit = await this.getFitInternal(edge.parentId, asOf, method, visited);
        learningRate = parentFit.learningRate;
      } catch (e) {
        if (e instanceof InsufficientDataError || e instanceof NotFoundError) return null;
        throw e;
      }
    }
    return {
      spec: { b: slopeFromLearningRate(learningRate), precision: edge.strength },
      meta: {
        active: true,
        source,
        parentId: edge.parentId,
        learningRate,
        strength: edge.strength,
      },
    };
  }

  /** 部件当前状态（来自投影表）。 */
  async getState(partId: string): Promise<PartStateResponse> {
    const part = await this.store.getPart(partId);
    if (!part) throw new NotFoundError(`部件 ${partId} 不存在`);
    const [inheritance, proj] = await Promise.all([
      this.store.getInheritance(partId),
      this.store.getProjection(partId),
    ]);
    return { part, inheritance, state: proj.state, eventCount: proj.eventCount };
  }

  /** 提交交付计划并取预测（可指定时点，默认当前）。 */
  async predict(
    partId: string,
    plan: PlanBatch[],
    asOf: Date | null,
    method: MidpointMethod,
  ): Promise<PredictionResponse> {
    const fit = await this.getFitInternal(partId, asOf, method, new Set([partId]));
    const state = await this.stateAt(partId, asOf);
    const prediction = predict(fit, state.maxUnit + 1, plan);
    return { partId, asOf: asOf ? asOf.toISOString() : null, fit, prediction };
  }

  /** 对比两个时点的拟合与（同一计划下的）预测差异。 */
  async compare(
    partId: string,
    from: Date,
    to: Date | null,
    plan: PlanBatch[] | null,
    method: MidpointMethod,
  ): Promise<CompareResponse> {
    const fitFrom = await this.getFitInternal(partId, from, method, new Set([partId]));
    const fitTo = await this.getFitInternal(partId, to, method, new Set([partId]));
    let predFrom: PredictionResult | null = null;
    let predTo: PredictionResult | null = null;
    if (plan) {
      const stateFrom = await this.stateAt(partId, from);
      const stateTo = await this.stateAt(partId, to);
      predFrom = predict(fitFrom, stateFrom.maxUnit + 1, plan);
      predTo = predict(fitTo, stateTo.maxUnit + 1, plan);
    }
    return {
      partId,
      from: { asOf: from.toISOString(), fit: fitFrom, prediction: predFrom },
      to: { asOf: to ? to.toISOString() : null, fit: fitTo, prediction: predTo },
      delta: {
        t1: fitTo.t1 - fitFrom.t1,
        learningRate: fitTo.learningRate - fitFrom.learningRate,
        b: fitTo.b - fitFrom.b,
        totalHours: predFrom && predTo ? predTo.totalHours - predFrom.totalHours : null,
        batchHours:
          predFrom && predTo
            ? predTo.batches.map((pb, i) => ({
                index: i,
                from: predFrom!.batches[i].hours,
                to: pb.hours,
                delta: pb.hours - predFrom!.batches[i].hours,
              }))
            : null,
      },
    };
  }
}
