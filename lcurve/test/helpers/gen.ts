/** 测试数据生成与工具 */

import { batchHours, exponentFromLearningRate } from '../../src/curve';
import { BatchDatum } from '../../src/fit';

/** 从精确曲线生成无噪声批次（从 startUnit 起连续划分） */
export function genBatches(
  t1: number,
  lr: number,
  sizes: number[],
  startUnit = 1,
  idPrefix = 'B',
): BatchDatum[] {
  const b = exponentFromLearningRate(lr);
  let cursor = startUnit;
  return sizes.map((s, i) => {
    const first = cursor;
    const last = cursor + s - 1;
    cursor = last + 1;
    return {
      batchId: `${idPrefix}${i + 1}`,
      firstUnit: first,
      lastUnit: last,
      hours: batchHours(t1, b, first, last),
    };
  });
}

/** 给批次总工时乘上确定性伪随机乘性噪声（mulberry32，固定种子可复现） */
export function addMultiplicativeNoise(batches: BatchDatum[], cv: number, seed = 42): BatchDatum[] {
  const rand = mulberry32(seed);
  // Box-Muller
  return batches.map((b) => {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return { ...b, hours: b.hours * Math.exp(cv * z) };
  });
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
