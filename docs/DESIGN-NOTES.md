# ccSynapse 架构评估与改造方案

日期：2026-09-27（第七版） · 评估对象：`F:\Project\MyTool\ccSynapse` (v0.1.0, **83 tests passing**)
图谱：299 节点 · 655 边 · 19 社区 · 0 导入环 — `graphify-out/graph.json`
当前 HEAD：`61b4d50` · **全部 P0 / P1 / P2（除 P2-2）已完成**，P3 仅剩 `--bg` 权限应答；另有八轮实测/审查驱动的修复

---

## 完成状态总览

### 计划内项目

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
| P2-2 增量协议 | ⬜ | **不做** —— 实测 689 KB / 8ms，不慢 | — |
| P2-3 结构判据轮次切分 | ✅ | 见第五轮（方案被实测改写） | `9abcb85` `75bc19c` |
| P2-4 占位符重启恢复 | ✅ | `sessionAliases` 落进用户状态文件 | `b4f6ae0` |
| P2-5 清理移植残留 | ✅ | 删 `messagesFromEvents` + `loadThreadHistory` 及 8 处空转调用 | `3b9a813` |
| P3 · 卡片搜索 | ✅ | Ctrl/Cmd+K，搜索提问 + 回答 | `d8c5130` |
| P3 · 流式回填 | ✅ | `GET /api/live` + 已有的 `synapse:live-reply` 通路 | `b600144` |
| P3 · 会话内 DAG 分支 | ✅ | `parentSeq` → 按父行解析父卡片 | `91a5789` |
| P3 · `--bg` 权限应答 | ⬜ | 需要 `--sdk-url` 控制套接字 | — |
| 审查发现 11 · 分支布局 | ✅ | 行号 = 泳道 + 兄弟序号，位置算出而非推挤 | `53f758f` |

### 第一轮人工测试驱动的 6 项 UI 修复

| 问题 | 解决 |
|---|---|
| 缺小地图 | 160×100px canvas 浮层，点击/拖拽平移 |
| 缩放下限过大 | `0.6` → `0.08`，新增「全览」按钮 |
| 等待节点应缩略 | `pendingReplies` 或 `answer === null` → 48px 脉冲圆点 |
| 「对话」按钮不跳转 | 根因 `data-action="close"` → `show-thread` |
| 左侧应为树形 | `buildThreadTree` + 按日期分组折叠 |
| 无意义节点未缩略 | 同上（`answer === null && error === null`） |

### 第二轮：血缘方向修正（我自己引入的 bug）

| 项 | 问题 | 修复 | commit |
|---|---|---|---|
| 血缘方向反转 | `detectForks` 要求「父必须比子小」，而 fork 是快照、原始会话更大 —— 方向正好相反 | 父改为必须严格更大；选父 tie-break 取 uuid 最多者（原始），使同源快照成为兄弟而非链 | `bc13b0b` |
| 锚点退化 | 父变成持续写入的原始会话后，`seedLength = 父总行数`，三个分支全锚到最后一轮 | 加 `uuidLine` 索引，用「最后一个共享 uuid 在父中的行号 + 1」作边界。实测三个快照锚点 448 / 962 / 981 | `20d6cef` |
| 陈旧血缘残留 | 检测结果为「根」时没有任何路径清除旧父指针，`9d8d607b` 与 `36466d4f` 互指成环，两个都不是根 | 加 `clearLineage()`：检测是唯一真相源，本轮未确认的旧链一律丢弃 | `d58823a` |

### 第三轮：侧边栏与画布交互

| 项 | 根因 | 修复 | commit |
|---|---|---|---|
| 侧边栏样式错乱 | **不是 CSS 问题**：`button` 嵌套 `button` 是无效 HTML，解析器把箭头之后的子元素全抛出 `.tree-row` | 行改 `div[role=button][tabindex=0]`，键位补 Enter/Space；缩进封顶 `min(depth,4)*10`；消除横向溢出；真层级线 | `56e7d75` |
| 只有小把手能拖 | 整卡无拖拽入口；圆点卡片没有手柄 | 整卡可拖（排除 `button`/`a`/`.thread-answer`）；圆点本身就是手柄；实测可拖元素 16 → 20 = 卡片数 | `4474131` |
| 拖圆点导致连线断开 | 三处各自判断「是不是圆点」，`refreshCardConnectors` 漏判，永远按 310×276 整卡锚定 | 收敛为 `isDotCard()` / `cardSize()`，渲染、两条连线路径、草稿连线、全览边界、小地图全部共用 | `ec79803` |
| 树只有两层 | 嵌套子代理被压平：42 个 `agent-*.meta.json` 的 `spawnDepth` 分布是 `{1:32, 2:7, 3:3}`，但文件全平铺在同一 `subagents/` 目录，按目录推断必然全挂到主会话 | 按 `toolUseId` 解析真实父（投影时建 `issuedToolCalls` 索引）；目录降为回退；加环保护。实测某个多子代理工作区的深度 `{0:21, 1:4, 2:7, 3:3}` | `b8ab878` |

### 第四轮：锚点与索引的连锁修正

| 项 | 根因 | 修复 | commit |
|---|---|---|---|
| 25 个子代理锚在同一处 | `index.js` 硬编码 `seedLength = 0`；消费端 `sourceSeq < 0` 过滤为空，回退到第一张卡片 | 加 `issuedToolLines` 索引（tool_use id → 行号），子代理锚到生成它的那一轮。实测 27/27 有值且互不相同，范围 49~2925 | `dc7a7ff` |
| 3 个子代理挂到错误的父 | **fork 会复制父的 assistant 行，同一 `tool_use` id 在每个副本里都被「发起」过**；`issuer` 索引先写入者胜出，胜出者是任意的 | 目录属主发起了该调用 → 保持目录父；未发起 → 才用 issuer 覆盖。判别信号干净：嵌套代理 `ownerIssued=false`，被污染的 `ownerIssued=true`。全库 `reParented` 13 → 10，恰等于嵌套代理数 | `02288a5` |
| 侧边栏被子代理淹没 | 33 行里 27 行是子代理（82%），真正有用的会话与分支被埋 | 同一父下的子代理收进默认折叠的合成节点「子代理 (N)」。顶层 6 行：根会话 + 3 分支 + 合成节点 + 独立会话 | `769bb95` |

**注意 `dc7a7ff` 与 `02288a5` 的连锁**：前者把子代理锚到生成行，后者的第一版修法（用 `continue` 提前退出）会让「目录属主胜出」的 3 个代理**丢掉 `parentSeedLength`**，退回成锚在父会话末尾——即前者刚修掉的行为。最终改为把 `realParent` 选成 `owner`，规则与锚点同时正确。**这提醒了一件事：在这套代码里「改父选择」和「算锚点」共用一个循环，任何提前退出都要同时检查两件事。**

---

## 反复出现的缺陷模式

四轮下来 13 个修复，其中 **7 个是同一类**：**同一个事实在多于一处被独立计算，其中一处算错或漏算。**

| 事实 | 被计算的地方 | 漏/错的一处 | 后果 |
|---|---|---|---|
| 「这张卡片是不是 48px 圆点」 | 渲染、首次连线、拖拽重算连线 | 拖拽重算（完全没判） | 拖动后线断 |
| 「卡片占多大」 | 连线、全览边界、小地图 | 全览/小地图（永远按整卡） | 圆点占去不存在的空间 |
| 「这个 thread 有没有父」 | 目录推断、`toolUseId` 解析 | 两者冲突时无裁决规则 | 3 个子代理挂错父 |
| 「谁发起了这次工具调用」 | `issuer` 索引 | 先写入者胜出，副本污染 | 同上 |
| 「父是谁」 | `detectForks` 的方向约束 | 反了 | 原始会话变成孙子节点 |
| 「子代理锚在哪一轮」 | `seedLength` | 硬编码 0 | 25 个挤在一处 |
| 「无回复的卡片怎么显示」 | `pendingReplies` 判断 | 与渲染判断不一致 | 不拖也错 |

**每次的修法都不是「补上错的那处」，而是把它收敛成单一来源**：`isDotCard()` / `cardSize()`、检测结果作为唯一真相源、`ownerIssued` 裁决。补一处只会让下一个消费方再漏一次。

**对后续维护者的建议**：
- 新增任何「按卡片形态取尺寸/位置」的代码，走 `cardSize()`，不要自己写 `CARD_WIDTH`。
- 新增任何「父是谁」的判断，记住 `detectForks` / 子代理解析 / `applyLineage` 是一条链，改一处要想链条下游。
- `server/index.js` 的子代理循环里「选父」和「算锚点」共用一次迭代，提前退出必须同时检查两件事。

### 第五轮：P2-3（方案被实测改写）

计划原文是「用下一条 user 行闭合 assistant 组，去掉 `grew` 跨轮询状态」。**实测推翻了它**：

- `stop_reason` 在**每一行**都重复（`{tool_use: 1004, end_turn: 67}`），标不出「最后一块」
- 「下一条 user 行」只解决「后面有 user 行」的情况，EOF 处仍需猜——**替代不了 `grew`**

但测量暴露了另一个真问题：**同一 `message.id` 的行会被从中间切开**（2667 条多行消息里 529 条如此）。原来「任何非 assistant 行都关闭组」是**碰巧安全**——块顺序 thinking → text → tool_use 让文本恰好总落在第一段。

**全语料分类**（「同一 message.id 两段 assistant 之间的每一行」）：

```
783  user:array 带 tool_result          ← 回答本组自己发出的调用
  6  attachment                        ← 工具结果的正文载荷
  4  user:array 不带 tool_result [text] ← skill 正文这类注入载荷
  0  string 提问 / 0 system / 0 各种 meta 类型
```

只放宽这三类，其余（真实提问、`system` 含 compact boundary、meta 类型）照旧关闭——没有依据的一律不给 pass。三类**缺一不可**（逐类单独摘掉验证：摘掉任一类，目标卡片都停在 seq 16；三类齐全才到 seq 25）。

**结果**：缺陷在真实语料仍是 **0 例**丢文本（连 payload 路径的第二段也只有 tool_use），所以收益是**把「碰巧安全」变成「结构上安全」**，不是修一个正在发生的 bug。

**验证方法值得记下**（比计数有力）：冻结快照法——该文件正被会话实时写入（两次跑之间从 309 长到 312），先 `cp` 成快照、md5 固定，两次跑读同一份字节；然后断言**全量事件集（type + 文本长度 + 文本前 40 字符）`diff` 为空**。1818 行两侧一致，唯一变化是那张卡的 seq 16 → 25，正是合并本身。

### 第五轮：其余三项

| 项 | 做法 | 验证 |
|---|---|---|
| P2-4 别名持久化 | `workspaces.json` 的 `sessionAliases`（用户状态，不可重建）；`rpc.js` 加可选 `onAlias` 回调即时落盘；启动时 `await store.listAliases()` 填入 | **对照实验**：预置别名 → 重启后 1 线程；去掉别名 → 2 线程（空占位 + 重复线程），精确复现原缺陷 |
| P2-5 清理残留 | 删 `messagesFromEvents`（无调用者）+ `loadThreadHistory`（空函数、8 处调用）；顺带删掉被暴露的两处冗余 `render()`（原本中间夹着已消失的 `await`，第二个条件严格更强） | 58 测试 + 浏览器实测挂载正常、无错误横幅 |
| P3 搜索 | Ctrl/Cmd+K；复用 `focusActiveCard` 的相机算法抽成 `centerCanvasOnCard`；浮层挂 `document.body`（`render()` 会重建 `app.innerHTML`） | 12 条结果、方向键 0→1→2→1→0→11 循环、Escape 关闭；XSS 端到端 img/script 节点数 = 0 |

**一个只有真实使用才会暴露的设计事实**：卡片拖拽位置存在 **localStorage**，按 origin 隔离，**不写服务端**。服务端的 `thread.position` 只用于建分支时写初始坐标。这意味着换端口/换 origin 打开画布会看到默认布局——不是 bug，但值得知道。

---

## 验证方法的三次自误

第五轮里我连续三次「发现」了并不存在的缺陷，全是探测方法的问题。记下来：

| 我的结论 | 实际原因 |
|---|---|
| 「Escape 关不掉浮层」 | 浮层元素**常驻 DOM**，开关靠 `hidden` 属性；我检查的是元素是否存在，恒为真 |
| 「方向键不动选中项」 | 在按键**之前**抓取了结果节点数组；`paintCardSearch()` 会重建 DOM，旧节点脱离文档后仍带旧的 `active` 类，`findIndex` 恒返回 0 |
| 「键盘完全无响应」 | 用 `input.focus()` + 合成事件的组合，但页面没有真实焦点时 focus 不生效；改用 `agent-browser-cli send-keys` 的真实按键后 Ctrl+K、Escape 均正常 |

**教训**：验证一个交互时，先确认「我读到的是不是这个状态的权威来源」。DOM 存在 ≠ 可见；节点引用 ≠ 当前节点；合成分发 ≠ 真实输入。三次里有两次若直接上报，就会变成假缺陷——和 P0 阶段那个「UUID 会被重映射」的文档误读是同一类错误。

**第六轮又犯了第四次同类错误**（见下），所以这条不是一次性的疏漏，是需要制度化的检查项。

---

## 第六轮：P3 的两项

### 流式回填（`b600144`）

**客户端早已就绪，服务端从没发过消息**：`app.js:2193` 处理 `synapse:live-reply`，`:724` 把它叠加到最新一轮的 answer（条件是 `answer === null || pending`），`applyLiveReplyToCard` 就地打补丁避免重绘。缺的只是数据源。

做法：`sync()` 的 session 记录暴露 `liveText`（当前卡在 EOF、尚未 drain 的组的累积文本，按 store 的 `MAX_PROJECTION_LENGTH` 截断）→ `GET /api/live`（key 经 `toLocal`）→ 客户端挂在已有的 1Hz `pollProjection` 上，用模块级 `liveSessions` 集合判断 `running:false`。

**顺手修掉一个会毁掉本功能的既有 bug**：`sync()` 里

```js
if (events.length === 0) { if (cache.primed) continue }
```

被持有的组再收到新文本行时**不产出任何事件**，于是被早退跳过，`sessions` 记录（连带 `liveText`）永远停在第 1 段。改成 `cache.primed && cache.open === null` 才跳过。代价为零——`projectEvents([])` 在 `workspace-store.js:293` 直接 `return null`，不触发 `mutate`、不写盘。

**明确的硬边界**：这是 **1Hz 刷新，不是逐 token 流式**。进行中的文本不在 store 里（组被 `grew` 持有），只能由这个轮询捎带；store 自身的投影也在同一节拍落地，更细的时钟拿不到更多信息。做真流式需要 SSE/WebSocket，而这套架构没有推送通道——代价不匹配收益。

### 会话内 DAG 分支（`91a5789`）

**计划里的判断被实测推翻**。原话是会话内分支「比跨会话 fork 常见得多」：

- 全语料 47 个文件里，真正的会话内分支（两个**用户提问**共享一个父节点）**只有 2 处**
- 跨会话 fork 仅 ccSynapse 一个工作区就有 4 个

**一大类干扰项必须排除**：每个文件里都有大量「多于一个子节点的节点」，但那是**并行工具调用**：

```
10 assistant tool_use WebFetch   ← 父
11 assistant tool_use Glob       ← 挂在 10 下
20 user tool_result (答复 10)     ← 也挂在 10 下，因为它是 10 的结果
```

工具结果挂到**它所答复的那次调用**的节点上。用户完全感知不到，不该做任何 UI。

两处真实分支同形——**从同一点重新提问**，且第一次提问都没有助手回复：

```
669 system
670 user  「帮我把P盘里…这个开头给去掉」        ← 撤回
673 user  「帮我把P盘里…这个开头给去掉，重命名」  ← 重发，父节点同样是 669
```

根因：`app.js:754` 的 `if (card.turnIndex > 0) card.parentId = siblings[card.turnIndex - 1].id`——**每一轮无条件挂到前一轮**。

做法：提问行用已有的 `uuidLine` 索引查 `parentUuid` 得到 `parentSeq` → 挂到事件上 → store 条件展开成 `sourceParentSeq` → 客户端 `turnCardContaining()` 按「一轮 = 从自己的提问到下一轮提问之前」的窗口解析父卡片，字段缺失或落在所有轮之前时回退到 `turnIndex - 1`。布局、thread 身份、去重逻辑、并行工具「分叉」都没碰。

**子代理纠正了我给的验证判据**：我要求断言「其余所有提问的 `parentSeq` 都等于它前一行的 seq」。真实数据里**不成立**——`1579` 的父行是 `1573`、`1630` 的是 `1624`（父行是上一条 assistant/system 行，不一定是 seq-1）。但这些解析出的**卡片**仍等于 `turnIndex-1`，所以不是分叉。**判据必须算在卡片层（窗口包含），算在 seq 层会把这两处误报成分叉。** 这是一条我没有想到的区分。

### 第六轮：第四次同类验证失误

我在验证 `/api/live` 时连续三次判定「功能不工作」，全部是同一个错误：**把 session 的 key 当成了 JSON 里的 `sessionId` 字段，实际是文件名**（`sess.jsonl` → `sess`，而 JSON 里写的是 `s`）。

```
错误判据:  '"s"' in response        ← 永不匹配 "sess"
真实响应:  {"sessions":{"sess":"seg1…seg12"}}
```

加上第五轮那三次，**六次「发现」里五次是探测方法的问题**。共同的形状是：**我假定了一个标识符/状态的含义，而没有先把它打出来核对**。

**制度化的检查项**（写给后续维护者，也写给我自己）：
1. 断言某个键存在前，先把实际的键/响应原样打出来一次
2. 改判断逻辑前，先确认被判断的值是从哪来的（文件名？字段？渲染后的 DOM？）
3. 验证「功能不工作」时，先用最小脚本在**最底层**确认数据正确，再逐层向上找——本轮就是靠这个定位到「transcript 层正常、问题在我的断言」

---

## 第七轮：代码审查驱动的修复

`/code-review` 对 `4f99f81...HEAD`（第六轮的两个功能）出了 **13 项行为缺陷 + 2 项清理**。这一轮的价值不在于找出了多少，而在于**它拿出的都是实测数据，并且推翻了我自己的一条复现**。

### 审查推翻我的地方（先记这个）

我声称「流式在连续生成时完全不可见」并给出了复现数字（`cards:1 dots:1 hasThreadAnswer:false`）。子代理指出这份证据**可能被隐藏标签页污染**：客户端在 `document.hidden` 时不跑轮询、rAF 被暂停，后台标签量到的恰好就是那个状态。我回查时**没有核对 `document.hidden`**。

更重要的是：`agent-browser-cli exec` 作用于**当前活动标签页**——我实测时它落在用户正在浏览的页面上，读到了 16 个标签的标题与 URL。**这是越界操作**，且说明我当时的测量环境根本不可控。

子代理的替代方法更强：**同一个可见标签内**做 master 与 fix 对照，数字成对出现，并给出 fix 自身的过渡曲线（`t≈5s dots:2 → t≈12s dots:0`，起点与 master 一致）。同环境前后对照同时排除了「初始状态不同」与「环境不同」两类混淆。**这条方法应当成为画布类验证的标准做法。**

另外它如实报告了**审查发现 12（补丁毁滚动）在 master 上无法复现**（`innerHTML` 替换并未把 `scrollTop` 归零，实测停在 40），因此没有把它算作「已修的缺陷」——它自己实现里的保存/恢复是新路径所必需，不是修旧账。

### 三条已确认的缺陷（我在 master 上独立复现过两条）

| 缺陷 | 实测 | 根因 |
|---|---|---|
| 流式在连续生成时不可见 | 可见标签对照：`cards:4 dots:2`（流式卡是圆点）→ 修复后 `cards:4 dots:0` | 进行中那一轮 `answer === null` → `isDotCard` 为真 → 圆点分支不产出 `.thread-answer` → 补丁首行 `return`；而组被持有时没有任何东西触发渲染，**没有兜底** |
| DAG 功能在既有数据上什么都不做 | `sourceParentSeq` **0 / 256** 条 user 消息 | 字段只在消息**首次创建**时附加，而 `projectEventInto` 跳过 seq 已存在的事件；重放每次启动都在跑，只是全部落成空操作 |
| 每次启动误报几十个会话在生成 | 首轮 `liveText` **72 / 121**，次轮 0 | 首读必然让尾部组保持打开，而 `liveText` 只看「组是否打开」、无新鲜度门槛 |

### 修复与各自的证据

| commit | 内容 | 关键数字 |
|---|---|---|
| `a020cc7` | 回填 `sourceParentSeq`（只填不覆盖）；原地重写时清掉 `uuidLine`/`uuidSet`/`issuedToolLines` 等按行号索引的状态 | 真实数据 **0 → 153/262**；673/670 的父都是 669；分叉**恰好 2**，并行工具调用 0 误判；消息丢失/改动/覆盖 0/0/0 |
| `978bdf0` | `LIVE_WINDOW_MS = 60_000` 新鲜度门槛；`assistant/message` 带 `messageId`、store 内合并续写；清理消失的会话；`#listTranscripts` 读不到 root 时返回 `null` | 首轮误报 **72/121 → 1/121**（剩余那个是 52 秒前真写过的）；停顿续写 `"后半句"` → **`"前半句\n后半句"`**；目录移走后 master 永久冻结 → 改后 2.5s 变 `{}` |
| `c5886aa` | live 文本注入抽成 `applyLiveAnswer` 供渲染与补丁共用（单一来源）；补丁按**模型**定位目标卡而非 DOM 顺序；`canvasAllCards`（未折叠全量表）；滚动保持；rAF 槽位改 `Set`；`running:false` 合并为一次重取+渲染 | 错误卡片：master 把已答完的 161 字覆写成 4402 字 → fix 保持 161；两会话 master 一张冻结 → fix 双卡同步；渲染合并 master `burst:7` → fix `burst:1`；收尾不再跌回圆点 |

### 门槛值是测出来的，不是拍的

`LIVE_WINDOW_MS` 的取值依据是「同一条 assistant 消息相邻两行之间的停顿」实测分布：**p50 0.39s / p90 2.2s / p99 15s / max 137s**（47 文件 3416 个间隔），取 60 秒。而且论证了**错误代价的不对称**——漏报的代价为零（那段文字下一 tick 由 `grew=false` 的释放照常落进 store，不丢字），误报的代价是「已完成会话卡片上闪一下正在回复」。所以该往大取。

### 两个方案被实测否决

**我建议的缓存版本号方案作废。** 我提出给投影缓存加版本号、版本低就丢弃重建。子代理指出这**按我说的做法成不了事**：`projectEventInto` 的 seq 去重比对的是 `thread.messages`，而那份 messages 正是启动时从投影缓存 merge 进来的——丢弃缓存后重放照样被同一处去重吞掉。要让版本号生效必须**连 messages 一起丢**，那会让 transcript 已删除的线程永久丢卡片，且每加一个字段就要再全量重建一次。而实测发现重放**每次启动本来就在跑**（150 条带 `parentSeq` 的事件被重放），缺的只是允许改已存在的消息。**3 行 vs 一条会丢数据的重建链路。**

**另一处否决**：审查建议在客户端合并同一轮的多条 assistant 消息。子代理指出那会把「文本→工具→文本」这种**正常**多消息轮的正文也拼进 answer，改变普通轮次的语义，且详情视图与卡片会不一致。选择在服务端按 `messageId` 合并，改的是根因——`AssistantGroup` 的注释早就写明「一条 API message 必须塌成一个事件」。

### 一次差点静默回滚的合并冲突

`fix-live-gate` 与 `fix-dag-backfill` 都改了 `projectEventInto`。前者把去重位置重构成 `messageId` 续写查找时，**顺带丢掉了后者的回填分支**。若按常规「用 incoming 覆盖」解冲突，DAG 修复会被静默回滚，而 **77 个测试照样全绿**——因为回填没有对应的测试断言。已把回填写回保留下来的那个去重位置（重放唯一丢弃重读值的地方）。

**这条值得单独记住：一个修复没有测试覆盖时，它在合并冲突里是隐形的。**

### 修复自身引入的反向风险（子代理主动堵上）

`#listTranscripts` 原本把「读不到 root」和「root 为空」都返回 `[]`。加上「清理消失会话」的逻辑后，**一次 readdir 失败就会清空所有会话**，并通知画布全部 `running:false`。改成读不到返回 `null`、保持上一次已知状态，并补了单测。**没有这一条，这个修复会引入比原缺陷更严重的问题。**

### 剩余未决

需要你定的两条（都是取舍，不是缺陷）：

1. **工具调用之后不再预览新段落**。共用闸门保留了 `answer === null || pending`，所以 store 已提交答案、新一段仍在流时，卡片显示已提交文本。放开它是一行，但那等于让部分文本盖住已提交答案（master 那种每秒横跳）；正确的修法是让 `/api/live` 带上组的 seq（服务端范围）。
2. **从画布发出的消息整轮是圆点**。`isDotCard` 的 `pendingReplies` 子句未动，所以画布上「追问/分支」发出的消息不预览流式文本。这不是退化（与流式功能存在之前一致），只是与终端发出的消息不一致。改它一行，但属 UX 决策。

审查发现 11 当时无人负责，已在第八轮修复（见下）。

---

## 第八轮：审查剩余的四条发现

第七轮修了三条，留下发现 8 / 11 / 14 / 15。这一轮把它们做完，**三条修复（含一条合并冲突）合并后 83 个测试通过**。

### 发现 11：分支没有布局表示（`53f758f`）

`positionFor` 里 x 只由血缘决定、**y 只由 `laneByThread` 决定**——同一 thread 里的两个兄弟因此拿到**完全相同的 (x, y)**，靠 `firstAvailableCardPosition` 把第二个往下推 318px。位置来自碰撞推挤而非布局计算，读起来像链条延续，且被推的卡片若落在别人的自然位置上会**连带推移无关会话的卡片**。

修法不是给分叉打偏移补丁，而是**看出 x 与 y 承担的是两种不同语义**：x 是「列」（血缘深度），y 是「行」。于是把位置拆成两遍算——行号 = 该 thread 的 lane + 同父下的兄弟序号（第一个孩子序号 0，所以原有行不变）；若目标格已被别人按其自身行列占用，**分叉自己再下一行**。

| 项 | 改前 | 改后 |
|---|---|---|
| 靠碰撞定位的卡片数 | 1 | **0** |
| 真实画布 35 会话 / 65 张卡片的坐标变化数 | — | **0** |
| 跨会话连带推移 | 两张被推 | 全部原位 |
| 线性 5 轮会话坐标 | `86,82 / 451,82 / 816,82 / 1181,82 / 1546,82` | **逐一同值** |

### 发现 8：陈旧的 liveReplies 跨工作区泄漏（`baa99e6`）

`running:false` 的清除被包在「线程必须在当前工作区」的闸门内，而 `pollLiveReplies` 里 `liveSessions = next` **无条件替换**。会话在别的工作区结束时，清除被跳过、id 又被移出集合 → 永不重试 → 那条 `{running:true, text:<旧部分文本>}` 永久留存。而 `conversationCards` 的注入条件不要求 `pendingReplies`，于是回到该工作区发起新一轮时，**旧文本被当作新问题的答案显示**。

修法：map 的 set/delete **提到闸门外无条件执行**，闸门降级为「要不要重绘」。`running:true` 也一并放行——不放行会留下「在别的工作区生成的会话，切过去看不到部分文本」的同类时间窗；放行无副作用（找不到卡片时补丁只更新模型，是第七轮 `fix-live-paint` 建立的语义）。

**子代理自己找到了第二处，而这一处更好：** `liveSessions` 是「服务端上次报了什么」的**第二份记录**。原逻辑只对上一 tick 出现过的 id 发 `running:false`，所以任何不在该集合里的条目**永远不会被清**。改成直接用 `state.liveReplies.keys()` 与 `next` 做差——**map 本身就是唯一记录**，删除因此是原子的、不会再漂移，`liveSessions` 变量整个删掉。这与本项目反复吃亏的模式是同一条解药：**不是补上漏的那处，而是让它没得漏。**

### 发现 14：同一查询两个实现（`7909d94`）

「哪一轮拥有这一行」在客户端有两处实现，边界约定还不同（fork 用 `< seedLength`，分支用 `<= seq`）。

我原本担心统一会改坏 fork 锚点，要求先验证再动手。**验证推翻了我的担心，但原因和我预想的不同**：两处传的**不是同一个参数**——fork 传的是**排他边界**，分支传的是**行号**。子会话继承 `[0, seedLength)`，最后一行是 `seedLength - 1`，所以 fork 站点改成 `turnCardContaining(parentCards ?? [], seedLength - 1)` 与原语义**完全等价**。既没取平均，也没改锚点语义。

验证里三样东西值得成为标准：
1. **真实数据回归**：真实 `workspaces.json` 跑真实 `conversationCards`，改前改后 **265 张卡片 0 处不同**，77 个 fork 锚点全同值（其中 47 个锚在非首轮——只有这些才可能被边界改动影响）
2. **正向对照**：把查询挪 100 行，同一脚本报出 **55 个锚点移动**——证明比对不是恒真的
3. **主动说明证据边界**：真实语料里**没有**「父提问正好落在切线上」的样本，所以真实数据**区分不了** `<` 和 `<=`，那一位只能由合成用例钉住

第 3 条尤其重要：前面几轮我的错误里有一半是「拿一个测不出结论的数据去下结论」。

### 发现 15：测试不覆盖接线（`7909d94`）

新测试用 `indexOf('function turnCardContaining')`…`indexOf('function conversationCards')` 做切片——依赖两个函数名**相邻**，重排即空切片报 `is not defined`；更严重的是**没有任何测试执行 `conversationCards`**，所以删掉 `sourceParentSeq` 的传递或回退分支，测试照样全绿。

**这条不是形式主义**：第七轮合并时，`fix-live-gate` 重构去重位置丢掉了 `fix-dag-backfill` 的回填分支——按常规解冲突会把 DAG 修复静默回滚，**而当时 77 个测试全绿，因为回填没有断言**。没有测试覆盖的修复，在合并冲突里是隐形的。

修法：切片改成**命名标记 + 断言**（复用 card-search / markdown-renderer 已有的窗口，不复制第四份 harness），并加载真正的 `conversationCards`。三条新断言各被**对应的变异证明会红**：删除字段传递 → AssertionError；删除回退 → TypeError；把 `seedLength - 1` 改回 `seedLength` → AssertionError。

### 这一轮的方法改进

`fix-stale-live` 主动记下了它如何避免第七轮那类污染：**全程未对用户活动标签页执行过任何 exec**，自己的标签页始终带 `--tab`，且每个页面脚本第一行断言 `location.href` 是自己开的 URL，不符即中止；发现用户窗口遮挡会让 `document.hidden=true` 后，改用**独立的 headless Chrome（CDP）**验证，用户浏览器只用于开关自己的标签页。

并把结论写进了复现证据：headless + 隔离服务端，**同一脚本同一 fixture 前后各跑一遍**，改动前后两栏数字成对出现。

---

## 第九轮：卡片显示「输出」，过程收进徽标（`feat/io-only`）

原话是「画布中默认方形节点展示的是实际输出和用户输入，中间思考、工具调用、HOOK、MCP 调用、SKILL 加载等全部缩略」。现状比表述更糟：卡片渲染 `answer = replies.at(-1)`——该轮**最后一条**助手消息。实测一轮 72 条助手消息、11274 字，卡片显示 22 字「No response requested.」。

### 判据：结构性，不靠长度或关键词

`intermediate` 由服务端 `AssistantGroup` 出：`drain()` 时 `this.toolCalls.length > 0`——**该 API 消息带没带 `tool_use`**。数据支持：真实语料 1043 条带文本的 API 消息里 882 条带工具调用（「我先看一下…」），161 条纯文本，**纯文本平均长 74%**。叙述短、答案长。

**但判据照抄只能改 4 张卡里的 1 张。** 把「最后一条 <200 字而整轮 >600 字」的 11 轮逐条打开看，才发现真正的元凶：那 22 字是 `model: "<synthetic>"`——Claude Code **自己写的**助手消息（中断后的 "No response requested."、模型/鉴权报错），共 13 条。结构判据把它们当纯文本输出，所以「72 条消息」那轮照旧 22 字。

于是加第二个字段 `synthetic`（`isSyntheticMessage`）。**为什么是两个字段而不是把 synthetic 折进 `intermediate`**：13 条里 9 条是**该轮唯一文本**——它们是错误报告本身，卡片必须继续显示；另外 4 条挂在被中断的长轮尾巴上。客户端按三级取值才能同时满足两边：

```
最后一条 非叙述且非 synthetic  →  最后一条 非 synthetic  →  最后一条  （不回退就成空卡片）
```

第三级实测覆盖 10 张卡（9 条错误通知 + 1 条），**改前改后逐字节相同**；中间级救的是那三张长轮。

### 徽标与展开

徽标把原来的「工具 N」换成按钮，分类计数：**思考**（thinking 块数之和，服务端只传计数不传文本）· **叙述**（`intermediate` 条数）· **工具** · **Skill** · **MCP** · **Agent**（`Task` 是 subagent 工具改名前的名字），**计数为 0 的类别不画**。语料分布：思考 1724 块 / 205 张卡，叙述 209，Agent 33，Skill 11，MCP 3——所以常见卡只有两三个 chip，点名的那两类只在实际出现时才多一行。

展开**复用详情视图的 `processRecords`**，且徽标带的就是那个 section 自己的 `data-message` key ⇒ 开合状态直接落在既有的 `state.expandedMessageIds` 上，**没有新增 state、没有新增 action**，一次点击同时展开章节和条目。面板放在 `.thread-answer` 内部（那个区域本来就 `overflow-y: auto`），因此 **310×276 的尺寸契约不动**，连线锚点、虚拟化、minimap 全不受影响。

### HOOK：选 B，不做（理由写在代码注释里）

`attachment:hook_success` 在顶层会话里 9 条（全语料含子代理 70 条）。打开看内容：`hookName` / `hookEvent` / `stdout`，**载荷是注入给会话的文本**（本语料里就是 ponytail 模式提示词），不是会话做了什么事。与工具调用、Skill 加载、子代理启动不同，一个 hook 计数说不出这一轮在干什么，所以不值得为它加代码路径。会话真做过的事都是 `tool_use` 块，那些已经计入。

### 实测（真实语料，`master` 与工作区两份 `app.js` 跑同一份投影）

| 项 | 数字 |
|---|---|
| 卡片数 / 答案变化 | 247 / **4** |
| 变长 / **变短** | 4 / **0** |
| 答案总字数 | 444931 → 445995（+0.2%） |
| 极端轮（72 条消息 / 11274 字） | **22 字 → 220 字**（"Found a real bug: **the alias never applied**…"） |
| 另两条中断长轮 | 22 → 198、22 → 146 |
| 纯叙述型（判据原点） | 31 → 597 |
| 10 张只含通知的卡片 | 逐字节不变 |

浏览器实测（独立 headless Chrome + CDP，隔离 `CCSYNAPSE_HOME`/`CCSYNAPSE_PROJECTS`/端口 3094，未碰用户标签页）：卡 1 显示纯文本结论而非「我先读一下…」，卡 2 显示「正在改测试夹具…」而非 "No response requested."；徽标点开列出「叙述 / Read / Skill / mcp__github__list_issues」，卡高仍 276、答案区内部滚动；再点收起；条目可单独展开。追加流式轮次后新卡先出部分文本、收尾落到最终答案——流式路径未动。

### 一处差点漏掉的回填

`projectEventInto` 的 seq 去重有两个入口：按 `sourceSeq` 的 `existing` 分支（提示词走这条，也是 `sourceParentSeq` 回填的地方）和**按 `messageId` 的 `carried` 分支**（助手消息走这条，重放时在 `sourceSeqs.includes` 处**提前 return**）。新字段只填在 `existing` 里，写着「回填已处理」而实际对助手消息永远不生效——**测试先红了一次才暴露**。修法是把填充放进 `carried` 的提前返回分支，并区分两种合并：同一行重读 ⇒ 只填不覆盖、thinking 取大；同一条消息的**另一半** ⇒ 布尔只置位、thinking 相加（行号不同才加，否则每次重启都会涨）。

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
