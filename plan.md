# ccSynapse 架构评估与改造方案

日期：2026-09-26 · 评估对象：`F:\Project\MyTool\ccSynapse` (v0.1.0, **47 tests passing**)
图谱：299 节点 · 655 边 · 19 社区 · 0 导入环 — `graphify-out/graph.json`
当前 HEAD：`e7fdeeb` · 全部 P0 + P1 + P2-1 + P2-6 已落地

---

## 完成状态总览

| 项 | 状态 | 落地内容 | commit |
|---|---|---|---|
| P0-1 UUID 血缘识别 | ✅ | 倒排索引 + `uuidSet`，指纹降为回退 | `5a01a0f` 前 |
| P0-2 持久化拆分 | ✅ | `workspaces.json` / `workspaces-projection.json` | — |
| P0-3 归档可撤销 | ✅ | `unarchiveThread()` + 侧边栏「已归档」 | — |
| P1-1 子代理投影 | ✅ | 扫描 `subagents/agent-*.jsonl` + `meta.json` | `5a01a0f` |
| P1-2 服务端测试 | ✅ | `routes.js`/`rpc.js` 拆分 + 8 个测试 | `acc94075` 前 |
| P1-3 启动预热 | ✅ | `prestart.js` + `SessionStart` hook | `1643a64` |
| P1-4 escapeHtml 覆盖 | ✅ | 2 个 XSS 测试走 `conversationCard()` 路径 | `bcc9b1b` |
| P2-1 轮询收窄 | ✅ | `refreshProjection` 按 `updatedAt` 短路 | — |
| P2-6 index.js 拆分 | ✅ | 与 P1-2 同步完成 | — |
| P2-2 增量协议 | ⬜ | 未做（实测不紧急） | — |
| P2-3 结构判据轮次切分 | ⬜ | 未做（风险中） | — |
| P2-4 占位符重启恢复 | ⬜ | 未做 | — |
| P2-5 清理移植残留 | ⬜ | 未做 | — |
| P3 功能缺口 | ⬜ | 未做（取舍项） | — |

**人工测试反馈的 6 项 UI 修复（全部完成）**

| 问题 | 解决 |
|---|---|
| 缺小地图 | 160×100px canvas 浮层，点击/拖拽平移 |
| 缩放下限过大 | `0.6` → `0.08`，新增「全览」按钮 |
| 等待节点应缩略 | `pendingReplies` 或 `answer === null` → 48px 脉冲圆点 |
| 「对话」按钮不跳转 | 根因 `data-action="close"` → `show-thread` |
| 左侧应为树形 | `buildThreadTree` + 按日期分组折叠 |
| 无意义节点未缩略 | 同上（`answer === null && error === null`） |

---

## 一、结论先行

现在的实现是一个**能跑通、局部质量不错、但生命周期划分错误**的系统。最大问题不是性能，而是**把「可重建的投影缓存」和「不可重建的用户布局」存进同一个文件**——改一行投影规则就要用户丢掉全部手工排版。

图谱分析补充了三条人工审查看不出来的证据：

**图谱新发现 1：`escapeHtml()` 是第五大枢纽节点（13 条边），不是工具函数。**
它被 Markdown 渲染路径和卡片渲染路径同时依赖，是整张画布唯一的 XSS 防线。它的度数比 `WorkspaceStore` 之外的所有服务端函数都高，而目前它没有任何安全专项测试。

**图谱新发现 2：`trust.js`（C8）的社区内聚度 0.33，是全仓库最高。**
对比：`server/index.js` 所在的 C0 内聚度仅 0.10，`bridge.js` 所在的 C1 为 0.09。
数据含义：把信任闸独立成模块是对的；同样的理由（低内聚 = 职责混杂）支持把 `index.js` 继续拆分。

**图谱新发现 3：P0-3（归档恢复）是图谱中唯一的孤立节点（C18，大小 1）。**
它与其他改造项之间没有任何依赖边。这意味着它可以在任何时间点独立实施，风险为零，不需要等待 P0-2 或 P0-1 完成。

算法层面有一处**已被实测证伪的假设**：官方 SDK 文档说 `--fork-session` 重写 UUID，我据此用内容指纹做血缘识别。实测：**子会话 300 个 UUID 里有 295 个与父会话逐字相同**，UUID 根本没被重写。精确识别一直可用，我用了一个不必要的近似算法。

性能方面实测：689 KB 载荷 8ms，不是瓶颈，降级到 P2。

---

## 二、评估

### 2.1 架构视角

**A1 · 投影与布局同生命周期（严重）**
`workspace-store.js` 的单个 `workspaces.json` 同时装着两类数据：

| 数据 | 可重建性 | 归属 |
|---|---|---|
| `threads[].messages[]`、`process[]` | **可**——从 transcript 重算即可 | 投影缓存 |
| `position`、`hiddenSessionIds`（归档）、`parentId` 覆盖 | **不可**——用户手工劳动 | 用户状态 |

后果是实测出来的：本次开发过程中为验证投影规则改动，删了 `workspaces.json` **4 次**。每一次都等于把用户所有卡片的手工拖拽位置和归档记录清零。

图谱佐证：C14（Architecture Debt / Persistence）把 `Projection/Layout Lifecycle Coupling Bug`、`WorkspaceStore Architecture Evaluation`、`P0-2: Split Persistence` 聚合成一个独立社区——三者紧密耦合，孤立于其他改造项之外。

**A2 · 宿主适配层的替换是干净的，但边界只做了一半**
`client.js`（DSH 宿主桥，242 行）整体删除、`app.js` 只换 RPC 传输，改得干净。但 `app.js` 里仍残留宿主假设：`state.dshWorkspaces` 永远为空（靠 `workspaceChoices()` 的 fallback 兜住）、`loadThreadHistory()` 是空函数（8 处调用）、`messagesFromEvents()` 无调用者。

**A3 · 服务端是单文件 333 行，路由/RPC/桥接/投影调度揉在一起**
图谱数据：`handleApi()`（C0，16 条边）是服务端第一枢纽。C0 内聚度 0.10，C1（bridge）内聚度 0.09——两个最大的服务端社区，内聚度都是全项目倒数。对比 C8（trust.js）0.33。这不是凑巧：`trust.js` 是唯一被提前拆出的模块。`index.js` 的 12 条路由和 `bridge.js` 的 CLI 调用和 `source.sync()` 调度混在一起，正是低内聚的直接成因。

**A4 · 单进程内存态与持久态双写**
`aliases` / `locals` / `pendingForks` / `appliedForks` 只在内存，重启即失。服务重启后，已 fork 但尚未识别的占位会话永远认不回它的真实会话 id，画布上会多出一个空线程。

### 2.2 研发视角

**E1 · 无 un-archive（用户可感知的缺陷）**
`archiveThread` → `removeThread` → 把 `dshSessionId` 推进 `hiddenSessionIds` 墓碑（`workspace-store.js:175`），此后所有投影路径都跳过它（`:128, :198`）。**全仓库没有任何撤销路径**——`:186-189` 只做增加。误点一次归档，会话就永久消失在画布上，只能手改 JSON。

图谱佐证：P0-3 对应的节点是图谱里唯一的 C18 单节点孤岛——实现成本极低，可独立并行。

**E2 · 服务端路由与 RPC 零测试**
36 个测试覆盖 `transcript`、`workspace-store`、`trust`、`markdown`。**`index.js` 的 12 条路由、`/api/rpc` 的 9 个分支、`bridge.js` 的 CLI 调用全部无测试**。

图谱新增：`handleHostMessage()`（画布端 RPC 分发）有 **16 条边**，与服务端的 `handleApi()` 完全对等——两者都是高度数枢纽，但目前只有 `handleApi()` 在测试范围的讨论里被提及。`handleHostMessage()` 处理所有来自画布的 RPC，包括 fork 触发，同样是零测试。

**E3 · 每秒全量重取（实测：浪费但不慢）**
实测（最大工作区）：`GET /api/workspaces/:id` 689–759 KB / 8ms / parse 1ms。
**当前规模下不是瓶颈**，8ms/次约 0.8% CPU。降级为 P2。

**E4 · 投影规则改动 = 破坏性升级**
因为「按行号 `sourceSeq` 去重」，改变解析逻辑后旧卡片不会被修正，必须整文件重来（README 里写成注意事项）。这是 A1 的直接后果。

**E5 · 插件启动路径笨重**
`/synapse` 需要：模型回合 → Bash 授权弹窗 → 起服务 → 开浏览器。`SessionStart` 的 `async: true` hook 可以在会话开始时无感预热服务。

### 2.3 算法视角

**G1 · 血缘识别用了一个不必要的近似算法（最重要的算法结论）**

现状：对每一轮取「提问 + 全部助手回复」的内容哈希，要求 ≥2 轮相同前缀。

推导依据是官方 SDK 文档：「`forkSession` rewrites every `sessionId` field and **remaps message UUIDs**」。

**实测证伪**（真实 fork 对 `9d8d607b` → `b69ad81d`）：

```
子会话 uuid 总数:           300
其中也存在于父会话的:        295      ← UUID 被完整保留
子会话独有（新增轮次）:        5
```

CLI 的 `--fork-session` 保留 UUID；SDK 的 `forkSession` 才重映射。精确判据一直可用：**`子.uuid ∩ 父.uuid` 非空即 fork**，误判率恒为 0。

图谱佐证：C12（Fork Detection & Lineage）把 `Content Fingerprint Algorithm`、`P0-1: UUID Intersection`、`parentUuid DAG` 聚在一起，与测试基础设施（C2）分属不同社区——血缘逻辑是独立的认知单元，应单独重写和测试。

**G2 · 轮次切分依赖时序，不依赖结构**
`AssistantGroup` 的"消息是否写完"靠时序推断（`grew` 判断）。结构性判据是现成的：**transcript 只追加，下一条 `user` 行就是本轮终止符**。用结构判据可以去掉 `grew` 这个跨轮询状态，并让首轮读取行为一致。

**G3 · `detectForks` 是 O(n²·k)**
46 个会话无感；会话数上万时需要按"首个 uuid"建倒排索引，降到近似 O(n)。UUID 方案顺带解决这个问题。

**G4 · 丢弃了 `parentUuid` 这条精确的会话内 DAG 边**
消息级血缘**只有** `parentUuid`；并行 tool_use 会产出同一个 `message.id` 的多条 assistant 行、uuid 不同（DAG 而非链表）。当前按行序切分，等于主动放弃"同一会话内回退/改问产生的分叉"。值得注意的是：`message.id` 归并这一点我是撞对的，与官方实现一致。

### 2.4 图谱视角（新增）

图谱 299 节点 / 655 边 / 19 社区，零导入环。以下是人工审查未发现的结构性信号：

**K1 · `escapeHtml()` 是第五大枢纽，也是唯一的隐式安全屏障**

度数 13，高于所有服务端函数（`handleApi()` 16 是唯一例外）。它被多条渲染路径共同依赖：Markdown 渲染 → `inlineMarkdown()` → `escapeHtml()`；卡片渲染 → `conversationCard()` → `escapeHtml()`；工具折叠 → `foldLegacyToolCards()` → `escapeHtml()`。

这意味着两件事：第一，它是整张画布 XSS 防线的单一通道，可以集中覆盖；第二，它的高度数说明渲染路径过于分散，多处重复走到同一个底层函数而不是走同一条渲染管道。

当前测试：`markdown-renderer.test.js` 覆盖了 `inlineMarkdown()` 路径，但直接走 `conversationCard()` 的路径没有测试。**安全关键函数只有一半覆盖。**

**K2 · 社区内聚度揭示模块化质量**

| 社区 | 代表模块 | 内聚度 | 含义 |
|---|---|---|---|
| C8 信任闸 | `trust.js` | **0.33** | 最高，职责单一，正确拆分 |
| C10 线程数据访问 | `app.js` 中的数据查询层 | **0.24** | 第二，隐含的子模块边界 |
| C9 图布局 | 连线与布局函数 | **0.20** | 第三，可独立维护 |
| C5 会话状态 | `openDshWorkspace()` 等 | **0.19** | 中等 |
| C0 服务端逻辑 | `index.js` + `workspace-store.js` | **0.10** | 低，职责混杂 |
| C1 桥接与 Node 集成 | `bridge.js` + `index.js` 混合 | **0.09** | 最低，边界不清 |

C0 和 C1 是全项目内聚度最低的两个社区，也恰好是改动最密、bug 最集中的地方。C8 是唯一被提前拆出来的模块，也是内聚度最高的。因果关系是反过来的：**不是因为 `trust.js` 简单所以内聚度高，而是因为它被拆出来了所以内聚度高。** 同样的拆分应该施加在 `index.js` 的路由层和 RPC 层上。

**K3 · P0-3 是结构孤岛，任何时候可独立实施**

图谱 C18 只含一个节点（`P0-3: Un-archive Capability`）。它与 P0-1（UUID 血缘）、P0-2（持久化拆分）之间没有任何依赖边。执行顺序图中把它画在 P0-2 和 P0-1 之后纯属习惯，实际上它可以在任何 sprint 独立完成，约 80 行，无回归风险。

---

## 三、改造方案

按「实测影响」排序，图谱证据标注在相关项下。

### P0 — 核心缺陷 ✅ 全部完成

#### ✅ P0-1 血缘识别换成 UUID 集合包含

**问题**：用内容指纹做 fork 识别（G1）。
**证据**：实测 295/300 UUID 跨 fork 保留。图谱 C12 把血缘相关概念聚成独立社区，说明这是一个结构上独立的改动单元。
**方案**：
1. `SessionCache` 记录 `uuidSet: Set<string>` 与 `novelUuids`（首次读取快照，后续增量跳过）。
2. `detectForks` 改为：`share = |child.uuidSet ∩ parent.uuidSet|`，`share >= 1` 即判定；父取 `share` 最大者。
3. **锚点**：共享 uuid 映射回父会话的轮次序号，`seedLength` 仍按现有语义（父的「下一轮 seq」）计算——`sourceSeedLength` 的消费方（`app.js:745-750`）不用动。
4. 保留内容指纹**仅作为回退**：当子会话 UUID 集为空（极旧格式或空文件）时才启用，日志里标注。
5. 删掉 `minShared = 2` 这个纯粹为了压误判而设的参数——UUID 匹配不需要它。**顺带解决 G3**：按首个 uuid 建 Map 即可。

**成本**：约 60 行（fingerprint → uuidSet，detectForks，倒排索引）。
**风险**：低。最坏情况是识别不出（漏判），不会错判。
**验收**：`test/transcript.test.js` 里的 fork 用例改为 uuid 判定；新增用例断言"重试（全新 uuid）永不被判为 fork"；用真实 fork 跑一次，断言认亲成功且锚点轮次正确。

#### ✅ P0-2 拆分持久化：投影缓存 vs 用户状态

**问题**：A1 / E4——改投影规则要用户丢掉排版。
**图谱佐证**：C14 把 `Projection/Layout Lifecycle Coupling Bug`、`WorkspaceStore Architecture Evaluation`、`P0-2` 聚为一个孤立社区，与其他任何代码节点无边——它是一个纯粹的技术债务包，不会被功能改动顺手修复，必须主动处理。
**方案**：两份文件，两个所有者。
- `workspaces.json`（**用户状态**，小、稳定、必须保留）：workspace 归属（cwd→id）、thread 的 `dshSessionId`/`parentId`/`position`/`color`、`hiddenSessionIds`。**投影器永远不写这里。**
- `projection.db` 或 `projection.jsonl`（**投影缓存**，可随时删除重建）：messages / process。
- 启动时若缓存缺失或版本不匹配 → 静默重建，**不动用户状态**。投影规则版本号写进缓存文件头。
- 过渡：检测到旧版单文件时自动拆成两份（现有 store 已有 v1→v4 迁移机制，照此加一版）。

**成本**：约 200 行（store 拆分 + 迁移 + 两个写入路径）。最大单项改造。
**风险**：中。迁移前必须 `copy` 一份 `workspaces.json.bak`，且迁移本身要有测试。
**验收**：手工拖 3 张卡片 → 改投影器版本号 → 重启 → 卡片位置与归档状态完好、内容已重建。`diff` 用户状态文件。
**收益**：消除 E4；`workspaces.json` 从 3.79 MB 降到预计 <100 KB；P2-1 的整文件重写成本自动消失。

#### ✅ P0-3 归档可撤销

**问题**：E1——单向墓碑。
**图谱**：C18 单节点孤岛，零依赖，任何时候可独立实施。
**方案**：store 加 `unarchive(sessionId)`（从 `hiddenSessionIds` 移除）；服务端加 `POST /api/sessions/:id/unarchive`；`app.js` 在侧边栏或工作区选择器旁加「已归档」入口，列出墓碑并允许恢复。
**成本**：约 80 行（store 10 + 路由 10 + UI 60）。
**风险**：低。
**验收**：归档 → 从「已归档」恢复 → 会话与卡片位置原样回来。

### P1 — 结构性 ✅ 全部完成

#### ✅ P1-1 子代理投影（32% 的语料当前不可见）
**证据**：`subagents/agent-*.jsonl` 22 个 vs 顶层 46 个。
**落地**：`transcript.js` 的 `#listTranscripts()` 下探 `<project>/<sessionId>/subagents/`，收集 `agent-*.jsonl`；`SessionCache` 新增 `parentSessionId`（从目录结构推断）与 `toolUseId`（读同目录 `.meta.json`）；`index.js` 投影循环内 `applyLineage()` 把子代理挂到父线程，`appliedForks` 防重。
**实测**：`subagents/` 不存在时 readdir 异常被吞，不影响普通项目。**commit** `5a01a0f`

#### ✅ P1-2 服务端与 RPC 测试（含画布端 handleHostMessage）

**问题**：E2——改动最密的地方零覆盖。
**落地**：`index.js` 拆出 `server/routes.js`（63 行）与 `server/rpc.js`（95 行），`bridge` 可注入。`test/server.test.js`（121 行，8 个测试）覆盖：信任闸（415 / 代理头 403 / 跨域 403 / 合法本地通过）、路由状态码（200 / 404）、`synapse:fork-session` 占位符别名闭环（stub bridge，不打真实模型）、`GET /api/workspaces/:id` 缺失 404。
**注**：`activeSessionId` 原语改为 `activeSessionRef = { id: null }` 对象盒，供 `rpc.js` 共享可变状态。

#### ✅ P1-3 启动路径无感化
**落地**：`server/prestart.js`（31 行）——HTTP 探测 `/api/workspaces`（800ms 超时），未监听则 `spawn(..., { detached: true })` 拉起（不用 shell `&`，Windows 可靠）。`.claude/hooks/hooks.json` 注册为 `SessionStart` hook。
**commit** `1643a64`

#### ✅ P1-4 `escapeHtml()` 安全覆盖（图谱新增）

**问题**：K1——`escapeHtml()` 是度数最高的安全关键函数（13 条边），只有 Markdown 路径有测试，卡片渲染路径无测试。
**落地**：`test/markdown-renderer.test.js` 加 `loadEscapeHtml()` 辅助函数（同 vm 切片模式）与 2 个测试：4 种 XSS payload 经 `escapeHtml` 后无裸 `<>` 残留；`conversationCard` 标题路径的 `<script>` 必须实体编码。
**实现中的一次修正**：初版断言「输出不含 `onerror` 字符串」是错的——`escapeHtml` 编码 HTML 字符，不编码属性名。正确不变量是「无裸 `&lt;`/`&gt;` 存活」。**commit** `bcc9b1b`

### P2 — 实测不紧急

#### ✅ P2-1 收窄轮询触发条件
**落地**：`refreshProjection` 在 fetch 前后各取一次当前工作区的 `updatedAt`，相同则直接返回 `false`，跳过详情重取。

#### ⬜ P2-2 增量/条件请求（等语料长大 10 倍再做）
实测 689 KB / 8ms / 1ms parse，当前不是瓶颈。触发条件：`workspaces.json` 超过 ~20 MB 或单次响应超过 ~50ms。最小方案是 ETag + 304，不是设计 delta 协议。

#### ⬜ P2-3 轮次切分改用结构判据（G2）
用"下一条 user 行"闭合 assistant 组，去掉 `grew` 跨轮询状态。约 40 行，去掉一个时序近似、让边界行为一致。
**风险**：中——这块逻辑被 8 个测试钉着，改动要连带复核。

#### ⬜ P2-4 进程重启后的占位符恢复（A4）
`pendingForks` / `aliases` 落盘到用户状态文件（它们是不可重建的用户状态，正好归 P0-2 的那一份）。约 30 行。

#### ⬜ P2-5 清理移植残留（A2）
删 `loadThreadHistory` 空函数（8 处调用）与无调用者的 `messagesFromEvents`；或至少各加一行注释说明为何保留。约 20 行。**注意**：`markdown-renderer.test.js` 依赖 `app.js` 中 `'const escapeHtml'` 到 `'function canvasConnectors'` 之间的源码切片，改这块会连带影响测试。

#### ✅ P2-6 index.js 路由层拆分（图谱新增 K2）
C0（内聚度 0.10）和 C1（0.09）是全仓库最低。**落地**：`index.js` 拆出 `routes.js`（路由分发）与 `rpc.js`（RPC 分支），`index.js` 只留配置/初始化/定时器。与 P1-2 同步完成。

---

## 三·补 — 人工测试反馈的 UI 修复（全部完成）

首轮人工测试后由 6 个 worktree 并发修复，均已合并入 master。

| # | 问题 | 根因 | 落地 |
|---|---|---|---|
| 1 | 右下角无小地图 | 从未实现 | 160×100px canvas 浮层，绘制卡片矩形与视口框，点击/拖拽平移，主题自适应 |
| 2 | 缩放下限过大（0.6）无法全览 | `app.js:1374` `Math.max(.6, ...)` | 改为 `Math.max(.08, ...)`；新增「全览」按钮 + `fitAllCards()`（算边界框、取最大可容纳 zoom、居中） |
| 3 | 等待节点应缩略为圆点 | 从未实现 | `pendingReplies` 命中 → 48px 圆点，圆心显示 `${turnIndex + 1}`，`dot-pulse` 脉冲动画，双击进详情；`connectorPath()` 加 `dims` 参数对齐圆心 |
| 4 | 顶部「对话」按钮不跳转 | `data-action="close"` 触发的是关闭 RPC | 改为 `data-action="show-thread"`，`data-thread` 指向 `state.activeId`（无活跃时回退 `currentThread()`），无可用线程时 `disabled` |
| 5 | 左侧应为树形 | 首版树仅依赖 `parentId`，而多数会话彼此无分支关系 → 全部平铺为根节点 | `buildThreadTree` + `groupRootsByDate`：按 `updatedAt` 分日期组，7 天内默认展开，更早折叠；折叠 key `date-group:YYYY-MM-DD` |
| 6 | 「无意义节点」未自动缩略 | 红框里的 `/plugin marketplace add` 等已完成卡片不在 `pendingReplies` 中 | 触发条件从 `isPending` 扩展为 `isPending \|\| (card.answer === null && card.error === null)`；`aria-label` 区分「等待回复」与「等待助手」 |

**过程中发现并修正的一处判断错误**：`card` 对象没有 `messages` 字段，助手回复存在 `card.answer` 上。首版按 `messages` 判断会全部失效。

---

## 四、明确不做，以及为什么

| 不做 | 理由 |
|---|---|
| SQLite / 流式存储 | P0-2 拆完后 `workspaces.json` 预计 <100 KB；投影缓存用 jsonl 即可。没有实测到的规模需求。 |
| delta/增量协议 | 实测 8ms/689KB，不慢。P2-1 那 3 行已落地，无谓请求已消。 |
| token 认证 | 本机单人使用，content-type + Origin + 代理头三道闸之后无实测可达路径。只增加摩擦。 |
| `Sec-Fetch-Site`/`Sec-Fetch-Mode` | content-type 要求已经堵死跨站简单请求。 |
| 采用 cc-haha 的 `forkedFrom` 做血缘 | 实测 46 个文件里出现 0 次——那是 cc-haha 桌面端自己写的，真 `--fork-session` 不写。 |
| 从 cc-haha 的 `src/` 抄代码 | 它的 LICENSE 是笼统 MIT，但 `src/` 是 Anthropic 专有源码，`THIRD_PARTY_LICENSES.md` 未披露。读格式可以，抄代码不行。 |

---

## 五、验收方法与结果

1. ✅ **P0-1**：新增测试断言「UUID 超集是 fork、UUID 不相交的重试永不连边」；指纹路径保留为回退。
2. ✅ **P0-2**：`workspaces-projection.json` 与 `workspaces.json` 分离；缓存缺失时静默重建，用户状态不动。
3. ✅ **P0-3**：`unarchiveThread()` + `GET /api/sessions/archived` + 侧边栏恢复入口。
4. ✅ **P1-2 + P1-4**：信任闸 4 项、路由状态码 2 项、fork 别名闭环 1 项、XSS 2 项，合计新增 10 个测试（37 → 47）。
5. ✅ **P2-1**：`refreshProjection` 按 `updatedAt` 短路，空闲工作区不再重取详情。

---

## 六、实际执行顺序（已完成部分）

```
P0-2 (拆持久化)            ✅
  ↓
P0-1 (UUID 血缘)           ✅
  ↓
P1-2 + P2-6 (测试 + 拆分)  ✅
  ↓
P0-3 (归档恢复)            ✅  ← 图谱孤岛判断正确，确实可独立并行
  ↓
人工测试 → 6 项 UI 修复    ✅  ← 计划外的反馈驱动工作
  ↓
P1-1 (子代理) / P2-1 (3行) ✅
  ↓
P1-3 (启动预热) / P1-4 (XSS) ✅
```

**剩余**：P2-2 / P2-3 / P2-4 / P2-5 / P3，均无已知 bug 驱动，属改善性工作。

**回顾一处判断修正**：图谱判定 P0-3 为孤岛（C18，零依赖）——实际执行时它确实在任意时间点独立完成，与其他项无耦合。这条图谱结论得到了验证。

**新出现的计划外工作**：人工测试暴露了 6 个 UI 问题（小地图、缩放下限、等待节点形态、按钮跳转、树形结构、空回复节点），全部不在原评估范围内。这类问题只有真实使用才会暴露——评估覆盖了架构与算法，但覆盖不了交互手感。
