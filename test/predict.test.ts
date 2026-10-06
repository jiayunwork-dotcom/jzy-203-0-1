/**
 * 交付计划预测：与真实曲线一致、区间行为、100% 学习率、df=0 时无区间。
 */
import { batchHours, cumulativeHours, slopeFromLearningRate } from '../src/curve';
import { BatchPoint, fitCurve } from '../src/fit';
import { predict } from '../src/predict';

const T1 = 100;
const R = 0.8;
const B = slopeFromLearningRate(R);

const batches: BatchPoint[] = ([[1, 10], [11, 20], [21, 30], [31, 40]] as [number, number][]).map(
  ([f, l], i) => ({ batchId: `B${i}`, firstUnit: f, lastUnit: l, totalHours: batchHours(T1, B, f, l) }),
);

test('基于精确拟合的预测与真实曲线一致', () => {
  const fit = fitCurve(batches);
  const p = predict(fit, 41, [{ units: 10 }, { units: 10 }]);
  expect(p.startUnit).toBe(41);
  expect(p.batches[0].firstUnit).toBe(41);
  expect(p.batches[0].lastUnit).toBe(50);
  expect(p.batches[1].firstUnit).toBe(51);
  expect(p.batches[0].hours).toBeCloseTo(batchHours(T1, B, 41, 50), 6);
  expect(p.batches[1].hours).toBeCloseTo(batchHours(T1, B, 51, 60), 6);
  expect(p.totalHours).toBeCloseTo(cumulativeHours(T1, B, 60) - cumulativeHours(T1, B, 40), 4);
  expect(p.totalUnits).toBe(20);
});

test('预测区间：df≥1 时给出且覆盖真值（无噪声时很窄）', () => {
  const fit = fitCurve(batches);
  const p = predict(fit, 41, [{ units: 10 }]);
  const ci = p.batches[0].ci95!;
  expect(ci).not.toBeNull();
  expect(ci[0]).toBeLessThanOrEqual(batchHours(T1, B, 41, 50) * (1 + 1e-9));
  expect(ci[1]).toBeGreaterThanOrEqual(batchHours(T1, B, 41, 50) * (1 - 1e-9));
  expect(p.totalCi95).not.toBeNull();
});

test('两批数据拟合（df=0）→ 无区间', () => {
  const fit = fitCurve(batches.slice(0, 2));
  const p = predict(fit, 21, [{ units: 5 }]);
  expect(p.batches[0].ci95).toBeNull();
  expect(p.totalCi95).toBeNull();
});

test('学习率 100%：剩余每件工时相同', () => {
  const flat: BatchPoint[] = ([[1, 5], [6, 15], [16, 30]] as [number, number][]).map(([f, l], i) => ({
    batchId: `F${i}`,
    firstUnit: f,
    lastUnit: l,
    totalHours: 70 * (l - f + 1),
  }));
  const fit = fitCurve(flat);
  const p = predict(fit, 31, [{ units: 4 }, { units: 6 }]);
  expect(p.batches[0].hours).toBeCloseTo(280, 6);
  expect(p.batches[1].hours).toBeCloseTo(420, 6);
  expect(p.totalHours).toBeCloseTo(700, 6);
});

test('各批工时之和等于总工时（浮点精度内）', () => {
  const fit = fitCurve(batches);
  const p = predict(fit, 41, [{ units: 7 }, { units: 13 }, { units: 30 }]);
  const sum = p.batches.reduce((s, b) => s + b.hours, 0);
  expect(Math.abs(sum - p.totalHours) / p.totalHours).toBeLessThan(1e-12);
});
