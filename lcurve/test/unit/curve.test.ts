/**
 * 参考值校验（任务书给定）：
 * 首件 100 小时、学习率 80% 时，第 2 件 80 小时，第 3 件约 70.21 小时，
 * 第 4 件 64 小时，前 4 件累计约 314.21 小时。
 */

import {
  batchHours,
  exponentFromLearningRate,
  learningRateFromExponent,
  sumPow,
  unitHours,
} from '../../src/curve';

describe('曲线模型参考值', () => {
  const b = exponentFromLearningRate(0.8);

  test('学习率与指数互转', () => {
    expect(b).toBeCloseTo(-0.321928, 6);
    expect(learningRateFromExponent(b)).toBeCloseTo(0.8, 12);
    expect(exponentFromLearningRate(1)).toBe(0);
  });

  test('单件工时：T(2)=80, T(3)≈70.21, T(4)=64', () => {
    expect(unitHours(100, b, 1)).toBeCloseTo(100, 10);
    expect(unitHours(100, b, 2)).toBeCloseTo(80, 10);
    expect(unitHours(100, b, 3)).toBeCloseTo(70.21, 2);
    expect(unitHours(100, b, 4)).toBeCloseTo(64, 10);
  });

  test('前 4 件累计约 314.21 小时', () => {
    expect(batchHours(100, b, 1, 4)).toBeCloseTo(314.21, 2);
    expect(100 * sumPow(1, 4, b)).toBeCloseTo(314.21, 2);
  });

  test('学习率 100% 时每件工时相同', () => {
    const b0 = exponentFromLearningRate(1);
    for (const x of [1, 2, 7, 100, 10000]) {
      expect(unitHours(55, b0, x)).toBeCloseTo(55, 10);
    }
    expect(batchHours(55, b0, 3, 9)).toBeCloseTo(7 * 55, 10);
  });
});
