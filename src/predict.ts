/**
 * 交付计划预测：给定剩余计划（分批量），预测每批工时与完工总工时及区间。
 *
 * 每批工时 = T1 · Σ_{x=first}^{last} x^b（精确求和，不用积分近似）。
 * 区间：对数空间 delta 法。logH = α + ln S(b)，对 (α, b) 的梯度
 * g = (1, Σx^b·ln x / Σx^b)，预测方差 = gᵀΣg + σ²（含残差方差，即预测区间
 * 而非仅参数置信区间），再乘 t_{0.975, df} 后取指数。总工时的区间按整个
 * 剩余区间整体计算（正确计入各批间由参数不确定性引起的相关性）。
 */
import { sumPow } from './curve';
import { FitResult } from './fit';
import { tQuantile } from './stats';

export interface PlanBatch {
  units: number;
}

export interface BatchPrediction {
  index: number;
  firstUnit: number;
  lastUnit: number;
  units: number;
  hours: number;
  ci95: [number, number] | null;
}

export interface PredictionResult {
  /** 预测起点（当前最大件号 + 1） */
  startUnit: number;
  batches: BatchPrediction[];
  totalUnits: number;
  totalHours: number;
  totalCi95: [number, number] | null;
}

function predictRange(
  fit: FitResult,
  first: number,
  last: number,
): { hours: number; ci95: [number, number] | null } {
  const S = sumPow(fit.b, first, last);
  const logH = fit.alpha + Math.log(S);
  const hours = Math.exp(logH);
  let ci95: [number, number] | null = null;
  if (fit.df >= 1 && fit.sigma2 !== null && fit.cov !== null) {
    let slnx = 0;
    for (let x = first; x <= last; x++) slnx += Math.pow(x, fit.b) * Math.log(x);
    const g0 = 1;
    const g1 = slnx / S;
    const [[c00, c01], [c10, c11]] = fit.cov;
    const varMean = g0 * g0 * c00 + g0 * g1 * (c01 + c10) + g1 * g1 * c11;
    const varPred = Math.max(varMean + fit.sigma2, 0);
    const half = tQuantile(0.975, fit.df) * Math.sqrt(varPred);
    ci95 = [Math.exp(logH - half), Math.exp(logH + half)];
  }
  return { hours, ci95 };
}

/** 从 startUnit 起按计划逐批预测；总区间按整个剩余区间一次性计算。 */
export function predict(fit: FitResult, startUnit: number, plan: PlanBatch[]): PredictionResult {
  const batches: BatchPrediction[] = [];
  let first = startUnit;
  plan.forEach((pb, index) => {
    const last = first + pb.units - 1;
    const { hours, ci95 } = predictRange(fit, first, last);
    batches.push({ index, firstUnit: first, lastUnit: last, units: pb.units, hours, ci95 });
    first = last + 1;
  });
  const totalUnits = plan.reduce((s, p) => s + p.units, 0);
  const total =
    totalUnits > 0
      ? predictRange(fit, startUnit, startUnit + totalUnits - 1)
      : { hours: 0, ci95: [0, 0] as [number, number] };
  return {
    startUnit,
    batches,
    totalUnits,
    totalHours: total.hours,
    totalCi95: total.ci95,
  };
}
