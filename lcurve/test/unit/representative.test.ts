/**
 * 代表件求解：精确闭式 vs 中点积分近似。
 * 近似误差必须落在 docs/math.md 声明的 EM 上界（×安全系数）之内。
 */

import { exponentFromLearningRate, unitHours } from '../../src/curve';
import {
  approxRepUnitErrorBound,
  representativeUnitApprox,
  representativeUnitExact,
} from '../../src/representative';

const B08 = exponentFromLearningRate(0.8);

describe('精确代表件', () => {
  test('单件批的代表件就是该件', () => {
    for (const x of [1, 2, 50, 1000]) {
      expect(representativeUnitExact(x, x, B08)).toBe(x);
    }
  });

  test('[1,4] 批（LR=80%）代表件 ≈ 2.1167，使单件工时×批量=批总工时', () => {
    const xbar = representativeUnitExact(1, 4, B08);
    expect(xbar).toBeCloseTo(2.1167, 3);
    // T(x̄)·4 = 前 4 件累计 314.21
    expect(unitHours(100, B08, xbar) * 4).toBeCloseTo(314.21, 2);
  });

  test('b→0 时退化为几何平均', () => {
    const geo = Math.exp((Math.log(11) + Math.log(12) + Math.log(13)) / 3);
    expect(representativeUnitExact(11, 13, 0)).toBeCloseTo(geo, 12);
    expect(representativeUnitExact(11, 13, 1e-13)).toBeCloseTo(geo, 6);
  });
});

describe('近似代表件', () => {
  test('b→0 时近似式趋于"积分的几何平均"，与离散几何平均相差即近似误差', () => {
    const geo = Math.exp((Math.log(11) + Math.log(12) + Math.log(13)) / 3);
    const approx = representativeUnitApprox(11, 13, 0);
    // 近似式在 b→0 时是 ∫lnx 的均值，不等于离散几何平均，但误差应 < 0.1%
    expect(Math.abs(approx / geo - 1)).toBeLessThan(1e-3);
    // 且与精确式（几何平均）的偏差随批量占比缩小
    const approxWide = representativeUnitApprox(1001, 1100, 0);
    const geoWide = representativeUnitExact(1001, 1100, 0);
    expect(Math.abs(approxWide / geoWide - 1)).toBeLessThan(1e-6);
  });

  test('误差落在文档声明的 EM 上界（安全系数 2）之内', () => {
    // 扫描包络：学习率 60%~100%、批次位置 1..50、批量 1..200
    let worst = 0;
    let worstCase = '';
    for (const lr of [0.6, 0.7, 0.8, 0.9, 0.95, 1.0]) {
      const b = exponentFromLearningRate(lr);
      for (let f = 1; f <= 50; f += 7) {
        for (const n of [1, 2, 5, 10, 20, 50, 100, 200]) {
          const exact = representativeUnitExact(f, f + n - 1, b);
          const approx = representativeUnitApprox(f, f + n - 1, b);
          const relErr = Math.abs(approx / exact - 1);
          const bound = approxRepUnitErrorBound(f, f + n - 1, b);
          if (relErr > worst) {
            worst = relErr;
            worstCase = `lr=${lr} F=${f} n=${n}`;
          }
          expect(relErr).toBeLessThanOrEqual(bound);
        }
      }
    }
    // 观测最差值写入日志，供文档核对
    console.info(`approx rep-unit worst rel err = ${(worst * 100).toFixed(3)}% @ ${worstCase}`);
  });
});
