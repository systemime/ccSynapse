---
name: synapse
description: 打开 ccSynapse 会话地图 — 把 Claude Code 的会话、追问和分支投影成一张可拖拽、可缩放的画布，并能从画布上直接发起分支。当用户想浏览或回顾会话历史、查看会话之间的分支关系、在画布上继续某个会话时使用。
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
node "${CLAUDE_PLUGIN_ROOT}/server/index.js"
```

等它打印出 `ccSynapse 会话地图: http://127.0.0.1:3080/` 再继续。

3. 打开浏览器：

```bash
cmd //c start "" http://127.0.0.1:3080/
```

4. 告诉用户点击顶部「会话地图」，并说明画布上能做什么（拖拽/缩放、点卡片看详情、选中回答里的文字直接追问、卡片底部「分支」开新分支、「定位」回到当前会话）。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CCSYNAPSE_PORT` | `3080` | 端口 |
| `CCSYNAPSE_HOME` | `~/.claude/synapse` | 画布元数据目录 |
| `CCSYNAPSE_PROJECTS` | `~/.claude/projects` | 会话记录目录 |
| `CCSYNAPSE_BG_ARGS` | 空 | 每次 `claude --bg` 追加的参数，例如 `--permission-mode acceptEdits` |
| `CCSYNAPSE_CLAUDE_BIN` | 自动探测 | `claude` 可执行文件路径 |

## 注意

- 分支走 `claude --bg --resume <id> --fork-session`。后台会话没有终端，需要授权的工具调用会被拒绝；如果分支卡住，设置 `CCSYNAPSE_BG_ARGS="--permission-mode acceptEdits"` 后重启服务。
- `claude --bg` 要求工作目录已在 Claude Code 里被信任，否则会直接报「Workspace not trusted」。
- 画布数据在 `workspaces.json`，删除它只丢布局和归档状态，不会动任何会话记录。
