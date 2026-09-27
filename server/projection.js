// The parts of transcript projection both harness adapters must agree on.
//
// Claude Code (transcript.js) and Codex (codex.js) both project onto one canvas
// and the store cannot tell their events apart, so anything that decides HOW
// MUCH of a message survives lives here rather than twice. A second copy would
// drift, and the drift would only ever show up as one harness's cards quietly
// behaving unlike the other's — the kind of difference nobody reports as a bug.

import { open } from 'node:fs/promises'

import { MAX_PROJECTION_LENGTH, PROJECTION_TRUNCATED_SUFFIX } from './workspace-store.js'

// Tool payloads are unbounded on disk: a single Write argument measured 88 KB,
// and tool records dominated the canvas state file (3.7 MB of 5 MB) — a file the
// store rewrites in full on every save. Message text is already capped
// (MAX_PROJECTION_LENGTH in the store); tool records were not, so cap them here.
// The detail view shows the head, which is what a folded tool record is for.
export const MAX_TOOL_LENGTH = 2_000
export const TOOL_TRUNCATED_SUFFIX = '\n——…（已截断）'

/** Most bytes of one transcript to ingest per poll, so a huge file cannot OOM the server. */
export const MAX_READ_BYTES = 16 * 1024 * 1024

// How recently a transcript must have been written for the text held at its EOF
// to count as a reply still being written. See `liveText` below.
export const LIVE_WINDOW_MS = 60_000

export function clampTool(text) {
  if (typeof text !== 'string' || text.length <= MAX_TOOL_LENGTH) return text
  return `${text.slice(0, MAX_TOOL_LENGTH)}${TOOL_TRUNCATED_SUFFIX}`
}

/**
 * Partial text of the group that is still being written, clamped exactly like a
 * projected message (same cap, same suffix, same trim) so the client can patch
 * it into the card the finished answer will replace without the two disagreeing.
 * Null when there is nothing to show — no open group, or one carrying only
 * thinking / tool_use blocks — because the client renders its own placeholder
 * for that, and an empty string would only churn the DOM once a second.
 */
export function liveText(parts) {
  const text = parts.join('\n').trim()
  if (text === '') return null
  if (text.length <= MAX_PROJECTION_LENGTH) return text
  return `${text.slice(0, MAX_PROJECTION_LENGTH)}${PROJECTION_TRUNCATED_SUFFIX}`
}

/** Warning latch: report a given surprise once, not once per line. */
const reported = new Set()
export function reportOnce(key, detail) {
  if (reported.has(key)) return
  reported.add(key)
  console.warn(`[ccSynapse] transcript: ${detail}`)
}

/**
 * Read the complete lines appended to `path` since the last call, updating the
 * cursor in place.
 *
 * `cursor` is any object holding `offset` (bytes already consumed) and `size`
 * (the length seen last time, or -1 for a file never read). A caller may pass
 * its own session cache directly.
 *
 * `reset` says the file was rewritten or truncated in place, so the bytes at
 * `offset` are no longer the ones that were there: the offset is rewound to 0
 * and the caller must drop every index into the old bytes. It is reported
 * rather than handled here because what needs dropping is per-harness.
 *
 * A trailing partial line is held for the next poll instead of parsed, and at
 * most MAX_READ_BYTES is read per call. Claude Code's own reader carries a 50 MB
 * cap with the note that session files "can grow to multiple GB", and this used
 * to allocate the whole remainder in one buffer; a file larger than the cap now
 * catches up over several polls instead of being read in one allocation, and the
 * partial-line handling leaves the offset on a boundary meanwhile.
 *
 * @returns {Promise<{lines: string[], grew: boolean, reset: boolean}>}
 */
export async function readAppended(path, cursor) {
  let handle
  try { handle = await open(path, 'r') }
  catch { return { lines: [], grew: false, reset: false } }
  try {
    const info = await handle.stat()
    const grew = cursor.size === -1 ? true : info.size !== cursor.size
    const reset = info.size < cursor.offset
    cursor.size = info.size
    if (reset) cursor.offset = 0
    if (info.size === cursor.offset) return { lines: [], grew, reset }

    const length = Math.min(info.size - cursor.offset, MAX_READ_BYTES)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset)
    const chunk = buffer.subarray(0, bytesRead).toString('utf8')
    // Hold a trailing partial line for the next poll rather than parsing it.
    const lastBreak = chunk.lastIndexOf('\n')
    if (lastBreak === -1) return { lines: [], grew, reset }
    cursor.offset += Buffer.byteLength(chunk.slice(0, lastBreak + 1), 'utf8')
    return { lines: chunk.slice(0, lastBreak).split('\n'), grew, reset }
  } finally {
    await handle.close()
  }
}
