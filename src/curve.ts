/**
 * 学习曲线核心模型（Wright 单件工时曲线）。
 *
 *   第 x 件工时  T(x) = T1 · x^b
 *   学习率 r ∈ (0, 1]：产量翻倍时单件工时变为原来的 r 倍
 *   斜率指数  b = log2(r) = ln(r) / ln(2) ≤ 0
 *
 * 参考值（T1=100, r=80%）：T(2)=80, T(3)≈70.21, T(4)=64, 前 4 件累计≈314.21。
 */

/** 学习率 → 斜率指数 b。b = 0 表示不学习（每件工时相同）。 */
export function slopeFromLearningRate(learningRate: number): number {
  if (!(learningRate > 0 && learningRate <= 1)) {
    throw new Error(`learning rate must be in (0, 1], got ${learningRate}`);
  }
  return Math.log(learningRate) / Math.LN2;
}

/** 斜率指数 b → 学习率。 */
export function learningRateFromSlope(b: number): number {
  return Math.pow(2, b);
}

/** 第 x 件的单件工时。 */
export function unitHours(t1: number, b: number, x: number): number {
  return t1 * Math.pow(x, b);
}

/**
 * Σ_{x=first}^{last} x^b —— 直接逐项求和（精确值，非积分近似）。
 * 支线飞机部件的累计产量量级（数百至数千件）下直接求和开销可忽略，
 * 且避免了任何近似误差，保证“无噪声数据 1e-6 还原参数”的性质。
 */
export function sumPow(b: number, first: number, last: number): number {
  let s = 0;
  for (let x = first; x <= last; x++) s += Math.pow(x, b);
  return s;
}

/** 区间 [first, last] 这一批的总工时。 */
export function batchHours(t1: number, b: number, first: number, last: number): number {
  return t1 * sumPow(b, first, last);
}

/** 前 count 件的累计工时。 */
export function cumulativeHours(t1: number, b: number, count: number): number {
  return t1 * sumPow(b, 1, count);
}
