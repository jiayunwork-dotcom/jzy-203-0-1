# 学习曲线拟合与预测服务（lcurve-service）

面向小型飞机部件厂的后端服务：用单件工时学习曲线拟合各部件的**首件工时**与
**学习率**，预测剩余交付计划的工时。数据以**事件流**（录入/更正/作废）追加记录，
拟合与预测全部由事件流推出，支持任意历史时点回推、重启恢复、改型件继承母型
学习率先验。

技术栈：Node.js 20 · TypeScript · Express · PostgreSQL 16 · Jest。

---

## 快速开始

```bash
# Docker（推荐）：起 PostgreSQL 16 + 本服务
docker compose up --build

# 本地开发：需要可连接的 PostgreSQL（DATABASE_URL）
npm install
npm run build && npm start        # 或 npm run dev（tsx watch）

# 测试：单元测试不需要数据库；DB 测试自动拉起内嵌 PostgreSQL 16
npm test                          # 全部
npm run test:unit                 # 仅纯计算
npm run test:db                   # 仅数据库相关
```

> DB 测试使用 `@embedded-postgres/linux-*` 提供的 PostgreSQL 16.6 二进制。
> 本仓库开发依赖固定了 arm64 版；x64 机器请执行
> `npm i -D @embedded-postgres/linux-x64@16.6.0-beta.15`。
> 也可用外部库：`LCURVE_TEST_DATABASE_URL=postgres://... npm run test:db`。

环境变量：`DATABASE_URL`（默认 `postgres://postgres:postgres@localhost:5432/lcurve`）、`PORT`（默认 3000）。

---

## 模型与关键决策

### 曲线模型

单件工时学习曲线（Wright 模型）：

```
T(x) = T1 · x^b        b = log2(LR) ≤ 0
```

`T1` 首件工时，`LR` 学习率（产量翻倍时单件工时变为原来的比例）。
参考值（`test/unit/curve.test.ts`）：T1=100、LR=80% 时 T(2)=80、
T(3)≈70.21、T(4)=64、前 4 件累计≈314.21。

### 代表件：精确闭式解 + 定点迭代（默认），近似式可选

批次数据只有区间 `[F,L]` 与批总工时 `H`。拟合需要每批的代表件 `x̄` 使
`T(x̄)·n = H`（`n=L-F+1`）。由于 `T1` 两边约去，**给定 b 时 x̄ 有闭式精确解，
不需要迭代求根**：

```
x̄ = ( (1/n)·Σ_{x=F}^{L} x^b )^{1/b}        （b→0 时极限为几何平均）
```

`x̄` 依赖尚未拟合的 `b`，因此对 `b` 做**定点迭代**：给定 b_k 算各批 `x̄`，
加权回归得 b_{k+1}，直至 |Δb| < 1e-12（实测 < 10 次收敛）。无噪声数据在
真值处是精确不动点，故精确代表件能按 1e-6 相对误差还原参数
（`test/unit/fit.test.ts`）。

**近似式**（Euler–Maclaurin 中点积分，把离散求和换成 `[F-½, L+½]` 上的积分）：

```
x̄ ≈ [ ((L+½)^{b+1} − (F−½)^{b+1}) / ((b+1)·n) ]^{1/b}
```

误差来源与上界见 [docs/math.md](docs/math.md)。结论：

- 误差随**批量增大**、**批次靠前**（F 小、曲线陡）而增大；
- 代表件相对误差上界（EM 一阶项×2 安全系数）由
  `approxRepUnitErrorBound()` 给出，测试在 LR∈[60%,100%]、F≤50、n≤200
  网格上验证（观测最差 7.8%，出现在 LR=60%、第 1 件单件批）；
- **拟合参数层面声明的上界**（`APPROX_FIT_ERROR_BOUND`，适用包络
  LR∈[70%,100%]、批量≤100、批数≥4）：学习率绝对误差 ≤ 1 个百分点、
  首件工时相对误差 ≤ 5%。网格测试观测最差为 0.03pp / 0.39%，余量充足
  （`test/unit/fitApprox.test.ts`）。

默认用精确式（闭式无额外成本）；近似式经 `FitOptions.representative='approx'`
选用，主要用于对照验证。

### 对数空间拟合 + 按批量加权

在**对数空间**做加权最小二乘：`ln(H_i/n_i) = ln T1 + b·ln x̄_i + ε`。理由：

- 工时误差以乘性（百分比）为主，对数空间方差齐性；原始空间拟合会让
  早期大批量批次主导目标函数；
- 模型线性化后有闭式解，且置信区间有经典公式，不必再做非线性优化的
  数值二阶导近似。

**权重 `w_i = n_i`（批量）**：若单件工时相对误差独立同分布，批次均值的对数
方差 ∝ 1/n_i，按批量加权等价于按件加权，大批（ averaging 掉噪声）话语权
更大。无噪声时任何一致权重都还原同一组参数，故该选择不影响性质测试。

### 置信区间与残差

- 残差：对数空间 `r_i = ln(实际批工时/拟合批工时)`，响应里同时给出每批
  实际/拟合工时；
- `σ̂² = Σw_i r_i²/(m−2)`（m≥3 批时可估计，`sigmaSource='estimated'`）；
- m≤2 批时自由度为 0 无法估计 σ，改用**假定批次总量变异系数 5%**
  （`assumedCv`，`sigmaSource='assumed'`），给出保守区间并在响应中明示；
- 区间：`(ln T1, b)` 空间正态/t 近似（estimated 用 t₀.₉₇₅(dof)，assumed
  用 z₀.₉₇₅），端点变换回 T1（exp）与 LR（2^b）。

### 预测区间

每批预测工时 `H_j = T1·Σx^b`；对数空间 delta 法传播参数不确定性，再加
批次噪声项 `σ²/n_j`（与拟合噪声模型一致）：

```
Var(ln H_j) = g_jᵀ·Cov·g_j + σ²/n_j ， g_j = [1, ∂ln S_j/∂b]
```

总工时的梯度按各批工时占比合并，区间水平 95%。

### 改型先验：等效批数 K，自动衰减

- 先验只加在**学习率**上（继承"学得快慢"），不加在首件工时上；
- 强度参数为**等效批数 K**（默认 4）：先验 = 一条权重 `λ = K·w̄` 的伪观测，
  直观含义"母型经验相当于 K 批本部件数据"；
- **衰减无需显式规则**：数据信息随批数与批间跨度自然增长，先验份额
  `λ/(λ+数据信息)` 自动下降（响应里的 `informationShare`）；
- **数据只有一两批时**：1 批 → 斜率信息为 0，学习率完全由先验决定
  （`informationShare≈1`），首件工时由该批数据定；2 批 → 先验通常仍占主导；
  30 批（默认 K=4）→ 先验份额 < 15%，100 批 → < 5%；
- 取值顺序：母型当前**有效学习率**（自身拟合值；母型无数据时沿链取它的
  先验）→ 声明关系时的显式先验值 → 无先验；
- 注意：有先验时追加与曲线吻合的数据，参数仍会向数据侧微调（先验份额
  继续衰减）——这是设计行为；"追加吻合数据参数不变"对无先验拟合严格成立。

---

## 事件溯源语义

事件类型：`part_registered`、`variant_declared`、`batch_recorded`、
`batch_corrected`、`batch_voided`。事件追加写、不改写历史；
`projections`/`parts` 表是可重建的读模型。

- **区间派生**：批次累计区间不存储，由"生产顺序（录入事件顺序）+ 各批件数
  + 跳号"在投影时派生。**更正某批件数后，后续所有批次区间自动整体平移**
  （`test/db/projectionShift.test.ts`）；作废同理。跳号以"本批之前跳过的
  件数"（gap）记录，平移时间隙大小不变。
- **幂等**：客户端事件编号（`eventId`）全局唯一，重复提交只生效一次，
  返回 `duplicate: true` 与首次的 `seq`。
- **并发**：同一部件的事件在事务内先取 `pg_advisory_xact_lock` 再校验、
  追加、更新投影，等价于按受理顺序串行处理；`recorded_at` 在锁内取
  `clock_timestamp()`，与 `seq` 同调单调。
- **历史时点**：`asOf` 按"截至该时刻的事件前缀"回放，与当时在线看到的
  结果一致（`test/db/events.test.ts`）。
- **重启恢复**：启动时从事件流整体重建读模型（`rebuildProjections`），
  重建后拟合结果不变（`test/db/recovery.test.ts`）。

---

## API

统一错误格式：`{ "error": { "code": "...", "message": "..." } }`。

### 部件与改型

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/parts` | 创建部件 `{partId, name?}`；已存在返回 200 `created:false` |
| GET | `/parts` | 部件列表（含母型与先验配置） |
| GET | `/parts/:id` | 部件当前投影（批次、区间、nextUnit） |
| POST | `/parts/:id/variant` | 声明改型 `{parentId, priorStrength?, priorLearningRate?}` |

### 批次事件

`POST /parts/:id/events`

```jsonc
// 录入：quantity、hours 必填；firstUnit 缺省 = 接续生产；
// firstUnit 大于预期时必须 allowGap: true（跳号），小于预期（重叠）拒收
{ "eventId": "uuid-1", "type": "batch_recorded",
  "batchId": "B1", "quantity": 10, "hours": 812.3,
  "firstUnit": 1, "allowGap": false }

// 更正：quantity / hours 至少其一；后续批次区间自动平移
{ "eventId": "uuid-2", "type": "batch_corrected", "batchId": "B1", "quantity": 12 }

// 作废
{ "eventId": "uuid-3", "type": "batch_voided", "batchId": "B1" }
```

响应：`201 {seq, recordedAt, duplicate:false}`；重复事件 `200 duplicate:true`。

### 查询

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/parts/:id/events?asOf=` | 事件列表 |
| GET | `/parts/:id/batches?asOf=` | 投影批次（含派生区间） |
| GET | `/parts/:id/fit?asOf=` | 拟合：t1、learningRate、置信区间、残差、先验信息 |
| POST | `/parts/:id/predictions` | `{plan:[{quantity}...], asOf?}` → 每批与总工时及 95% 区间 |
| POST | `/parts/:id/compare` | `{from, to, plan?}` → 两时点拟合差异（可选预测差异） |

拟合响应示例（节选）：

```jsonc
{
  "status": "ok",                 // 或 insufficient_data
  "t1": 100.02, "learningRate": 0.7998, "exponentB": -0.3223,
  "confidence": { "level": 0.95, "t1": [99.1, 100.9], "learningRate": [0.795, 0.805] },
  "sigma": 0.012, "sigmaSource": "estimated",   // 或 assumed（批数≤2）
  "batchesUsed": 10,
  "residuals": [ {"batchId":"B1","firstUnit":1,"lastUnit":10,
                  "actualHours":812.3,"fittedHours":811.9,"logResidual":0.0005} ],
  "prior": { "parentId": "BASE", "source": "parent_fit",
             "learningRate": 0.8, "strength": 4, "informationShare": 0.12 }
}
```

### 拒收规则（全部有测试覆盖）

| 情形 | 状态码 | code |
|---|---|---|
| 件数非正整数 | 400 | `QUANTITY_NOT_POSITIVE_INTEGER` |
| 工时非正 | 400 | `HOURS_NOT_POSITIVE` |
| 批次区间重叠 | 409 | `BATCH_OVERLAP` |
| 批次区间空档（未标跳号） | 409 | `BATCH_GAP` |
| 学习率先验不在 (0,1] | 400 | `INVALID_PRIOR_LEARNING_RATE` |
| 先验强度越界 | 400 | `INVALID_PRIOR_STRENGTH` |
| 改型关系成环 | 409 | `VARIANT_CYCLE` |
| 批次号复用（含已作废） | 409 | `BATCH_ID_EXISTS` |
| 更正/作废不存在或已作废的批次 | 404/409 | `BATCH_NOT_FOUND` / `BATCH_VOIDED` |
| 空更正、非法事件类型/编号、非法计划/时间戳 | 400 | `EMPTY_CORRECTION` 等 |
| 数据不足时请求预测 | 409 | `INSUFFICIENT_DATA` |
| 事件编号被他部件占用 | 409 | `EVENT_ID_CONFLICT` |

---

## 测试清单映射

| 任务书要求 | 位置 |
|---|---|
| 参考值（100h/80% → 80、70.21、64、314.21） | `test/unit/curve.test.ts` |
| 无噪声还原参数（精确代表件，1e-6） | `test/unit/fit.test.ts` |
| 近似式误差落在声明上界内 | `test/unit/fitApprox.test.ts`、`test/unit/representative.test.ts` |
| 批次划分无关 | `test/unit/fit.test.ts` |
| 缩放（工时×k） | `test/unit/fit.test.ts` |
| 100% 学习率 | `test/unit/curve.test.ts`、`test/unit/fit.test.ts` |
| 吻合数据不改参数 | `test/unit/fit.test.ts` |
| 件数更正引起区间平移 | `test/unit/projection.test.ts`、`test/db/projectionShift.test.ts` |
| 历史时点回推一致 | `test/db/events.test.ts`、`test/db/api.test.ts` |
| 重复事件幂等 | `test/db/events.test.ts`、`test/db/concurrency.test.ts` |
| 并发提交（串行等价） | `test/db/concurrency.test.ts` |
| 先验在少数据时的作用 | `test/unit/prior.test.ts`、`test/db/priorApi.test.ts` |
| 重启恢复 | `test/db/recovery.test.ts` |
| 预测（点值/区间/LR=100%） | `test/unit/predict.test.ts` |
| 拒收规则 | `test/db/api.test.ts`、`test/db/priorApi.test.ts` |

## 模块结构

```
src/
  curve.ts          曲线模型（单件工时、区间累计、指数↔学习率）
  representative.ts 代表件：精确闭式 / 中点积分近似 / 误差上界
  fit.ts            对数空间加权最小二乘 + 定点迭代 + 置信区间 + 先验伪观测
  predict.ts        交付计划预测与区间（delta 法）
  prior.ts          改型先验合成（等效批数、沿链继承、显式兜底）
  projection.ts     事件 → 部件状态（纯函数；区间派生/平移）
  eventStore.ts     事件追加、幂等、部件锁、时点回放
  service.ts        业务编排（校验、事务、拟合/预测/对比、重建）
  app.ts            Express 路由与错误映射
  server.ts         启动：建表 → 重建投影 → 监听
sql/schema.sql      事件表 + 读模型表
docs/math.md        数学细节（代表件误差推导、拟合与区间公式、先验）
```
