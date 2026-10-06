/**
 * 先验合成（改型继承母型学习率）：
 * 数据少时向母型靠拢，数据多了以自身为主；1 批时学习率完全由先验决定。
 */

import { exponentFromLearningRate, sumPow } from '../../src/curve';
import { fitLearningCurve } from '../../src/fit';
import { buildPrior, DEFAULT_PRIOR_STRENGTH } from '../../src/prior';
import { genBatches } from '../helpers/gen';

const PARENT_LR = 0.8;
const OWN_LR = 0.7;

function parentLr() {
  return fitLearningCurve(genBatches(100, PARENT_LR, Array(10).fill(10)))!.learningRate;
}

const spec = { parentId: 'PARENT', priorStrength: DEFAULT_PRIOR_STRENGTH, explicitPriorLr: null };

describe('先验在少数据时的作用', () => {
  test('只有 1 批数据：学习率≈母型，首件工时由该批决定，先验信息份额≈1', () => {
    const own = genBatches(100, OWN_LR, [10]); // 来自 LR=70% 曲线的第 1..10 件
    const { prior, source } = buildPrior(parentLr(), spec);
    expect(source).toBe('parent_fit');
    const fit = fitLearningCurve(own, prior)!;
    expect(Math.abs(fit.learningRate - PARENT_LR)).toBeLessThan(1e-6);
    expect(fit.prior!.informationShare).toBeGreaterThan(0.99);
    // 首件工时 = 曲线以母型学习率穿过该批：t1 = H / Σx^b_parent
    const t1Expected = own[0]!.hours / sumPow(1, 10, exponentFromLearningRate(PARENT_LR));
    expect(Math.abs(fit.t1 / t1Expected - 1)).toBeLessThan(1e-6);
  });

  test('2 批数据：学习率被先验明显拉向母型（介于自身与母型之间）', () => {
    const own = genBatches(100, OWN_LR, [10, 10]);
    const noPrior = fitLearningCurve(own)!;
    expect(Math.abs(noPrior.learningRate - OWN_LR)).toBeLessThan(1e-6); // 无先验精确还原 70%

    const { prior } = buildPrior(parentLr(), spec);
    const withPrior = fitLearningCurve(own, prior)!;
    expect(withPrior.learningRate).toBeGreaterThan(OWN_LR + 1e-6);
    expect(withPrior.learningRate).toBeLessThan(PARENT_LR);
    // 默认 K=4 时 2 批数据的先验份额仍占主导：拟合值应明显靠近母型
    expect(Math.abs(withPrior.learningRate - PARENT_LR)).toBeLessThan(0.03);
    expect(withPrior.prior!.informationShare).toBeGreaterThan(0.5);
    expect(withPrior.prior!.informationShare).toBeLessThan(1);
  });

  test('数据增多后以自身为主，先验份额单调衰减', () => {
    const { prior } = buildPrior(parentLr(), spec);
    const fit2 = fitLearningCurve(genBatches(100, OWN_LR, [10, 10]), prior)!;
    const fit30 = fitLearningCurve(genBatches(100, OWN_LR, Array(30).fill(10)), prior)!;
    const fit100 = fitLearningCurve(genBatches(100, OWN_LR, Array(100).fill(10)), prior)!;

    // 先验份额随数据量单调下降
    expect(fit2.prior!.informationShare).toBeGreaterThan(fit30.prior!.informationShare);
    expect(fit30.prior!.informationShare).toBeGreaterThan(fit100.prior!.informationShare);
    expect(fit100.prior!.informationShare).toBeLessThan(0.05);

    // 拟合学习率单调逼近自身真值 70%
    const d2 = Math.abs(fit2.learningRate - OWN_LR);
    const d30 = Math.abs(fit30.learningRate - OWN_LR);
    const d100 = Math.abs(fit100.learningRate - OWN_LR);
    expect(d2).toBeGreaterThan(d30);
    expect(d30).toBeGreaterThan(d100);
    expect(d30).toBeLessThan(0.02);
    expect(d100).toBeLessThan(0.005);
  });
});

describe('先验来源选择', () => {
  test('母型无拟合时用显式先验值', () => {
    const { prior, source, learningRate } = buildPrior(null, { ...spec, explicitPriorLr: 0.85 });
    expect(source).toBe('explicit');
    expect(learningRate).toBe(0.85);
    expect(prior).not.toBeNull();
  });

  test('母型拟合优先于显式值', () => {
    const { source, learningRate } = buildPrior(parentLr(), { ...spec, explicitPriorLr: 0.85 });
    expect(source).toBe('parent_fit');
    expect(Math.abs(learningRate! - PARENT_LR)).toBeLessThan(1e-9);
  });

  test('两者皆无则不加先验', () => {
    const { prior, source } = buildPrior(null, spec);
    expect(source).toBe('none');
    expect(prior).toBeNull();
  });

  test('显式先验下 1 批数据即可拟合', () => {
    const own = genBatches(100, OWN_LR, [10]);
    const { prior } = buildPrior(null, { ...spec, explicitPriorLr: 0.85 });
    const fit = fitLearningCurve(own, prior)!;
    expect(Math.abs(fit.learningRate - 0.85)).toBeLessThan(1e-9);
  });
});
