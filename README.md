# 学习曲线成本估算后端

面向小型支线飞机部件厂的后端服务：以**单件工时学习曲线**为核心，按批次累计数据拟合曲线参数、预测剩余交付计划的工时；全部批次数据以**事件流**（录入 / 更正 / 作废）追加记录，拟合与预测永远从事件流推出，支持任意历史时点回推与服务重启恢复。

技术栈：Node.js 20 · TypeScript · Express · PostgreSQL 16 · Jest。前端由客户自行开发，本仓库只含后端。

---

## 1. 模块划分

| 模块 | 文件 | 职责 |
|---|---|---|
| 曲线模型 | `src/curve.ts` | T(x)=T1·x^b、学习率↔斜率换算、区间精确求和 |
| 代表件求解 | `src/midpoint.ts` | 精确代表件、近似代表件、近似误差上界 |
| 拟合 | `src/fit.ts` | 对数空间加权最小二乘 + 代表件不动点迭代 + 置信区间 + 残差 + 近似法参数误差上界 |
| 预测 | `src/predict.ts` | 交付计划逐批/总工时预测与预测区间 |
| 先验合成 | `src/prior.ts` | 改型继承图（成环检测）；合成逻辑见 `src/service.ts` |
| 数值统计 | `src/stats.ts` | 对数伽马、不完全 Beta、t 分布分位数（无第三方依赖） |
| 事件归约 | `src/projection.ts` | 纯函数归约器：事件流 → 部件状态（三条路径共用） |
| 事件存储 | `src/store.ts` | 追加事件（幂等、部件级串行化）、投影持久化与重建 |
| 应用服务 | `src/service.ts` | 拟合/预测/先验递归合成/时点对比的编排 |
| 接口层 | `src/api.ts` | Express 路由、输入校验、错误映射 |
| 数据库 | `src/db.ts` | 连接池与幂等建表 |

## 2. 数学模型

Wright 单件工时曲线：

```
T(x) = T1 · x^b        第 x 件的工时
r     = 2^b            学习率（产量翻倍时单件工时的比例），r ∈ (0, 1]
b     = ln r / ln 2    斜率指数，b ≤ 0
```

参考值（T1=100、r=80%）：T(2)=80、T(3)≈70.21、T(4)=64、前 4 件累计≈314.21 —— 由 `test/curve.test.ts` 逐条验证。

所有批次工时、累计工时都用**逐项精确求和** `Σ x^b`（`sumPow`），不用积分近似；支线部件的产量量级下开销可忽略，换来的是无噪声数据 1e-6 还原参数的硬保证。

## 3. 代表件：定义、两种求法与误差上界

批次数据只有累计区间 `[a, c]`（m = c−a+1 件）和批次总工时 H，没有每一件的工时。拟合需要给每批找一个**代表件** x̄，使

```
T1 · x̄^b · m = Σ_{x=a}^{c} T1 · x^b   ⟹   x̄ = ( (1/m) Σ x^b )^{1/b}
```

x̄ 只依赖 b（学习率），与 T1 无关；而 b 正是要拟合的量 —— 这是问题的循环所在。

### 3.1 本服务的选择：精确代表件 + 不动点迭代（默认）

给定 b，精确代表件按定义**直接计算**（`exactRepresentativeUnit`，单件批 x̄=a；b→0 时退化为几何平均）。循环在外层用**不动点迭代**解开：

1. 初值 b₀（两批以上时用近似代表件做一次预回归；否则取 log2 0.8 或先验值）；
2. 用当前 b 算各批代表件 → 对数空间加权回归得到新 b；
3. 重复直到 |Δb| < 1e-13，或检测到浮点极限环（迭代映射在定点附近有 ~1e-12 的浮点噪声，继续迭代只会在相邻浮点数间循环，此时已达机器精度下的不动点）。

无噪声数据下精确代表件使所有数据点严格共线，回归精确还原参数（实测误差 ~1e-12，远优于要求的 1e-6）。

### 3.2 近似式（可选，`method=approx`）及误差上界

把求和换成中点法则积分的闭式：

```
x̄ ≈ ( (1/m) ∫_{a-1/2}^{c+1/2} x^b dx )^{1/b}
```

**误差上界（`approxRelativeErrorBound`，README 与代码注释中有完整推导）**：中点法则在单位区间上的误差为 f''(ξ)/24，f''(t)=b(b−1)·t^(b−2) 的最大值按单调性取端点，故

```
|ΔS| ≤ (|b(b−1)|/24) · Σ_{x=a}^{c} max|f''|      （S = Σ x^b）
|Δx̄/x̄| ≤ |ΔS| / (|b| · S)
```

b→0 时分子分母中的 |b| 约去，极限非零（对数积分 vs 离散几何平均之差），代码按极限形式计算。

**实测与上界（r=80%）**：

| 批次区间 | 实际相对误差 | 声明上界 |
|---|---|---|
| [1,1]（首件单独成批，最坏情形） | 5.89% | 29.6% |
| [1,10] | 1.30% | 4.98% |
| [1,100]（大批量但位置靠前） | 0.26% | 0.96% |
| [101,110] | 0.0005% | 0.0005% |
| [1001,1100] | <1e-6 | <1e-6 |

规律：**误差由最靠前的批次主导**，随批次位置后移按约 1/a² 衰减；批量增大本身不放大误差，位置靠前才是主因。

**近似法对拟合参数的影响**（`approxFitErrorBounds`，测试中断言实际误差不越界）：设各批代表件相对误差 ≤ ε，则对数自变量的误差 ≤ ε/(1−ε)，且可以严格推出（恒等式，非一阶近似）

```
|Δb| ≤ |b| · L · ε_max /(1−ε_max),   L = Σ w·|ũ| / Σ w·ũ²   （ũ = 加权中心化后的 ln x̄）
|Δα| ≤ |Δb|·|x̄_w| + |b| · ε_max/(1−ε_max)
|ΔT1/T1| ≤ e^{|Δα|} − 1,             |Δr/r| ≤ 2^{|Δb|} − 1
```

以 r=83%、批次 [1-4]/[5-12]/[13-30]/[31-60]/[61-100] 为例：学习率相对误差上界 1.55%（实际 0.064%），T1 相对误差上界 11.3%（实际 0.36%）。上界偏保守（约 5–25 倍），但它是**可计算、可声明**的保证；测试 `test/fit.test.ts` 验证实际误差落在声明上界之内。

**结论**：默认用精确法（成本极低、误差为零）；近似法仅用于对比验证，接口通过 `?method=approx` 显式开启。

## 4. 拟合：对数空间加权最小二乘

对第 i 批：y_i = ln(H_i / m_i)，x_i = ln x̄_i，模型 y = α + b·x，α = ln T1。

**为什么在对数空间拟合**：工时噪声是乘性的（百分比误差），对数变换后方差稳定、模型线性化；尺度不变性（工时 ×k ⇒ T1 ×k、学习率不变）随之自然成立；残差即相对误差，符合成本科的使用习惯。

**权重 w_i = m_i（批内件数）**：若单件工时有独立乘性噪声（变异系数 σ_u），批均值 H_i/m_i 的方差 ∝ σ_u²/m_i，故按件数加权等价于每“件”等权。无噪声数据严格共线时权重不影响解 —— 因此“批次划分无关”这一性质对任意权重成立。

**先验并入**：学习率先验作为精度 ν0 的高斯先验加入法方程（见第 6 节）。

**置信区间**：σ² = RSS/(n−2)，Cov(α̂, b̂) = σ²·(XᵀWX + P)⁻¹（P 为先验精度阵），t 分位数取 df = n−2。T1 与学习率的区间由对数空间区间端点取指数/2^· 得到。**n ≤ 2（df=0）时区间返回 null** —— 两批数据能定参数但无法估计噪声，不假装有区间。残差按批给出对数残差与工时相对残差。

## 5. 预测

给定剩余交付计划（`{batches:[{units}…]}` 或 `{totalUnits, batchSize}`），从当前最大件号 +1 起：

- 每批工时 = T1 · Σ_{x=first}^{last} x^b（精确求和）；完工总工时按整个剩余区间一次求和；
- 区间：对数空间 delta 法。logH = α + ln S(b)，梯度 g = (1, Σx^b·lnx / Σx^b)，预测方差 = gᵀΣg + σ²（含残差方差，即**预测区间**而非仅参数置信区间），t 分位数 df = n−2；总工时区间按整个区间整体计算，正确计入各批间由参数不确定性引起的相关性。df=0 时区间为 null。

## 6. 改型先验的合成

改型件可声明继承一个母型（每部件至多一个母型，可成链；成环拒绝）。**先验只作用于学习率，T1 始终由自身数据决定** —— 改型通常改变的是单件工时水平，而学习机理（工艺、产线）与母型一致。

- **先验值**：显式给定（必须在 (0,1]，否则 400），或缺省跟随母型当前拟合的学习率（沿链递归；母型尚无拟合时先验不生效）。
- **强度 ν0（strength，默认 8）**：先验作为精度 ν0 的高斯项并入法方程，后验斜率

  ```
  b = (I_data · b_data + ν0 · b_prior) / (I_data + ν0),
  I_data = Σ w·(ln x̄ − 加权均值)²   （数据对斜率的信息量）
  ```

- **衰减方式**：不需要人为衰减函数 —— I_data 随批次数与批次在对数件号上的散布自然增大，先验份额 ν0/(ν0+I_data) 自动下降。拟合结果中的 `priorShare` 字段实时报告该份额。

**数据只有一两批时结果由什么决定**（默认 ν0=8、典型批量与散布下的实测）：

| 自身批数 | 先验份额 | 学习率行为 |
|---|---|---|
| 1 批 | 100% | 完全等于先验（单批无先验本来无法拟合）；T1 由自身数据点按先验斜率反解 |
| 2 批 | ≈47% | 明显向母型靠拢 |
| 3 批 | ≈24% | 过渡 |
| 4 批 | ≈13% | 以自身为主 |
| 6 批 | ≈5% | 基本由自身数据决定 |

（上表为母型 r=75%、自身 r=95%、批次覆盖 1–160 件的实测；`priorShare` 逐次拟合返回，客户可按部件调 strength。）

## 7. 事件溯源语义

事件流是唯一事实来源（`events` 表：`event_id` 主键即幂等键、`seq` 全局递增、`recorded_at` 入库时刻）。三类事件：

- **record 录入**：区间必须紧接当前最大件号，重叠 → 409；出现空档 → 409，除非显式 `allowsGap`（跳号：序列号空缺，如报废件）；批次号重复 → 409。
- **correct 更正**：改总工时和/或件数（以 `lastUnit` 表达）。**件数变化时，之后所有批次（含已作废的）的累计区间整体平移同一差值**，空档大小随之保持 —— 因为后续件号是物理序列号，其真实位置由前面批次的真实件数决定。作废的批次不能更正。
- **void 作废**：数据不再参与拟合，但**区间仍然占位**（件已生产，序列号不回填），`maxUnit` 不变；重复作废 → 409。

**一致性机制**：

- **幂等**：同一 `eventId` 重复提交且内容一致 → 返回 `duplicate` 不重复生效；内容不一致 → 409。
- **并发**：追加事件在单事务内先取部件级 `pg_advisory_xact_lock`，同一部件的事件追加被串行化 —— 并发提交的最终状态与按处理顺序串行执行完全一致（可串行化）。推论：并发录入相互依赖的批次时，排在前面批次之前被处理的那批会因空档被 409 拒绝（这正是它在该串行顺序下应得的结果），客户端按顺序重试即可收敛；测试验证了“被应用的批次必为连续前缀、重试后终态与全部串行提交相同”。
- **时点回推**：`asOf` 查询 = 重放 `recorded_at <= asOf` 的事件（按 seq）。在线追加、时点回推、重启重建**共用同一个纯函数归约器**（`src/projection.ts`），因此历史时点结果必然与当时在线看到的一致（集成测试逐字段断言）。
- **重启恢复**：服务启动时清空投影表并从事件流整体重建；拟合与预测本就实时从事件流计算，投影表服务于状态查询。

## 8. API 一览

```
GET    /health
POST   /parts                          {partId, name}
GET    /parts
GET    /parts/:partId                  部件当前状态（投影：批次区间、maxUnit、事件数）
PUT    /parts/:partId/inheritance      {parentId, priorLearningRate?, strength?}
GET    /parts/:partId/inheritance
DELETE /parts/:partId/inheritance
POST   /parts/:partId/events           批次事件（见下）
GET    /parts/:partId/events           事件流
GET    /parts/:partId/fit?asOf=&method=exact|approx
POST   /parts/:partId/predictions      {plan, asOf?, method?}
POST   /parts/:partId/compare          {from, to?, plan?, method?}
```

**批次事件**：

```jsonc
// 录入
{"eventId":"…","type":"record","batchId":"B1","firstUnit":1,"lastUnit":10,"totalHours":631.5,"allowsGap":false}
// 更正（工时和/或件数）
{"eventId":"…","type":"correct","batchId":"B1","totalHours":640.0,"lastUnit":12}
// 作废
{"eventId":"…","type":"void","batchId":"B1"}
```

响应：`201 {outcome:"applied", seq, recordedAt, state}`；重复事件 `200 {outcome:"duplicate", …}`。

**拟合结果**（`GET /parts/:id/fit`）：`t1`、`learningRate`、`b`、`ci95`（t1/learningRate/b，df=0 时为 null）、`sigma2`、`df`、逐批 `residuals`、`priorShare`、`prior{active,source,learningRate,strength}`、`iterations`。

**预测**（`POST /parts/:id/predictions`）：逐批 `{firstUnit,lastUnit,units,hours,ci95}` 与 `{totalHours,totalCi95}`，附所用拟合结果。

**对比**（`POST /parts/:id/compare`）：两个时点的拟合与（同一计划下的）预测，及 `delta{t1, learningRate, b, totalHours, batchHours[]}`；`to` 缺省为当前。

**拒收规则**（全部有测试覆盖）：

| 情形 | 状态码 |
|---|---|
| 件数不是正整数（firstUnit/lastUnit 非正整数、lastUnit<firstUnit、更正后件数非正） | 400 |
| 工时不为正 | 400 |
| 批次区间与已有批次重叠 | 409 |
| 批次区间出现空档且未标注 allowsGap | 409 |
| 学习率先验不在 (0,1] | 400 |
| 改型关系成环（含自继承） | 409 / 400 |
| 部件/批次/继承关系不存在 | 404 |
| 批次号重复、重复作废、作废后更正、事件编号重用不同内容 | 409 |
| 数据不足（无批次，或仅一批且无先验） | 422 |

## 9. 运行

```bash
# 完整服务（app + postgres:16-alpine）
docker compose up --build

# 本地开发（需要可连的 PostgreSQL）
docker compose up -d db
npm install
npm run dev          # ts-node 起服务，PORT 默认 3000

# 测试
npm test                     # 单元 + 集成（无 DATABASE_URL 时自动拉起内嵌 PostgreSQL 16）
docker compose --profile test up --build --abort-on-container-exit test   # compose 内全量测试
```

环境变量：`DATABASE_URL`（默认 `postgres://lc:lc@localhost:5432/learning_curve`）、`PORT`。

集成测试说明：`test/helpers.ts` 优先使用 `DATABASE_URL`；否则用 devDependency 随附的 zonky PostgreSQL 16 二进制在临时目录拉起实例（首次运行自动就绪，无需 Docker）；两者都不可用时跳过数据库测试并告警，`REQUIRE_DB=1` 时改为直接失败（compose 测试即如此）。

## 10. 测试清单映射

| 要求 | 位置 |
|---|---|
| 参考值（80/70.21/64/314.21） | `test/curve.test.ts` |
| 无噪声数据还原参数（精确法 1e-6 内） | `test/fit.test.ts` |
| 近似法误差落在声明上界内 | `test/midpoint.test.ts`、`test/fit.test.ts` |
| 批次划分无关 | `test/fit.test.ts` |
| 缩放（工时×k ⇒ T1×k、率不变） | `test/fit.test.ts` |
| 100% 学习率 | `test/curve.test.ts`、`test/fit.test.ts`、`test/predict.test.ts` |
| 追加吻合数据参数不变 | `test/fit.test.ts` |
| 件数更正引起区间平移 | `test/projection.test.ts`、`test/api.integration.test.ts` |
| 历史时点回推一致 | `test/api.integration.test.ts` |
| 重复事件幂等 | `test/api.integration.test.ts` |
| 并发提交（可交换更正、同幂等键、并发顺序录入） | `test/api.integration.test.ts` |
| 先验在少数据时的作用与衰减 | `test/prior.test.ts`、`test/api.integration.test.ts` |
| 重启恢复 | `test/api.integration.test.ts` |
| 预测与两时点对比 | `test/predict.test.ts`、`test/api.integration.test.ts` |
| 全部拒收规则 | `test/api.integration.test.ts`、`test/projection.test.ts` |
