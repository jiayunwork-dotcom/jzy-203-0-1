/**
 * 改型（衍生件）学习率先验的合成。
 *
 * 设计（详见 docs/math.md）：
 *  - 先验只加在学习率（指数 b）上，不加在首件工时上——改型继承的是
 *    "学得快慢"，不是"第一件干多久"。
 *  - 先验强度以"等效批数 K"参数化（默认 4）：母型经验相当于 K 批本部件
 *    数据的说服力。实现上是一条权重 λ = K·w̄ 的伪观测。
 *  - 衰减不需要显式规则：数据信息随批数与批间跨度自然增长，先验份额
 *    ≈ λ/(λ+数据信息) 自动下降。只有 1 批数据时斜率信息为 0，学习率
 *    完全由先验决定，首件工时由该批数据定；2 批时先验通常仍占主导。
 *  - 先验取值：母型当前拟合的学习率优先；母型尚无拟合时用声明改型关系
 *    时给定的显式先验值；两者都没有则不加先验。
 */

import { exponentFromLearningRate } from './curve';
import type { PriorSpec } from './fit';

/** 默认先验强度：等效 4 批数据 */
export const DEFAULT_PRIOR_STRENGTH = 4;
/** 先验强度合法范围（等效批数） */
export const PRIOR_STRENGTH_MIN = 1e-6;
export const PRIOR_STRENGTH_MAX = 1000;

export interface VariantSpec {
  parentId: string;
  priorStrength: number;
  explicitPriorLr: number | null;
}

/**
 * 合成先验。parentLr 为母型的"有效学习率"（自身拟合值；母型无数据时
 * 沿链取它自己的先验均值），null 表示母型链上没有可用信息。
 */
export function buildPrior(
  parentLr: number | null,
  spec: VariantSpec,
): { prior: PriorSpec | null; source: 'parent_fit' | 'explicit' | 'none'; learningRate: number | null } {
  if (parentLr != null) {
    return {
      prior: { bMean: exponentFromLearningRate(parentLr), equivalentBatches: spec.priorStrength },
      source: 'parent_fit',
      learningRate: parentLr,
    };
  }
  if (spec.explicitPriorLr != null) {
    return {
      prior: { bMean: exponentFromLearningRate(spec.explicitPriorLr), equivalentBatches: spec.priorStrength },
      source: 'explicit',
      learningRate: spec.explicitPriorLr,
    };
  }
  return { prior: null, source: 'none', learningRate: null };
}
