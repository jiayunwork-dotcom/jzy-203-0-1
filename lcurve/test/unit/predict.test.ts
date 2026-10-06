/**
 * 预测：无噪声时点预测精确、区间宽度≈0；含噪时真值落在区间内；
 * LR=100% 时批工时 = 件数 × 单件工时。
 */

import { exponentFromLearningRate, batchHours } from '../../src/curve';
import { fitLearningCurve } from '../../src/fit';
import { predictPlan } from '../../src/predict';
import { addMultiplicativeNoise, genBatches } from '../helpers/gen';

describe('交付计划预测', () => {
  test('无噪声拟合的预测与精确曲线一致，区间宽度≈0', () => {
    const fit = fitLearningCurve(genBatches(100, 0.8, Array(10).fill(10)))!;
    const plan = [{ quantity: 10 }, { quantity: 20 }, { quantity: 30 }];
    const pred = predictPlan(fit, 101, plan);
    const b = exponentFromLearningRate(0.8);

    expect(pred.batches[0]!.firstUnit).toBe(101);
    expect(pred.batches[0]!.lastUnit).toBe(110);
    expect(pred.batches[1]!.firstUnit).toBe(111);
    expect(pred.batches[2]!.lastUnit).toBe(160);

    const exact0 = batchHours(100, b, 101, 110);
    const exact1 = batchHours(100, b, 111, 130);
    const exact2 = batchHours(100, b, 131, 160);
    expect(Math.abs(pred.batches[0]!.hours / exact0 - 1)).toBeLessThan(1e-9);
    expect(Math.abs(pred.batches[1]!.hours / exact1 - 1)).toBeLessThan(1e-9);
    expect(Math.abs(pred.batches[2]!.hours / exact2 - 1)).toBeLessThan(1e-9);
    expect(Math.abs(pred.total.hours / (exact0 + exact1 + exact2) - 1)).toBeLessThan(1e-9);

    // 无噪声 → 区间退化为点
    expect(pred.total.hoursHi / pred.total.hours - 1).toBeLessThan(1e-6);
    expect(1 - pred.total.hoursLo / pred.total.hours).toBeLessThan(1e-6);
  });

  test('LR=100%：批工时 = 件数 × 单件工时', () => {
    const fit = fitLearningCurve(genBatches(250, 1.0, Array(8).fill(5)))!;
    const pred = predictPlan(fit, 41, [{ quantity: 7 }, { quantity: 13 }]);
    expect(pred.batches[0]!.hours).toBeCloseTo(7 * 250, 6);
    expect(pred.batches[1]!.hours).toBeCloseTo(13 * 250, 6);
    expect(pred.total.hours).toBeCloseTo(20 * 250, 6);
  });

  test('含噪拟合的预测区间覆盖真值', () => {
    const noisy = addMultiplicativeNoise(genBatches(100, 0.8, Array(12).fill(10)), 0.05, 11);
    const fit = fitLearningCurve(noisy)!;
    const pred = predictPlan(fit, 121, [{ quantity: 10 }, { quantity: 10 }]);
    const b = exponentFromLearningRate(0.8);
    const exactTotal = batchHours(100, b, 121, 140);
    expect(exactTotal).toBeGreaterThan(pred.total.hoursLo);
    expect(exactTotal).toBeLessThan(pred.total.hoursHi);
    // 区间应有一定宽度（含不确定性），但不至于离谱
    expect(pred.total.hoursHi / pred.total.hoursLo).toBeGreaterThan(1.001);
    expect(pred.total.hoursHi / pred.total.hoursLo).toBeLessThan(1.5);
  });
});
