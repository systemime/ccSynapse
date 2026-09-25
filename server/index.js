// ccSynapse server: projects Claude Code transcripts onto the Synapse canvas
// and bridges canvas actions back to real `claude` sessions.
//
// Replaces dsh-synapse's Cordis `apply()` (index.js:744-829). The routes, status
// codes, and store semantics are kept 1:1 so the ported client works unchanged;
// the only structural difference is that ccSynapse owns its HTTP server instead
// of mounting onto a host's, because Claude Code exposes no server to mount on.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WorkspaceStore, InputError, NotFoundError } from './workspace-store.js'
import { trustSet, rejectStatus } from './trust.js'
import { TranscriptSource, detectForks } from './transcript.js'
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
  workspaceTitle: process.env.CCSYNAPSE_WORKSPACE_TITLE ?? 'Claude Code 任务',
  // Extra flags for every `claude --bg` spawn, e.g.
  //   CCSYNAPSE_BG_ARGS="--permission-mode acceptEdits"
  // A background session has no terminal, so a tool call that needs approval
  // is denied. Set this when branches stall on permissions.
  backgroundArgs: (process.env.CCSYNAPSE_BG_ARGS ?? '').split(' ').filter(Boolean),
  trustedHosts: (process.env.CCSYNAPSE_TRUSTED_HOSTS ?? '').split(',').map(part => part.trim()).filter(Boolean),
}

const store = new WorkspaceStore(config.dataFile)
const source = new TranscriptSource(config.transcripts)

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

async function project() {
  if (projecting) return
  projecting = true
  try {
    const sessions = await source.sync(store, config.workspaceTitle, toLocal)

    // Lineage, authoritative first: a fork ccSynapse itself started knows its
    // parent exactly, so resolve it now that the child id is known.
    for (const [placeholder, pending] of pendingForks) {
      const child = locals.get(placeholder)
      if (child === undefined || !sessions.has(child)) continue
      appliedForks.set(placeholder, toLocal(pending.parentSessionId))
      await applyLineage(placeholder, sessions.get(child), toLocal(pending.parentSessionId), pending.seedLength)
      pendingForks.delete(placeholder)
    }

    // Then the heuristic path, for forks made in a terminal.
    for (const [childId, link] of detectForks(sessions)) {
      const local = toLocal(childId)
      const parent = toLocal(link.parentSessionId)
      if (appliedForks.get(local) === parent) continue
      appliedForks.set(local, parent)
      await applyLineage(local, sessions.get(childId), parent, link.seedLength)
    }
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

const { handleRpc } = createRpcHandler({ source, aliases, locals, pendingForks, activeSessionRef, config })
const { handleApi } = createRouter({ store, source, handleRpc, toLocal })

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
  void projectLoop()
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    // Flush the coalesced write window so a drag survives an immediate restart.
    try { await store.flush() } catch { /* shutting down anyway */ }
    server.close(() => process.exit(0))
  })
}
