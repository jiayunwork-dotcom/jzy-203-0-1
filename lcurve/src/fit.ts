/**
 * 学习曲线拟合。
 *
 * 方法选择（理由详见 docs/math.md）：
 *  - 在对数空间做加权最小二乘：ln(H_i/n_i) = ln T1 + b · ln x̄_i + ε_i。
 *    工时误差以乘性（百分比）为主，对数空间方差齐性，且模型线性化后
 *    有闭式解与经典置信区间。
 *  - 代表件 x̄_i 依赖未知的 b，因此对 b 做定点迭代：给定 b_k 算 x̄_i，
 *    回归得到 b_{k+1}，直至收敛。无噪声数据在真值处是精确不动点，
 *    因此能按 1e-6 精度还原参数。
 *  - 权重 w_i = n_i（批量）：若单件工时的相对误差独立同分布，批次均值的
 *    对数方差 ∝ 1/n_i，故按批量加权等价于按件加权。
 *  - 改型先验以"伪观测"注入：对 b 加一条权重 λ = K·w̄（K 为等效批数、
 *    w̄ 为平均批权重）的观测，数据信息随批数增长，先验份额自动衰减，
 *    无需显式衰减表。
 */

import { learningRateFromExponent } from './curve';
import { representativeUnitExact, representativeUnitApprox } from './representative';

export interface BatchDatum {
  batchId?: string;
  firstUnit: number;
  lastUnit: number;
  /** 批次总工时 */
  hours: number;
}

/** 学习率先验（在指数 b 空间表述） */
export interface PriorSpec {
  /** b 的先验均值 = log2(先验学习率) */
  bMean: number;
  /**
   * 先验强度：等效批数 K。先验作为一条权重 λ = K·w̄（w̄ 为本部件各批
   * 平均权重）的伪观测进入正规方程，直观含义是"母型经验相当于 K 批
   * 本部件数据的说服力"。数据信息随批数增长，先验份额 ≈ λ/(λ+数据信息)
   * 自动衰减。
   */
  equivalentBatches: number;
}

export interface FitOptions {
  /** 代表件算法：精确闭式（默认）或中点积分近似 */
  representative: 'exact' | 'approx';
  /** 加权方式：按批量（默认）或等权 */
  weighting: 'batchSize' | 'none';
  /** 残差自由度不足时假定的批次总量变异系数（用于给出保守区间） */
  assumedCv: number;
  maxIterations: number;
  tolerance: number;
}

export const DEFAULT_FIT_OPTIONS: FitOptions = {
  representative: 'exact',
  weighting: 'batchSize',
  assumedCv: 0.05,
  maxIterations: 200,
  tolerance: 1e-12,
};

/**
 * 近似代表件拟合误差的声明上界（测试据此校验，文档同步声明）。
 * 适用包络：学习率 ∈ [70%, 100%]、批量 ≤ 100、批数 ≥ 4，见 docs/math.md。
 */
export const APPROX_FIT_ERROR_BOUND = {
  /** 学习率绝对误差上界（百分点，0.01 = 1pp） */
  learningRateAbs: 0.01,
  /** 首件工时相对误差上界 */
  t1Rel: 0.05,
} as const;

export interface FitResidual {
  index: number;
  batchId?: string;
  firstUnit: number;
  lastUnit: number;
  actualHours: number;
  fittedHours: number;
  /** ln(实际/拟合)，对数空间残差 */
  logResidual: number;
}

export interface FitResult {
  t1: number;
  learningRate: number;
  b: number;
  logT1: number;
  /** (ln T1, b) 空间的协方差矩阵 */
  covariance: [[number, number], [number, number]];
  /** 对数空间残差标准差（估计值或假定值） */
  sigma: number;
  sigmaSource: 'estimated' | 'assumed';
  degreesOfFreedom: number;
  residuals: FitResidual[];
  batchesUsed: number;
  prior: null | {
    bMean: number;
    equivalentBatches: number;
    /** 先验信息占后验信息的比例 ∈ [0,1]，1 = 完全由先验决定 */
    informationShare: number;
  };
  converged: boolean;
  iterations: number;
  representative: 'exact' | 'approx';
}

/** t 分布 0.975 分位数表（自由度 1..30），超出用正态近似 */
const T_975 = [
  12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.306, 2.2622, 2.2281,
  2.201, 2.1788, 2.1604, 2.1448, 2.1314, 2.1199, 2.1098, 2.1009, 2.093, 2.086,
  2.0796, 2.0739, 2.0687, 2.0639, 2.0595, 2.0555, 2.0518, 2.0484, 2.0452, 2.0423,
];
export const Z_975 = 1.959964;

export function tQuantile975(dof: number): number {
  if (dof >= 1 && dof <= 30) return T_975[dof - 1]!;
  return Z_975;
}

/** 数据不足时返回 null（无先验至少需要 2 批，有先验至少需要 1 批）。 */
export function fitLearningCurve(
  batches: BatchDatum[],
  prior: PriorSpec | null = null,
  options: FitOptions = DEFAULT_FIT_OPTIONS,
): FitResult | null {
  const m = batches.length;
  if (m === 0) return null;
  if (m === 1 && !prior) return null;

  const n = batches.map((bt) => bt.lastUnit - bt.firstUnit + 1);
  const y = batches.map((bt, i) => Math.log(bt.hours / n[i]!));
  const w = options.weighting === 'batchSize' ? n : n.map(() => 1);
  const rep = options.representative === 'exact' ? representativeUnitExact : representativeUnitApprox;
  // 先验伪观测权重：K × 平均批权重（与数据权重同量纲）
  const wMean = w.reduce((s, wi) => s + wi, 0) / m;
  const lambda = prior ? prior.equivalentBatches * wMean : 0;
  const bPrior = prior ? prior.bMean : 0;

  // 初始 b：有先验用先验均值，否则用代数中点做一次加权回归
  let b = prior ? prior.bMean : initialSlope(batches, y, w);
  let a = 0;
  let converged = false;
  let iterations = 0;

  // 正规方程系数（含先验伪观测），2x2 闭式求解
  const solve = (z: number[]): [number, number] => {
    let sw = 0, sz = 0, szz = 0, sy = 0, szy = 0;
    for (let i = 0; i < m; i++) {
      const wi = w[i]!, zi = z[i]!, yi = y[i]!;
      sw += wi; sz += wi * zi; szz += wi * zi * zi; sy += wi * yi; szy += wi * zi * yi;
    }
    const a00 = sw, a01 = sz, a11 = szz + lambda;
    const r0 = sy, r1 = szy + lambda * bPrior;
    const det = a00 * a11 - a01 * a01;
    if (!(det > 0)) return [NaN, NaN];
    return [(r0 * a11 - r1 * a01) / det, (a00 * r1 - a01 * r0) / det];
  };

  let z = batches.map((bt) => Math.log(rep(bt.firstUnit, bt.lastUnit, b)));
  for (iterations = 1; iterations <= options.maxIterations; iterations++) {
    const [aNew, bNew] = solve(z);
    if (!isFinite(aNew) || !isFinite(bNew)) break;
    const delta = Math.abs(bNew - b) + Math.abs(aNew - a);
    a = aNew;
    b = bNew;
    z = batches.map((bt) => Math.log(rep(bt.firstUnit, bt.lastUnit, b)));
    if (delta < options.tolerance) {
      converged = true;
      break;
    }
  }
  // 用最终的 z 再解一次，保证 (a, b) 与代表件自洽
  const solved = solve(z);
  if (isFinite(solved[0]) && isFinite(solved[1])) {
    a = solved[0];
    b = solved[1];
  }

  // 残差与方差
  const residuals: FitResidual[] = batches.map((bt, i) => {
    const fittedAvg = Math.exp(a + b * z[i]!);
    const fitted = fittedAvg * n[i]!;
    return {
      index: i,
      batchId: bt.batchId,
      firstUnit: bt.firstUnit,
      lastUnit: bt.lastUnit,
      actualHours: bt.hours,
      fittedHours: fitted,
      logResidual: Math.log(bt.hours / fitted),
    };
  });
  let sse = 0;
  for (let i = 0; i < m; i++) sse += w[i]! * residuals[i]!.logResidual ** 2;

  const dof = m - 2;
  let sigma: number;
  let sigmaSource: 'estimated' | 'assumed';
  if (dof >= 1) {
    sigma = Math.sqrt(Math.max(sse, 0) / dof);
    sigmaSource = 'estimated';
  } else {
    sigma = options.assumedCv;
    sigmaSource = 'assumed';
  }

  // 协方差：σ² · (X'WX + P)^{-1}
  let sw = 0, sz = 0, szz = 0;
  for (let i = 0; i < m; i++) {
    sw += w[i]!; sz += w[i]! * z[i]!; szz += w[i]! * z[i]! * z[i]!;
  }
  const a00 = sw, a01 = sz, a11 = szz + lambda;
  const det = a00 * a11 - a01 * a01;
  const s2 = sigma * sigma;
  const covariance: [[number, number], [number, number]] = [
    [(s2 * a11) / det, (-s2 * a01) / det],
    [(-s2 * a01) / det, (s2 * a00) / det],
  ];

  // 先验信息份额：λ / (λ + 数据对 b 的信息)（同为权重单位，量纲一致）
  let informationShare = 0;
  if (prior) {
    const dataInfo = szz - (sz * sz) / sw;
    informationShare = lambda / (lambda + Math.max(dataInfo, 0));
  }

  return {
    t1: Math.exp(a),
    learningRate: learningRateFromExponent(b),
    b,
    logT1: a,
    covariance,
    sigma,
    sigmaSource,
    degreesOfFreedom: Math.max(dof, 0),
    residuals,
    batchesUsed: m,
    prior: prior
      ? { bMean: prior.bMean, equivalentBatches: prior.equivalentBatches, informationShare }
      : null,
    converged,
    iterations,
    representative: options.representative,
  };
}

/** 无先验时的初始斜率：代数中点上的加权回归 */
function initialSlope(batches: BatchDatum[], y: number[], w: number[]): number {
  const m = batches.length;
  const z0 = batches.map((bt) => Math.log((bt.firstUnit + bt.lastUnit) / 2));
  let sw = 0, sz = 0, szz = 0, sy = 0, szy = 0;
  for (let i = 0; i < m; i++) {
    sw += w[i]!; sz += w[i]! * z0[i]!; szz += w[i]! * z0[i]! ** 2; sy += y[i]! * w[i]!; szy += w[i]! * z0[i]! * y[i]!;
  }
  const denom = sw * szz - sz * sz;
  if (Math.abs(denom) < 1e-300) return Math.log(0.85) / Math.LN2;
  return (sw * szy - sz * sy) / denom;
}
