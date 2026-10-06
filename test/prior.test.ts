/**
 * 学习率先验的合成：少数据时由先验主导、数据增多后衰减到以自身为主。
 */
import { batchHours, slopeFromLearningRate } from '../src/curve';
import { BatchPoint, fitCurve } from '../src/fit';
import { exactRepresentativeUnit } from '../src/midpoint';
import { wouldCreateCycle } from '../src/prior';

const PARENT_T1 = 200;
const PARENT_R = 0.75;
const CHILD_T1 = 150;
const CHILD_R = 0.95;
const BP = slopeFromLearningRate(PARENT_R);
const BC = slopeFromLearningRate(CHILD_R);

function parentBatches(): BatchPoint[] {
  const ranges: [number, number][] = [[1, 5], [6, 15], [16, 30], [31, 60], [61, 100]];
  return ranges.map(([f, l], i) => ({
    batchId: `P${i}`,
    firstUnit: f,
    lastUnit: l,
    totalHours: batchHours(PARENT_T1, BP, f, l),
  }));
}

function childBatch(f: number, l: number, id: string): BatchPoint {
  return { batchId: id, firstUnit: f, lastUnit: l, totalHours: batchHours(CHILD_T1, BC, f, l) };
}

test('只有一批数据时：学习率完全由先验决定，T1 由自身数据决定', () => {
  const parentFit = fitCurve(parentBatches());
  const prior = { b: parentFit.b, precision: 8 };
  const own = childBatch(1, 8, 'C1');
  const fit = fitCurve([own], { prior });
  expect(fit.b).toBeCloseTo(parentFit.b, 12);
  expect(fit.learningRate).toBeCloseTo(PARENT_R, 6);
  expect(fit.priorShare).toBe(1);
  // T1：用先验斜率 + 自身数据点手工核算
  const xr = exactRepresentativeUnit(1, 8, parentFit.b);
  const expectedT1 = own.totalHours / 8 / Math.pow(xr, parentFit.b);
  expect(fit.t1).toBeCloseTo(expectedT1, 8);
});

test('两批数据：拟合率严格介于自身与先验之间，且明显偏向先验', () => {
  const parentFit = fitCurve(parentBatches());
  const prior = { b: parentFit.b, precision: 8 };
  const batches = [childBatch(1, 8, 'C1'), childBatch(9, 20, 'C2')];
  const ownOnly = fitCurve(batches);
  expect(Math.abs(ownOnly.learningRate - CHILD_R)).toBeLessThan(1e-9);
  const blended = fitCurve(batches, { prior });
  expect(blended.priorShare).toBeGreaterThan(0.4);
  expect(blended.priorShare).toBeLessThan(1);
  expect(blended.learningRate).toBeGreaterThan(PARENT_R);
  expect(blended.learningRate).toBeLessThan(ownOnly.learningRate);
});

test('数据增多：先验份额单调衰减，拟合率向自身学习率靠拢', () => {
  const parentFit = fitCurve(parentBatches());
  const prior = { b: parentFit.b, precision: 8 };
  const all = [
    childBatch(1, 8, 'C1'),
    childBatch(9, 20, 'C2'),
    childBatch(21, 40, 'C3'),
    childBatch(41, 70, 'C4'),
    childBatch(71, 110, 'C5'),
    childBatch(111, 160, 'C6'),
  ];
  const shares: number[] = [];
  const rates: number[] = [];
  for (let n = 2; n <= all.length; n++) {
    const f = fitCurve(all.slice(0, n), { prior });
    shares.push(f.priorShare);
    rates.push(f.learningRate);
  }
  for (let i = 1; i < shares.length; i++) {
    expect(shares[i]).toBeLessThan(shares[i - 1]);
  }
  expect(Math.abs(rates[rates.length - 1] - CHILD_R)).toBeLessThan(Math.abs(rates[0] - CHILD_R));
  expect(rates[rates.length - 1]).toBeGreaterThan(PARENT_R + 0.1);
});

test('显式先验值：单批数据时学习率等于先验', () => {
  const fit = fitCurve([childBatch(1, 8, 'C1')], {
    prior: { b: slopeFromLearningRate(0.7), precision: 8 },
  });
  expect(fit.learningRate).toBeCloseTo(0.7, 12);
});

test('先验强度为 0 等价于无先验', () => {
  const batches = [childBatch(1, 8, 'C1'), childBatch(9, 20, 'C2')];
  const noPrior = fitCurve(batches);
  const zeroPrior = fitCurve(batches, { prior: { b: slopeFromLearningRate(0.6), precision: 0 } });
  expect(zeroPrior.b).toBeCloseTo(noPrior.b, 12);
  expect(zeroPrior.priorShare).toBe(0);
});

test('继承成环检测', () => {
  const edges = new Map<string, string>([
    ['B', 'A'],
    ['C', 'B'],
  ]);
  expect(wouldCreateCycle(edges, 'A', 'C')).toBe(true); // A→C→B→A
  expect(wouldCreateCycle(edges, 'D', 'C')).toBe(false); // D→C→B→A 无环
  expect(wouldCreateCycle(edges, 'A', 'A')).toBe(true); // 自继承
  expect(wouldCreateCycle(new Map(), 'X', 'Y')).toBe(false);
});
