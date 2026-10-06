/**
 * 曲线模型参考值与基本性质。
 */
import {
  batchHours,
  cumulativeHours,
  learningRateFromSlope,
  slopeFromLearningRate,
  sumPow,
  unitHours,
} from '../src/curve';

const B80 = slopeFromLearningRate(0.8);

describe('参考值：首件 100 小时、学习率 80%', () => {
  test('第 2 件 80 小时', () => {
    expect(unitHours(100, B80, 2)).toBeCloseTo(80, 10);
  });
  test('第 3 件约 70.21 小时', () => {
    expect(unitHours(100, B80, 3)).toBeCloseTo(70.21, 2);
  });
  test('第 4 件 64 小时', () => {
    expect(unitHours(100, B80, 4)).toBeCloseTo(64, 10);
  });
  test('前 4 件累计约 314.21 小时', () => {
    expect(cumulativeHours(100, B80, 4)).toBeCloseTo(314.21, 2);
  });
});

test('学习率与斜率指数互转（往返一致）', () => {
  for (const r of [0.5, 0.7, 0.8, 0.95, 1]) {
    expect(learningRateFromSlope(slopeFromLearningRate(r))).toBeCloseTo(r, 12);
  }
  expect(slopeFromLearningRate(1)).toBe(0);
});

test('sumPow / batchHours 与逐项计算一致', () => {
  const manual = [5, 6, 7, 8, 9].reduce((s, x) => s + Math.pow(x, B80), 0);
  expect(sumPow(B80, 5, 9)).toBeCloseTo(manual, 12);
  expect(batchHours(100, B80, 5, 9)).toBeCloseTo(100 * manual, 8);
});

test('学习率 100%（b=0）时每件工时相同', () => {
  const b = slopeFromLearningRate(1);
  for (const x of [1, 2, 7, 100]) {
    expect(unitHours(55, b, x)).toBeCloseTo(55, 12);
  }
  expect(cumulativeHours(55, b, 10)).toBeCloseTo(550, 10);
});

test('非法学习率抛错', () => {
  expect(() => slopeFromLearningRate(0)).toThrow();
  expect(() => slopeFromLearningRate(1.5)).toThrow();
  expect(() => slopeFromLearningRate(-0.2)).toThrow();
});
