// ccSynapse server: projects Claude Code transcripts onto the Synapse canvas
// and bridges canvas actions back to real `claude` sessions.
//
// Replaces dsh-synapse's Cordis `apply()` (index.js:744-829). The routes, status
// codes, and store semantics are kept 1:1 so the ported client works unchanged;
// the only structural difference is that ccSynapse owns its HTTP server instead
// of mounting onto a host's, because Claude Code exposes no server to mount on.

import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WorkspaceStore, InputError, NotFoundError } from './workspace-store.js'
import { trustSet, rejectStatus } from './trust.js'
import { TranscriptSource, detectForks } from './transcript.js'
import { CodexSource } from './codex.js'
import { createRpcHandler } from './rpc.js'
import { createRouter, sendJson } from './routes.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(HERE, '..', 'web')
const PROJECT_INTERVAL_MS = 1_000

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
// Never inside the plugin root: that directory is replaced on every plugin
// update, which would silently discard the canvas layout.
const DATA_FILE = process.env.CCSYNAPSE_HOME
  ? join(process.env.CCSYNAPSE_HOME, 'workspaces.json')
  : process.env.CLAUDE_PLUGIN_DATA
    ? join(process.env.CLAUDE_PLUGIN_DATA, 'workspaces.json')
    : join(CLAUDE_HOME, 'synapse', 'workspaces.json')

const config = {
  port: Number(process.env.CCSYNAPSE_PORT ?? 3080),
  host: process.env.CCSYNAPSE_HOST ?? '127.0.0.1',
  dataFile: DATA_FILE,
  transcripts: process.env.CCSYNAPSE_PROJECTS ?? join(CLAUDE_HOME, 'projects'),
  // Codex's own layout: <root>/<YYYY>/<MM>/<DD>/rollout-*.jsonl.
  codexSessions: process.env.CCSYNAPSE_CODEX_SESSIONS ?? join(homedir(), '.codex', 'sessions'),
  workspaceTitle: process.env.CCSYNAPSE_WORKSPACE_TITLE ?? 'Claude Code 任务',
  // Extra flags for every `claude --bg` spawn, e.g.
  //   CCSYNAPSE_BG_ARGS="--permission-mode acceptEdits"
  // A background session has no terminal, so a tool call that needs approval
  // is denied. Set this when branches stall on permissions.
  backgroundArgs: (process.env.CCSYNAPSE_BG_ARGS ?? '').split(' ').filter(Boolean),
  trustedHosts: (process.env.CCSYNAPSE_TRUSTED_HOSTS ?? '').split(',').map(part => part.trim()).filter(Boolean),
}

const store = new WorkspaceStore(config.dataFile)
const claude = new TranscriptSource(config.transcripts)
// Both harnesses project onto one canvas. A machine without Codex has no such
// root, and the adapter already treats an unlistable root as "keep what we had",
// so a missing directory costs nothing and is never an error.
const codex = new CodexSource(config.codexSessions)

// One session map for everything above the store — lineage, the live feed, the
// bridge's cwd/title lookups, /api/reset — so no consumer has to know which
// adapter read a session, and adding a third harness would touch only this.
// Rebuilt each cycle rather than merged on read: a consumer can then never see
// a half-updated view, and each source still owns and prunes its own entries.
const sessions = new Map()
const source = { sessions }

// A `claude --bg` fork chooses its own session id (it ignores --session-id), but
// the canvas needs the id before the first turn is sent, because the client
// creates the branch card and then posts the prompt in a separate call. So a
// fork gets a server-generated placeholder id, and the real id is aliased onto
// it once `claude agents --json` reports it. Everything above the store — REST,
// RPC, lineage — speaks the placeholder, so the thread never has to be repointed.
const aliases = new Map()      // real sessionId -> placeholder
const locals = new Map()       // placeholder   -> real sessionId
const pendingForks = new Map() // placeholder   -> { parentSessionId, cwd, title, seedLength }
const appliedForks = new Map() // child local id -> parent local id (lineage already written)
const activeSessionRef = { id: null }
let projecting = false

const toLocal = id => (typeof id === 'string' ? aliases.get(id) ?? id : id)
const toReal = id => (typeof id === 'string' ? locals.get(id) ?? id : id)

// [realId, partialText] for every session still writing a reply. A getter of
// its own rather than passing `source` to the router, so the route depends on
// the one thing it needs and nothing else. `toLocal` is applied by the router.
const liveTexts = () => [...source.sessions]
  .filter(([, session]) => session.liveText !== null)
  .map(([id, session]) => [id, session.liveText])

// An alias is user state, not a rebuildable projection: only this map links the
// canvas card (which holds the placeholder) to the real session. Forget it on
// restart and the next projection draws a second thread for the real id beside
// the empty placeholder. Awaited before the server listens, so the first
// projection cycle already sees it.
for (const [realId, localId] of Object.entries(await store.listAliases())) {
  aliases.set(realId, localId)
  locals.set(localId, realId)
}

async function project() {
  if (projecting) return
  projecting = true
  try {
    const claudeSessions = await claude.sync(store, config.workspaceTitle, toLocal)
    const codexSessions = await codex.sync(store, config.workspaceTitle, toLocal)
    // No await between the clear and the refill, so a concurrent reader sees
    // either the previous cycle's map or this one — never an empty one.
    sessions.clear()
    for (const [id, session] of claudeSessions) sessions.set(id, session)
    for (const [id, session] of codexSessions) sessions.set(id, session)

    // Every session that legitimately has a parent this run. Anything holding a
    // stored link but missing from this set is stale (see clearLineage below).
    const withLineage = new Set()

    // Lineage, authoritative first: a fork ccSynapse itself started knows its
    // parent exactly, so resolve it now that the child id is known.
    for (const [placeholder, pending] of pendingForks) {
      const child = locals.get(placeholder)
      if (child === undefined || !sessions.has(child)) continue
      withLineage.add(placeholder)
      if (appliedForks.get(placeholder) === toLocal(pending.parentSessionId)) { pendingForks.delete(placeholder); continue }
      appliedForks.set(placeholder, toLocal(pending.parentSessionId))
      await applyLineage(placeholder, sessions.get(child), toLocal(pending.parentSessionId), pending.seedLength)
      pendingForks.delete(placeholder)
    }

    // Then the exact path, for forks made in a terminal (UUID intersection).
    for (const [childId, link] of detectForks(sessions)) {
      const local = toLocal(childId)
      const parent = toLocal(link.parentSessionId)
      withLineage.add(local)
      if (appliedForks.get(local) === parent) continue
      appliedForks.set(local, parent)
      await applyLineage(local, sessions.get(childId), parent, link.seedLength)
    }

    // Subagent projection: sessions discovered under <parentSessionId>/subagents/
    // are hung off their parent via the same lineage mechanism as forks.
    for (const [sessionId, session] of sessions) {
      if (session.parentSessionId === null) continue
      const local = toLocal(sessionId)
      withLineage.add(local)
      const parent = toLocal(session.parentSessionId)
      if (appliedForks.get(local) === parent) continue
      appliedForks.set(local, parent)
      // The spawning turn when the parent is known (transcript.js resolves it),
      // else 0: a subagent with no resolved spawner anchors at its parent's end,
      // which is the old behaviour.
      await applyLineage(local, session, parent, session.parentSeedLength ?? 0)
    }

    // Detection is the single source of truth for lineage. Without this, a link
    // written by an earlier run whose fork no longer shows up — a stale edge
    // from before the direction fix, a deleted transcript — lives forever,
    // because `dshThread` only rewrites a link the detector contradicts and
    // never clears one it no longer reports.
    await store.clearLineage([...sessions.keys()].map(toLocal).filter(id => !withLineage.has(id)))
  } catch (error) {
    console.warn(`[ccSynapse] projection cycle failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    projecting = false
  }
}

/**
 * Write a fork relation into the store. The store learns lineage from the
 * session header while projecting, so this replays the header with no events —
 * `dshThread` then repairs `parentId`/`sourceParentSessionId`/`sourceSeedLength`
 * without touching a single card.
 */
function applyLineage(localId, record, parentLocalId, seedLength) {
  return store.projectSession({
    id: localId,
    title: record.title,
    header: { cwd: record.cwd, parentSession: parentLocalId, seedLength },
    firstLiveSeq: 0,
    events: [],
  }, 0, config.workspaceTitle)
}

/** The transcript projection runs off its own clock; the client polls REST. */
async function projectLoop() {
  await project()
  setTimeout(() => { void projectLoop() }, PROJECT_INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendFile(response, status, contentType, body) {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  response.end(body)
}

const TRUSTED = trustSet(config.trustedHosts)

const { handleRpc } = createRpcHandler({
  source, aliases, locals, pendingForks, activeSessionRef, config,
  // Write through at the moment the alias is minted, rather than reconciling
  // memory against disk on every projection cycle: the two can then never
  // diverge, and there is no window where a restart drops a fresh alias.
  onAlias: (realId, localId) => {
    store.setAlias(realId, localId).catch(error => {
      console.warn(`[ccSynapse] cannot persist session alias: ${error instanceof Error ? error.message : String(error)}`)
    })
  },
})
const { handleApi } = createRouter({ store, source, handleRpc, toLocal, liveTexts })

const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
])

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname
  try {
    const asset = STATIC.get(pathname)
    if (asset !== undefined) {
      const [file, contentType] = asset
      return sendFile(response, 200, contentType, await readFile(join(WEB_ROOT, file), 'utf8'))
    }
    if (pathname.startsWith('/api/')) {
      const rejected = rejectStatus(request, TRUSTED)
      if (rejected !== null) {
        return sendJson(response, rejected, { error: rejected === 415 ? '请求必须是 application/json' : '请求来源不被信任' })
      }
      return await handleApi(request, response, pathname)
    }
    return sendFile(response, 404, 'text/plain; charset=utf-8', 'not found')
  } catch (error) {
    if (error instanceof InputError) return sendJson(response, 400, { error: error.message })
    if (error instanceof NotFoundError) return sendJson(response, 404, { error: error.message })
    console.error('[ccSynapse]', error)
    return sendJson(response, 500, { error: 'Synapse 数据暂时不可用' })
  }
})

server.on('error', error => {
  // A second instance is the usual cause, and the raw stack for EADDRINUSE
  // says nothing about that. Say the actionable thing and stop.
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用。用 CCSYNAPSE_PORT=<其它端口> 再启动，或先停掉已有实例。`)
    process.exit(1)
  }
  throw error
})

server.listen(config.port, config.host, () => {
  const { port } = server.address()
  console.log(`ccSynapse 会话地图: http://${config.host}:${port}/`)
  console.log(`  数据文件: ${config.dataFile}`)
  console.log(`  会话目录: ${config.transcripts}`)
  // Both roots are scanned at startup and a missing one is skipped, never an
  // error — but say so, because「为什么看不到 Codex 会话」has no other answer.
  console.log(`  Codex 会话目录: ${config.codexSessions}${existsSync(config.codexSessions) ? '' : '（不存在，已跳过）'}`)
  void projectLoop()
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    // Flush the coalesced write window so a drag survives an immediate restart.
    try { await store.flush() } catch { /* shutting down anyway */ }
    server.close(() => process.exit(0))
  })
}
