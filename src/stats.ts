/**
 * 数值统计：Lanczos 对数伽马、正则化不完全 Beta 函数、Student-t 分布，
 * 用于拟合参数与预测的置信/预测区间（t 分位数）。无第三方依赖。
 */

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(z)，Lanczos 近似（g=7, n=9），全复平面主支精度约 1e-15。 */
export function logGamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** 不完全 Beta 函数的连分式（Numerical Recipes betacf）。 */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** 正则化不完全 Beta 函数 I_x(a, b)。 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Student-t 分布 CDF（df ≥ 1）。 */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const ib = regularizedIncompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/** Student-t 分位数（CDF 的反函数，二分求解）。 */
export function tQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`p must be in (0, 1), got ${p}`);
  if (!(df >= 1)) throw new Error(`df must be >= 1, got ${df}`);
  if (p === 0.5) return 0;
  const upper = p > 0.5;
  const target = upper ? p : 1 - p;
  let lo = 0;
  let hi = 1;
  while (tCdf(hi, df) < target) hi *= 2;
  for (let i = 0; i < 120; i++) {
    const mid = 0.5 * (lo + hi);
    if (tCdf(mid, df) < target) lo = mid;
    else hi = mid;
  }
  const q = 0.5 * (lo + hi);
  return upper ? q : -q;
}
