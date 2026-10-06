/**
 * 单件工时学习曲线（Wright 模型）：
 *   第 x 件工时 T(x) = T1 · x^b，其中 b = log2(学习率) ≤ 0。
 * 学习率 LR：产量翻倍时单件工时变为原来的比例，LR = 2^b。
 */

export const LN2 = Math.LN2;

/** 学习率 → 指数 b（LR=0.8 → b≈-0.3219；LR=1 → b=0） */
export function exponentFromLearningRate(lr: number): number {
  return Math.log(lr) / LN2;
}

/** 指数 b → 学习率 */
export function learningRateFromExponent(b: number): number {
  return Math.pow(2, b);
}

/** 第 x 件的单件工时 */
export function unitHours(t1: number, b: number, x: number): number {
  return t1 * Math.pow(x, b);
}

/** Σ_{x=first}^{last} x^b —— 精确逐项求和（件数在万件级以内性能无虞） */
export function sumPow(first: number, last: number, b: number): number {
  let s = 0;
  for (let x = first; x <= last; x++) s += Math.pow(x, b);
  return s;
}

/** Σ_{x=first}^{last} x^b · ln(x)，预测区间对 b 求导用 */
export function sumPowLnX(first: number, last: number, b: number): number {
  let s = 0;
  for (let x = first; x <= last; x++) {
    s += Math.pow(x, b) * Math.log(x);
  }
  return s;
}

/** 区间 [first, last] 的累计工时（一批的总工时） */
export function batchHours(t1: number, b: number, first: number, last: number): number {
  return t1 * sumPow(first, last, b);
}
