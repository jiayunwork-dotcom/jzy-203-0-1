/**
 * 请求输入校验：所有拒收规则（件数非正整数、工时不为正、先验越界等）
 * 在进入领域逻辑之前集中在这里判定，抛出 ValidationError（400）。
 */
import { ValidationError } from './errors';
import { BatchEvent } from './projection';
import { PlanBatch } from './predict';

export function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

export function isPositiveNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** 解析并校验批次事件请求体。 */
export function parseEventBody(body: unknown): BatchEvent {
  if (body === null || typeof body !== 'object') {
    throw new ValidationError('请求体必须是 JSON 对象');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.eventId !== 'string' || b.eventId.length === 0) {
    throw new ValidationError('eventId 必须是非空字符串（幂等键）');
  }
  if (b.type !== 'record' && b.type !== 'correct' && b.type !== 'void') {
    throw new ValidationError("type 必须是 'record' | 'correct' | 'void'");
  }
  if (typeof b.batchId !== 'string' || b.batchId.length === 0) {
    throw new ValidationError('batchId 必须是非空字符串');
  }
  const type = b.type;
  const base = { eventId: b.eventId, type, batchId: b.batchId } as const;

  if (type === 'record') {
    if (!isPositiveInt(b.firstUnit)) throw new ValidationError('firstUnit 必须是正整数');
    if (!isPositiveInt(b.lastUnit)) throw new ValidationError('lastUnit 必须是正整数');
    if (b.lastUnit < b.firstUnit) {
      throw new ValidationError('lastUnit 必须不小于 firstUnit（批次件数为正整数）');
    }
    if (!isPositiveNumber(b.totalHours)) {
      throw new ValidationError('totalHours 必须为正数');
    }
    return {
      ...base,
      firstUnit: b.firstUnit,
      lastUnit: b.lastUnit,
      totalHours: b.totalHours,
      allowsGap: b.allowsGap === true,
    };
  }

  if (type === 'correct') {
    const hasHours = b.totalHours !== undefined;
    const hasLast = b.lastUnit !== undefined;
    if (!hasHours && !hasLast) {
      throw new ValidationError('更正事件必须包含 totalHours 和/或 lastUnit');
    }
    if (hasHours && !isPositiveNumber(b.totalHours)) {
      throw new ValidationError('totalHours 必须为正数');
    }
    if (hasLast && !isPositiveInt(b.lastUnit)) {
      throw new ValidationError('lastUnit 必须是正整数');
    }
    return {
      ...base,
      totalHours: hasHours ? (b.totalHours as number) : undefined,
      lastUnit: hasLast ? (b.lastUnit as number) : undefined,
    };
  }

  return base;
}

/** 解析交付计划：{batches:[{units}…]} 或 {totalUnits, batchSize}；允许外层包一层 plan。 */
export function parsePlan(body: unknown): PlanBatch[] {
  const root = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const plan = (root.plan !== undefined ? root.plan : root) as Record<string, unknown>;
  if (plan !== null && typeof plan === 'object' && Array.isArray((plan as { batches?: unknown }).batches)) {
    const list = (plan as { batches: unknown[] }).batches;
    if (list.length === 0) throw new ValidationError('交付计划至少包含一批');
    return list.map((item, i) => {
      const units =
        item !== null && typeof item === 'object'
          ? (item as Record<string, unknown>).units
          : item;
      if (!isPositiveInt(units)) {
        throw new ValidationError(`交付计划第 ${i} 批的件数必须是正整数`);
      }
      return { units };
    });
  }
  if (
    plan !== null &&
    typeof plan === 'object' &&
    isPositiveInt((plan as Record<string, unknown>).totalUnits) &&
    isPositiveInt((plan as Record<string, unknown>).batchSize)
  ) {
    const totalUnits = (plan as Record<string, number>).totalUnits;
    const batchSize = (plan as Record<string, number>).batchSize;
    const out: PlanBatch[] = [];
    let remaining = totalUnits;
    while (remaining > 0) {
      const u = Math.min(remaining, batchSize);
      out.push({ units: u });
      remaining -= u;
    }
    return out;
  }
  throw new ValidationError('交付计划必须是 {batches:[{units}…]} 或 {totalUnits, batchSize}');
}

/** 解析 ISO 日期时间参数；undefined → null；非法 → 400。 */
export function parseDateParam(value: unknown, name = 'asOf'): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${name} 必须是 ISO 日期时间字符串`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${name} 不是合法的日期时间：${value}`);
  return d;
}
