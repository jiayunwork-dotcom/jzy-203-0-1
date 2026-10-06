/**
 * 批次“代表件”求解。
 *
 * 批次数据只有累计区间 [first, last] 与批次总工时，没有每一件的工时。
 * 代表件 x̄ 的定义：按曲线计算的这一件工时乘以批量等于整批工时，即
 *
 *   T1 · x̄^b · m = Σ_{x=first}^{last} T1 · x^b   （m = last − first + 1）
 *
 * 消去 T1 后 x̄ = ( (1/m) Σ x^b )^{1/b}，它只依赖于 b（学习率），与 T1 无关。
 *
 * 本模块提供两种实现：
 *  - exact ：给定 b 直接按定义计算（服务默认；拟合层再对 b 做不动点迭代）。
 *  - approx：把求和换成区间中点法则积分 ∫_{first-1/2}^{last+1/2} x^b dx 的闭式解，
 *            省掉逐项求和。误差有严格上界（approxRelativeErrorBound），
 *            推导见 README「近似代表件的误差上界」一节。
 */
import { sumPow } from './curve';

export type MidpointMethod = 'exact' | 'approx';

/** b → 0 时精确代表件的极限是区间上各件的几何平均。 */
function geometricMean(first: number, last: number): number {
  let s = 0;
  for (let x = first; x <= last; x++) s += Math.log(x);
  return Math.exp(s / (last - first + 1));
}

/** 精确代表件：x̄ = ( (1/m) Σ_{x=first}^{last} x^b )^{1/b}。 */
export function exactRepresentativeUnit(first: number, last: number, b: number): number {
  const m = last - first + 1;
  if (m === 1) return first;
  if (Math.abs(b) < 1e-10) return geometricMean(first, last);
  return Math.pow(sumPow(b, first, last) / m, 1 / b);
}

/**
 * 近似代表件（中点法则积分闭式）：
 *   x̄ ≈ ( (1/m) ∫_{first-1/2}^{last+1/2} x^b dx )^{1/b}
 * b → 0 的极限为 exp( (1/m) ∫ ln x dx )；b = −1 时积分为 ln。
 */
export function approxRepresentativeUnit(first: number, last: number, b: number): number {
  const m = last - first + 1;
  const lo = first - 0.5;
  const hi = last + 0.5;
  if (Math.abs(b) < 1e-10) {
    return Math.exp(((hi * Math.log(hi) - hi) - (lo * Math.log(lo) - lo)) / m);
  }
  const bp1 = b + 1;
  const integral =
    Math.abs(bp1) < 1e-10
      ? Math.log(hi / lo)
      : (Math.pow(hi, bp1) - Math.pow(lo, bp1)) / bp1;
  return Math.pow(integral / m, 1 / b);
}

export function representativeUnit(
  first: number,
  last: number,
  b: number,
  method: MidpointMethod,
): number {
  return method === 'approx'
    ? approxRepresentativeUnit(first, last, b)
    : exactRepresentativeUnit(first, last, b);
}

/**
 * 近似代表件的相对误差上界 |x̄_approx − x̄_exact| / x̄_exact。
 *
 * 推导（详见 README）：中点法则在单位区间 [x−1/2, x+1/2] 上的误差为
 * f''(ξ)/24，故 |∫ − Σ| ≤ (|b(b−1)| / 24) · Σ_x max|f''|，
 * 其中 f''(t) = b(b−1)·t^{b−2} 的最大值按 t^{b−2} 的单调性取区间端点。
 * 再由 x̄ = (S/m)^{1/b} 的误差传播 |Δx̄/x̄| ≤ |ΔS| / (|b|·S) 得到本界。
 */
export function approxRelativeErrorBound(first: number, last: number, b: number): number {
  const exponent = b - 2;
  let edgeSum = 0;
  for (let x = first; x <= last; x++) {
    const edge = exponent <= 0 ? x - 0.5 : x + 0.5;
    edgeSum += Math.pow(edge, exponent);
  }
  const sumBound = (Math.abs(b * (b - 1)) / 24) * edgeSum;
  const lo = first - 0.5;
  const hi = last + 0.5;
  const bp1 = b + 1;
  const integral =
    Math.abs(bp1) < 1e-10
      ? Math.log(hi / lo)
      : (Math.pow(hi, bp1) - Math.pow(lo, bp1)) / bp1;
  const denom = Math.max(integral - sumBound, 1e-300);
  // |Δx̄/x̄| ≤ |ΔS| / (|b|·S)。b → 0 时 |ΔS| 中的因子 |b| 与分母约去，
  // 极限为 (Σ max|x^{b-2}| / 24) / S —— 不是 0（对数积分与离散几何平均的差异）。
  if (b === 0) return edgeSum / 24 / denom;
  return sumBound / (Math.abs(b) * denom);
}
