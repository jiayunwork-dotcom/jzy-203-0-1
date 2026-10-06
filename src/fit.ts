/**
 * 学习曲线拟合：对数空间加权最小二乘 + 代表件不动点迭代。
 *
 * 模型：ln T(x) = α + b·ln x，α = ln T1。
 * 每批 i 给出一个观测点 (ln x̄_i, ln(H_i / m_i))，其中代表件 x̄_i 依赖 b，
 * 因此对 b 做不动点迭代：猜 b → 算代表件 → WLS 解出 (α, b) → 重复至收敛。
 *
 * 设计决策（理由详见 README）：
 *  - 对数空间拟合：工时噪声是乘性的（百分比误差），对数变换后方差稳定、
 *    模型线性化，且“工时 ×k ⇒ T1 ×k、学习率不变”的尺度不变性自然成立。
 *  - 权重 w_i = m_i（批量）：批均值 H_i/m_i 的方差 ∝ 1/m_i（乘性单元噪声假设下），
 *    故按批量加权；无噪声数据共线时任意权重都过同一条线，因此该选择
 *    不影响“批次划分无关”等精确性质。
 *  - 学习率先验：以精度 ν0 的高斯先验并入法方程（见 prior.ts / README）。
 */
import { learningRateFromSlope, sumPow } from './curve';
import { ConvergenceError, InsufficientDataError } from './errors';
import {
  approxRelativeErrorBound,
  approxRepresentativeUnit,
  MidpointMethod,
  representativeUnit,
} from './midpoint';
import { tQuantile } from './stats';

export interface BatchPoint {
  batchId: string;
  firstUnit: number;
  lastUnit: number;
  totalHours: number;
}

/** 学习率先验：b 为高斯先验均值，precision 为先验精度 ν0（与 Σw·(ln x̄ − 均值)² 同量纲）。 */
export interface PriorSpec {
  b: number;
  precision: number;
}

export interface FitOptions {
  method?: MidpointMethod;
  prior?: PriorSpec | null;
  maxIterations?: number;
  tolerance?: number;
}

export interface BatchResidual {
  batchId: string;
  firstUnit: number;
  lastUnit: number;
  units: number;
  actualHours: number;
  fittedHours: number;
  /** 对数空间残差 ln(实际批工时/拟合批工时) */
  logResidual: number;
  /** 相对残差 (实际 − 拟合) / 拟合 */
  relativeResidual: number;
}

export interface FitResult {
  method: MidpointMethod;
  batchCount: number;
  totalUnits: number;
  /** α = ln T1 */
  alpha: number;
  /** 斜率指数 b = log2(学习率) */
  b: number;
  t1: number;
  learningRate: number;
  /** 残差方差 σ²（df ≥ 1 时可用，否则为 null） */
  sigma2: number | null;
  df: number;
  /** (α, b) 的协方差矩阵（含先验精度），df ≥ 1 时可用 */
  cov: [[number, number], [number, number]] | null;
  seAlpha: number | null;
  seB: number | null;
  ci95: {
    t1: [number, number] | null;
    learningRate: [number, number] | null;
    b: [number, number] | null;
  };
  residuals: BatchResidual[];
  iterations: number;
  /** 先验在斜率后验中的份额 ν0 / (ν0 + 数据信息量)，0 表示无先验 */
  priorShare: number;
}

interface Design {
  n: number;
  W: number;
  Wx: number;
  Wy: number;
  Wxx: number;
  Wxy: number;
  xs: number[];
  ys: number[];
  ws: number[];
}

const DEFAULT_B0 = Math.log(0.8) / Math.LN2;

function buildDesign(batches: BatchPoint[], b: number, method: MidpointMethod): Design {
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  let W = 0;
  let Wx = 0;
  let Wy = 0;
  let Wxx = 0;
  let Wxy = 0;
  for (const bt of batches) {
    const m = bt.lastUnit - bt.firstUnit + 1;
    const x = Math.log(representativeUnit(bt.firstUnit, bt.lastUnit, b, method));
    const y = Math.log(bt.totalHours / m);
    const w = m;
    xs.push(x);
    ys.push(y);
    ws.push(w);
    W += w;
    Wx += w * x;
    Wy += w * y;
    Wxx += w * x * x;
    Wxy += w * x * y;
  }
  return { n: batches.length, W, Wx, Wy, Wxx, Wxy, xs, ys, ws };
}

/**
 * 解加权法方程 [W, Wx; Wx, Wxx+ν0]·(α,b)ᵀ = [Wy; Wxy+ν0·b_prior]。
 * 返回解与设计矩阵的逆（用于协方差）。
 */
function solveWls(
  d: Design,
  prior: PriorSpec | null,
): { alpha: number; b: number; inv: [[number, number], [number, number]] } {
  const P = prior?.precision ?? 0;
  const pb = P * (prior?.b ?? 0);
  const a11 = d.W;
  const a12 = d.Wx;
  const a22 = d.Wxx + P;
  const r1 = d.Wy;
  const r2 = d.Wxy + pb;
  const det = a11 * a22 - a12 * a12;
  if (!(det > 0) || !Number.isFinite(det)) {
    throw new InsufficientDataError(
      '拟合欠定：至少需要两批位置不同的数据，或一个学习率先验',
    );
  }
  const alpha = (r1 * a22 - a12 * r2) / det;
  const b = (a11 * r2 - a12 * r1) / det;
  return {
    alpha,
    b,
    inv: [
      [a22 / det, -a12 / det],
      [-a12 / det, a11 / det],
    ],
  };
}

/** 初始斜率：用近似代表件（b₀ = log2 0.8）做一次无先验 WLS。 */
function initialSlopeGuess(batches: BatchPoint[]): number {
  if (batches.length < 2) return DEFAULT_B0;
  try {
    const sol = solveWls(buildDesign(batches, DEFAULT_B0, 'approx'), null);
    return Number.isFinite(sol.b) ? sol.b : DEFAULT_B0;
  } catch {
    return DEFAULT_B0;
  }
}

/**
 * 拟合学习曲线。
 * 需要 ≥2 批数据，或 1 批数据 + 学习率先验；否则抛 InsufficientDataError。
 */
export function fitCurve(batches: BatchPoint[], options: FitOptions = {}): FitResult {
  const method = options.method ?? 'exact';
  const prior = options.prior ?? null;
  const maxIterations = options.maxIterations ?? 200;
  const tolerance = options.tolerance ?? 1e-13;

  if (batches.length === 0) {
    throw new InsufficientDataError('没有可用的批次数据');
  }
  if (batches.length === 1 && !prior) {
    throw new InsufficientDataError('只有一批数据且没有学习率先验：无法同时拟合首件工时与学习率');
  }

  // 不动点迭代：代表件依赖 b，b 又由以代表件为自变量的回归给出。
  // 除容差停止外，还检测浮点极限环（步长不再减小且已极小）——
  // 迭代映射在定点附近的浮点噪声约 1e-12，继续迭代只会在几个相邻浮点数间循环。
  let b = prior?.b ?? initialSlopeGuess(batches);
  let iterations = 0;
  let converged = false;
  let prevDelta = Infinity;
  for (iterations = 1; iterations <= maxIterations; iterations++) {
    const sol = solveWls(buildDesign(batches, b, method), prior);
    const delta = sol.b - b;
    b = sol.b;
    const absDelta = Math.abs(delta);
    if (absDelta < tolerance) {
      converged = true;
      break;
    }
    if (absDelta < 1e-9 && absDelta > prevDelta * 0.9) {
      converged = true; // 浮点极限环：已达机器精度下的不动点
      break;
    }
    prevDelta = absDelta;
  }
  if (!converged) {
    throw new ConvergenceError(`代表件迭代在 ${maxIterations} 次内未收敛`);
  }

  // 用收敛后的 b 重建设计矩阵并解出最终 (α, b)
  const d = buildDesign(batches, b, method);
  const sol = solveWls(d, prior);
  const alpha = sol.alpha;

  let rss = 0;
  for (let i = 0; i < d.n; i++) {
    const r = d.ys[i] - (alpha + b * d.xs[i]);
    rss += d.ws[i] * r * r;
  }
  const df = d.n - 2;
  const sigma2 = df >= 1 ? rss / df : null;
  const cov: [[number, number], [number, number]] | null =
    sigma2 !== null
      ? [
          [sol.inv[0][0] * sigma2, sol.inv[0][1] * sigma2],
          [sol.inv[1][0] * sigma2, sol.inv[1][1] * sigma2],
        ]
      : null;
  const seAlpha = cov ? Math.sqrt(cov[0][0]) : null;
  const seB = cov ? Math.sqrt(cov[1][1]) : null;

  let ciT1: [number, number] | null = null;
  let ciB: [number, number] | null = null;
  let ciRate: [number, number] | null = null;
  if (df >= 1 && seAlpha !== null && seB !== null) {
    const t = tQuantile(0.975, df);
    ciB = [b - t * seB, b + t * seB];
    ciRate = [learningRateFromSlope(ciB[0]), learningRateFromSlope(ciB[1])];
    ciT1 = [Math.exp(alpha - t * seAlpha), Math.exp(alpha + t * seAlpha)];
  }

  const t1 = Math.exp(alpha);
  const residuals: BatchResidual[] = batches.map((bt, i) => {
    const m = bt.lastUnit - bt.firstUnit + 1;
    const fitted = t1 * sumPow(b, bt.firstUnit, bt.lastUnit);
    return {
      batchId: bt.batchId,
      firstUnit: bt.firstUnit,
      lastUnit: bt.lastUnit,
      units: m,
      actualHours: bt.totalHours,
      fittedHours: fitted,
      logResidual: d.ys[i] - (alpha + b * d.xs[i]),
      relativeResidual: (bt.totalHours - fitted) / fitted,
    };
  });

  // 数据对斜率的信息量 I_data = Σ w·(x − x̄_w)²；先验份额 = ν0 / (ν0 + I_data)
  const iData = d.Wxx - (d.Wx * d.Wx) / d.W;
  const P = prior?.precision ?? 0;
  const priorShare = P > 0 ? P / (P + iData) : 0;

  return {
    method,
    batchCount: d.n,
    totalUnits: batches.reduce((s, bt) => s + (bt.lastUnit - bt.firstUnit + 1), 0),
    alpha,
    b,
    t1,
    learningRate: learningRateFromSlope(b),
    sigma2,
    df,
    cov,
    seAlpha,
    seB,
    ci95: { t1: ciT1, learningRate: ciRate, b: ciB },
    residuals,
    iterations,
    priorShare,
  };
}

export interface ApproxErrorBounds {
  /** 逐批代表件相对误差上界的最大值 */
  maxUnitRelativeBound: number;
  /** |Δb| 上界 */
  slopeAbsoluteBound: number;
  /** |Δα| 上界 */
  interceptAbsoluteBound: number;
  /** |ΔT1| / T1 上界 */
  t1RelativeBound: number;
  /** |Δ学习率| / 学习率 上界 */
  learningRateRelativeBound: number;
}

/**
 * 用近似代表件拟合时，参数误差的声明上界（推导见 README「近似代表件的误差上界」）。
 *
 * 设第 i 批代表件相对误差 |ε_i| ≤ B_i（approxRelativeErrorBound），
 * 则对数自变量的误差 |e_i| ≤ B_i / (1 − B_i)，且（恒等式，非一阶近似）
 *   Δb = b · Σ w·ũ·e / Σ w·ũ²,   Δα = b·ē_w − Δb·x̄_w
 * 其中 ũ 为加权中心化后的 ln x̄（近似设计矩阵）。由此得到下列可计算上界。
 */
export function approxFitErrorBounds(batches: BatchPoint[], b: number): ApproxErrorBounds {
  const infinite: ApproxErrorBounds = {
    maxUnitRelativeBound: Infinity,
    slopeAbsoluteBound: Infinity,
    interceptAbsoluteBound: Infinity,
    t1RelativeBound: Infinity,
    learningRateRelativeBound: Infinity,
  };
  const bounds = batches.map((bt) => approxRelativeErrorBound(bt.firstUnit, bt.lastUnit, b));
  const epsMax = Math.max(...bounds);
  if (!(epsMax < 1)) return { ...infinite, maxUnitRelativeBound: epsMax };
  const eMax = epsMax / (1 - epsMax);

  const xs = batches.map((bt) => Math.log(approxRepresentativeUnit(bt.firstUnit, bt.lastUnit, b)));
  const ws = batches.map((bt) => bt.lastUnit - bt.firstUnit + 1);
  const W = ws.reduce((s, w) => s + w, 0);
  const xw = xs.reduce((s, x, i) => s + ws[i] * x, 0) / W;
  let su = 0;
  let su2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const u = xs[i] - xw;
    su += ws[i] * Math.abs(u);
    su2 += ws[i] * u * u;
  }
  if (su2 === 0) return { ...infinite, maxUnitRelativeBound: epsMax };

  const leverage = su / su2;
  const slopeAbs = Math.abs(b) * leverage * eMax;
  const interceptAbs = slopeAbs * Math.abs(xw) + Math.abs(b) * eMax;
  return {
    maxUnitRelativeBound: epsMax,
    slopeAbsoluteBound: slopeAbs,
    interceptAbsoluteBound: interceptAbs,
    t1RelativeBound: Math.expm1(interceptAbs),
    learningRateRelativeBound: Math.expm1(Math.LN2 * slopeAbs),
  };
}
