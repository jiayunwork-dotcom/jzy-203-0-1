/**
 * 交付计划预测。
 *
 * 给定拟合结果与剩余计划（若干批、每批件数），从当前累计位置继续编号，
 * 每批预测工时 = T1 · Σ x^b。
 *
 * 区间（95%）：在对数空间用 delta 方法传播参数不确定性，
 * 再加上批次的不可约噪声项 σ²/n（与拟合时的加权噪声模型一致）：
 *   Var(ln H_j) = g_jᵀ · Cov · g_j + σ²/n_j，g_j = [1, ∂ln S_j/∂b]
 * 总工时的梯度按各批工时占比加权合并。
 */

import { sumPow, sumPowLnX } from './curve';
import { FitResult, Z_975 } from './fit';

export interface PlanBatch {
  quantity: number;
}

export interface BatchPrediction {
  index: number;
  firstUnit: number;
  lastUnit: number;
  quantity: number;
  hours: number;
  hoursLo: number;
  hoursHi: number;
}

export interface PredictionResult {
  startUnit: number;
  batches: BatchPrediction[];
  total: { hours: number; hoursLo: number; hoursHi: number };
  /** 区间置信水平 */
  level: 0.95;
}

export function predictPlan(fit: FitResult, startUnit: number, plan: PlanBatch[]): PredictionResult {
  const { b, t1, covariance: cov, sigma } = fit;
  const batches: BatchPrediction[] = [];
  let cursor = startUnit;

  // 先算每批的点预测与对数空间梯度
  const grads: Array<[number, number]> = [];
  const noises: number[] = [];
  const hoursArr: number[] = [];
  for (let j = 0; j < plan.length; j++) {
    const qty = plan[j]!.quantity;
    const first = cursor;
    const last = cursor + qty - 1;
    const s = sumPow(first, last, b);
    const ds = sumPowLnX(first, last, b);
    const hours = t1 * s;
    const c = s > 0 ? ds / s : 0; // ∂ln H / ∂b
    const varLog =
      cov[0][0] + 2 * c * cov[0][1] + c * c * cov[1][1] + (sigma * sigma) / qty;
    const half = Z_975 * Math.sqrt(Math.max(varLog, 0));
    batches.push({
      index: j,
      firstUnit: first,
      lastUnit: last,
      quantity: qty,
      hours,
      hoursLo: hours * Math.exp(-half),
      hoursHi: hours * Math.exp(+half),
    });
    grads.push([1, c]);
    noises.push((sigma * sigma) / qty);
    hoursArr.push(hours);
    cursor = last + 1;
  }

  // 总工时：对数空间按占比合并参数不确定性；噪声项（独立）在线性空间合并
  const total = hoursArr.reduce((s, h) => s + h, 0);
  let gA = 0, gB = 0, varNoiseLog = 0;
  for (let j = 0; j < plan.length; j++) {
    const share = total > 0 ? hoursArr[j]! / total : 0;
    gA += share * grads[j]![0];
    gB += share * grads[j]![1];
    varNoiseLog += share * share * noises[j]!;
  }
  const varLogTotal =
    gA * gA * cov[0][0] + 2 * gA * gB * cov[0][1] + gB * gB * cov[1][1] + varNoiseLog;
  const halfTotal = Z_975 * Math.sqrt(Math.max(varLogTotal, 0));

  return {
    startUnit,
    batches,
    total: {
      hours: total,
      hoursLo: total * Math.exp(-halfTotal),
      hoursHi: total * Math.exp(+halfTotal),
    },
    level: 0.95,
  };
}
