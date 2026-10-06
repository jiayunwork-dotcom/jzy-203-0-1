/**
 * 件数更正引起的区间整体平移（端到端，含拟合联动）。
 */

import { closeDb, makeService, resetDb } from '../helpers/db';
import { batchHours, exponentFromLearningRate } from '../../src/curve';

beforeAll(resetDb);
afterAll(closeDb);

describe('件数更正的区间平移', () => {
  test('更正第一批件数后，后续批次区间整体平移，拟合使用新区间', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'SHIFT' });
    // 按 LR=80% 曲线生成三批（各 10 件）的精确工时
    const b = exponentFromLearningRate(0.8);
    const h = (f: number, l: number) => batchHours(100, b, f, l);
    await svc.submitBatchEvent('SHIFT', { eventId: 'sh-1', type: 'batch_recorded', batchId: 'B1', quantity: 10, hours: h(1, 10) });
    await svc.submitBatchEvent('SHIFT', { eventId: 'sh-2', type: 'batch_recorded', batchId: 'B2', quantity: 10, hours: h(11, 20) });
    await svc.submitBatchEvent('SHIFT', { eventId: 'sh-3', type: 'batch_recorded', batchId: 'B3', quantity: 10, hours: h(21, 30) });

    let proj = await svc.getProjection('SHIFT');
    expect(proj.batches.map((x) => [x.firstUnit, x.lastUnit])).toEqual([[1, 10], [11, 20], [21, 30]]);
    let fit = await svc.getFit('SHIFT');
    expect(Math.abs(fit.learningRate! / 0.8 - 1)).toBeLessThan(1e-6);

    // B1 件数 10 → 15：B2/B3 区间应整体平移 5 件
    await svc.submitBatchEvent('SHIFT', { eventId: 'sh-4', type: 'batch_corrected', batchId: 'B1', quantity: 15 });
    proj = await svc.getProjection('SHIFT');
    expect(proj.batches.map((x) => [x.firstUnit, x.lastUnit])).toEqual([[1, 15], [16, 25], [26, 35]]);
    expect(proj.nextUnit).toBe(36);

    // 注意：B2/B3 的工时仍对应原区间 [11,20]/[21,30]，
    // 平移后数据不再吻合原曲线，拟合结果必然变化——这正是平移必须处理对的原因
    fit = await svc.getFit('SHIFT');
    expect(Math.abs(fit.learningRate! - 0.8)).toBeGreaterThan(1e-4);

    // 若 B1 的工时也更正为 15 件的精确值，且 B2/B3 是财务按正确区间补录的，
    // 则把 B2/B3 也更正为新区间工时后应重新还原参数
    await svc.submitBatchEvent('SHIFT', { eventId: 'sh-5', type: 'batch_corrected', batchId: 'B1', hours: h(1, 15) });
    await svc.submitBatchEvent('SHIFT', { eventId: 'sh-6', type: 'batch_corrected', batchId: 'B2', hours: h(16, 25) });
    await svc.submitBatchEvent('SHIFT', { eventId: 'sh-7', type: 'batch_corrected', batchId: 'B3', hours: h(26, 35) });
    fit = await svc.getFit('SHIFT');
    expect(Math.abs(fit.learningRate! / 0.8 - 1)).toBeLessThan(1e-6);
    expect(Math.abs(fit.t1! / 100 - 1)).toBeLessThan(1e-6);
  });

  test('作废中间批次，后续区间整体上移', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'SHIFT-VOID' });
    await svc.submitBatchEvent('SHIFT-VOID', { eventId: 'v1', type: 'batch_recorded', batchId: 'B1', quantity: 10, hours: 800 });
    await svc.submitBatchEvent('SHIFT-VOID', { eventId: 'v2', type: 'batch_recorded', batchId: 'B2', quantity: 10, hours: 700 });
    await svc.submitBatchEvent('SHIFT-VOID', { eventId: 'v3', type: 'batch_recorded', batchId: 'B3', quantity: 10, hours: 650 });
    await svc.submitBatchEvent('SHIFT-VOID', { eventId: 'v4', type: 'batch_voided', batchId: 'B2' });
    const proj = await svc.getProjection('SHIFT-VOID');
    expect(proj.batches.map((x) => [x.batchId, x.firstUnit, x.lastUnit])).toEqual([
      ['B1', 1, 10],
      ['B3', 11, 20],
    ]);
    expect(proj.nextUnit).toBe(21);
  });
});
