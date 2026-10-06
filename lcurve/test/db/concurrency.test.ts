/**
 * 并发提交：最终状态与按受理顺序串行处理相同；并发重复事件只生效一次。
 */

import { closeDb, getPool, makeService, resetDb } from '../helpers/db';
import { getEventsForPart } from '../../src/eventStore';
import { replayEvents } from '../../src/projection';

beforeAll(resetDb);
afterAll(closeDb);

describe('并发提交', () => {
  test('10 个并发录入：全部受理，投影与按 seq 串行回放一致', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'CONC' });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        svc.submitBatchEvent('CONC', {
          eventId: `conc-${i}`,
          type: 'batch_recorded',
          batchId: `B${i}`,
          quantity: 5,
          hours: 400 - i,
        }),
      ),
    );
    expect(results.every((r) => !r.duplicate)).toBe(true);
    // seq 两两不同
    expect(new Set(results.map((r) => r.seq)).size).toBe(10);

    const proj = await svc.getProjection('CONC');
    expect(proj.batches).toHaveLength(10);
    // 区间连续无缝（顺序由受理序决定）
    for (let i = 0; i < 10; i++) {
      expect(proj.batches[i]!.firstUnit).toBe(i * 5 + 1);
      expect(proj.batches[i]!.lastUnit).toBe(i * 5 + 5);
    }
    expect(proj.nextUnit).toBe(51);

    // 与按事件流串行回放完全一致
    const events = await getEventsForPart(getPool(), 'CONC');
    expect(replayEvents('CONC', events)).toEqual(proj);
  });

  test('并发的更正与录入：结果等价于某个串行顺序，且与回放一致', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'CONC2' });
    await svc.submitBatchEvent('CONC2', { eventId: 'c0', type: 'batch_recorded', batchId: 'B0', quantity: 10, hours: 800 });

    // 并发：更正 B0 件数 + 录入新批
    await Promise.all([
      svc.submitBatchEvent('CONC2', { eventId: 'c1', type: 'batch_corrected', batchId: 'B0', quantity: 12 }),
      svc.submitBatchEvent('CONC2', { eventId: 'c2', type: 'batch_recorded', batchId: 'B1', quantity: 5, hours: 350 }),
      svc.submitBatchEvent('CONC2', { eventId: 'c3', type: 'batch_corrected', batchId: 'B0', hours: 900 }),
    ]);

    const proj = await svc.getProjection('CONC2');
    expect(proj.batches).toHaveLength(2);
    expect(proj.batches[0]!.quantity).toBe(12);
    expect(proj.batches[0]!.hours).toBe(900);
    expect(proj.batches[1]!.firstUnit).toBe(13); // 平移生效
    const events = await getEventsForPart(getPool(), 'CONC2');
    expect(replayEvents('CONC2', events)).toEqual(proj);
  });

  test('同一事件编号并发提交：只生效一次', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'CONC-DUP' });
    const ev = {
      eventId: 'same-id',
      type: 'batch_recorded' as const,
      batchId: 'B1',
      quantity: 5,
      hours: 400,
    };
    const results = await Promise.all([
      svc.submitBatchEvent('CONC-DUP', ev),
      svc.submitBatchEvent('CONC-DUP', ev),
      svc.submitBatchEvent('CONC-DUP', ev),
    ]);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(2);
    const proj = await svc.getProjection('CONC-DUP');
    expect(proj.batches).toHaveLength(1);
  });
});
