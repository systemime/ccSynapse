// Codex rollout -> the same projection events transcript.js emits for Claude
// Code. The store cannot tell which harness an event came from, so the event
// shapes must match exactly: user/message, assistant/message (with
// turn/step/intermediate/thinking/messageId), tool/call, tool/result.
//
// The format below was measured over this machine's whole corpus (12 sessions,
// 1443 lines, codex-cli 0.150.1), not read off a spec — Codex documents nothing
// here, and like Claude Code's transcript it can change on any release. So the
// same three rules apply: every unknown type is skipped, a surprise degrades one
// card instead of taking the server down, and nothing outside this file parses a
// rollout. Verified live against a session started while writing this.
//
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO timestamp>-<uuid>.jsonl
//   { timestamp, ordinal, type, payload }
//   type: session_meta | event_msg | response_item | turn_context | world_state
//
// Only `response_item` carries conversation. Four things the corpus settled that
// are easy to get wrong:
//
//   1. `ordinal` is the file's own monotonic 0-based counter (checked 0..n-1 in
//      all 12 files), so it IS the seq — no line index to reconstruct, and it
//      stays correct across the torn lines a partial read can produce.
//   2. `payload.internal_chat_message_metadata_passthrough.turn_id` is present
//      on 100% of response_item (586/586). Turn membership is DATA, not a timing
//      guess: every item sharing a turn_id is one turn, which is why this file
//      needs none of Claude Code's message-id grouping and open-group
//      bookkeeping.
//   3. `phase` on an assistant message is 'commentary' (56), 'final_answer' (19),
//      or absent (4). It is the model's own declaration of narration vs output,
//      and it beats any structural guess: 8 turns in this corpus contain BOTH
//      tool calls and a final_answer, so "the turn has tool calls, therefore
//      this message is narration" would misfile those 8 real answers. The 4
//      phase-less messages are all turns' last message with no tool call before
//      or after them — answers by structure too, so the two rules agree there.
//   4. Appends are whole items. Measured on a live session: a 6104-character
//      assistant message went from absent to complete in a single write, never a
//      partial size. So unlike Claude Code — which writes one API message across
//      several lines — there is never half-written text on disk, and the only
//      thing that can still be in flight is the file's TRAILING message. That is
//      what this adapter holds open and serves as `liveText`.

import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { clampTool, liveText, readAppended, reportOnce, LIVE_WINDOW_MS } from './projection.js'

// Text Codex injects as a `user` message that nobody typed, measured over the
// corpus: `<environment_context>` 12 (cwd, shell, date, sandbox policy — session
// setup) and `<turn_aborted>` 6 (the machine notice that a turn was interrupted,
// which arrives in the same turn as a real question). The remaining 32 user
// messages are real questions, and the independent count of
// `event_msg`/`item_completed` with `item.type === 'UserMessage'` is also exactly
// 32 — two sources agreeing, which test/codex.test.js asserts on the real corpus.
const INJECTED_ONLY = /^\s*<(environment_context|turn_aborted)>/

/** The prompt a person actually typed, or null when the message is Codex's own injection. */
export function promptText(content) {
  const text = content.trim()
  if (text === '') return null
  return INJECTED_ONLY.test(text) ? null : text
}

/**
 * Text of a content block array. Codex writes role-specific types — `output_text`
 * for the assistant, `input_text` for user and developer — but all of them carry
 * their text in `text`; anything else (an image, say) contributes nothing.
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (typeof block?.text === 'string' ? block.text : '')).join('')
}

/** Tool output blocks, flattened the way transcript.js flattens a tool_result. */
function flattenOutput(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output
    .map(block => (block?.type === 'image' || block?.type === 'input_image' ? '[image]' : typeof block?.text === 'string' ? block.text : ''))
    .filter(part => part !== '')
    .join('\n')
}

// rollout-<ISO timestamp>-<uuid>.jsonl. The session_meta line carries the same id
// and overrides this; the filename is only needed to key the cache before the
// first line has been parsed.
const ROLLOUT_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
function sessionIdFromName(path) {
  const name = basename(path)
  return ROLLOUT_UUID.exec(name)?.[1] ?? basename(name, '.jsonl')
}

class RolloutCache {
  constructor(path, sessionId) {
    this.path = path
    this.sessionId = sessionId
    this.offset = 0
    this.size = -1
    this.lineCount = 0
    this.cwd = null
    // Codex records no title, unlike Claude Code's `ai-title`. Left null so the
    // store names the thread from its first question — which works out because
    // the injection filter above means the first `user/message` this file emits
    // is a real one.
    this.title = null
    this.turn = 0
    this.turnId = null
    this.pendingThinking = 0
    this.open = null      // the trailing assistant message, held until the file grows past it
    this.primed = false
  }
}

/**
 * Incrementally projects every rollout under `root` into `store`.
 * Only appended bytes are ever re-read; a full parse happens once per file.
 */
export class CodexSource {
  /** @param {string} root directory holding <YYYY>/<MM>/<DD>/rollout-*.jsonl */
  constructor(root) {
    this.root = root
    this.caches = new Map()
    this.sessions = new Map()
  }

  /** @returns {string[]|null} rollout paths, or null when the root cannot be listed at all */
  async #listRollouts() {
    let entries
    // The layout is three date directories deep and not worth walking by hand;
    // `recursive` is the stdlib answer and it also survives a layout change.
    try { entries = await readdir(this.root, { withFileTypes: true, recursive: true }) }
    catch { return null }
    const files = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue
      files.push(join(entry.parentPath, entry.name))
    }
    return files
  }

  /** Emit the held trailing message, if any. */
  #flushOpen(cache, out) {
    const open = cache.open
    if (open === null) return
    cache.open = null
    out.push({
      seq: open.seq,
      time: open.time,
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text: open.text }] },
        turn: open.turn,
        step: 1,
        messageId: open.messageId,
        intermediate: open.intermediate,
        thinking: open.thinking,
      },
    })
  }

  async #project(cache) {
    const { lines, grew, reset } = await readAppended(cache.path, cache)
    const events = []
    if (reset) {
      reportOnce(`rewrite:${cache.path}`, `codex rollout rewritten in place, reprojecting: ${cache.path}`)
      cache.lineCount = 0
      cache.turn = 0
      cache.turnId = null
      cache.pendingThinking = 0
      cache.open = null
      cache.primed = false
    }

    for (const line of lines) {
      const seq = cache.lineCount++
      if (line.trim() === '') continue
      // Anything at all after a message proves that message complete, so the
      // hold is released at the top of every line — what survives is exactly the
      // file's trailing message. Released before the parse, so a line this
      // adapter cannot read still counts as "something came after it".
      this.#flushOpen(cache, events)
      let envelope
      try { envelope = JSON.parse(line) } catch { continue }   // torn line: skip, never throw
      const time = typeof envelope.timestamp === 'string' ? envelope.timestamp : new Date().toISOString()

      if (envelope.type === 'session_meta') {
        const meta = envelope.payload ?? {}
        if (typeof meta.cwd === 'string' && meta.cwd.trim() !== '') cache.cwd = meta.cwd
        if (typeof meta.session_id === 'string' && meta.session_id !== '') cache.sessionId = meta.session_id
        continue
      }
      // event_msg (token counts, task start/complete), turn_context and
      // world_state all repeat what response_item already carries, or carry
      // nothing the canvas draws.
      if (envelope.type !== 'response_item') continue

      const payload = envelope.payload ?? {}
      const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id
      if (turnId !== cache.turnId) {
        cache.turnId = turnId
        cache.turn += 1
        // Reasoning never crosses a turn boundary, so a pending count is dropped
        // with the turn that produced it.
        cache.pendingThinking = 0
      }

      if (payload.type === 'message') {
        // The developer role is the system prompt (skills instructions, measured
        // 12 times), not a turn.
        if (payload.role === 'developer') continue
        if (payload.role === 'user') {
          const prompt = promptText(textOf(payload.content))
          if (prompt !== null) events.push({ seq, time, type: 'user/message', data: { content: [{ type: 'text', text: prompt }] } })
          continue
        }
        if (payload.role !== 'assistant') continue
        const text = textOf(payload.content)
        if (text.trim() === '') continue
        // Held rather than emitted: it is the only candidate for "still being
        // written" (see the header note). Its own turn rides along, because
        // `cache.turn` has moved on by the time the next poll releases it.
        cache.open = {
          seq,
          time,
          turn: cache.turn,
          messageId: typeof payload.id === 'string' ? payload.id : null,
          intermediate: payload.phase === 'commentary',
          thinking: cache.pendingThinking,
          text,
        }
        cache.pendingThinking = 0
        continue
      }

      // Only the COUNT leaves this file. The canvas summarizes thinking
      // ("思考 N") and never shows it, and Codex encrypts the text anyway —
      // `encrypted_content` with an empty `summary` in 189 of 193 items.
      if (payload.type === 'reasoning') {
        cache.pendingThinking += 1
        continue
      }

      // `custom_tool_call` carries its argument as a raw string, `function_call`
      // as JSON text; both are clamped on the way out, like every other tool
      // payload.
      if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
        events.push({
          seq, time, type: 'tool/call',
          data: {
            callId: payload.call_id,
            name: payload.name,
            arguments: clampTool(payload.type === 'custom_tool_call' ? payload.input : payload.arguments),
            turn: cache.turn,
            step: 1,
          },
        })
        continue
      }

      if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
        // `error` stays null: every call in the corpus completed, and the exit
        // status of a failed one is prose inside the output text, not a field.
        // Reporting "no error" is honest here; inventing one is not.
        events.push({
          seq, time, type: 'tool/result',
          data: {
            callId: payload.call_id,
            error: null,
            message: { source: { callId: payload.call_id }, content: [{ type: 'text', text: clampTool(flattenOutput(payload.output)) }] },
            turn: cache.turn,
            step: 1,
          },
        })
        continue
      }

      reportOnce(`unknown:${payload.type}`, `unknown Codex item type "${payload.type}" skipped`)
    }

    // A trailing message on a file that has stopped growing is finished (the
    // turn ended); release it now instead of waiting for a next line that may
    // never come.
    if (cache.open !== null && !grew) this.#flushOpen(cache, events)
    return events
  }

  /**
   * Pull new events out of every rollout and hand them to the store.
   *
   * `mapSessionId` is applied only to the id handed to the store, exactly as in
   * transcript.js, so `this.sessions` stays keyed by the real id for lineage and
   * the bridge.
   */
  async sync(store, fallbackTitle, mapSessionId = id => id) {
    const paths = await this.#listRollouts()
    // A root that cannot be listed is not an empty root — same rule as
    // transcript.js: keep the last known state and let the next poll retry,
    // rather than un-naming every session for one tick. `~/.codex` does not
    // exist on a machine without Codex, which is the ordinary case, not an error.
    if (paths === null) return this.sessions

    for (const path of paths) {
      let info
      try { info = await stat(path) } catch { continue }

      let cache = this.caches.get(path)
      if (cache === undefined) {
        cache = new RolloutCache(path, sessionIdFromName(path))
        this.caches.set(path, cache)
      } else if (info.size === cache.size && cache.open === null && cache.offset >= cache.size) {
        continue                              // nothing new, nothing held open, nothing left unread
      }

      const events = await this.#project(cache)
      if (cache.cwd === null) continue        // session_meta not read yet: no session
      if (events.length === 0 && cache.primed && cache.open === null) continue

      const session = {
        id: mapSessionId(cache.sessionId),
        harness: 'codex',
        title: cache.title,
        header: { cwd: cache.cwd },
        firstLiveSeq: 0,
        events,
      }
      this.sessions.set(cache.sessionId, {
        id: cache.sessionId, harness: 'codex', cwd: cache.cwd, title: cache.title, mtimeMs: info.mtimeMs,
        lastSeq: cache.lineCount,
        parentSessionId: null,
        // Deliberately no `uuidSet` and no `fingerprint`: detectForks has nothing
        // to match a Codex session on, which is the point. Codex lineage is not
        // auto-detected — re-asking one question in a fresh session would
        // fingerprint exactly like a fork, and this machine has no Codex fork to
        // check such a rule against. A Codex branch ccSynapse starts itself is
        // (later) recorded exactly instead of guessed.
        //
        // `liveText` is the trailing message while the file is warm: with whole-
        // item appends it is the only text that can still be in flight, and the
        // same 60s window as transcript.js keeps a finished session from
        // flashing 「正在回复」on the first sync after a restart.
        liveText: cache.open !== null && Date.now() - info.mtimeMs <= LIVE_WINDOW_MS ? liveText([cache.open.text]) : null,
      })

      try {
        if (cache.primed) await store.projectEvents(session, events, fallbackTitle)
        else { await store.projectSession(session, 0, fallbackTitle); cache.primed = true }
      } catch (error) {
        console.warn(`[ccSynapse] codex projection failed for ${cache.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // A rollout that is gone must leave both maps, for the reasons transcript.js
    // spells out: `caches` is a pure read cache (a file that comes back is
    // re-read from 0 and re-projected, which the store dedups by seq), and every
    // `sessions` consumer wants the sessions that exist NOW.
    const current = new Set(paths)
    for (const path of [...this.caches.keys()]) {
      if (!current.has(path)) this.caches.delete(path)
    }
    const reading = new Set([...this.caches.values()].map(cache => cache.sessionId))
    for (const id of [...this.sessions.keys()]) {
      if (!reading.has(id)) this.sessions.delete(id)
    }
    return this.sessions
  }
}
