/**
 * 事件流行为：幂等、历史时点回推一致、更正/作废的回放。
 */

import { closeDb, getPool, makeApp, makeService, resetDb } from '../helpers/db';
import { getEventsForPart } from '../../src/eventStore';
import { replayEvents } from '../../src/projection';
import request from 'supertest';

beforeAll(resetDb);
afterAll(closeDb);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('重复事件幂等', () => {
  test('相同事件编号重复提交只生效一次', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'IDEM' });
    const ev = {
      eventId: 'idem-evt-1',
      type: 'batch_recorded' as const,
      batchId: 'B1',
      quantity: 10,
      hours: 800,
    };
    const r1 = await svc.submitBatchEvent('IDEM', ev);
    expect(r1.duplicate).toBe(false);
    const r2 = await svc.submitBatchEvent('IDEM', ev);
    expect(r2.duplicate).toBe(true);
    expect(r2.seq).toBe(r1.seq);
    // 更正事件重复提交同样幂等
    const c1 = await svc.submitBatchEvent('IDEM', {
      eventId: 'idem-evt-2', type: 'batch_corrected', batchId: 'B1', hours: 812.5,
    });
    const c2 = await svc.submitBatchEvent('IDEM', {
      eventId: 'idem-evt-2', type: 'batch_corrected', batchId: 'B1', hours: 812.5,
    });
    expect(c2.duplicate).toBe(true);

    const events = await svc.listEvents('IDEM');
    expect(events).toHaveLength(3); // part_registered + recorded + corrected
    const proj = await svc.getProjection('IDEM');
    expect(proj.batches).toHaveLength(1);
    expect(proj.batches[0]!.hours).toBe(812.5);
  });

  test('API 层重复提交返回 200 且不改状态', async () => {
    const app = makeApp();
    await request(app).post('/parts').send({ partId: 'IDEM-API' });
    const body = {
      eventId: 'dup-1', type: 'batch_recorded', batchId: 'B1', quantity: 5, hours: 400,
    };
    const r1 = await request(app).post('/parts/IDEM-API/events').send(body);
    const r2 = await request(app).post('/parts/IDEM-API/events').send(body);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body.duplicate).toBe(true);
    const proj = await request(app).get('/parts/IDEM-API/batches');
    expect(proj.body.batches).toHaveLength(1);
  });
});

describe('历史时点回推一致', () => {
  test('更正前后的时点回推各自等于当时在线结果', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'HIST' });
    // 三批无噪声数据（LR=80%）
    const hours = [812.30, 596.50, 508.20];
    for (let i = 0; i < 3; i++) {
      await svc.submitBatchEvent('HIST', {
        eventId: `hist-${i}`, type: 'batch_recorded', batchId: `B${i + 1}`,
        quantity: 10, hours: hours[i]!,
      });
    }
    const fitLive1 = await svc.getFit('HIST');
    const events1 = await svc.listEvents('HIST');
    const tBefore = events1[events1.length - 1]!.recordedAt;

    await sleep(5); // 保证时间戳可分（微秒精度下仍留余量）

    // 财务更正第一批工时
    await svc.submitBatchEvent('HIST', {
      eventId: 'hist-corr', type: 'batch_corrected', batchId: 'B1', hours: 820.0,
    });
    const fitLive2 = await svc.getFit('HIST');
    expect(fitLive2.t1).not.toBeCloseTo(fitLive1.t1!, 6);

    // 回推到更正前：必须与当时在线结果一致
    const fitAsOf = await svc.getFit('HIST', tBefore);
    expect(fitAsOf.t1).toBe(fitLive1.t1);
    expect(fitAsOf.learningRate).toBe(fitLive1.learningRate);
    expect(fitAsOf.residuals).toEqual(fitLive1.residuals);

    // 回推到更正后：与当前一致
    const events2 = await svc.listEvents('HIST');
    const tAfter = events2[events2.length - 1]!.recordedAt;
    const fitAsOf2 = await svc.getFit('HIST', tAfter);
    expect(fitAsOf2.t1).toBe(fitLive2.t1);
  });

  test('快照与全量回放逐字段一致', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'SNAP' });
    await svc.submitBatchEvent('SNAP', { eventId: 'k1', type: 'batch_recorded', batchId: 'B1', quantity: 10, hours: 800 });
    await svc.submitBatchEvent('SNAP', { eventId: 'k2', type: 'batch_recorded', batchId: 'B2', quantity: 15, hours: 1000 });
    await svc.submitBatchEvent('SNAP', { eventId: 'k3', type: 'batch_corrected', batchId: 'B1', quantity: 12 });
    await svc.submitBatchEvent('SNAP', { eventId: 'k4', type: 'batch_voided', batchId: 'B2' });
    await svc.submitBatchEvent('SNAP', { eventId: 'k5', type: 'batch_recorded', batchId: 'B3', quantity: 7, hours: 500 });

    const snapshot = await svc.getProjection('SNAP');
    const events = await getEventsForPart(getPool(), 'SNAP');
    const replayed = replayEvents('SNAP', events);
    expect(snapshot).toEqual(replayed);
  });
});
