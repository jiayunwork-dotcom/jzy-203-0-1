/**
 * 投影：区间派生、件数更正引起的整体平移、作废、跳号保持、回放一致性。
 */

import { applyEvent, emptyProjection, replayEvents, DomainEvent } from '../../src/projection';

function rec(batchId: string, quantity: number, hours: number, gap = 0): DomainEvent {
  return { type: 'batch_recorded', payload: { batchId, quantity, hours, gap } };
}

describe('投影与区间派生', () => {
  test('连续录入三批：区间依次衔接', () => {
    let p = emptyProjection('P');
    p = applyEvent(p, { type: 'part_registered', payload: {} });
    p = applyEvent(p, rec('B1', 10, 800));
    p = applyEvent(p, rec('B2', 10, 700));
    p = applyEvent(p, rec('B3', 10, 650));
    expect(p.batches.map((b) => [b.firstUnit, b.lastUnit])).toEqual([
      [1, 10],
      [11, 20],
      [21, 30],
    ]);
    expect(p.nextUnit).toBe(31);
  });

  test('更正某批件数后，后续所有批次区间整体平移', () => {
    let p = emptyProjection('P');
    applyEvent(p, { type: 'part_registered', payload: {} });
    applyEvent(p, rec('B1', 10, 800));
    applyEvent(p, rec('B2', 10, 700));
    applyEvent(p, rec('B3', 10, 650));
    // B1 件数 10 → 15
    applyEvent(p, { type: 'batch_corrected', payload: { batchId: 'B1', quantity: 15 } });
    expect(p.batches.map((b) => [b.firstUnit, b.lastUnit])).toEqual([
      [1, 15],
      [16, 25],
      [26, 35],
    ]);
    expect(p.nextUnit).toBe(36);
    // 再改小：10 → 5，后续回移
    applyEvent(p, { type: 'batch_corrected', payload: { batchId: 'B2', quantity: 5 } });
    expect(p.batches.map((b) => [b.firstUnit, b.lastUnit])).toEqual([
      [1, 15],
      [16, 20],
      [21, 30],
    ]);
    expect(p.nextUnit).toBe(31);
  });

  test('作废某批后，后续批次区间整体上移', () => {
    let p = emptyProjection('P');
    applyEvent(p, { type: 'part_registered', payload: {} });
    applyEvent(p, rec('B1', 10, 800));
    applyEvent(p, rec('B2', 10, 700));
    applyEvent(p, rec('B3', 10, 650));
    applyEvent(p, { type: 'batch_voided', payload: { batchId: 'B1' } });
    expect(p.batches.map((b) => [b.batchId, b.firstUnit, b.lastUnit])).toEqual([
      ['B2', 1, 10],
      ['B3', 11, 20],
    ]);
    expect(p.nextUnit).toBe(21);
    // 作废的批次号仍在 seenBatchIds，不可复用
    expect(p.seenBatchIds).toContain('B1');
  });

  test('跳号间隙在平移后保持不变', () => {
    let p = emptyProjection('P');
    applyEvent(p, { type: 'part_registered', payload: {} });
    applyEvent(p, rec('B1', 10, 800));
    applyEvent(p, rec('B2', 10, 700, 4)); // 跳过 4 件：从 15 开始
    expect(p.batches[1]!.firstUnit).toBe(15);
    expect(p.batches[1]!.lastUnit).toBe(24);
    // B1 件数更正 10 → 12：B2 整体平移，间隙仍为 4
    applyEvent(p, { type: 'batch_corrected', payload: { batchId: 'B1', quantity: 12 } });
    expect(p.batches[1]!.firstUnit).toBe(17);
    expect(p.batches[1]!.lastUnit).toBe(26);
    expect(p.batches[1]!.gap).toBe(4);
  });

  test('更正工时只改本批，不影响区间', () => {
    let p = emptyProjection('P');
    applyEvent(p, { type: 'part_registered', payload: {} });
    applyEvent(p, rec('B1', 10, 800));
    applyEvent(p, rec('B2', 10, 700));
    applyEvent(p, { type: 'batch_corrected', payload: { batchId: 'B1', hours: 812.5 } });
    expect(p.batches[0]!.hours).toBe(812.5);
    expect(p.batches[1]!.firstUnit).toBe(11);
  });

  test('增量应用与整体回放结果一致', () => {
    const events: DomainEvent[] = [
      { type: 'part_registered', payload: { name: 'X' } },
      rec('B1', 10, 800),
      rec('B2', 10, 700, 2),
      { type: 'batch_corrected', payload: { batchId: 'B1', quantity: 15 } },
      rec('B3', 5, 300),
      { type: 'batch_voided', payload: { batchId: 'B2' } },
      { type: 'batch_corrected', payload: { batchId: 'B3', hours: 310 } },
    ];
    let inc = emptyProjection('P');
    for (const e of events) inc = applyEvent(inc, e);
    const rep = replayEvents('P', events);
    expect(rep).toEqual(inc);
  });
});
