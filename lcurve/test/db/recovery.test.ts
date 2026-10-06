/**
 * 重启恢复：读模型（projections/parts）丢失后可从事件流完整重建，
 * 重建后的拟合结果与丢失前一致。
 */

import { closeDb, getPool, makeService, resetDb } from '../helpers/db';
import { getEventsForPart } from '../../src/eventStore';
import { replayEvents } from '../../src/projection';

beforeAll(resetDb);
afterAll(closeDb);

describe('重启恢复', () => {
  test('清空读模型后从事件流重建，拟合结果不变', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'REC' });
    await svc.submitBatchEvent('REC', { eventId: 'r1', type: 'batch_recorded', batchId: 'B1', quantity: 10, hours: 812.3 });
    await svc.submitBatchEvent('REC', { eventId: 'r2', type: 'batch_recorded', batchId: 'B2', quantity: 10, hours: 596.5 });
    await svc.submitBatchEvent('REC', { eventId: 'r3', type: 'batch_recorded', batchId: 'B3', quantity: 10, hours: 508.2 });
    await svc.submitBatchEvent('REC', { eventId: 'r4', type: 'batch_corrected', batchId: 'B1', hours: 815.0 });

    const fitBefore = await svc.getFit('REC');
    const projBefore = await svc.getProjection('REC');

    // 模拟重启且读模型丢失
    await getPool().query('TRUNCATE projections, parts');
    const rebuilt = await svc.rebuildProjections();
    expect(rebuilt.events).toBeGreaterThan(0);

    const fitAfter = await svc.getFit('REC');
    const projAfter = await svc.getProjection('REC');
    expect(fitAfter.t1).toBe(fitBefore.t1);
    expect(fitAfter.learningRate).toBe(fitBefore.learningRate);
    expect(fitAfter.residuals).toEqual(fitBefore.residuals);
    expect(projAfter).toEqual(projBefore);

    // 与全量回放一致
    const events = await getEventsForPart(getPool(), 'REC');
    expect(projAfter).toEqual(replayEvents('REC', events));
  });

  test('重建后改型关系（parts 表）也恢复', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'REC-PARENT' });
    await svc.createPart({ partId: 'REC-CHILD' });
    await svc.declareVariant('REC-CHILD', { parentId: 'REC-PARENT', priorLearningRate: 0.85 });

    await getPool().query('TRUNCATE projections, parts');
    await svc.rebuildProjections();

    const proj = await svc.getProjection('REC-CHILD');
    expect(proj.parentId).toBe('REC-PARENT');
    expect(proj.explicitPriorLr).toBe(0.85);
    const parts = (await svc.listParts()) as Array<{ partId: string; parentId: string | null }>;
    const child = parts.find((p) => p.partId === 'REC-CHILD');
    expect(child?.parentId).toBe('REC-PARENT');
  });
});
