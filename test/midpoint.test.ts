/**
 * 代表件求解：精确式、近似式与近似误差上界。
 */
import { slopeFromLearningRate, sumPow } from '../src/curve';
import {
  approxRelativeErrorBound,
  approxRepresentativeUnit,
  exactRepresentativeUnit,
} from '../src/midpoint';

describe('精确代表件', () => {
  test('单件批次的代表件就是该件', () => {
    expect(exactRepresentativeUnit(7, 7, -0.3)).toBe(7);
  });

  test('b=0 时退化为几何平均', () => {
    const g = Math.exp((Math.log(4) + Math.log(5) + Math.log(6) + Math.log(7) + Math.log(8)) / 5);
    expect(exactRepresentativeUnit(4, 8, 0)).toBeCloseTo(g, 12);
  });

  test('定义性质：m · x̄^b = Σ x^b', () => {
    const cases: [number, number, number][] = [
      [1, 10, -0.3],
      [3, 3, -0.5],
      [20, 45, -0.15],
      [1, 1, -0.9],
      [100, 250, -0.5146],
    ];
    for (const [a, c, b] of cases) {
      const xr = exactRepresentativeUnit(a, c, b);
      const m = c - a + 1;
      expect(m * Math.pow(xr, b)).toBeCloseTo(sumPow(b, a, c), 8);
    }
  });
});

describe('近似代表件（中点法则积分）', () => {
  test('实际误差落在声明上界之内（学习率 × 位置 × 批量网格）', () => {
    for (const r of [0.7, 0.8, 0.9, 0.97]) {
      const b = slopeFromLearningRate(r);
      for (const a of [1, 2, 5, 10, 50, 100]) {
        for (const m of [1, 2, 5, 10, 20]) {
          const exact = exactRepresentativeUnit(a, a + m - 1, b);
          const approx = approxRepresentativeUnit(a, a + m - 1, b);
          const bound = approxRelativeErrorBound(a, a + m - 1, b);
          const rel = Math.abs(approx - exact) / exact;
          expect(rel).toBeLessThanOrEqual(bound * (1 + 1e-9));
        }
      }
    }
  });

  test('b=0 时近似式收敛到连续几何平均，误差有界（约 0.2%）', () => {
    const bound = approxRelativeErrorBound(3, 9, 0);
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThan(0.01);
    const exact = exactRepresentativeUnit(3, 9, 0);
    const rel = Math.abs(approxRepresentativeUnit(3, 9, 0) - exact) / exact;
    expect(rel).toBeLessThanOrEqual(bound * (1 + 1e-9));
  });

  test('批次靠后时误差可忽略（< 1e-4）', () => {
    const b = slopeFromLearningRate(0.8);
    const exact = exactRepresentativeUnit(101, 110, b);
    const rel = Math.abs(approxRepresentativeUnit(101, 110, b) - exact) / exact;
    expect(rel).toBeLessThan(1e-4);
  });

  test('最靠前的单件批误差最大，但仍有界（r=80% 时约 6%，上界约 30%）', () => {
    const b = slopeFromLearningRate(0.8);
    const rel = Math.abs(approxRepresentativeUnit(1, 1, b) - 1);
    expect(rel).toBeGreaterThan(0.01);
    expect(rel).toBeLessThan(0.1);
    expect(rel).toBeLessThanOrEqual(approxRelativeErrorBound(1, 1, b) * (1 + 1e-9));
  });

  test('b = −1（学习率 50%）特殊情形不发散', () => {
    const b = slopeFromLearningRate(0.5);
    expect(b).toBeCloseTo(-1, 12);
    const exact = exactRepresentativeUnit(2, 5, b);
    const approx = approxRepresentativeUnit(2, 5, b);
    expect(Math.abs(approx - exact) / exact).toBeLessThanOrEqual(
      approxRelativeErrorBound(2, 5, b) * (1 + 1e-9),
    );
  });
});
