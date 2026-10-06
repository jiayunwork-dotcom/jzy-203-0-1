/**
 * 拟合：无噪声还原（精确/近似代表件）、批次划分无关、缩放不变性、
 * 100% 学习率、吻合数据不改参数、数据不足、置信区间与残差。
 */
import { batchHours, slopeFromLearningRate } from '../src/curve';
import { InsufficientDataError } from '../src/errors';
import { approxFitErrorBounds, BatchPoint, fitCurve } from '../src/fit';

const T1 = 137.5;
const R = 0.83;
const B = slopeFromLearningRate(R);

function exactBatches(ranges: [number, number][], t1 = T1, b = B): BatchPoint[] {
  return ranges.map(([f, l], i) => ({
    batchId: `B${i + 1}`,
    firstUnit: f,
    lastUnit: l,
    totalHours: batchHours(t1, b, f, l),
  }));
}

const RANGES: [number, number][] = [[1, 4], [5, 12], [13, 30], [31, 60], [61, 100]];

describe('无噪声数据参数还原', () => {
  test('精确代表件：参数在 1e-6 相对误差内还原（实际远优于）', () => {
    const fit = fitCurve(exactBatches(RANGES));
    expect(Math.abs(fit.t1 - T1) / T1).toBeLessThan(1e-6);
    expect(Math.abs(fit.learningRate - R) / R).toBeLessThan(1e-6);
    expect(Math.abs(fit.t1 - T1) / T1).toBeLessThan(1e-9);
    expect(Math.abs(fit.b - B)).toBeLessThan(1e-9);
  });

  test('近似代表件：参数误差落在文档声明的上界之内', () => {
    const batches = exactBatches(RANGES);
    const fit = fitCurve(batches, { method: 'approx' });
    const bounds = approxFitErrorBounds(batches, B);
    expect(Math.abs(fit.b - B)).toBeLessThanOrEqual(bounds.slopeAbsoluteBound);
    expect(Math.abs(fit.t1 - T1) / T1).toBeLessThanOrEqual(bounds.t1RelativeBound);
    expect(Math.abs(fit.learningRate - R) / R).toBeLessThanOrEqual(bounds.learningRateRelativeBound);
    // 上界本身应足够紧才有意义：含早期批次时量级为百分之几
    expect(bounds.learningRateRelativeBound).toBeLessThan(0.05);
    expect(bounds.learningRateRelativeBound).toBeGreaterThan(1e-6);
  });

  test('近似代表件：批次靠后时上界很小', () => {
    const late: [number, number][] = [[501, 520], [521, 540], [541, 560], [561, 580]];
    const batches = exactBatches(late);
    const bounds = approxFitErrorBounds(batches, B);
    expect(bounds.learningRateRelativeBound).toBeLessThan(1e-3);
    const fit = fitCurve(batches, { method: 'approx' });
    expect(Math.abs(fit.learningRate - R) / R).toBeLessThanOrEqual(bounds.learningRateRelativeBound);
    expect(Math.abs(fit.learningRate - R) / R).toBeLessThan(1e-4);
  });

  test('两批数据也能还原（不动点），但无置信区间（df=0）', () => {
    const fit = fitCurve(exactBatches([[1, 10], [11, 30]]));
    expect(Math.abs(fit.learningRate - R) / R).toBeLessThan(1e-9);
    expect(Math.abs(fit.t1 - T1) / T1).toBeLessThan(1e-9);
    expect(fit.ci95.t1).toBeNull();
    expect(fit.ci95.learningRate).toBeNull();
  });
});

describe('拟合性质', () => {
  test('批次划分无关：同一曲线的不同分批给出相同参数', () => {
    const fa = fitCurve(exactBatches([[1, 4], [5, 12], [13, 30], [31, 60]]));
    const fb = fitCurve(exactBatches([[1, 10], [11, 25], [26, 45], [46, 60]]));
    const fc = fitCurve(exactBatches([[1, 20], [21, 40], [41, 60]]));
    for (const f of [fb, fc]) {
      expect(Math.abs(f.t1 - fa.t1) / fa.t1).toBeLessThan(1e-9);
      expect(Math.abs(f.b - fa.b)).toBeLessThan(1e-9);
    }
  });

  test('缩放：工时 ×k → T1 ×k，学习率不变', () => {
    const k = 17.3;
    const base = fitCurve(exactBatches(RANGES));
    const scaled = fitCurve(exactBatches(RANGES).map((b) => ({ ...b, totalHours: b.totalHours * k })));
    expect(Math.abs(scaled.t1 - base.t1 * k) / (base.t1 * k)).toBeLessThan(1e-12);
    expect(Math.abs(scaled.b - base.b)).toBeLessThan(1e-12);
    expect(Math.abs(scaled.learningRate - base.learningRate)).toBeLessThan(1e-12);
  });

  test('学习率 100%：每件工时相同，b=0', () => {
    const t1 = 88;
    const fit = fitCurve(exactBatches([[1, 6], [7, 20], [21, 50]], t1, 0));
    expect(Math.abs(fit.b)).toBeLessThan(1e-9);
    expect(fit.learningRate).toBeCloseTo(1, 9);
    expect(Math.abs(fit.t1 - t1) / t1).toBeLessThan(1e-9);
  });

  test('追加与曲线完全吻合的批次，参数不变', () => {
    const f4 = fitCurve(exactBatches(RANGES.slice(0, 4)));
    const f5 = fitCurve(exactBatches(RANGES));
    expect(Math.abs(f5.t1 - f4.t1) / f4.t1).toBeLessThan(1e-9);
    expect(Math.abs(f5.b - f4.b)).toBeLessThan(1e-9);
  });

  test('数据不足：空数据或单批无先验 → 抛错', () => {
    expect(() => fitCurve([])).toThrow(InsufficientDataError);
    expect(() => fitCurve(exactBatches([[1, 10]]))).toThrow(InsufficientDataError);
  });

  test('置信区间：df≥1 时给出且覆盖真值（无噪声时退化为点）', () => {
    const fit = fitCurve(exactBatches(RANGES)); // n=5, df=3
    expect(fit.df).toBe(3);
    const [loT, hiT] = fit.ci95.t1!;
    expect(loT).toBeLessThanOrEqual(T1 * (1 + 1e-9));
    expect(hiT).toBeGreaterThanOrEqual(T1 * (1 - 1e-9));
    const [loR, hiR] = fit.ci95.learningRate!;
    expect(loR).toBeLessThanOrEqual(R * (1 + 1e-9));
    expect(hiR).toBeGreaterThanOrEqual(R * (1 - 1e-9));
  });

  test('残差：无噪声数据残差≈0，每批一条', () => {
    const fit = fitCurve(exactBatches(RANGES));
    expect(fit.residuals).toHaveLength(RANGES.length);
    for (const r of fit.residuals) {
      expect(Math.abs(r.logResidual)).toBeLessThan(1e-8);
      expect(Math.abs(r.relativeResidual)).toBeLessThan(1e-8);
      expect(r.fittedHours).toBeCloseTo(r.actualHours, 6);
    }
  });

  test('带噪声数据：σ²>0，区间宽度为正且覆盖真值', () => {
    const noisy = exactBatches(RANGES.concat([[101, 150], [151, 210], [211, 280]])).map((b, i) => ({
      ...b,
      totalHours: b.totalHours * (1 + (i % 2 === 0 ? 0.03 : -0.03)),
    }));
    const fit = fitCurve(noisy);
    expect(fit.sigma2).toBeGreaterThan(0);
    const [lo, hi] = fit.ci95.learningRate!;
    expect(hi - lo).toBeGreaterThan(0);
    expect(lo).toBeLessThan(R);
    expect(hi).toBeGreaterThan(R);
    const [loT, hiT] = fit.ci95.t1!;
    expect(loT).toBeLessThan(T1);
    expect(hiT).toBeGreaterThan(T1);
  });
});
