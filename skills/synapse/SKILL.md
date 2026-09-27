---
name: synapse
description: 打开 ccSynapse 会话地图 — 把 Claude Code 和 Codex 的会话、追问、分支和子代理投影成一张可拖拽、可缩放的画布，并能从画布上直接发起分支。当用户想浏览或回顾会话历史、查看会话之间的分支关系、在画布上继续某个会话时使用。
---

# 会话地图

启动 ccSynapse 本地服务并用浏览器打开画布。服务是常驻进程，不要等它退出。

## 步骤

1. 先看服务是否已经在跑：

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/api/workspaces
```

- 返回 `200` → 已在运行，直接跳到第 3 步。
- 其它（连不上）→ 继续第 2 步。

2. 后台启动服务（用 `run_in_background: true`，不要用阻塞方式运行）：

```bash
ROOT="${CCSYNAPSE_ROOT:-${CLAUDE_PLUGIN_ROOT:-<本技能目录>/../..}}"
node "$ROOT/server/index.js"
```

`<本技能目录>` 就是宿主报告的「Base directory for this skill」——技能在 `<仓库根>/skills/synapse/`，所以上两级就是仓库根。

- Claude Code：`$CLAUDE_PLUGIN_ROOT` 直接可用。
- Codex：**不设** `CLAUDE_PLUGIN_ROOT`（实测为 null），走第三条；插件缓存里是整份仓库，`server/` 就在那里。
- 手工 clone：设 `CCSYNAPSE_ROOT`，或者直接 `cd <克隆目录> && node server/index.js`。

等它打印出 `ccSynapse 会话地图: http://127.0.0.1:3080/` 再继续。

3. 打开浏览器：

```bash
cmd //c start "" http://127.0.0.1:3080/
```

4. 告诉用户画布**就是默认视图，不需要点任何东西**，并说明能做什么（**Claude Code 与 Codex 的会话在同一张画布上**，卡片标出来源；Codex 侧只读）：

   - **导航**：拖动画布平移、滚轮缩放（8%–400%）、右下角小地图点击或拖拽定位、「全览」把所有卡片收进视口
   - **切换会话**：左侧「会话」树点一行就切到那个会话，画布跳到它最新一轮并高亮闪一下（悬停那一行能看到完整会话 UUID）
   - **卡片**：默认只显示这一轮的**提问**和**输出**；思考、工具调用、Skill、MCP、子代理收在底部徽标里，点一下就地展开
   - **详情**：点卡片标题或底部「详情」进单会话视图
   - **追问**：在回答里选中一段文字，会出现浮层带进新的追问
   - **分支**：卡片底部「分支」从该轮开新会话（走 `claude --bg --fork-session`）
   - **搜索**：`Ctrl+K`（macOS `Cmd+K`）按提问和回答全文搜索并跳转
   - **归档 / 恢复**：卡片底部「归档」；侧边栏底部「已归档」可恢复
   - **切换**：画布上方标签栏的**「地图」/「详情」**在两个视图间切换

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CCSYNAPSE_PORT` | `3080` | 端口 |
| `CCSYNAPSE_HOST` | `127.0.0.1` | 监听地址 |
| `CCSYNAPSE_HOME` | `$CLAUDE_PLUGIN_DATA` → `~/.claude/synapse` | 画布元数据目录 |
| `CCSYNAPSE_PROJECTS` | `~/.claude/projects` | Claude Code 会话记录目录 |
| `CCSYNAPSE_CODEX_SESSIONS` | `~/.codex/sessions` | Codex rollout 目录；不存在就跳过，不算错误 |
| `CCSYNAPSE_BG_ARGS` | 空 | 每次 `claude --bg` 追加的参数，例如 `--permission-mode acceptEdits` |
| `CCSYNAPSE_CLAUDE_BIN` | 自动探测 | `claude` 可执行文件路径 |
| `CCSYNAPSE_CODEX_BIN` | 自动探测 | `codex` 可执行文件路径（只用于「终端」按钮） |
| `CCSYNAPSE_THEME` | `light` | 只有 `dark` 会切到暗色 |
| `CCSYNAPSE_TRUSTED_HOSTS` | 空 | 额外允许的 Host，局域网访问时填写 |

## 注意

- 两个 harness 的会话目录在启动时各扫一次，**缺哪个都不算错误**（日志会写明跳过）。
- **Codex 会话是只读的**：画布上的「分支」「继续追问」对 Codex 会明确报错，不会偷偷用 `claude --resume` 去开一个空会话。用 Codex 的会话请走它自己的 `codex resume` / `codex fork`。
- 分支走 `claude --bg --resume <id> --fork-session`。后台会话没有终端，需要授权的工具调用会被拒绝；如果分支卡住，设置 `CCSYNAPSE_BG_ARGS="--permission-mode acceptEdits"` 后重启服务。
- `claude --bg` 要求工作目录已在 Claude Code 里被信任，否则会直接报「Workspace not trusted」。
- **画布数据是两个文件，删除的后果不同**：
  - `workspaces.json` —— **用户状态**（卡片位置、归档记录、分支别名）。删了会丢布局和归档，**不会动任何会话记录**。
  - `workspaces-projection.json` —— **可重建的投影缓存**（消息、工具记录）。随时可删，重启后自动重算。
- 端口被占用时服务会打印一条可读提示后退出，不会留下半启动的进程。
