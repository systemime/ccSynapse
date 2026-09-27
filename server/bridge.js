// Claude Code session bridge: the counterpart to DSH's in-process session API.
//
// Claude Code has no inbound API a plugin can call, so every action here is a
// `claude` CLI invocation. Verified behaviour on this machine (claude 2.1.282):
//
//   claude --bg --resume <id> --fork-session "<prompt>"   branch a session
//   claude --bg --resume <id> "<prompt>"                  continue in background
//   claude --bg "<prompt>"                                new background session
//   claude agents --json                                  short id -> full sessionId
//   claude attach <short id>                              open in this terminal
//
// Three things that are NOT obvious and cost real debugging to find:
//   1. `--bg` conflicts with `--print`; the prompt is the POSITIONAL argument.
//   2. `--bg` assigns the session id itself and silently ignores `--session-id`,
//      so the caller cannot choose the id up front — it must be discovered.
//   3. `--bg` refuses to run in a directory the user has not trusted in Claude
//      Code, so a branch can fail with "Workspace not trusted"; that message is
//      surfaced verbatim because it is the only actionable thing to say.
//
// Codex sessions are read-only here: none of the `--bg` machinery applies to
// them (a Codex branch is a separate work unit). The one thing they share is
// `openInTerminal`, which needs a real `codex` executable to hand a terminal —
// hence `codexBinary` below, the twin of `claudeBinary`.

import { spawn } from 'node:child_process'
import { accessSync, constants, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
// Node refuses to spawn .cmd/.bat without a shell (EINVAL) since the
// 2024 argument-injection fix, and going through a shell would let a prompt
// text reach cmd.exe's parser. So we only ever run a real executable.
const SHIM_EXTENSIONS = ['.cmd', '.bat', '.ps1']
const SHORT_ID_PATTERN = /backgrounded\s*[·:]\s*([0-9a-f]{6,})/i

let cachedBinary
let cachedCodexBinary

function executableAt(path) {
  if (SHIM_EXTENSIONS.some(extension => path.toLowerCase().endsWith(extension))) return false
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

/**
 * Locate a spawnable `claude` (a real executable, never an npm .cmd shim).
 * The npm-global layout keeps one at
 * `<npm prefix>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`.
 */
export function claudeBinary() {
  if (cachedBinary !== undefined) return cachedBinary
  const override = process.env.CCSYNAPSE_CLAUDE_BIN
  if (override) return (cachedBinary = override)
  const names = IS_WINDOWS ? ['claude.exe', 'claude'] : ['claude']
  const nested = ['node_modules', '@anthropic-ai', 'claude-code', 'bin']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const name of names) {
      for (const candidate of [join(directory, name), join(directory, ...nested, name)]) {
        if (executableAt(candidate)) return (cachedBinary = candidate)
      }
    }
  }
  return (cachedBinary = null)
}

/**
 * Locate a spawnable `codex`, probed exactly like `claude` above and with the
 * same two rules: a real executable, never npm's extensionless shim.
 *
 * Measured on this machine, because the obvious scan does not find it: PATH
 * holds `<npm prefix>/codex` (a shell script, which spawns as ENOENT) and its
 * .cmd/.ps1 twins, while the real binary sits under two variable names —
 * platform-arch and a target triple — that cannot be written down:
 *
 *   <npm prefix>/node_modules/@openai/codex/node_modules/
 *     @openai/codex-<platform>-<arch>/vendor/<triple>/bin/codex.exe
 *
 * So the flat PATH scan covers other install methods (scoop, winget, brew) and
 * the vendor walk is the one that hits here. On Windows only `.exe` counts,
 * for the reason above. CCSYNAPSE_CODEX_BIN skips both.
 */
export function codexBinary() {
  if (cachedCodexBinary !== undefined) return cachedCodexBinary
  const override = process.env.CCSYNAPSE_CODEX_BIN
  if (override) return (cachedCodexBinary = override)
  const names = IS_WINDOWS ? ['codex.exe'] : ['codex']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (executableAt(candidate)) return (cachedCodexBinary = candidate)
    }
    for (const candidate of vendorCodexBinaries(directory)) {
      if (executableAt(candidate)) return (cachedCodexBinary = candidate)
    }
  }
  return (cachedCodexBinary = null)
}

/** The `<vendor>/<triple>/bin/codex.exe` paths under one npm prefix. */
function vendorCodexBinaries(prefix) {
  // node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/<triple>/bin
  // — the platform package is scoped, so it sits one level below the scope
  // directory rather than directly in node_modules.
  const packages = join(prefix, 'node_modules', '@openai', 'codex', 'node_modules')
  let vendors
  try { vendors = readdirSync(packages, { withFileTypes: true }) } catch { return [] }
  const roots = []
  for (const vendor of vendors) {
    if (!vendor.isDirectory()) continue
    if (!vendor.name.startsWith('@')) { roots.push(join(packages, vendor.name)); continue }
    const scope = join(packages, vendor.name)
    let scoped
    try { scoped = readdirSync(scope, { withFileTypes: true }) } catch { continue }
    for (const entry of scoped) if (entry.isDirectory()) roots.push(join(scope, entry.name))
  }

  const found = []
  for (const root of roots) {
    const triples = join(root, 'vendor')
    let targets
    try { targets = readdirSync(triples, { withFileTypes: true }) } catch { continue }
    for (const target of targets) {
      if (target.isDirectory()) found.push(join(triples, target.name, 'bin', IS_WINDOWS ? 'codex.exe' : 'codex'))
    }
  }
  return found
}

/**
 * Run the CLI without a shell. `argv` is handed to CreateProcess/execve
 * verbatim, so prompt text containing & | ^ % " cannot be reinterpreted.
 * Resolves as soon as `onData` returns a value (used to catch the background id
 * without waiting for the process to exit), or when it closes.
 */
function run(binary, args, { cwd, timeoutMs = 60_000, onData } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null, new Error('Claude Code 命令超时'))
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      if (onData === undefined) return
      const found = onData(stdout)
      if (found !== undefined && found !== null) {
        finish({ stdout, stderr, code: null })
        child.unref()
      }
    })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => finish(null, error))
    child.on('close', code => finish({ stdout, stderr, code }))
  })
}

function failure(result) {
  const text = `${result.stderr}\n${result.stdout}`.trim()
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  return new Error(line === '' ? 'Claude Code 命令失败' : line)
}

/** `claude agents --json` rows, including background jobs and live terminals. */
export async function listAgents() {
  const binary = claudeBinary()
  if (binary === null) return []
  const result = await run(binary, ['agents', '--json'], { timeoutMs: 20_000 })
  try { return JSON.parse(result.stdout) } catch { return [] }
}

/** The short id printed by `--bg` is the first 8 hex characters of the session UUID. */
async function resolveSessionId(shortId) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const agents = await listAgents()
    const match = agents.find(agent => agent?.id === shortId)
    if (typeof match?.sessionId === 'string') return match.sessionId
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  return null
}

/**
 * Start a background turn against an existing session.
 * @returns {Promise<{shortId: string|null, sessionId: string|null, forked: boolean}>}
 */
export async function continueSession({ sessionId, text, cwd, extraArgs = [] }) {
  return startBackground({ cwd, extraArgs, args: ['--bg', '--resume', sessionId, text] })
}

/**
 * Branch a session. `--fork-session` copies the transcript into a new session id
 * and leaves the original untouched; the prompt is part of the same invocation
 * because the copy is only useful once it has been given something to answer.
 */
export async function forkSession({ sessionId, text, cwd, extraArgs = [] }) {
  return startBackground({ cwd, extraArgs, forked: true, args: ['--bg', '--resume', sessionId, '--fork-session', text] })
}

export async function createSession({ text, cwd, extraArgs = [] }) {
  return startBackground({ cwd, extraArgs, args: ['--bg', text] })
}

async function startBackground({ args, cwd, forked = false, extraArgs = [] }) {
  const binary = claudeBinary()
  if (binary === null) throw new Error('找不到可执行的 claude：请设置 CCSYNAPSE_CLAUDE_BIN 指向原生可执行文件')
  const result = await run(binary, [...args, ...extraArgs], {
    cwd,
    onData: stdout => SHORT_ID_PATTERN.exec(stdout)?.[1],
  })
  const shortId = SHORT_ID_PATTERN.exec(result.stdout)?.[1] ?? null
  if (shortId === null) throw failure(result)
  const resolvedId = await resolveSessionId(shortId)
  return { shortId, sessionId: resolvedId, forked }
}

/**
 * Open a session in a real terminal, where its tool approvals can actually be
 * answered. Prefers Windows Terminal; falls back to a plain cmd window.
 *
 * `harness` picks the CLI that can resume the session at all: a Codex rollout
 * has no Claude Code transcript, so `claude --resume` on one would open a second,
 * empty session under a borrowed id. Claude Code stays the default, and its
 * command line is unchanged.
 */
export function openInTerminal({ sessionId, cwd, harness }) {
  if (process.env.CCSYNAPSE_NO_TERMINAL === '1') return { opened: false, reason: 'disabled' }
  const directory = cwd ?? process.cwd()
  const codex = harness === 'codex'
  const command = codex ? codexBinary() : 'claude'
  if (command === null) return { opened: false, reason: '找不到可执行的 codex：请设置 CCSYNAPSE_CODEX_BIN 指向原生可执行文件' }
  const resume = codex ? ['resume', sessionId] : ['--resume', sessionId]
  const terminal = (process.env.PATH ?? '').split(delimiter)
    .map(entry => join(entry, 'wt.exe'))
    .find(executableAt)
  try {
    if (terminal !== undefined) {
      spawn(terminal, ['-w', '0', 'new-tab', '--startingDirectory', directory, command, ...resume],
        { detached: true, stdio: 'ignore', windowsHide: false }).unref()
      return { opened: true, via: 'wt' }
    }
    const shell = process.env.ComSpec ?? 'cmd.exe'
    spawn(shell, ['/c', 'start', '', 'cmd', '/k', command, ...resume], { cwd: directory, detached: true, stdio: 'ignore' }).unref()
    return { opened: true, via: 'cmd' }
  } catch (error) {
    return { opened: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
