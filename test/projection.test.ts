/**
 * 事件归约器（纯函数）：录入校验、件数更正区间平移、作废语义。
 */
import { ConflictError, NotFoundError, ValidationError } from '../src/errors';
import { applyEvent, BatchEvent, reduceEvents } from '../src/projection';

const rec = (
  id: string,
  batchId: string,
  f: number,
  l: number,
  h: number,
  allowsGap = false,
): BatchEvent => ({ eventId: id, type: 'record', batchId, firstUnit: f, lastUnit: l, totalHours: h, allowsGap });

describe('批次录入', () => {
  test('顺序录入构建累计区间', () => {
    const s = reduceEvents([rec('e1', 'B1', 1, 10, 900), rec('e2', 'B2', 11, 20, 700), rec('e3', 'B3', 21, 35, 800)]);
    expect(s.maxUnit).toBe(35);
    expect(s.batches.map((b) => [b.firstUnit, b.lastUnit])).toEqual([[1, 10], [11, 20], [21, 35]]);
  });

  test('区间重叠 → 拒绝', () => {
    expect(() => reduceEvents([rec('e1', 'B1', 1, 10, 900), rec('e2', 'B2', 10, 20, 700)])).toThrow(ConflictError);
    expect(() => reduceEvents([rec('e1', 'B1', 1, 10, 900), rec('e2', 'B2', 5, 8, 700)])).toThrow(ConflictError);
  });

  test('空档：未标注跳号 → 拒绝；标注 → 接受', () => {
    expect(() => reduceEvents([rec('e1', 'B1', 1, 10, 900), rec('e2', 'B2', 15, 20, 700)])).toThrow(ConflictError);
    const s = reduceEvents([rec('e1', 'B1', 1, 10, 900), rec('e2', 'B2', 15, 20, 700, true)]);
    expect(s.maxUnit).toBe(20);
    expect(s.batches[1].firstUnit).toBe(15);
  });

  test('批次号重复 → 拒绝', () => {
    expect(() => reduceEvents([rec('e1', 'B1', 1, 10, 900), rec('e2', 'B1', 11, 20, 700)])).toThrow(ConflictError);
  });
});

describe('件数更正引起的区间平移', () => {
  const base = () =>
    reduceEvents([rec('e1', 'B1', 1, 10, 900), rec('e2', 'B2', 11, 20, 700), rec('e3', 'B3', 21, 30, 600)]);

  test('件数增加 → 后续批次整体后移', () => {
    const s = applyEvent(base(), { eventId: 'e4', type: 'correct', batchId: 'B1', lastUnit: 12 });
    expect(s.batches.map((b) => [b.firstUnit, b.lastUnit])).toEqual([[1, 12], [13, 22], [23, 32]]);
    expect(s.maxUnit).toBe(32);
  });

  test('件数减少 → 后续批次整体前移', () => {
    const s = applyEvent(base(), { eventId: 'e4', type: 'correct', batchId: 'B2', lastUnit: 18 });
    expect(s.batches.map((b) => [b.firstUnit, b.lastUnit])).toEqual([[1, 10], [11, 18], [19, 28]]);
    expect(s.maxUnit).toBe(28);
  });

  test('跳号空档随平移保持大小', () => {
    const s0 = reduceEvents([rec('e1', 'B1', 1, 10, 900), rec('e2', 'B2', 15, 20, 700, true)]);
    const s = applyEvent(s0, { eventId: 'e3', type: 'correct', batchId: 'B1', lastUnit: 12 });
    expect(s.batches.map((b) => [b.firstUnit, b.lastUnit])).toEqual([[1, 12], [17, 22]]);
  });

  test('只更正工时不平移', () => {
    const s = applyEvent(base(), { eventId: 'e4', type: 'correct', batchId: 'B2', totalHours: 750 });
    expect(s.batches.map((b) => [b.firstUnit, b.lastUnit])).toEqual([[1, 10], [11, 20], [21, 30]]);
    expect(s.batches[1].totalHours).toBe(750);
  });

  test('更正后件数非正 → 拒绝', () => {
    expect(() => applyEvent(base(), { eventId: 'e4', type: 'correct', batchId: 'B2', lastUnit: 5 })).toThrow(ValidationError);
    expect(() => applyEvent(base(), { eventId: 'e4', type: 'correct', batchId: 'B2', lastUnit: 10 })).toThrow(ValidationError);
  });

  test('更正未知批次 → NotFound', () => {
    expect(() => applyEvent(base(), { eventId: 'e4', type: 'correct', batchId: 'BX', totalHours: 1 })).toThrow(NotFoundError);
  });
});

describe('作废', () => {
  test('作废后批次不参与拟合但区间仍占位（maxUnit 不变）', () => {
    const s0 = reduceEvents([rec('e1', 'B1', 1, 10, 900), rec('e2', 'B2', 11, 20, 700), rec('e3', 'B3', 21, 30, 600)]);
    const s = applyEvent(s0, { eventId: 'e4', type: 'void', batchId: 'B2' });
    expect(s.batches[1].status).toBe('voided');
    expect(s.maxUnit).toBe(30);
    const active = s.batches.filter((b) => b.status === 'active');
    expect(active.map((b) => b.batchId)).toEqual(['B1', 'B3']);
  });

  test('重复作废 / 作废后更正 → 拒绝', () => {
    const s0 = reduceEvents([rec('e1', 'B1', 1, 10, 900)]);
    const s1 = applyEvent(s0, { eventId: 'e2', type: 'void', batchId: 'B1' });
    expect(() => applyEvent(s1, { eventId: 'e3', type: 'void', batchId: 'B1' })).toThrow(ConflictError);
    expect(() => applyEvent(s1, { eventId: 'e4', type: 'correct', batchId: 'B1', totalHours: 5 })).toThrow(ConflictError);
  });

  test('作废的批次仍随后续平移（占位语义）', () => {
    const s0 = reduceEvents([rec('e1', 'B1', 1, 10, 900), rec('e2', 'B2', 11, 20, 700), rec('e3', 'B3', 21, 30, 600)]);
    const s1 = applyEvent(s0, { eventId: 'e4', type: 'void', batchId: 'B3' });
    const s2 = applyEvent(s1, { eventId: 'e5', type: 'correct', batchId: 'B1', lastUnit: 12 });
    expect(s2.batches[2].firstUnit).toBe(23);
    expect(s2.batches[2].lastUnit).toBe(32);
    expect(s2.batches[2].status).toBe('voided');
  });
});
