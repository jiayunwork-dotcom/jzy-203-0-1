/**
 * API / 事件溯源集成测试（需要 PostgreSQL；见 helpers.ts 的就绪策略）。
 *
 * 覆盖：录入→拟合、历史时点回推一致、件数更正区间平移、重复事件幂等、
 * 并发提交、重启恢复、改型先验、预测与对比、全部拒收规则。
 */
import { Express } from 'express';
import request from 'supertest';
import { batchHours, slopeFromLearningRate } from '../src/curve';
import { isDbAvailable, makeApp, resetDb, setup, teardown } from './helpers';

const B80 = slopeFromLearningRate(0.8);
const H = (f: number, l: number, t1 = 100, b = B80) => batchHours(t1, b, f, l);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(setup, 300000);
afterAll(teardown);
beforeEach(resetDb);

function skipIfNoDb(): boolean {
  if (!isDbAvailable()) {
    console.warn('  ↷ 跳过（无数据库）');
    return true;
  }
  return false;
}

async function createPart(app: Express, partId: string): Promise<void> {
  await request(app).post('/parts').send({ partId, name: partId }).expect(201);
}

function rec(eventId: string, batchId: string, f: number, l: number, hours: number, allowsGap = false) {
  return {
    eventId,
    type: 'record',
    batchId,
    firstUnit: f,
    lastUnit: l,
    totalHours: hours,
    ...(allowsGap ? { allowsGap: true } : {}),
  };
}

describe('健康检查', () => {
  it('GET /health', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('批次事件与拟合', () => {
  it('录入批次 → 当前拟合还原曲线参数（1e-6）', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'P1');
    await request(app).post('/parts/P1/events').send(rec('e1', 'B1', 1, 10, H(1, 10))).expect(201);
    await request(app).post('/parts/P1/events').send(rec('e2', 'B2', 11, 20, H(11, 20))).expect(201);
    await request(app).post('/parts/P1/events').send(rec('e3', 'B3', 21, 40, H(21, 40))).expect(201);
    const res = await request(app).get('/parts/P1/fit').expect(200);
    expect(Math.abs(res.body.t1 - 100) / 100).toBeLessThan(1e-6);
    expect(Math.abs(res.body.learningRate - 0.8) / 0.8).toBeLessThan(1e-6);
    expect(res.body.batchCount).toBe(3);
    expect(res.body.residuals).toHaveLength(3);
    expect(res.body.prior.active).toBe(false);
  });

  it('历史时点回推与当时在线看到的结果一致', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'P1');
    await request(app).post('/parts/P1/events').send(rec('e1', 'B1', 1, 10, H(1, 10))).expect(201);
    await request(app).post('/parts/P1/events').send(rec('e2', 'B2', 11, 20, H(11, 20))).expect(201);
    await request(app).post('/parts/P1/events').send(rec('e3', 'B3', 21, 40, H(21, 40))).expect(201);
    const online = (await request(app).get('/parts/P1/fit').expect(200)).body;
    await sleep(60);
    const tMid = new Date().toISOString();
    await sleep(60);
    // 时点之后发生：财务更正 + 新批次
    await request(app)
      .post('/parts/P1/events')
      .send({ eventId: 'e4', type: 'correct', batchId: 'B1', totalHours: H(1, 10) * 1.3 })
      .expect(201);
    await request(app).post('/parts/P1/events').send(rec('e5', 'B4', 41, 55, H(41, 55))).expect(201);
    const historical = (
      await request(app).get(`/parts/P1/fit?asOf=${encodeURIComponent(tMid)}`).expect(200)
    ).body;
    expect(historical.t1).toBe(online.t1);
    expect(historical.b).toBe(online.b);
    expect(historical.learningRate).toBe(online.learningRate);
    expect(historical.batchCount).toBe(online.batchCount);
    expect(historical.residuals).toEqual(online.residuals);
    const current = (await request(app).get('/parts/P1/fit').expect(200)).body;
    expect(current.batchCount).toBe(4);
    expect(current.t1).not.toBe(online.t1);
  });

  it('件数更正：后续批次区间整体平移，平移后拟合还原参数', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'P1');
    // B1 件数记错（记了 10 件，实际 12 件），后续批次区间整体偏 2；
    // 工时按真实曲线记录（真实位置 [1,12]、[13,22]、[23,32]）
    await request(app).post('/parts/P1/events').send(rec('e1', 'B1', 1, 10, H(1, 12))).expect(201);
    await request(app).post('/parts/P1/events').send(rec('e2', 'B2', 11, 20, H(13, 22))).expect(201);
    await request(app).post('/parts/P1/events').send(rec('e3', 'B3', 21, 30, H(23, 32))).expect(201);
    // 财务更正：B1 实为 12 件
    await request(app)
      .post('/parts/P1/events')
      .send({ eventId: 'e4', type: 'correct', batchId: 'B1', lastUnit: 12 })
      .expect(201);
    const state = (await request(app).get('/parts/P1').expect(200)).body.state;
    expect(state.batches.map((b: { firstUnit: number; lastUnit: number }) => [b.firstUnit, b.lastUnit]))
      .toEqual([[1, 12], [13, 22], [23, 32]]);
    expect(state.maxUnit).toBe(32);
    const fit = (await request(app).get('/parts/P1/fit').expect(200)).body;
    expect(Math.abs(fit.t1 - 100) / 100).toBeLessThan(1e-6);
    expect(Math.abs(fit.learningRate - 0.8) / 0.8).toBeLessThan(1e-6);
  });

  it('重复事件幂等：相同事件编号只生效一次；编号重用不同内容 → 409', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'P1');
    const ev = rec('e1', 'B1', 1, 10, H(1, 10));
    const r1 = await request(app).post('/parts/P1/events').send(ev).expect(201);
    expect(r1.body.outcome).toBe('applied');
    const r2 = await request(app).post('/parts/P1/events').send(ev).expect(200);
    expect(r2.body.outcome).toBe('duplicate');
    const events = (await request(app).get('/parts/P1/events').expect(200)).body.events;
    expect(events).toHaveLength(1);
    await request(app).post('/parts/P1/events').send({ ...ev, totalHours: 123 }).expect(409);
  });

  it('并发提交：可交换的更正/作废并发执行，最终状态与串行一致', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'P1');
    await request(app).post('/parts/P1/events').send(rec('e1', 'B1', 1, 10, H(1, 10))).expect(201);
    await request(app).post('/parts/P1/events').send(rec('e2', 'B2', 11, 20, H(11, 20))).expect(201);
    await request(app).post('/parts/P1/events').send(rec('e3', 'B3', 21, 30, H(21, 30))).expect(201);
    const results = await Promise.all([
      request(app).post('/parts/P1/events').send({ eventId: 'c1', type: 'correct', batchId: 'B1', totalHours: 911 }),
      request(app).post('/parts/P1/events').send({ eventId: 'c2', type: 'correct', batchId: 'B2', totalHours: 722 }),
      request(app).post('/parts/P1/events').send({ eventId: 'c3', type: 'void', batchId: 'B3' }),
    ]);
    for (const r of results) expect(r.status).toBe(201);
    const state = (await request(app).get('/parts/P1').expect(200)).body.state;
    const byId = Object.fromEntries(
      state.batches.map((b: { batchId: string }) => [b.batchId, b] as const),
    ) as Record<string, { totalHours: number; status: string }>;
    expect(byId.B1.totalHours).toBe(911);
    expect(byId.B2.totalHours).toBe(722);
    expect(byId.B3.status).toBe('voided');
    const events = (await request(app).get('/parts/P1/events').expect(200)).body.events;
    expect(events).toHaveLength(6);
  });

  it('并发提交：同一事件编号并发 → 只生效一次', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'P1');
    const ev = rec('dup1', 'B1', 1, 10, H(1, 10));
    const [r1, r2] = await Promise.all([
      request(app).post('/parts/P1/events').send(ev),
      request(app).post('/parts/P1/events').send(ev),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const events = (await request(app).get('/parts/P1/events').expect(200)).body.events;
    expect(events).toHaveLength(1);
  });

  it('并发提交：并发录入可串行化，被拒事件按序重试后收敛到同一终态', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'P1');
    await request(app).post('/parts/P1/events').send(rec('e1', 'B1', 1, 10, H(1, 10))).expect(201);
    const defs: [string, string, number, number][] = [
      ['e2', 'B2', 11, 20],
      ['e3', 'B3', 21, 30],
      ['e4', 'B4', 31, 40],
    ];
    // 并发录入相互依赖的批次：处理顺序不定，排在前面批次之前到达的会因空档被 409
    // 拒绝 —— 这与“按处理顺序串行执行”的结果一致（可串行化）
    const results = await Promise.all(
      defs.map(([id, batchId, f, l]) =>
        request(app).post('/parts/P1/events').send(rec(id, batchId, f, l, H(f, l))),
      ),
    );
    for (const r of results) expect([201, 409]).toContain(r.status);
    // 被应用的批次必然是从 1 开始的连续前缀（某批被应用 ⟹ 其前驱已被应用）
    const state = (await request(app).get('/parts/P1').expect(200)).body.state;
    expect(state.batches[0].firstUnit).toBe(1);
    for (let i = 1; i < state.batches.length; i++) {
      expect(state.batches[i].firstUnit).toBe(state.batches[i - 1].lastUnit + 1);
    }
    // 按原顺序重试：已应用的幂等返回 duplicate，被拒的（连续后缀）依次生效
    const outcomes: string[] = [];
    for (const [id, batchId, f, l] of defs) {
      const r = await request(app).post('/parts/P1/events').send(rec(id, batchId, f, l, H(f, l)));
      outcomes.push(r.body.outcome);
      expect([200, 201]).toContain(r.status);
    }
    // 最终状态与全部按序串行提交完全相同
    const final = (await request(app).get('/parts/P1').expect(200)).body.state;
    expect(final.batches.map((b: { batchId: string }) => b.batchId)).toEqual(['B1', 'B2', 'B3', 'B4']);
    expect(final.maxUnit).toBe(40);
    const fit = (await request(app).get('/parts/P1/fit').expect(200)).body;
    expect(Math.abs(fit.learningRate - 0.8) / 0.8).toBeLessThan(1e-6);
  });

  it('重启恢复：从事件流重建投影后，状态与拟合结果一致', async () => {
    if (skipIfNoDb()) return;
    const first = makeApp();
    await createPart(first.app, 'P1');
    await request(first.app).post('/parts/P1/events').send(rec('e1', 'B1', 1, 10, H(1, 10))).expect(201);
    await request(first.app).post('/parts/P1/events').send(rec('e2', 'B2', 11, 20, H(11, 20))).expect(201);
    await request(first.app)
      .post('/parts/P1/events')
      .send({ eventId: 'e3', type: 'correct', batchId: 'B1', lastUnit: 12 })
      .expect(201);
    await request(first.app).post('/parts/P1/events').send(rec('e4', 'B3', 23, 30, H(23, 30))).expect(201);
    const stateBefore = (await request(first.app).get('/parts/P1').expect(200)).body;
    const fitBefore = (await request(first.app).get('/parts/P1/fit').expect(200)).body;

    // 模拟重启：新的服务实例 + 从事件流重建投影
    const restarted = makeApp();
    await restarted.store.rebuildProjections();
    const stateAfter = (await request(restarted.app).get('/parts/P1').expect(200)).body;
    const fitAfter = (await request(restarted.app).get('/parts/P1/fit').expect(200)).body;

    expect(stateAfter.state).toEqual(stateBefore.state);
    expect(stateAfter.eventCount).toBe(stateBefore.eventCount);
    expect(fitAfter.t1).toBe(fitBefore.t1);
    expect(fitAfter.b).toBe(fitBefore.b);
    expect(fitAfter.learningRate).toBe(fitBefore.learningRate);
  });
});

describe('改型继承（学习率先验）', () => {
  it('少数据时向母型靠拢，数据多了以自身为主', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'BASE');
    const BP = slopeFromLearningRate(0.75);
    const parentRanges: [number, number][] = [[1, 5], [6, 15], [16, 30], [31, 60], [61, 100]];
    for (let i = 0; i < parentRanges.length; i++) {
      const [f, l] = parentRanges[i];
      await request(app)
        .post('/parts/BASE/events')
        .send(rec(`p${i}`, `PB${i}`, f, l, batchHours(200, BP, f, l)))
        .expect(201);
    }
    await createPart(app, 'VAR1');
    const BC = slopeFromLearningRate(0.95);
    await request(app)
      .post('/parts/VAR1/events')
      .send(rec('v0', 'VB0', 1, 8, batchHours(150, BC, 1, 8)))
      .expect(201);
    // 只有一批数据且未声明继承 → 422
    await request(app).get('/parts/VAR1/fit').expect(422);
    // 声明继承（跟随母型拟合值）
    await request(app).put('/parts/VAR1/inheritance').send({ parentId: 'BASE' }).expect(200);
    const fit1 = (await request(app).get('/parts/VAR1/fit').expect(200)).body;
    expect(fit1.prior.active).toBe(true);
    expect(fit1.prior.source).toBe('parent-fit');
    expect(Math.abs(fit1.learningRate - 0.75) / 0.75).toBeLessThan(1e-6);
    expect(fit1.priorShare).toBe(1);
    // 自身数据增多 → 以自身为主
    const more: [number, number][] = [[9, 20], [21, 40], [41, 70], [71, 110], [111, 160]];
    for (let i = 0; i < more.length; i++) {
      const [f, l] = more[i];
      await request(app)
        .post('/parts/VAR1/events')
        .send(rec(`v${i + 1}`, `VB${i + 1}`, f, l, batchHours(150, BC, f, l)))
        .expect(201);
    }
    const fit2 = (await request(app).get('/parts/VAR1/fit').expect(200)).body;
    expect(fit2.priorShare).toBeLessThan(0.5);
    expect(Math.abs(fit2.learningRate - 0.95)).toBeLessThan(Math.abs(fit1.learningRate - 0.95));
    expect(fit2.learningRate).toBeGreaterThan(0.85);
  });

  it('显式学习率先验 + 先验取值校验', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'BASE');
    await createPart(app, 'VAR1');
    await request(app).post('/parts/VAR1/events').send(rec('v0', 'VB0', 1, 8, 900)).expect(201);
    await request(app)
      .put('/parts/VAR1/inheritance')
      .send({ parentId: 'BASE', priorLearningRate: 0.7 })
      .expect(200);
    const fit = (await request(app).get('/parts/VAR1/fit').expect(200)).body;
    expect(fit.prior.source).toBe('explicit');
    expect(fit.learningRate).toBeCloseTo(0.7, 9);
    // 非法先验：不在 (0, 1]
    await request(app).put('/parts/VAR1/inheritance').send({ parentId: 'BASE', priorLearningRate: 1.5 }).expect(400);
    await request(app).put('/parts/VAR1/inheritance').send({ parentId: 'BASE', priorLearningRate: 0 }).expect(400);
    await request(app).put('/parts/VAR1/inheritance').send({ parentId: 'BASE', priorLearningRate: -0.3 }).expect(400);
    // 1.0 合法（不学习）
    await request(app).put('/parts/VAR1/inheritance').send({ parentId: 'BASE', priorLearningRate: 1 }).expect(200);
  });

  it('继承成环 → 409；自继承 → 400；母型不存在 → 404', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'A');
    await createPart(app, 'B');
    await createPart(app, 'C');
    await request(app).put('/parts/B/inheritance').send({ parentId: 'A' }).expect(200);
    await request(app).put('/parts/C/inheritance').send({ parentId: 'B' }).expect(200);
    await request(app).put('/parts/A/inheritance').send({ parentId: 'C' }).expect(409);
    await request(app).put('/parts/A/inheritance').send({ parentId: 'A' }).expect(400);
    await request(app).put('/parts/A/inheritance').send({ parentId: 'ZZZ' }).expect(404);
  });
});

describe('预测与对比', () => {
  it('提交交付计划并取预测（两种计划形式等价）', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'P1');
    const ranges: [number, number][] = [[1, 10], [11, 20], [21, 30], [31, 40]];
    for (let i = 0; i < ranges.length; i++) {
      const [f, l] = ranges[i];
      await request(app).post('/parts/P1/events').send(rec(`e${i}`, `B${i}`, f, l, H(f, l))).expect(201);
    }
    const pred = (
      await request(app)
        .post('/parts/P1/predictions')
        .send({ plan: { batches: [{ units: 10 }, { units: 10 }] } })
        .expect(200)
    ).body;
    expect(pred.prediction.startUnit).toBe(41);
    expect(pred.prediction.batches[0].firstUnit).toBe(41);
    expect(pred.prediction.batches[0].lastUnit).toBe(50);
    expect(pred.prediction.batches[0].hours).toBeCloseTo(H(41, 50), 4);
    expect(pred.prediction.totalHours).toBeCloseTo(H(41, 50) + H(51, 60), 4);
    expect(pred.prediction.batches[0].ci95).not.toBeNull();
    expect(pred.prediction.totalCi95).not.toBeNull();
    const pred2 = (
      await request(app)
        .post('/parts/P1/predictions')
        .send({ plan: { totalUnits: 20, batchSize: 10 } })
        .expect(200)
    ).body;
    expect(pred2.prediction.totalHours).toBeCloseTo(pred.prediction.totalHours, 8);
    await request(app).post('/parts/P1/predictions').send({ plan: { batches: [{ units: 0 }] } }).expect(400);
    await request(app).post('/parts/P1/predictions').send({ plan: { totalUnits: -5, batchSize: 10 } }).expect(400);
  });

  it('对比两个时点的拟合与预测差异', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'P1');
    const ranges: [number, number][] = [[1, 10], [11, 20], [21, 30], [31, 40]];
    for (let i = 0; i < ranges.length; i++) {
      const [f, l] = ranges[i];
      await request(app).post('/parts/P1/events').send(rec(`e${i}`, `B${i}`, f, l, H(f, l))).expect(201);
    }
    await sleep(60);
    const t0 = new Date().toISOString();
    await sleep(60);
    await request(app)
      .post('/parts/P1/events')
      .send({ eventId: 'fix1', type: 'correct', batchId: 'B0', totalHours: H(1, 10) * 1.25 })
      .expect(201);
    const cmp = (
      await request(app)
        .post('/parts/P1/compare')
        .send({ from: t0, plan: { batches: [{ units: 10 }] } })
        .expect(200)
    ).body;
    expect(cmp.from.fit.batchCount).toBe(4);
    expect(Math.abs(cmp.from.fit.t1 - 100) / 100).toBeLessThan(1e-6);
    expect(cmp.delta.t1).not.toBe(0);
    expect(cmp.delta.totalHours).not.toBeNull();
    expect(cmp.from.prediction.totalHours).not.toBe(cmp.to.prediction.totalHours);
    expect(cmp.delta.batchHours).toHaveLength(1);
  });
});

describe('拒收规则', () => {
  it('件数非正整数 / 工时不为正 / 区间重叠或空档 / 未知资源', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'P1');
    // 件数不是正整数
    await request(app).post('/parts/P1/events').send(rec('x1', 'B1', 0, 10, 100)).expect(400);
    await request(app).post('/parts/P1/events').send(rec('x2', 'B1', 1, 10.5, 100)).expect(400);
    await request(app).post('/parts/P1/events').send(rec('x3', 'B1', 10, 5, 100)).expect(400);
    // 工时不为正
    await request(app).post('/parts/P1/events').send(rec('x4', 'B1', 1, 10, 0)).expect(400);
    await request(app).post('/parts/P1/events').send(rec('x5', 'B1', 1, 10, -50)).expect(400);
    // 正常录入
    await request(app).post('/parts/P1/events').send(rec('e1', 'B1', 1, 10, H(1, 10))).expect(201);
    // 区间重叠
    await request(app).post('/parts/P1/events').send(rec('e2', 'B2', 5, 15, 100)).expect(409);
    // 空档（未标注跳号）
    await request(app).post('/parts/P1/events').send(rec('e3', 'B2', 21, 30, 100)).expect(409);
    // 标注跳号 → 接受
    await request(app).post('/parts/P1/events').send(rec('e4', 'B2', 21, 30, H(21, 30), true)).expect(201);
    // 未知部件
    await request(app).post('/parts/NOPE/events').send(rec('e5', 'B1', 1, 5, 100)).expect(404);
    await request(app).get('/parts/NOPE/fit').expect(404);
    // 未知批次更正 / 作废
    await request(app).post('/parts/P1/events').send({ eventId: 'e6', type: 'correct', batchId: 'BX', totalHours: 5 }).expect(404);
    await request(app).post('/parts/P1/events').send({ eventId: 'e7', type: 'void', batchId: 'BX' }).expect(404);
    // 更正内容为空
    await request(app).post('/parts/P1/events').send({ eventId: 'e8', type: 'correct', batchId: 'B1' }).expect(400);
    // 事件类型非法
    await request(app).post('/parts/P1/events').send({ eventId: 'e9', type: 'delete', batchId: 'B1' }).expect(400);
  });

  it('作废后区间仍占位，后续录入紧接最大件号；作废批次不参与拟合', async () => {
    if (skipIfNoDb()) return;
    const { app } = makeApp();
    await createPart(app, 'P1');
    await request(app).post('/parts/P1/events').send(rec('e1', 'B1', 1, 10, H(1, 10))).expect(201);
    await request(app).post('/parts/P1/events').send(rec('e2', 'B2', 11, 20, H(11, 20))).expect(201);
    await request(app).post('/parts/P1/events').send({ eventId: 'e3', type: 'void', batchId: 'B2' }).expect(201);
    // B2 作废但区间占位：下一批仍从 21 开始
    await request(app).post('/parts/P1/events').send(rec('e4', 'B3', 21, 30, H(21, 30))).expect(201);
    const fit = (await request(app).get('/parts/P1/fit').expect(200)).body;
    expect(fit.batchCount).toBe(2);
    expect(fit.residuals.map((r: { batchId: string }) => r.batchId)).toEqual(['B1', 'B3']);
    const state = (await request(app).get('/parts/P1').expect(200)).body.state;
    expect(state.maxUnit).toBe(30);
  });
});
