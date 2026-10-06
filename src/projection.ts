/**
 * 部件批次状态的纯函数归约器（projection）。
 *
 * 语义约定（详见 README「事件溯源语义」）：
 *  - record  ：追加一个批次。区间必须紧接当前最大件号（firstUnit = maxUnit + 1），
 *              除非显式 allowsGap（跳号：序列号空缺，如报废件）。
 *  - correct ：更正某批的总工时和/或件数（以 lastUnit 表达）。
 *              件数变化时，之后所有批次的累计区间整体平移同一差值
 *             （空档大小随之保持），因为后续批次的件号是物理序列号，
 *              它们的真实位置由前面批次的真实件数决定。
 *  - void    ：作废一条批次记录 —— 数据不再参与拟合，但其区间仍然占位
 *             （件已经生产，物理序列号不回填），maxUnit 不变。
 *
 * 同一个归约器同时用于：在线追加事件、历史时点回推（as-of 截断后重放）、
 * 服务重启后的投影重建 —— 三条路径共享一份代码，保证结果一致。
 */
import { ConflictError, NotFoundError, ValidationError } from './errors';

export type EventType = 'record' | 'correct' | 'void';

export interface BatchEvent {
  eventId: string;
  type: EventType;
  batchId: string;
  firstUnit?: number;
  lastUnit?: number;
  totalHours?: number;
  allowsGap?: boolean;
}

export interface BatchState {
  batchId: string;
  firstUnit: number;
  lastUnit: number;
  totalHours: number;
  status: 'active' | 'voided';
}

export interface PartState {
  /** 按件号区间升序 */
  batches: BatchState[];
  /** 已生产的最大件号（含作废批次与跳号空档之后的区间） */
  maxUnit: number;
}

export function initialPartState(): PartState {
  return { batches: [], maxUnit: 0 };
}

export function applyEvent(state: PartState, ev: BatchEvent): PartState {
  switch (ev.type) {
    case 'record':
      return applyRecord(state, ev);
    case 'correct':
      return applyCorrect(state, ev);
    case 'void':
      return applyVoid(state, ev);
  }
}

function applyRecord(state: PartState, ev: BatchEvent): PartState {
  if (state.batches.some((b) => b.batchId === ev.batchId)) {
    throw new ConflictError(`批次号 ${ev.batchId} 已存在`);
  }
  const first = ev.firstUnit!;
  const last = ev.lastUnit!;
  const expected = state.maxUnit + 1;
  if (first < expected) {
    throw new ConflictError(
      `批次区间 [${first}, ${last}] 与已有批次重叠（下一个应为第 ${expected} 件）`,
    );
  }
  if (first > expected && !ev.allowsGap) {
    throw new ConflictError(
      `批次从第 ${first} 件开始，但下一个应为第 ${expected} 件：存在空档（如为跳号请显式标注 allowsGap）`,
    );
  }
  const batch: BatchState = {
    batchId: ev.batchId,
    firstUnit: first,
    lastUnit: last,
    totalHours: ev.totalHours!,
    status: 'active',
  };
  return {
    batches: [...state.batches, batch],
    maxUnit: Math.max(state.maxUnit, last),
  };
}

function applyCorrect(state: PartState, ev: BatchEvent): PartState {
  const idx = state.batches.findIndex((b) => b.batchId === ev.batchId);
  if (idx < 0) throw new NotFoundError(`批次 ${ev.batchId} 不存在`);
  if (state.batches[idx].status === 'voided') {
    throw new ConflictError(`批次 ${ev.batchId} 已作废，不能更正`);
  }
  const batches = state.batches.map((b) => ({ ...b }));
  const target = batches[idx];
  if (ev.totalHours !== undefined) {
    if (!(ev.totalHours > 0)) throw new ValidationError('更正后的总工时必须为正');
    target.totalHours = ev.totalHours;
  }
  if (ev.lastUnit !== undefined && ev.lastUnit !== target.lastUnit) {
    if (!Number.isInteger(ev.lastUnit) || ev.lastUnit < target.firstUnit) {
      throw new ValidationError(
        `更正后的末件号 ${ev.lastUnit} 不合法（须为不小于首件号 ${target.firstUnit} 的整数，即件数为正整数）`,
      );
    }
    // 件数变化 → 之后所有批次（含作废的，区间仍占位）整体平移
    const delta = ev.lastUnit - target.lastUnit;
    const oldLast = target.lastUnit;
    target.lastUnit = ev.lastUnit;
    for (const b of batches) {
      if (b.firstUnit > oldLast) {
        b.firstUnit += delta;
        b.lastUnit += delta;
      }
    }
  }
  const maxUnit = batches.reduce((m, b) => Math.max(m, b.lastUnit), 0);
  return { batches, maxUnit };
}

function applyVoid(state: PartState, ev: BatchEvent): PartState {
  const idx = state.batches.findIndex((b) => b.batchId === ev.batchId);
  if (idx < 0) throw new NotFoundError(`批次 ${ev.batchId} 不存在`);
  if (state.batches[idx].status === 'voided') {
    throw new ConflictError(`批次 ${ev.batchId} 已作废`);
  }
  const batches = state.batches.map((b) => ({ ...b }));
  batches[idx].status = 'voided';
  return { batches, maxUnit: state.maxUnit };
}

/** 按顺序重放事件流，得到部件状态。 */
export function reduceEvents(events: BatchEvent[]): PartState {
  return events.reduce(applyEvent, initialPartState());
}
