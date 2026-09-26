// Claude Code transcript -> DSH-shaped projection events.
//
// This is the ONLY module that knows the on-disk transcript format. Claude Code
// documents that format as internal and unstable
// (https://code.claude.com/docs/en/sessions#where-transcripts-are-stored:
// "The entry format is internal to Claude Code and changes between versions, so
// scripts that parse these files directly can break on any release"), so:
//   - every unknown `type` is skipped, never thrown on
//   - a format surprise degrades one card, it does not take the server down
//   - nothing outside this file reads a .jsonl
//
// We read the raw jsonl rather than the supported Agent SDK helpers because
// `getSessionMessages()` returns the *post-compaction* chain, which would erase
// exactly the per-turn history the canvas exists to show.

import { readdir, readFile, stat, open } from 'node:fs/promises'
import { join, basename } from 'node:path'

// seq is the 0-based line index: monotonic within a file, which is what the
// store's `sourceSeq` dedup needs to make replay idempotent.
// Everything in Claude Code's own entry union that carries no turn. Listing them
// explicitly is better than falling through to the unknown-type warning: these
// are known-good, and `agent-name` showed up 52 times in one real corpus.
const META_TYPES = new Set([
  'mode', 'permission-mode', 'atis-latch', 'last-prompt', 'queue-operation',
  'file-history-snapshot', 'file-history-delta', 'cost-state', 'attachment',
  'agent-name', 'agent-color', 'agent-setting', 'tag', 'pr-link',
  'attribution-snapshot', 'content-replacement', 'worktree-state',
  'task-summary', 'speculation-accept', 'session-meta',
])

// Injected scaffolding that is not something the human typed. Measured shapes
// on a real corpus: `local-command-caveat` / `local-command-stdout` (command
// output), `system-reminder` (hook and mode injection), and `task-notification`
// (background-agent completion, observed up to 32 KB per line).
const INJECTED_ONLY = /^\s*<(local-command-|system-reminder|task-notification)/
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

/**
 * The prompt a person actually typed in a `user` line, or null when the line is
 * scaffolding rather than a turn.
 *
 * A slash command is the interesting case: `/graphify F:\path` carries the real
 * intent in `<command-args>`, while a bare `/model` or `/clear` is UI
 * housekeeping that would only add noise to the canvas. So commands keep their
 * arguments and drop their empty shells.
 */
export function promptText(content) {
  const text = content.trim()
  if (text === '') return null
  // A slash command carries the typed intent in <command-args>; a bare
  // `/model` is UI housekeeping, not a turn.
  if (text.startsWith('<command-name>')) {
    const name = COMMAND_NAME.exec(text)?.[1]?.trim() ?? ''
    const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? ''
    return args === '' ? null : `${name} ${args}`.trim()
  }
  return INJECTED_ONLY.test(text) ? null : text
}

/** Warning latch: report a given surprise once, not once per line. */
const reported = new Set()
function reportOnce(key, detail) {
  if (reported.has(key)) return
  reported.add(key)
  console.warn(`[ccSynapse] transcript: ${detail}`)
}

// Tool payloads are unbounded on disk: a single Write argument measured 88 KB,
// and tool records dominated the canvas state file (3.7 MB of 5 MB) — a file the
// store rewrites in full on every save. Message text is already capped
// (MAX_PROJECTION_LENGTH in the store); tool records were not, so cap them here.
// The detail view shows the head, which is what a folded tool record is for.
const MAX_TOOL_LENGTH = 2_000
const TOOL_TRUNCATED_SUFFIX = '\n——…（已截断）'

/** Most bytes of one transcript to ingest per poll, so a huge file cannot OOM the server. */
const MAX_READ_BYTES = 16 * 1024 * 1024

function clampTool(text) {
  if (typeof text !== 'string' || text.length <= MAX_TOOL_LENGTH) return text
  return `${text.slice(0, MAX_TOOL_LENGTH)}${TOOL_TRUNCATED_SUFFIX}`
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('')
}

/** @returns {string|null} the human prompt on this line, or null if it is not a turn */
function userPrompt(raw) {
  if (raw?.type !== 'user' || typeof raw.message?.content !== 'string') return null
  if (raw.message?.isMeta === true) return null
  // A compaction summary is written as a user message but is machine-authored
  // recap text. The transcript is append-only, so the turns it summarizes are
  // still on disk and already projected — showing the summary too would add a
  // card nobody typed, restating history the canvas already draws.
  if (raw.message?.isCompactSummary === true || raw.isCompactSummary === true) return null
  return promptText(raw.message.content)
}

function flattenToolResult(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (b?.type === 'text' ? b.text ?? '' : b?.type === 'image' ? '[image]' : ''))
    .filter(part => part !== '')
    .join('\n')
}

function toolError(toolUseResult) {
  if (toolUseResult === undefined || toolUseResult === null) return null
  if (toolUseResult.interrupted === true) return '已中断'
  if (typeof toolUseResult.stderr === 'string' && toolUseResult.stderr.trim() !== '') return toolUseResult.stderr.trim()
  return null
}

/**
 * Translate one transcript line into zero or more projection events.
 * Assistant text/tool blocks are handled by the caller so they can be grouped
 * by API message id first.
 */
function translateLine(raw, seq, time) {
  const type = raw.type

  if (META_TYPES.has(type)) return []

  if (type === 'ai-title') {
    const title = typeof raw.aiTitle === 'string' ? raw.aiTitle : typeof raw.title === 'string' ? raw.title : ''
    return title.trim() === '' ? [] : [{ seq, time, type: 'session/title', data: { title } }]
  }

  if (type === 'assistant') {
    if (!Array.isArray(raw.message?.content)) return []
    return raw.message.content.flatMap(block => {
      if (block?.type !== 'tool_use') return []
      const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? null)
      return [{ seq, time, type: 'tool/call', data: { callId: block.id, name: block.name, arguments: clampTool(input) } }]
    })
  }

  if (type === 'user') {
    const content = raw.message?.content
    // A real prompt is a plain string; arrays are tool results.
    if (typeof content === 'string') {
      const text = userPrompt(raw)
      return text === null ? [] : [{ seq, time, type: 'user/message', data: { content: [{ type: 'text', text }] } }]
    }
    if (Array.isArray(content)) {
      return content
        .filter(block => block?.type === 'tool_result')
        .map(block => ({
          seq, time, type: 'tool/result',
          data: {
            callId: block.tool_use_id,
            error: toolError(raw.toolUseResult),
            message: { source: { callId: block.tool_use_id }, content: [{ type: 'text', text: clampTool(flattenToolResult(block.content)) }] },
          },
        }))
    }
    return []
  }

  if (type === 'system') {
    if (raw.subtype === 'compact_boundary') {
      reportOnce('compact', 'compaction boundary seen; pre-compaction turns are not recoverable from the transcript')
    }
    return []
  }

  reportOnce(`unknown:${type}`, `unknown entry type "${type}" skipped`)
  return []
}

/**
 * Assistant text blocks belonging to one API message can arrive on several
 * lines. They must collapse to ONE projection event: the canvas chains every
 * assistant message into a turn and shows only the last as the answer, so a
 * split message would silently drop text. `messageId` groups them; `seq` tracks
 * the group's latest line so its identity is stable across poll boundaries.
 */
class AssistantGroup {
  constructor(turn) {
    this.messageId = null
    this.seq = 0
    this.time = null
    this.turn = turn
    this.parts = []
    this.toolCalls = []
  }
  addText(text, time) {
    if (text.trim() !== '') this.parts.push(text)
    if (this.time === null) this.time = time
  }
  /** The message event first, then its tool calls, so the card exists to fold into. */
  drain() {
    const events = []
    if (this.parts.length > 0) {
      events.push({
        seq: this.seq,
        time: this.time ?? new Date().toISOString(),
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: this.parts.join('\n') }] }, turn: this.turn, step: 1 },
      })
    }
    for (const call of this.toolCalls) events.push({ ...call, data: { ...call.data, turn: this.turn, step: 1 } })
    return events
  }
}

class SessionCache {
  constructor(path, sessionId) {
    this.path = path
    this.sessionId = sessionId
    this.offset = 0
    this.size = -1
    this.lineCount = 0
    this.cwd = null
    this.title = null
    this.turn = 0
    this.open = null
    this.fingerprint = []
    this.turnSeqs = []
    this.turnParts = []
    this.uuidSet = new Set()
    this.uuidLine = new Map()   // uuid -> seq (0-based line index) in THIS file
    this.primed = false
    this.parentSessionId = null
    this.toolUseId = null
    this.issuedToolCalls = new Set()   // tool_use ids this transcript ISSUED
    this.issuedToolLines = new Map()   // tool_use id -> seq (line index) that ISSUED it
  }
}

function fingerprintOf(text) {
  const normalized = text.replaceAll(/\s+/g, ' ').trim().slice(0, 200)
  let hash = 2166136261
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/**
 * Incrementally projects every transcript under `root` into `store`.
 * Only appended bytes are ever re-read; a full parse happens once per file.
 */
export class TranscriptSource {
  /** @param {string} root directory holding per-project transcript folders */
  constructor(root) {
    this.root = root
    this.caches = new Map()
    this.sessions = new Map()
  }

  async #listTranscripts() {
    let projects
    try { projects = await readdir(this.root, { withFileTypes: true }) }
    catch { return [] }
    const files = []
    for (const project of projects) {
      if (!project.isDirectory()) continue
      let entries
      try { entries = await readdir(join(this.root, project.name), { withFileTypes: true }) }
      catch { continue }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(this.root, project.name, entry.name))
        if (!entry.isDirectory()) continue
        // Scan subagent transcripts: <project>/<sessionId>/subagents/agent-*.jsonl
        const sessionId = entry.name
        let subEntries
        try { subEntries = await readdir(join(this.root, project.name, sessionId, 'subagents'), { withFileTypes: true }) }
        catch { continue }
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.startsWith('agent-') && sub.name.endsWith('.jsonl')) {
            files.push(join(this.root, project.name, sessionId, 'subagents', sub.name))
          }
        }
      }
    }
    return files
  }

  /** @returns {{lines: string[], grew: boolean}} complete lines appended since last call */
  async #readAppended(cache) {
    let handle
    try { handle = await open(cache.path, 'r') }
    catch { return { lines: [], grew: false } }
    try {
      const info = await handle.stat()
      const grew = cache.size === -1 ? true : info.size !== cache.size
      if (info.size < cache.offset) {
        // Rewritten or truncated in place. Restart the file; the store dedups by
        // seq, so replaying already-projected turns is a no-op.
        reportOnce(`rewrite:${cache.path}`, `transcript rewritten in place, reprojecting: ${cache.path}`)
        cache.offset = 0
        cache.lineCount = 0
        cache.turn = 0
        cache.open = null
        cache.primed = false
      }
      cache.size = info.size
      if (info.size === cache.offset) return { lines: [], grew }

      // Read at most one chunk per poll. Claude Code's own reader carries a
      // 50 MB cap with the note that session files "can grow to multiple GB",
      // and this used to allocate the whole remainder in one buffer. A file
      // larger than the cap simply catches up over several one-second polls;
      // the partial-line handling below already leaves the offset on a boundary.
      const length = Math.min(info.size - cache.offset, MAX_READ_BYTES)
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, cache.offset)
      const chunk = buffer.subarray(0, bytesRead).toString('utf8')
      // Hold a trailing partial line for the next poll rather than parsing it.
      const lastBreak = chunk.lastIndexOf('\n')
      if (lastBreak === -1) return { lines: [], grew }
      cache.offset += Buffer.byteLength(chunk.slice(0, lastBreak + 1), 'utf8')
      return { lines: chunk.slice(0, lastBreak).split('\n'), grew }
    } finally {
      await handle.close()
    }
  }

  #flush(cache, out) {
    if (cache.open === null) return
    out.push(...cache.open.drain())
    cache.open = null
  }

  async #project(cache) {
    const { lines, grew } = await this.#readAppended(cache)
    const events = []

    for (const line of lines) {
      const seq = cache.lineCount++
      if (line.trim() === '') continue
      let raw
      try { raw = JSON.parse(line) } catch { continue }   // torn line: skip, never throw
      const time = typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString()

      if (cache.cwd === null && typeof raw.cwd === 'string' && raw.cwd.trim() !== '') cache.cwd = raw.cwd
      if (typeof raw.uuid === 'string' && raw.uuid.length > 0) {
        cache.uuidSet.add(raw.uuid)
        // First occurrence only: a later repeat must not move the fork cut.
        if (!cache.uuidLine.has(raw.uuid)) cache.uuidLine.set(raw.uuid, seq)
      }
      if (userPrompt(raw) !== null) cache.turn += 1

      if (raw.type === 'assistant') {
        const messageId = raw.message?.id ?? null
        // A new API message closes the previous group.
        if (cache.open !== null && cache.open.messageId !== messageId) this.#flush(cache, events)
        if (cache.open === null) cache.open = new AssistantGroup(cache.turn)
        cache.open.messageId = messageId
        cache.open.seq = seq
        cache.open.addText(textOf(raw.message?.content), time)
        for (const event of translateLine(raw, seq, time)) {
          if (event.type === 'tool/call') {
            // Only a real tool_use block counts as "this session called it" —
            // a mention of the id in text must never look like a spawn.
            cache.issuedToolCalls.add(event.data.callId)
            // First occurrence only: a later repeat must not move the anchor.
            if (!cache.issuedToolLines.has(event.data.callId)) cache.issuedToolLines.set(event.data.callId, seq)
            cache.open.toolCalls.push(event)
          } else events.push(event)
        }
        continue
      }

      // Any non-assistant line closes the open group.
      this.#flush(cache, events)
      for (const event of translateLine(raw, seq, time)) {
        if (event.type === 'session/title') cache.title = event.data.title
        // Tool results need the same turn/step stamp as the calls they answer,
        // otherwise the store cannot find the card to fold them into and they
        // sit in pendingProcess forever, leaving every tool with result: null.
        if (event.type === 'tool/result') event.data = { ...event.data, turn: cache.turn, step: 1 }
        events.push(event)
      }
    }

    // A group touching EOF may still be receiving lines. Hold it for one poll so
    // a message split across polls stays a single card; flush once the file has
    // stopped growing (the turn finished) or a closing line arrives.
    if (cache.open !== null && !grew) this.#flush(cache, events)

    // Fingerprint a turn once it is COMPLETE (i.e. when the next prompt arrives),
    // covering both the question and the replies it produced.
    //
    // Hashing only the question is not enough: re-sending the same prompt in a
    // fresh session — what someone does after a model error — produces an
    // identical prompt prefix but a *different* answer, and would be misread as
    // a fork. A `--fork-session` copy preserves replies verbatim, so including
    // them separates "branched from" from "asked again". The trailing turn is
    // deliberately left out because it is still growing, which also means a fork
    // of the very last turn is not auto-detected — a miss, not a wrong edge.
    for (const event of events) {
      if (event.type === 'user/message') {
        if (cache.turnParts.length > 0) cache.fingerprint.push(fingerprintOf(cache.turnParts.join('\u0000')))
        cache.turnParts = [textOf(event.data.content)]
        cache.turnSeqs.push(event.seq)
      } else if (event.type === 'assistant/message') {
        cache.turnParts.push(textOf(event.data.message.content))
      }
    }
    return events
  }

  /**
   * Pull new events out of every transcript and hand them to the store.
   *
   * `mapSessionId` is how a `claude --bg` fork gets folded onto the placeholder
   * id the canvas already knows (see server/index.js). It is applied ONLY to the
   * id handed to the store — `this.sessions` stays keyed by the real id, because
   * lineage detection and the bridge both work in real-id space.
   */
  async sync(store, fallbackTitle, mapSessionId = id => id) {
    for (const path of await this.#listTranscripts()) {
      let info
      try { info = await stat(path) } catch { continue }

      let cache = this.caches.get(path)
      if (cache === undefined) {
        cache = new SessionCache(path, basename(path, '.jsonl'))
        // Detect subagent files: <root>/<project>/<parentSessionId>/subagents/agent-*.jsonl
        const dir = join(path, '..')
        if (basename(dir) === 'subagents') {
          cache.parentSessionId = basename(join(dir, '..'))
          try {
            const meta = JSON.parse(await readFile(join(dir, cache.sessionId + '.meta.json'), 'utf8'))
            cache.toolUseId = meta.toolUseId ?? null
          } catch { /* meta absent, toolUseId stays null */ }
        }
        this.caches.set(path, cache)
      } else if (info.size === cache.size && cache.open === null && cache.offset >= cache.size) {
        continue                              // nothing new, nothing held open, nothing left unread
      }

      const events = await this.#project(cache)
      if (cache.cwd === null) continue        // metadata-only file, no session yet
      if (events.length === 0) {
        if (cache.primed) continue
      }

      const session = {
        id: mapSessionId(cache.sessionId),
        title: cache.title,
        header: { cwd: cache.cwd },
        firstLiveSeq: 0,
        events,
      }
      this.sessions.set(cache.sessionId, {
        id: cache.sessionId, cwd: cache.cwd, title: cache.title, mtimeMs: info.mtimeMs,
        fingerprint: cache.fingerprint, turnSeqs: cache.turnSeqs, lastSeq: cache.lineCount,
        uuidSet: cache.uuidSet,
        uuidLine: cache.uuidLine,
        parentSessionId: cache.parentSessionId ?? null,
        toolUseId: cache.toolUseId ?? null,
        issuedToolCalls: cache.issuedToolCalls,
        issuedToolLines: cache.issuedToolLines,
      })

      try {
        // First sighting replays the whole file; later polls only feed the tail.
        if (cache.primed) await store.projectEvents(session, events, fallbackTitle)
        else { await store.projectSession(session, 0, fallbackTitle); cache.primed = true }
      } catch (error) {
        console.warn(`[ccSynapse] projection failed for ${cache.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Resolve subagent parents. The directory says which session a subagent was
    // spawned *under*, but nested agents are all written flat into one
    // subagents/ directory, so that only ever yields the top-level session. The
    // meta file's toolUseId names the Agent tool call that spawned it, and the
    // transcript that ISSUED that call is the real parent.
    //
    // Rebuilt every sync, not only when something changed: a child's file can be
    // read before its spawner's tool_use has been, so the index is only complete
    // once every transcript has been read — and it is a few hundred strings.
    const issuer = new Map()
    for (const session of this.sessions.values()) {
      for (const id of session.issuedToolCalls ?? []) {
        if (!issuer.has(id)) issuer.set(id, session.id)
      }
    }
    for (const session of this.sessions.values()) {
      if (session.toolUseId === null || session.toolUseId === undefined) continue
      // A fork copies its parent's assistant lines verbatim, so the very same
      // tool_use id is issued in every copy of the conversation and `issuer`
      // hands back whichever copy happened to be read first. The folder a
      // subagent was written under is the session that spawned it, and it wins
      // whenever it issued the call too — otherwise a fork copy that sorts
      // first adopts an agent it never spawned, and the anchor lands on the
      // copy's line. The folder loses only when it did NOT issue the call,
      // which is exactly the nested-agent case: those are all written flat into
      // one subagents/ directory and only the toolUseId names the real spawner.
      const owner = session.parentSessionId
      const realParent = this.sessions.get(owner)?.issuedToolCalls?.has(session.toolUseId) === true
        ? owner
        : issuer.get(session.toolUseId)
      // Only accept a parent that exists this run; otherwise keep the directory
      // guess so an agent whose spawner is gone still lands somewhere sensible.
      if (realParent === undefined || realParent === session.id) continue
      // Walking up from the candidate must never come back here: a cycle would
      // make the lineage tree unrenderable, and one cheap walk prevents it.
      const seen = new Set([session.id])
      let up = realParent
      while (up !== undefined && !seen.has(up)) {
        seen.add(up)
        up = this.sessions.get(up)?.parentSessionId ?? undefined
      }
      if (seen.has(up)) continue
      session.parentSessionId = realParent
      // Where in the parent the spawn happened: the canvas keeps parent cards
      // with `sourceSeq < seedLength`, so +1 puts the spawning line itself
      // inside the cut and anchors the agent at its own turn instead of at the
      // parent's last one. Same +1 convention as detectForks below.
      const spawnLine = this.sessions.get(realParent)?.issuedToolLines?.get(session.toolUseId)
      if (Number.isSafeInteger(spawnLine)) session.parentSeedLength = spawnLine + 1
    }
    return this.sessions
  }
}

/**
 * Lineage for forks made outside ccSynapse.
 *
 * `--fork-session` is not a byte copy: it rewrites every `sessionId` and remaps
 * message UUIDs, and it records no parent pointer on disk. UUID matching
 * therefore cannot work. Match on what the copy does preserve instead — the
 * content of each completed turn. A session whose turn fingerprints are a strict
 * prefix of another's was forked from it, anchored at the last shared turn.
 *
 * `seedLength` is expressed in the PARENT's seq (line-index) space, because the
 * canvas resolves the fork anchor as "the last parent turn whose `sourceSeq` is
 * below the seed" (app.js:773-786). The boundary is one past the parent's line
 * for the last UUID the child still shares — the fork cut — so each snapshot
 * anchors at the turn it actually forked from rather than at the parent's end.
 * A parent with no line index (fingerprint path, hand-built sessions) falls
 * back to its total line count.
 *
 * Two weak signals are ruled out by construction: a single shared turn (plenty
 * of unrelated sessions open with the same "你好"), and a fingerprint taken over
 * the question alone (which would call a re-asked question a fork). Forks
 * ccSynapse starts itself do not use this path at all — they are recorded
 * exactly — so being conservative here only costs auto-detection of hand-rolled
 * forks of very short sessions.
 *
 * When UUIDs are available the same rule reads off containment: the fork is a
 * snapshot of the original, so the child's UUID set is a subset and the parent
 * — the session that kept growing — is the strictly larger one. Sizing alone
 * does not pick between candidates that share the same core, so the largest of
 * the equally-matching sessions wins: snapshots taken at different times become
 * siblings under the original instead of a chain through one another.
 *
 * @param {Map<string, {id: string, fingerprint: string[], turnSeqs: number[], lastSeq: number, uuidSet?: Set<string>, uuidLine?: Map<string, number>}>} sessions
 * @param {number} minShared minimum matching leading turns to call it a fork
 * @returns {Map<string, {parentSessionId: string, seedLength: number}>}
 */
export function detectForks(sessions, minShared = 2) {
  const list = [...sessions.values()]

  // Build inverted index: uuid → [sessionId, ...] for O(n) lookup
  // ponytail: full uuid index, per-session bloom filter if memory matters at 10k+ sessions
  const uuidIndex = new Map()
  for (const session of list) {
    for (const uuid of (session.uuidSet ?? [])) {
      let arr = uuidIndex.get(uuid)
      if (arr === undefined) { arr = []; uuidIndex.set(uuid, arr) }
      arr.push(session.id)
    }
  }

  // For each session, count shared UUIDs with every other session
  const sharedCount = new Map()  // `${childId}:${parentId}` → count
  for (const session of list) {
    for (const uuid of (session.uuidSet ?? [])) {
      const others = uuidIndex.get(uuid)
      if (others === undefined || others.length < 2) continue
      for (const otherId of others) {
        if (otherId === session.id) continue
        const key = `${session.id}:${otherId}`
        sharedCount.set(key, (sharedCount.get(key) ?? 0) + 1)
      }
    }
  }

  const forks = new Map()

  for (const session of list) {
    if ((session.uuidSet?.size ?? 0) === 0) continue
    let bestParent = null
    let bestShared = 0

    for (const other of list) {
      if (other.id === session.id) continue
      // A fork is a snapshot of the original, so the CHILD holds fewer UUIDs:
      // the parent must be strictly larger. The original keeps taking turns,
      // which is why it ends up with the most UUIDs of the family.
      if ((other.uuidSet?.size ?? 0) <= (session.uuidSet?.size ?? 0)) continue
      const shared = sharedCount.get(`${session.id}:${other.id}`) ?? 0
      if (shared === 0) continue
      // Most shared UUIDs wins; ties go to the largest session, so snapshots
      // taken at different times all hang off the original as siblings instead
      // of chaining through each other (they share the same core, and tie).
      if (shared > bestShared || (shared === bestShared && bestParent !== null && (other.uuidSet?.size ?? 0) > (bestParent.uuidSet?.size ?? 0))) {
        bestShared = shared
        bestParent = other
      }
    }

    if (bestParent === null) continue

    // The fork cut is the last message the child inherited from the parent.
    // Look it up in the parent's own line index so the canvas anchors the
    // branch at the turn it actually forked from, not at the parent's end.
    let forkLine = -1
    for (const uuid of session.uuidSet ?? []) {
      const line = bestParent.uuidLine?.get(uuid)
      if (line !== undefined && line > forkLine) forkLine = line
    }
    // +1 because the consumer keeps cards with sourceSeq < seedLength.
    const seedLength = forkLine >= 0 ? forkLine + 1 : bestParent.lastSeq
    if (Number.isSafeInteger(seedLength) && seedLength > 0) {
      forks.set(session.id, { parentSessionId: bestParent.id, seedLength })
    }
  }

  // Fall back to fingerprint for sessions not matched by UUID path
  const fingerprintList = list.filter(s => !forks.has(s.id) && s.fingerprint?.length >= minShared)
  if (fingerprintList.length >= 2) {
    for (const child of fingerprintList) {
      if (forks.has(child.id)) continue
      let best = null; let shared = 0
      for (const parent of fingerprintList) {
        if (parent.id === child.id) continue
        if (parent.fingerprint.length >= child.fingerprint.length) continue
        let matched = 0
        while (matched < parent.fingerprint.length && parent.fingerprint[matched] === child.fingerprint[matched]) matched++
        if (matched !== parent.fingerprint.length || matched < minShared) continue
        if (best === null || parent.fingerprint.length > best.fingerprint.length) { best = parent; shared = matched }
      }
      if (best === null) continue
      const seedLength = best.turnSeqs[shared] ?? best.lastSeq
      if (Number.isSafeInteger(seedLength) && seedLength > 0) forks.set(child.id, { parentSessionId: best.id, seedLength })
    }
  }

  return forks
}
