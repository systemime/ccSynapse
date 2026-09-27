# ccSynapse

**Claude Code 和 Codex 共用的可视化会话地图。** 把同一工作目录下的会话、追问、分支和子代理投影成一张可拖拽、可缩放的画布，并且可以从画布上直接发起分支。

两个 harness 的会话读进**同一张画布**，卡片上标出它来自哪个：`会话目录` 扫 `~/.claude/projects`，`Codex 会话目录` 扫 `~/.codex/sessions`，两边都存在就都画，缺哪边都只是跳过。Codex 侧目前是**只读**的——从画布分支/继续只对 Claude Code 会话开放（见下方「与宿主的边界」）。

是 [dsh-synapse](https://github.com/liangmianya/dsh-synapse)（DeepSeek Harness 的会话地图插件）在 Claude Code 上的移植。

## 它做什么

| 能力 | 说明 |
|---|---|
| 会话地图 | 每个工作目录一张画布，把该目录下所有会话的每一轮铺开。 |
| 只显示输入与输出 | 方形节点默认显示这一轮的**提问**和**助手的输出**；思考、叙述、工具调用、Skill、MCP、子代理收在底部徽标里，点一下就地展开。 |
| 真实分支 | 用 `claude --bg --resume <id> --fork-session` 从任意一轮开新分支，原会话不动。 |
| 血缘还原 | 终端里手工 `--fork-session` 产生的分支靠 **UUID 集合相交**认出（精确，不靠内容猜测）；子代理按生成它的那次工具调用挂到父会话，嵌套子代理逐层还原。 |
| 流式回显 | 回复还在生成时就显示在卡片上（1 秒粒度），不必等整轮结束。 |
| 会话树 | 左侧「会话」按日期分组，分支和子代理挂在父会话下。点一行就切到那个会话：画布跳到它最新一轮，落点卡片高亮闪一下。 |
| 搜索 | `Ctrl+K`（macOS `Cmd+K`）按提问和回答全文搜索并跳转。 |
| 追问更顺手 | 选中回答里的文字可以直接带进新的追问；常用补充词可编辑。 |
| 详情与归档 | 点卡片看完整会话记录；归档只改画布元数据，不动会话本身，且**可恢复**。 |

画布支持拖拽平移、8%–400% 缩放、右下角小地图定位、拖动卡片并自动保存位置、折叠/展开后续分支、一键定位当前会话、一键全览、卡片内平滑滚动与 Markdown 表格渲染。

## 安装

两种宿主，装哪个都行，**两个都装也行**——服务只有一个，画布是同一张。零依赖，只需要 Node ≥ 22。

### Claude Code

```
/plugin marketplace add systemime/ccSynapse
/plugin install ccsynapse@ccsynapse
```

### Codex

```bash
codex plugin marketplace add systemime/ccSynapse
codex plugin add ccsynapse@ccsynapse
```

> 本地克隆同理：把 `systemime/ccSynapse` 换成克隆目录的路径。

### 不用插件

```bash
git clone https://github.com/systemime/ccSynapse
cd ccSynapse && node server/index.js
```

## 使用

服务起来后打开 **http://127.0.0.1:3080/** ——画布就是首页，不需要点任何东西。

| 从哪开始 | 怎么做 |
|---|---|
| Claude Code | 敲 `/synapse`（停在 3080 的服务会被复用），它会顺手开浏览器 |
| Codex | 说「打开会话地图」（技能名 `synapse`） |
| 没用插件 | `node server/index.js`，然后自己开上面那个地址 |

服务是常驻进程，`Ctrl+C` 结束；端口被占用时会打印一条可读提示后退出，不会留下半启动的进程。

装了插件的话，服务会在**会话开始时自动预热**（`hooks/hooks.json` 的 `SessionStart`），所以 `/synapse` 通常只是开个浏览器。

进去之后：

- 左侧「工作区」下拉切工作目录，每个目录一张画布；「会话」树列出该目录下所有会话（分支挂在父会话下，子代理折成一行，悬停可看完整 UUID）
- 点会话树的任意一行 → 画布跳到那个会话最新一轮并高亮闪一下
- 卡片默认只显示这一轮的**提问**和**输出**，其余收在底部徽标里，点一下就地展开
- 卡片底部：`详情`（完整记录）、`终端`（在原生 CLI 里打开）、`归档`
- 画布：拖拽平移、滚轮缩放（8%–400%）、右下角小地图、「整理」「定位」「全览」
- 选中回答里的文字可以带进新的追问；`Ctrl+K`（macOS `Cmd+K`）全文搜索

## 配置

全部通过环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CCSYNAPSE_PORT` | `3080` | 监听端口 |
| `CCSYNAPSE_HOST` | `127.0.0.1` | 监听地址 |
| `CCSYNAPSE_HOME` | `$CLAUDE_PLUGIN_DATA` → `~/.claude/synapse` | 画布元数据目录 |
| `CCSYNAPSE_PROJECTS` | `~/.claude/projects` | Claude Code 会话记录目录 |
| `CCSYNAPSE_CODEX_SESSIONS` | `~/.codex/sessions` | Codex rollout 目录；不存在就跳过，不算错误 |
| `CCSYNAPSE_BG_ARGS` | 空 | 每次 `claude --bg` 追加的参数，见下方「后台会话的权限」 |
| `CCSYNAPSE_CLAUDE_BIN` | 自动探测 | `claude` 可执行文件路径 |
| `CCSYNAPSE_CODEX_BIN` | 自动探测 | `codex` 可执行文件路径（仅用于「终端」按钮） |
| `CCSYNAPSE_TRUSTED_HOSTS` | 空 | 额外允许的 Host（局域网访问时填写） |
| `CCSYNAPSE_THEME` | `light` | 画布主题；只有填 `dark` 会切暗色 |

### 两个数据文件，删除的后果不同

| 文件 | 内容 | 删了会怎样 |
|---|---|---|
| `workspaces.json` | **用户状态**：卡片位置、归档记录、分支别名 | 丢布局与归档，**不会动任何会话记录** |
| `workspaces-projection.json` | **可重建的投影缓存**：消息、工具记录 | 随时可删，下次启动自动重算 |

改投影规则、想重跑一遍时，删 `workspaces-projection.json` 那一个就够——删 `workspaces.json` 会连你的手工排版一起丢掉。

## 与两个宿主的边界

- 会话记录（`~/.claude/projects/**/*.jsonl`、`~/.codex/sessions/**/rollout-*.jsonl`）始终是唯一事实来源，ccSynapse **只读不写**。
- 插件不修改 prompt、模型请求、工具 schema 或 provider 路由。
- 服务默认只监听 `127.0.0.1`。

### Codex 侧能做什么、不能做什么

| | Claude Code 会话 | Codex 会话 |
|---|---|---|
| 投影到画布（提问、输出、工具计数、流式回显） | ✅ | ✅ |
| 血缘（fork 靠 UUID 相交、子代理挂父会话） | ✅ | fork 未验证；子代理不适用 |
| 从画布「分支」/「继续追问」 | ✅ `claude --bg --fork-session` | ❌ 明确报错 |
| 「终端」按钮 | `claude --resume` | `codex resume` |

Codex 侧的分支**没有做**，而且不是省略——`claude --resume <codex 的 id>` 认不出那个 id，会凭空开一个空的 Claude Code 会话，画布上就多出一张永远填不上的卡片。所以 RPC 对 Codex 会话直接返回错误，而不是让它错下去。要用 Codex 的会话，走它自己的 `codex resume` / `codex fork`。

同样**没做**的还有 Codex 侧的血缘自动识别：本机语料里 12 个 Codex 会话之间没有任何共享条目 id，没有 fork 可测，所以「`codex fork` 是否保留 id」这个问题保持**未验证**，也就不据此写任何启发式。

### 安全

`/api` 前面有三道闸：

1. **Host 允许名单** —— 挡 DNS rebinding。`localhost`、`127.0.0.1` 始终允许，其它加进 `CCSYNAPSE_TRUSTED_HOSTS`。
2. **代理痕迹检测** —— 带 `Forwarded` / `X-Forwarded-*` / `X-Real-IP` / `Via` 的请求一律拒绝。
3. **Origin 同源 + content-type 必须是 JSON** —— 挡跨站请求。

第三条不是形式主义。`text/plain` 和表单编码属于 CORS 安全列表，用它们发的跨站请求**不会触发预检**，能直接打到 `/api/rpc`——而这个接口可以起一个后台 Claude Code 会话。要求 JSON 就把浏览器逼回预检，而本服务不响应预检、也不发 CORS 头，请求就死在浏览器里。改动前后都实测过。

明确**没做**的两件事：没有加 `Sec-Fetch-Site`/`Sec-Fetch-Mode` 检查（content-type 要求之后已无实测可达路径），也没有加 token 认证（本机单人使用，只增加摩擦）。

## 已知限制

**解析会话记录用的是内部格式。** Claude Code 官方文档明确说明该格式「internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release」。本项目无法绕过这一点——官方支持的 `getSessionMessages()` 返回的是**压缩后**的消息链，会丢掉画布最需要的逐轮历史。所有解析都隔离在 `server/transcript.js` 一个文件里，遇到不认识的条目会跳过并在日志里提示一次，不会让服务崩溃。

**分支血缘靠 UUID 相交，所以需要双方都还在磁盘上。** 父会话被删除后，子会话会被重新当成根节点。这与「重启时会话表由磁盘重建」是同一套语义，不是额外限制。

**会话内分支很罕见。** 从同一点重新提问（撤回后改问）会在同一份记录里形成分叉，本项目能正确画出；但在实测语料里 47 个会话只有 2 处，而跨会话 fork 常见得多。

**流式回显是 1 秒粒度，不是逐 token。** 进行中的文本不在投影缓存里（那一轮还没结束），只能由 1Hz 的轮询捎带。

**后台会话的权限。** 分支走 `claude --bg`，它没有终端，需要授权的工具调用会被自动拒绝。如果分支卡在权限上：

```powershell
$env:CCSYNAPSE_BG_ARGS="--permission-mode acceptEdits"   # 或按需给别的模式
```

另外 `claude --bg` 要求工作目录已在 Claude Code 中被信任，否则会直接报 `Workspace not trusted`——这条错误会原样显示在卡片上。

**会话恢复不带回参数。** 地图上「终端」按钮执行的是 `claude --resume <id>`，而 `--mcp-config` / `--settings` / `--plugin-dir` / `--add-dir` 都不会随 resume 恢复。被恢复的会话行为可能与原会话不同。

**HOOK 不计入中间过程。** `attachment:hook_success` 的载荷是**注入给会话的文本**（比如某个模式的提示词），不是会话做过的事——一个 hook 计数说不出这轮在干什么，所以没为它加代码路径。

**压缩（compaction）之后的历史。** 会话记录是只追加的，所以压缩前的轮次仍在磁盘上，画布会照常显示；压缩摘要本身是机器写的，会被跳过，不会变成一张没人问过的卡片。

**部分工具结果是占位符。** 大块工具输出会被 Claude Code 挪到 `<project>/<sessionId>/tool-results/` 并留下存根，画布显示的就是那个存根。另外单条工具参数/结果超过 2000 字符会截断。

**画布布局在浏览器里。** 卡片位置存在 `localStorage`，按 origin 隔离；`workspaces.json` 里的位置只用于新建分支时的初始坐标。换端口或换 origin 打开会看到默认布局。

## 开发

```bash
npm run build    # node --check 全部 JS
npm test         # node --test，105 个测试
```

测试覆盖八块：`transcript`（Claude Code 投影与血缘）、`codex`（Codex 投影）、`workspace-store`（移植的行为测试）、`trust`（信任闸）、`server`（路由与 RPC）、`markdown-renderer`、`card-search`、`canvas-layout`。

`docs/DESIGN-NOTES.md` 记录了十一轮改造的实测数据与推理过程，包括几处**用测量推翻原有判断**的地方——这本项目的多数缺陷不是「写错了」，而是「同一个事实在多于一处被独立计算，其中一处算错」，那份文档记录了这条模式的具体形态。

## 来源与许可

MIT。衍生自 [dsh-synapse](https://github.com/liangmianya/dsh-synapse)：

- `server/workspace-store.js` — 移植自其 `index.js` 的 WorkspaceStore（存储、去重、工具折叠、迁移、锁与防抖），改动处均以 `ccSynapse:` 注释标出。
- `web/app.js`、`web/styles.css` — 移植自同名文件（画布引擎、卡片、Markdown 渲染、虚拟化、手势），改动集中在宿主桥接与文案。
- 其余（`server/transcript.js`、`server/bridge.js`、`server/index.js`、`server/routes.js`、`server/rpc.js`、`server/trust.js`、`server/prestart.js`、`web/index.html`）为本项目新增。

上游是三段式架构：服务端 + 注入宿主页面的桥 + iframe 应用。Claude Code 没有可注入的宿主页面，也没有可供插件挂载的本地 HTTP 服务，所以 `client.js`（宿主桥）被整体删除，`app.js` 里的 `postMessage` RPC 换成对自己的 `fetch`。
