# ccSynapse

Claude Code 的可视化会话地图。把同一工作目录下的会话、追问和分支投影成一张可拖拽、可缩放的画布，并且可以从画布上直接发起分支。

是 [dsh-synapse](https://github.com/liangmianya/dsh-synapse)（DeepSeek Harness 的会话地图插件）在 Claude Code 上的移植。

## 它做什么

| 能力 | 说明 |
|---|---|
| 会话地图 | 每个工作目录一张画布，把该目录下所有会话的每一轮提问和回答铺开。 |
| 真实分支 | 用 `claude --bg --resume <id> --fork-session` 从任意一轮开新分支，原会话不动。 |
| 工具折叠 | 按 `callId` 把工具调用和结果折进它所属的那张卡片，显示为「工具 N」。 |
| 追问更顺手 | 选中回答里的文字可以直接带进新的追问；常用补充词可编辑。 |
| 详情与归档 | 点卡片看完整会话记录；归档只改画布元数据，不动会话本身。 |

画布支持拖动画布与缩放（最高 4×）、拖动卡片并自动保存位置、折叠/展开后续分支、一键定位当前会话、卡片内平滑滚动与 Markdown 表格渲染。

## 安装

```powershell
/plugin marketplace add F:\Project\MyTool\ccSynapse
/plugin install ccsynapse@ccsynapse
```

然后：

```
/synapse
```

它会启动本地服务并打开 `http://127.0.0.1:3080/`。

也可以不经插件直接跑：

```powershell
node server/index.js
```

## 配置

全部通过环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CCSYNAPSE_PORT` | `3080` | 监听端口 |
| `CCSYNAPSE_HOST` | `127.0.0.1` | 监听地址 |
| `CCSYNAPSE_HOME` | `$CLAUDE_PLUGIN_DATA` → `~/.claude/synapse` | 画布元数据目录 |
| `CCSYNAPSE_PROJECTS` | `~/.claude/projects` | 会话记录目录 |
| `CCSYNAPSE_BG_ARGS` | 空 | 每次 `claude --bg` 追加的参数，见下方「后台会话的权限」 |
| `CCSYNAPSE_CLAUDE_BIN` | 自动探测 | `claude` 可执行文件路径 |
| `CCSYNAPSE_TRUSTED_HOSTS` | 空 | 额外允许的 Host（局域网访问时填写） |

画布元数据写在 `workspaces.json`。**删除它只丢布局和归档状态，不会动任何会话记录。**

## 与 Claude Code 的边界

- 会话记录（`~/.claude/projects/**/*.jsonl`）始终是唯一事实来源，ccSynapse 只读不写。
- 插件不修改 prompt、模型请求、工具 schema 或 provider 路由。
- 服务只监听 `127.0.0.1`。`/api` 前面有一道信任闸：Host 必须在允许名单内（`localhost`、`127.0.0.1` 始终允许，其它加入 `CCSYNAPSE_TRUSTED_HOSTS`），带任何代理痕迹头（`Forwarded`/`X-Forwarded-*`/`X-Real-IP`/`Via`）的请求一律拒绝，带 `Origin` 的请求必须是同源，写请求必须是 `application/json`。

  最后一条不是形式主义——它挡的是真实可达的攻击：`text/plain` 和表单编码属于 CORS 安全列表，用它们发的跨站请求**不会触发预检**，能直接打到 `/api/rpc`；而这个接口可以起一个后台 Claude Code 会话。要求 JSON 就把浏览器逼回预检，而本服务不响应预检、也不发 CORS 头，请求就死在浏览器里。改动前后都实测过。

  值得说明的是「没做」的两件事：没有加 `Sec-Fetch-Site`/`Sec-Fetch-Mode` 检查，因为上面的 content-type 要求之后已经没有可达路径；也没有加 token 认证，本机单人使用的场景下它只增加摩擦。

## 已知限制

**解析会话记录用的是内部格式。** Claude Code 官方文档明确说明该格式「internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release」。本项目的会话投影无法绕过这一点——官方支持的 `getSessionMessages()` 返回的是**压缩后**的消息链，会丢掉画布最需要的逐轮历史。所有解析都隔离在 `server/transcript.js` 一个文件里，遇到不认识的条目会跳过并在日志里提示一次，不会让服务崩溃。

**分支识别分两档。** ccSynapse 自己发起的分支是精确记录的。终端里手工 `/branch` 或 `--fork-session` 产生的分支靠内容指纹猜：要求两份记录有 **≥2 轮完全相同**的前导内容（提问 **和** 回答都要一致）。这意味着：只提问不重答的「重试」不会被误判成分支；反过来，只复制了一轮就分叉的会话识别不出来。宁可漏判，也不错判。

**后台会话的权限。** 分支走 `claude --bg`，它没有终端，需要授权的工具调用会被自动拒绝。如果分支卡在权限上，设置：

```powershell
$env:CCSYNAPSE_BG_ARGS="--permission-mode acceptEdits"   # 或按需给别的模式
```

另外 `claude --bg` 要求工作目录已在 Claude Code 中被信任，否则会直接报 `Workspace not trusted`——这条错误会原样显示在卡片上。

**会话恢复不带回参数。** 地图上「终端」按钮执行的是 `claude --resume <id>`，而 `--mcp-config` / `--settings` / `--plugin-dir` / `--add-dir` 都不会随 resume 恢复。被恢复的会话行为可能与原会话不同。

**子代理会话暂未纳入。** `<project>/<sessionId>/subagents/agent-*.jsonl` 目前不投影。子代理与父会话的关联不在 jsonl 里，而在同目录的 `agent-*.meta.json` 边车文件的 `toolUseId` 字段上。

**压缩（compaction）之后的历史。** 会话记录是只追加的，所以压缩前的轮次仍在磁盘上，画布会照常显示；压缩摘要本身是机器写的，会被跳过，不会变成一张没人问过的卡片。

**部分工具结果是占位符。** 大块工具输出会被 Claude Code 挪到 `<project>/<sessionId>/tool-results/` 并留下存根，画布显示的就是那个存根。另外单条工具参数/结果超过 2000 字符会截断。

**直接调 API 要带 JSON。** 服务只接受 `content-type: application/json` 的写请求，这是为了挡住跨站请求（见下方「安全」）。用脚本访问时别忘了 `-H 'content-type: application/json'`。

**改了投影规则需要重建画布。** 投影按行号去重，所以改动解析逻辑后请删除 `workspaces.json` 让它重跑一遍。

## 开发

```powershell
npm run build    # node --check 全部 JS
npm test         # node --test
```

测试覆盖两块：移植自 dsh-synapse 的 `workspace-store` 行为测试（原样通过），以及本项目新增的 transcript 投影与血缘识别测试。

## 来源与许可

MIT。衍生自 [dsh-synapse](https://github.com/liangmianya/dsh-synapse)：

- `server/workspace-store.js` — 移植自其 `index.js` 的 WorkspaceStore（存储、去重、工具折叠、迁移、锁与防抖），改动处均以 `ccSynapse:` 注释标出。
- `web/app.js`、`web/styles.css` — 移植自同名文件（画布引擎、卡片、Markdown 渲染、虚拟化、手势），改动集中在宿主桥接与文案。
- 其余（`server/transcript.js`、`server/bridge.js`、`server/index.js`、`web/index.html`）为本项目新增。

上游是三段式架构：服务端 + 注入宿主页面的桥 + iframe 应用。Claude Code 没有可注入的宿主页面，也没有可供插件挂载的本地 HTTP 服务，所以 `client.js`（宿主桥）被整体删除，`app.js` 里的 `postMessage` RPC 换成对自己的 `fetch`。
