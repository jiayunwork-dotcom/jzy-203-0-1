/**
 * 近似代表件拟合的误差上界校验。
 * 上界在 src/fit.ts 的 APPROX_FIT_ERROR_BOUND 声明，与 docs/math.md 同步；
 * 本测试在声明包络（LR ∈ [70%,100%]、批量 ≤ 100、批数 ≥ 4）内扫描验证。
 */

import {
  APPROX_FIT_ERROR_BOUND,
  DEFAULT_FIT_OPTIONS,
  fitLearningCurve,
} from '../../src/fit';
import { genBatches } from '../helpers/gen';

const APPROX_OPTS = { ...DEFAULT_FIT_OPTIONS, representative: 'approx' as const };

describe('近似式拟合误差落在声明上界内', () => {
  const cases: Array<[number, number]> = []; // [lr, batchSize]
  for (const lr of [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0]) {
    for (const size of [1, 5, 20, 100]) {
      cases.push([lr, size]);
    }
  }

  let worstLr = 0;
  let worstT1 = 0;
  let worstDesc = '';

  test.each(cases)('LR=%d 批量=%d：误差 ≤ 声明上界', (lr, size) => {
    const count = Math.max(4, Math.floor(1000 / size));
    const batches = genBatches(100, lr, Array(count).fill(size));
    const fit = fitLearningCurve(batches, null, APPROX_OPTS)!;
    const lrErr = Math.abs(fit.learningRate - lr);
    const t1Err = Math.abs(fit.t1 / 100 - 1);
    if (lrErr > worstLr || t1Err > worstT1) {
      worstLr = Math.max(worstLr, lrErr);
      worstT1 = Math.max(worstT1, t1Err);
      worstDesc = `lr=${lr} size=${size}: lrErr=${(lrErr * 100).toFixed(4)}pp t1Err=${(t1Err * 100).toFixed(3)}%`;
    }
    expect(lrErr).toBeLessThanOrEqual(APPROX_FIT_ERROR_BOUND.learningRateAbs);
    expect(t1Err).toBeLessThanOrEqual(APPROX_FIT_ERROR_BOUND.t1Rel);
  });

  afterAll(() => {
    console.info(`approx fit worst observed: ${worstDesc}`);
  });
});
