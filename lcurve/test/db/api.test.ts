/**
 * 端到端 API 测试：完整业务流程 + 各类拒收规则。
 */

import request from 'supertest';
import { closeDb, makeApp, resetDb } from '../helpers/db';
import { genBatches } from '../helpers/gen';

const app = () => makeApp();

beforeAll(resetDb);
afterAll(closeDb);

async function createPart(partId: string) {
  return request(app()).post('/parts').send({ partId });
}

async function recordBatches(partId: string, t1: number, lr: number, sizes: number[], idPrefix = 'B') {
  const batches = genBatches(t1, lr, sizes, 1, idPrefix);
  for (const b of batches) {
    const r = await request(app()).post(`/parts/${partId}/events`).send({
      eventId: `${partId}-${b.batchId}`,
      type: 'batch_recorded',
      batchId: b.batchId,
      quantity: b.lastUnit - b.firstUnit + 1,
      hours: b.hours,
    });
    expect(r.status).toBe(201);
  }
  return batches;
}

describe('完整业务流程', () => {
  test('建部件 → 录批次 → 拟合 → 预测 → 对比', async () => {
    await createPart('API-FLOW');
    const batches = await recordBatches('API-FLOW', 100, 0.8, Array(10).fill(10));

    // 拟合
    const fit = await request(app()).get('/parts/API-FLOW/fit');
    expect(fit.status).toBe(200);
    expect(fit.body.status).toBe('ok');
    expect(Math.abs(fit.body.t1 / 100 - 1)).toBeLessThan(1e-6);
    expect(Math.abs(fit.body.learningRate / 0.8 - 1)).toBeLessThan(1e-6);
    expect(fit.body.batchesUsed).toBe(10);
    expect(fit.body.residuals).toHaveLength(10);
    expect(fit.body.confidence.t1[0]).toBeLessThanOrEqual(fit.body.t1);
    expect(fit.body.confidence.t1[1]).toBeGreaterThanOrEqual(fit.body.t1);
    expect(fit.body.confidence.learningRate[0]).toBeLessThanOrEqual(fit.body.learningRate);

    // 预测
    const pred = await request(app())
      .post('/parts/API-FLOW/predictions')
      .send({ plan: [{ quantity: 10 }, { quantity: 20 }] });
    expect(pred.status).toBe(200);
    expect(pred.body.startUnit).toBe(101);
    expect(pred.body.batches[0].firstUnit).toBe(101);
    expect(pred.body.batches[1].firstUnit).toBe(111);
    expect(pred.body.total.hours).toBeCloseTo(
      pred.body.batches[0].hours + pred.body.batches[1].hours,
      6,
    );
    expect(pred.body.total.hoursLo).toBeLessThanOrEqual(pred.body.total.hours);
    expect(pred.body.total.hoursHi).toBeGreaterThanOrEqual(pred.body.total.hours);

    // 对比（前后两个时点：用事件时间戳；events[0] 是 part_registered）
    const events = await request(app()).get('/parts/API-FLOW/events');
    const t5 = events.body.events[5].recordedAt; // 第 5 批录入时刻
    const t10 = events.body.events[10].recordedAt;
    const cmp = await request(app())
      .post('/parts/API-FLOW/compare')
      .send({ from: t5, to: t10, plan: [{ quantity: 10 }] });
    expect(cmp.status).toBe(200);
    expect(cmp.body.from.batchesUsed).toBe(5);
    expect(cmp.body.to.batchesUsed).toBe(10);
    // 无噪声数据：两时点参数一致，delta≈0
    expect(Math.abs(cmp.body.delta.learningRate.abs)).toBeLessThan(1e-9);
    expect(cmp.body.predictionFrom.total.hours).toBeGreaterThan(0);
    expect(cmp.body.predictionTo.total.hours).toBeGreaterThan(0);
    void batches;
  });

  test('历史时点拟合与当时在线结果一致', async () => {
    await createPart('API-HIST');
    await recordBatches('API-HIST', 100, 0.8, Array(6).fill(10));
    const events = await request(app()).get('/parts/API-HIST/events');
    const t3 = events.body.events[3].recordedAt; // events[0] 是 part_registered

    // 当时（只有 3 批）在线看到的结果
    const liveThen = await request(app()).get('/parts/API-HIST/fit').query({ asOf: t3 });
    expect(liveThen.body.batchesUsed).toBe(3);
    // 事后用同一时点回推，必须一致
    const replay = await request(app()).get('/parts/API-HIST/fit').query({ asOf: t3 });
    expect(replay.body.t1).toBe(liveThen.body.t1);
    expect(replay.body.learningRate).toBe(liveThen.body.learningRate);
    // 与当前（6 批）不同
    const now = await request(app()).get('/parts/API-HIST/fit');
    expect(now.body.batchesUsed).toBe(6);
  });
});

describe('拒收规则', () => {
  test('件数不是正整数', async () => {
    await createPart('VAL-QTY');
    for (const quantity of [0, -1, 2.5, NaN, '10']) {
      const r = await request(app()).post('/parts/VAL-QTY/events').send({
        eventId: `v-${String(quantity)}`,
        type: 'batch_recorded',
        batchId: 'B1',
        quantity,
        hours: 100,
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('QUANTITY_NOT_POSITIVE_INTEGER');
    }
  });

  test('工时不为正', async () => {
    await createPart('VAL-HRS');
    for (const hours of [0, -5, NaN, Infinity]) {
      const r = await request(app()).post('/parts/VAL-HRS/events').send({
        eventId: `h-${String(hours)}`,
        type: 'batch_recorded',
        batchId: 'B1',
        quantity: 10,
        hours,
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('HOURS_NOT_POSITIVE');
    }
  });

  test('区间重叠与空档（跳号需显式标注）', async () => {
    await createPart('VAL-INT');
    await request(app()).post('/parts/VAL-INT/events').send({
      eventId: 'i-1', type: 'batch_recorded', batchId: 'B1', quantity: 10, hours: 800,
    });
    // 重叠
    const overlap = await request(app()).post('/parts/VAL-INT/events').send({
      eventId: 'i-2', type: 'batch_recorded', batchId: 'B2', quantity: 5, hours: 300, firstUnit: 5,
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('BATCH_OVERLAP');
    // 空档未标注
    const gap = await request(app()).post('/parts/VAL-INT/events').send({
      eventId: 'i-3', type: 'batch_recorded', batchId: 'B2', quantity: 5, hours: 300, firstUnit: 15,
    });
    expect(gap.status).toBe(409);
    expect(gap.body.error.code).toBe('BATCH_GAP');
    // 显式跳号 → 接受
    const skip = await request(app()).post('/parts/VAL-INT/events').send({
      eventId: 'i-4', type: 'batch_recorded', batchId: 'B2', quantity: 5, hours: 300,
      firstUnit: 15, allowGap: true,
    });
    expect(skip.status).toBe(201);
    const proj = await request(app()).get('/parts/VAL-INT/batches');
    expect(proj.body.batches[1].firstUnit).toBe(15);
    expect(proj.body.nextUnit).toBe(20); // [15,19] 之后
  });

  test('未知部件 / 未知批次 / 批次号复用 / 重复作废', async () => {
    const ghost = await request(app()).get('/parts/NOPE/fit');
    expect(ghost.status).toBe(404);

    await createPart('VAL-STATE');
    const noBatch = await request(app()).post('/parts/VAL-STATE/events').send({
      eventId: 's-1', type: 'batch_corrected', batchId: 'BX', hours: 5,
    });
    expect(noBatch.status).toBe(404);
    expect(noBatch.body.error.code).toBe('BATCH_NOT_FOUND');

    await request(app()).post('/parts/VAL-STATE/events').send({
      eventId: 's-2', type: 'batch_recorded', batchId: 'B1', quantity: 10, hours: 800,
    });
    const reuse = await request(app()).post('/parts/VAL-STATE/events').send({
      eventId: 's-3', type: 'batch_recorded', batchId: 'B1', quantity: 5, hours: 300,
    });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('BATCH_ID_EXISTS');

    await request(app()).post('/parts/VAL-STATE/events').send({
      eventId: 's-4', type: 'batch_voided', batchId: 'B1',
    });
    const voidAgain = await request(app()).post('/parts/VAL-STATE/events').send({
      eventId: 's-5', type: 'batch_voided', batchId: 'B1',
    });
    expect(voidAgain.status).toBe(409);
    expect(voidAgain.body.error.code).toBe('BATCH_VOIDED');
    // 作废后批次号仍不可复用
    const reuseVoided = await request(app()).post('/parts/VAL-STATE/events').send({
      eventId: 's-6', type: 'batch_recorded', batchId: 'B1', quantity: 5, hours: 300,
    });
    expect(reuseVoided.status).toBe(409);
  });

  test('空更正 / 非法事件类型 / 非法事件编号', async () => {
    await createPart('VAL-MISC');
    await request(app()).post('/parts/VAL-MISC/events').send({
      eventId: 'm-0', type: 'batch_recorded', batchId: 'B1', quantity: 10, hours: 800,
    });
    const empty = await request(app()).post('/parts/VAL-MISC/events').send({
      eventId: 'm-1', type: 'batch_corrected', batchId: 'B1',
    });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('EMPTY_CORRECTION');

    const badType = await request(app()).post('/parts/VAL-MISC/events').send({
      eventId: 'm-2', type: 'batch_exploded', batchId: 'B1',
    });
    expect(badType.status).toBe(400);

    const noId = await request(app()).post('/parts/VAL-MISC/events').send({
      type: 'batch_recorded', batchId: 'B2', quantity: 5, hours: 100,
    });
    expect(noId.status).toBe(400);
    expect(noId.body.error.code).toBe('INVALID_EVENT_ID');
  });

  test('数据不足时预测被拒', async () => {
    await createPart('VAL-INSUF');
    await request(app()).post('/parts/VAL-INSUF/events').send({
      eventId: 'u-1', type: 'batch_recorded', batchId: 'B1', quantity: 10, hours: 800,
    });
    const fit = await request(app()).get('/parts/VAL-INSUF/fit');
    expect(fit.body.status).toBe('insufficient_data');
    const pred = await request(app()).post('/parts/VAL-INSUF/predictions').send({
      plan: [{ quantity: 5 }],
    });
    expect(pred.status).toBe(409);
    expect(pred.body.error.code).toBe('INSUFFICIENT_DATA');
  });

  test('非法交付计划 / 非法时间戳', async () => {
    await createPart('VAL-PLAN');
    await recordBatches('VAL-PLAN', 100, 0.8, [10, 10]);
    const badPlan = await request(app()).post('/parts/VAL-PLAN/predictions').send({
      plan: [{ quantity: 0 }],
    });
    expect(badPlan.status).toBe(400);
    const badPlan2 = await request(app()).post('/parts/VAL-PLAN/predictions').send({ plan: [] });
    expect(badPlan2.status).toBe(400);
    const badTs = await request(app()).get('/parts/VAL-PLAN/fit').query({ asOf: 'not-a-date' });
    expect(badTs.status).toBe(400);
    expect(badTs.body.error.code).toBe('INVALID_TIMESTAMP');
  });
});
