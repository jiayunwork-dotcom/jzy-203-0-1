/**
 * 改型继承（学习率先验）的纯函数部分。
 *
 * 设计（详见 README「改型先验的合成」）：
 *  - 每个部件最多声明一个母型；先验只作用于学习率（斜率 b），
 *    首件工时 T1 始终由自身数据决定。
 *  - 先验值可显式给定（须在 (0, 1]），或不给出则跟随母型当前拟合的学习率
 *   （母型自身也可以有先验，沿链递归合成）。
 *  - 合成方式：把先验当作精度为 ν0（strength）的高斯先验并入加权最小二乘的
 *    法方程。后验斜率 = (I_data·b_data + ν0·b_prior) / (I_data + ν0)，
 *    其中 I_data = Σ w·(ln x̄ − 加权均值)² 随批次增多而增大，先验份额
 *    ν0/(ν0+I_data) 自动衰减 —— 数据少时向母型靠拢，数据多了以自身为主。
 */

/** 判断把 child → parent 加入继承图后是否成环（沿 parent 链向上走）。 */
export function wouldCreateCycle(
  edges: ReadonlyMap<string, string>,
  childId: string,
  parentId: string,
): boolean {
  if (childId === parentId) return true;
  let cur: string | undefined = parentId;
  const seen = new Set<string>();
  while (cur !== undefined) {
    if (cur === childId) return true;
    if (seen.has(cur)) return true; // 既有数据异常成环时也拒绝
    seen.add(cur);
    cur = edges.get(cur);
  }
  return false;
}
