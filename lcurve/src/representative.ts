/**
 * 批次代表件（lot midpoint）求解。
 *
 * 批次数据只有区间 [F, L] 和批次总工时 H，拟合需要为每批找一个代表件 x̄，
 * 使 T(x̄) · n = H（n = L-F+1 为批量）。由于 T1 在等式两边约去，
 * 给定指数 b 时代表件有闭式精确解，无需迭代求根：
 *
 *   精确式：x̄ = ( (1/n) · Σ_{x=F}^{L} x^b )^{1/b}
 *   b → 0 的极限为几何平均：x̄ → exp( (1/n) Σ ln x )
 *
 * 近似式（Euler–Maclaurin 中点积分，把离散求和换成区间 [F-½, L+½] 上的积分）：
 *   x̄ ≈ [ ((L+½)^{b+1} − (F−½)^{b+1}) / ((b+1)·n) ]^{1/b}
 *
 * 近似误差（一阶 EM 修正，b 恰好约去）：
 *   ε ≈ (hi^{b−1} − lo^{b−1}) / (24 · ∫) ，hi=L+½, lo=F−½
 * 批量越大、批次越靠前（F 小、曲线陡），误差越大；详见 docs/math.md。
 */

import { sumPow } from './curve';

const B_EPS = 1e-10;

/** 精确代表件（闭式）。 */
export function representativeUnitExact(first: number, last: number, b: number): number {
  const n = last - first + 1;
  if (n === 1) return first;
  if (Math.abs(b) < B_EPS) {
    // b → 0：几何平均
    let s = 0;
    for (let x = first; x <= last; x++) s += Math.log(x);
    return Math.exp(s / n);
  }
  return Math.pow(sumPow(first, last, b) / n, 1 / b);
}

/** 近似代表件（中点积分式）。 */
export function representativeUnitApprox(first: number, last: number, b: number): number {
  const n = last - first + 1;
  const lo = first - 0.5;
  const hi = last + 0.5;
  if (Math.abs(b) < 1e-8) {
    // b → 0：∫ ln x dx = x·ln x − x
    const intLn = hi * Math.log(hi) - hi - (lo * Math.log(lo) - lo);
    return Math.exp(intLn / n);
  }
  if (Math.abs(b + 1) < 1e-8) {
    // b → -1：∫ x^{-1} dx = ln x
    return Math.pow(Math.log(hi / lo) / n, 1 / b);
  }
  const mean = (Math.pow(hi, b + 1) - Math.pow(lo, b + 1)) / ((b + 1) * n);
  return Math.pow(mean, 1 / b);
}

/**
 * 近似代表件相对误差的理论上界（EM 一阶项 × 安全系数）。
 * 用于文档声明与测试校验，见 docs/math.md。
 */
export function approxRepUnitErrorBound(
  first: number,
  last: number,
  b: number,
  safetyFactor = 2,
): number {
  const lo = first - 0.5;
  const hi = last + 0.5;
  let integral: number;
  if (Math.abs(b + 1) < 1e-8) {
    integral = Math.log(hi / lo);
  } else {
    integral = (Math.pow(hi, b + 1) - Math.pow(lo, b + 1)) / (b + 1);
  }
  const corr = (Math.pow(hi, b - 1) - Math.pow(lo, b - 1)) / (24 * integral);
  return Math.abs(corr) * safetyFactor;
}
