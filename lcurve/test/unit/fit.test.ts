/**
 * 拟合性质测试（精确代表件）：
 * 无噪声还原、批次划分无关、缩放、100% 学习率、吻合数据不改参数、
 * 残差与置信区间、数据不足的处理。
 */

import { fitLearningCurve, DEFAULT_FIT_OPTIONS } from '../../src/fit';
import { addMultiplicativeNoise, genBatches } from '../helpers/gen';

const REL = 1e-6;

describe('无噪声数据还原参数（精确代表件）', () => {
  test('10×10 批，T1=100, LR=80% → 1e-6 相对误差内还原', () => {
    const fit = fitLearningCurve(genBatches(100, 0.8, Array(10).fill(10)))!;
    expect(fit.converged).toBe(true);
    expect(Math.abs(fit.t1 / 100 - 1)).toBeLessThan(REL);
    expect(Math.abs(fit.learningRate / 0.8 - 1)).toBeLessThan(REL);
  });

  test('不同学习率与首件的组合都能还原', () => {
    for (const [t1, lr] of [[100, 0.8], [500, 0.7], [25, 0.9], [1000, 0.95], [80, 0.65]] as const) {
      const fit = fitLearningCurve(genBatches(t1, lr, [5, 8, 12, 20, 30, 25]))!;
      expect(Math.abs(fit.t1 / t1 - 1)).toBeLessThan(REL);
      expect(Math.abs(fit.learningRate / lr - 1)).toBeLessThan(REL);
    }
  });

  test('残差≈0，置信区间宽度≈0', () => {
    const fit = fitLearningCurve(genBatches(100, 0.8, Array(10).fill(10)))!;
    for (const r of fit.residuals) expect(Math.abs(r.logResidual)).toBeLessThan(1e-9);
    expect(fit.sigma).toBeLessThan(1e-9);
    expect(fit.sigmaSource).toBe('estimated');
  });
});

describe('批次划分无关性', () => {
  test('同一曲线的不同划分给出相同参数', () => {
    const partitions = [
      Array(20).fill(5),
      Array(10).fill(10),
      Array(5).fill(20),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 10],
      Array(100).fill(1),
      [100],
    ];
    const fits = partitions.map((p) => fitLearningCurve(genBatches(100, 0.8, p))!);
    // 单批（[100]）无法独立拟合，跳过
    const valid = fits.filter((f) => f !== null);
    expect(valid.length).toBe(partitions.length - 1);
    for (const f of valid) {
      expect(Math.abs(f.t1 / 100 - 1)).toBeLessThan(REL);
      expect(Math.abs(f.learningRate / 0.8 - 1)).toBeLessThan(REL);
    }
  });
});

describe('缩放性质', () => {
  test('所有工时 × k：学习率不变、首件工时 × k', () => {
    const k = 3.7;
    const base = genBatches(100, 0.8, Array(10).fill(10));
    const scaled = base.map((b) => ({ ...b, hours: b.hours * k }));
    const f0 = fitLearningCurve(base)!;
    const f1 = fitLearningCurve(scaled)!;
    expect(Math.abs(f1.learningRate - f0.learningRate)).toBeLessThan(1e-9);
    expect(Math.abs(f1.t1 / (f0.t1 * k) - 1)).toBeLessThan(1e-9);
  });
});

describe('学习率 100%', () => {
  test('拟合出 b≈0、LR≈1，首件工时精确', () => {
    const fit = fitLearningCurve(genBatches(250, 1.0, Array(8).fill(5)))!;
    expect(Math.abs(fit.b)).toBeLessThan(1e-9);
    expect(Math.abs(fit.learningRate - 1)).toBeLessThan(1e-9);
    expect(Math.abs(fit.t1 / 250 - 1)).toBeLessThan(REL);
  });
});

describe('追加吻合数据不改参数', () => {
  test('拟合 5 批后再追加同一曲线的 5 批，参数不变', () => {
    const all = genBatches(100, 0.8, Array(10).fill(10));
    const f5 = fitLearningCurve(all.slice(0, 5))!;
    const f10 = fitLearningCurve(all)!;
    expect(Math.abs(f10.t1 - f5.t1)).toBeLessThan(1e-9);
    expect(Math.abs(f10.learningRate - f5.learningRate)).toBeLessThan(1e-9);
  });
});

describe('数据不足与边界', () => {
  test('无先验时 1 批数据不可拟合', () => {
    expect(fitLearningCurve(genBatches(100, 0.8, [10]))).toBeNull();
    expect(fitLearningCurve([])).toBeNull();
  });

  test('2 批数据可拟合但残差自由度为 0，sigma 用假定值', () => {
    const fit = fitLearningCurve(genBatches(100, 0.8, [10, 10]))!;
    expect(Math.abs(fit.learningRate / 0.8 - 1)).toBeLessThan(REL);
    expect(fit.degreesOfFreedom).toBe(0);
    expect(fit.sigmaSource).toBe('assumed');
    expect(fit.sigma).toBe(DEFAULT_FIT_OPTIONS.assumedCv);
  });
});

describe('含噪数据', () => {
  test('5% 乘性噪声下参数接近真值，且真值落在 95% 置信区间内', () => {
    const noisy = addMultiplicativeNoise(genBatches(100, 0.8, Array(12).fill(10)), 0.05, 7);
    const fit = fitLearningCurve(noisy)!;
    expect(Math.abs(fit.learningRate - 0.8)).toBeLessThan(0.03);
    expect(Math.abs(fit.t1 / 100 - 1)).toBeLessThan(0.15);
    // 置信区间覆盖真值（固定种子，确定性）
    const sdB = Math.sqrt(fit.covariance[1][1]);
    const sdA = Math.sqrt(fit.covariance[0][0]);
    expect(Math.abs(fit.b - Math.log2(0.8))).toBeLessThan(3 * sdB);
    expect(Math.abs(fit.logT1 - Math.log(100))).toBeLessThan(3 * sdA);
  });
});
