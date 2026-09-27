// Behavioural tests for the Codex rollout adapter. The fixtures mirror shapes
// observed on a real machine (codex-cli 0.150.1, 12 sessions / 1443 lines),
// including the awkward ones: an injection-only opening turn, a message with no
// `phase`, and a final answer in a turn that also ran tools.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, utimes, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexSource, promptText } from '../server/codex.js'
import { WorkspaceStore } from '../server/workspace-store.js'
import { MAX_TOOL_LENGTH, TOOL_TRUNCATED_SUFFIX } from '../server/projection.js'

const SESSION_ID = '01a00b9f-428f-73c0-baf2-4089c9635ca2'
const PROMPT = '把这段报错定位到具体的协议字段'

/** Minimal stand-in for WorkspaceStore that records what the projector emits. */
function stubStore() {
  return {
    calls: [],
    projected: [],
    async projectSession(session, replayFrom, title) { this.calls.push(['session', session.id, title]); this.projected.push(...session.events) },
    async projectEvents(session, events, title) { this.calls.push(['events', session.id, title]); this.projected.push(...events) },
  }
}

/**
 * Write a rollout. `ordinal` is generated from the array index because that is
 * exactly what the real format does (verified 0..n-1 in all 12 files on disk).
 */
async function fixture(entries) {
  const root = await mkdtemp(join(tmpdir(), 'ccsynapse-codex-'))
  const day = join(root, '2026', '08', '17')
  await mkdir(day, { recursive: true })
  const file = join(day, `rollout-2026-08-17T01-29-41-${SESSION_ID}.jsonl`)
  await writeFile(file, entries.map((entry, ordinal) => `${JSON.stringify({ timestamp: '2026-08-17T01:29:41.000Z', ordinal, ...entry })}\n`).join(''), 'utf8')
  return { root, file, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const meta = cwd => ({ type: 'session_meta', payload: { session_id: SESSION_ID, id: SESSION_ID, cwd, originator: 'codex-tui', cli_version: '0.150.1' } })
// Only response_item is conversation; everything else must be skipped.
const noise = type => ({ type, payload: { turn_id: 'ignored', cwd: 'C:\\Elsewhere' } })

let ids = 0
const item = (payload, turn = 'turn-1') => ({ type: 'response_item', payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: turn } } })
const userMessage = (text, turn) => item({ type: 'message', id: `m${ids++}`, role: 'user', content: [{ type: 'input_text', text }] }, turn)
const assistantMessage = (text, phase, turn) => item({ type: 'message', id: `msg_${ids++}`, role: 'assistant', content: [{ type: 'output_text', text }], ...(phase === undefined ? {} : { phase }) }, turn)
const developerMessage = text => item({ type: 'message', id: `m${ids++}`, role: 'developer', content: [{ type: 'input_text', text }] })
const reasoning = turn => item({ type: 'reasoning', id: `rs_${ids++}`, summary: [], encrypted_content: 'ENCRYPTED' }, turn)
const customCall = (callId, name, input, turn) => item({ type: 'custom_tool_call', id: `ctc_${ids++}`, status: 'completed', call_id: callId, name, input }, turn)
const customOutput = (callId, text, turn) => item({ type: 'custom_tool_call_output', id: `ctco_${ids++}`, call_id: callId, output: [{ type: 'input_text', text }] }, turn)
const functionCall = (callId, name, args, turn) => item({ type: 'function_call', id: `fc_${ids++}`, name, arguments: args, call_id: callId }, turn)
const functionOutput = (callId, text, turn) => item({ type: 'function_call_output', id: `fco_${ids++}`, call_id: callId, output: [{ type: 'input_text', text }] }, turn)

/** Sync until the file stops yielding anything: the first pass holds the trailing message. */
async function project(source, passes = 2) {
  const store = stubStore()
  for (let pass = 0; pass < passes; pass++) await source.sync(store, 'T')
  return store
}

test('the envelope is three kinds of metadata plus response_item, and only the last projects', async () => {
  const { root, cleanup } = await fixture([
    meta('F:\\Project\\Demo'),
    noise('world_state'),
    noise('event_msg'),
    noise('turn_context'),
    userMessage(PROMPT),
    assistantMessage('回答', 'final_answer'),
  ])
  try {
    const store = await project(new CodexSource(root))
    assert.deepEqual(store.projected.map(event => event.type), ['user/message', 'assistant/message'])
    // seq is the envelope's own ordinal, not a line index reconstructed here.
    assert.deepEqual(store.projected.map(event => event.seq), [4, 5])
  } finally { await cleanup() }
})

test('injection wrappers are not questions, developer messages are not turns', async () => {
  const { root, cleanup } = await fixture([
    meta('F:\\Project\\Demo'),
    developerMessage('<skills_instructions>## Skills</skills_instructions>'),
    userMessage('<environment_context>\n<cwd>C:\\Users\\OwO</cwd>\n</environment_context>'),
    userMessage('<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>'),
    userMessage(PROMPT),
    assistantMessage('回答', 'final_answer'),
  ])
  try {
    const store = await project(new CodexSource(root))
    const prompts = store.projected.filter(event => event.type === 'user/message').map(event => event.data.content[0].text)
    assert.deepEqual(prompts, [PROMPT], 'only the typed question becomes a user turn')
    assert.equal(store.projected.some(event => /skills_instructions/.test(JSON.stringify(event.data))), false, 'the developer system prompt is never projected')
    // The unit under it, so a wrapper added later is a deliberate edit here.
    assert.equal(promptText('  <environment_context>\n<cwd>x</cwd>'), null)
    assert.equal(promptText('<turn_aborted>…'), null)
    assert.equal(promptText(' 真正的提问 '), '真正的提问')
  } finally { await cleanup() }
})

test('phase decides narration from output, not "the turn ran tools"', async () => {
  const { root, cleanup } = await fixture([
    meta('F:\\Project\\Demo'),
    userMessage(PROMPT),
    assistantMessage('我先看一下这个文件。', 'commentary'),
    customCall('call_1', 'exec', 'tools.read_file({path:"a.ts"})'),
    customOutput('call_1', 'export const a = 1'),
    assistantMessage('问题就在这里。', 'final_answer'),
    // 8 real turns in the corpus carry both tools and a final_answer, so a rule
    // built on "the turn has tool calls" would misfile every one of them.
    assistantMessage('这个会话没有工具可用。', undefined),
  ])
  try {
    const store = await project(new CodexSource(root))
    const messages = store.projected.filter(event => event.type === 'assistant/message')
    // A phase-less message is an answer too: it is where CLIs without the field
    // land, and it is what the 4 such messages in the real corpus are.
    assert.deepEqual(messages.map(event => event.data.intermediate), [true, false, false])
  } finally { await cleanup() }
})

test('reasoning is a count on the next message, never text of its own', async () => {
  const { root, cleanup } = await fixture([
    meta('F:\\Project\\Demo'),
    userMessage(PROMPT),
    reasoning(), reasoning(),
    assistantMessage('先看这里。', 'commentary'),
    customCall('call_1', 'exec', 'x'),
    customOutput('call_1', 'ok'),
    reasoning(), reasoning(), reasoning(),
    assistantMessage('结论。', 'final_answer'),
  ])
  try {
    const store = await project(new CodexSource(root))
    const messages = store.projected.filter(event => event.type === 'assistant/message')
    assert.deepEqual(messages.map(event => event.data.thinking), [2, 3])
    // Only the count leaves the adapter: the canvas summarizes thinking and
    // never shows it, and Codex encrypts the text anyway.
    assert.equal(store.projected.some(event => JSON.stringify(event).includes('ENCRYPTED')), false)
  } finally { await cleanup() }
})

test('a turn is a turn_id, and every item of one lands in it', async () => {
  const { root, cleanup } = await fixture([
    meta('F:\\Project\\Demo'),
    userMessage('第一问', '01a00ba0-125f-7c99-9586-649bfbb46cc5'),
    reasoning('01a00ba0-125f-7c99-9586-649bfbb46cc5'),
    assistantMessage('第一答', 'final_answer', '01a00ba0-125f-7c99-9586-649bfbb46cc5'),
    // The opening turn is context injection only: no question, so no turn spent.
    userMessage('<environment_context>\n<cwd>C:\\Users\\OwO</cwd>', '01a00ba1-aaaa-7c99-9586-649bfbb46cc5'),
    userMessage('第二问', '01a00ba2-125f-7c99-9586-649bfbb46cc5'),
    customCall('call_2', 'exec', 'y', '01a00ba2-125f-7c99-9586-649bfbb46cc5'),
    customOutput('call_2', 'ok', '01a00ba2-125f-7c99-9586-649bfbb46cc5'),
    assistantMessage('第二答', 'final_answer', '01a00ba2-125f-7c99-9586-649bfbb46cc5'),
  ])
  try {
    const store = await project(new CodexSource(root))
    // The injected turn takes a number but no card: the counter follows turn_id
    // changes, because nothing in the format promises a turn starts with a
    // prompt. `turn` is only ever used to fold a tool call into its own card, so
    // a number spent on a turn that emits nothing costs nothing.
    // Carried on the assistant message, exactly as transcript.js carries it: a
    // user/message has no turn, because the store files a question by its seq.
    const answers = store.projected.filter(event => event.type === 'assistant/message')
    assert.deepEqual(answers.map(event => event.data.turn), [1, 3])
    // The tool call and result carry the SAME turn/step as the message they
    // belong to, which is the only way the store can fold them into that card.
    const call = store.projected.find(event => event.type === 'tool/call')
    const result = store.projected.find(event => event.type === 'tool/result')
    assert.equal(call.data.turn, 3)
    assert.equal(call.data.step, 1)
    assert.equal(result.data.turn, 3)
    assert.equal(result.data.step, 1)
  } finally { await cleanup() }
})

test('both tool dialects map to one call/result pair, keyed by call_id', async () => {
  const { root, cleanup } = await fixture([
    meta('F:\\Project\\Demo'),
    userMessage(PROMPT),
    customCall('call_1', 'exec', 'const r = await tools.shell_command({command:"pnpm test"})'),
    customOutput('call_1', 'Exit code: 0'),
    functionCall('call_2', 'wait', '{"cell_id":"3","yield_time_ms":10000}'),
    functionOutput('call_2', 'Wall time 0.0 seconds'),
    assistantMessage('跑完了。', 'final_answer'),
  ])
  try {
    const store = await project(new CodexSource(root))
    const calls = store.projected.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => [event.data.callId, event.data.name]), [['call_1', 'exec'], ['call_2', 'wait']])
    // `custom_tool_call.input` is a raw string and `function_call.arguments` is
    // JSON text; both come out as the string the store folds.
    assert.equal(calls[1].data.arguments, '{"cell_id":"3","yield_time_ms":10000}')
    const results = store.projected.filter(event => event.type === 'tool/result')
    assert.deepEqual(results.map(event => event.data.message.source.callId), ['call_1', 'call_2'])
    assert.equal(results[0].data.message.content[0].text, 'Exit code: 0')
    assert.equal(results[0].data.error, null)
  } finally { await cleanup() }
})

test('tool payloads are clamped like Claude Code clamps its own', async () => {
  const { root, cleanup } = await fixture([
    meta('F:\\Project\\Demo'),
    userMessage(PROMPT),
    customCall('call_1', 'exec', 'x'.repeat(MAX_TOOL_LENGTH + 5_000)),
    customOutput('call_1', 'y'.repeat(MAX_TOOL_LENGTH + 5_000)),
    assistantMessage('好了。', 'final_answer'),
  ])
  try {
    const store = await project(new CodexSource(root))
    const call = store.projected.find(event => event.type === 'tool/call')
    const result = store.projected.find(event => event.type === 'tool/result')
    assert.equal(call.data.arguments.length, MAX_TOOL_LENGTH + TOOL_TRUNCATED_SUFFIX.length)
    assert.ok(call.data.arguments.endsWith(TOOL_TRUNCATED_SUFFIX))
    assert.equal(result.data.message.content[0].text.length, MAX_TOOL_LENGTH + TOOL_TRUNCATED_SUFFIX.length)
  } finally { await cleanup() }
})

test('the trailing message is held, served as liveText, then released', async () => {
  const { root, file, cleanup } = await fixture([
    meta('F:\\Project\\Demo'),
    userMessage(PROMPT),
    assistantMessage('前半句', 'final_answer'),
  ])
  try {
    const source = new CodexSource(root)
    const store = stubStore()
    await source.sync(store, 'T')
    // Codex appends whole items, so the trailing message is the only text that
    // can still be in flight — held out of the store, visible only here.
    assert.equal(store.projected.some(event => event.type === 'assistant/message'), false)
    assert.equal(source.sessions.get(SESSION_ID).liveText, '前半句')

    await source.sync(store, 'T')
    const answers = store.projected.filter(event => event.type === 'assistant/message')
    assert.deepEqual(answers.map(event => event.data.message.content[0].text), ['前半句'])
    // Its own turn travelled with it: the counter had moved on by the time the
    // next pass released it.
    assert.equal(answers[0].data.turn, 1)
    assert.equal(source.sessions.get(SESSION_ID).liveText, null)

    // Nothing left to say: a third pass projects nothing at all.
    const before = store.projected.length
    await source.sync(store, 'T')
    assert.equal(store.projected.length, before)
  } finally { await cleanup() }
})

test('a cold file is not a reply in progress, and growing appends project once', async () => {
  const { root, file, cleanup } = await fixture([
    meta('F:\\Project\\Demo'),
    userMessage(PROMPT),
    assistantMessage('旧回答', 'final_answer'),
  ])
  try {
    // Every file's first read has no size to compare against and counts as
    // "grew", so an ungated hold would flash 「正在回复」on every finished
    // session at startup. mtime is the honest signal.
    const old = new Date(Date.now() - 3_600_000)
    await utimes(file, old, old)
    const source = new CodexSource(root)
    const store = stubStore()
    await source.sync(store, 'T')
    assert.equal(source.sessions.get(SESSION_ID).liveText, null)

    await appendFile(file, `${JSON.stringify({ timestamp: '2026-08-17T01:30:00.000Z', ordinal: 3, ...userMessage('第二问', 'turn-2') })}\n`, 'utf8')
    await appendFile(file, `${JSON.stringify({ timestamp: '2026-08-17T01:30:01.000Z', ordinal: 4, ...assistantMessage('第二答', 'final_answer', 'turn-2') })}\n`, 'utf8')
    await source.sync(store, 'T')
    await source.sync(store, 'T')
    const prompts = store.projected.filter(event => event.type === 'user/message')
    assert.deepEqual(prompts.map(event => event.data.content[0].text), [PROMPT, '第二问'])
    assert.deepEqual(prompts.map(event => event.seq), [1, 3], 'seq stays the envelope ordinal across the append')
    const answers = store.projected.filter(event => event.type === 'assistant/message')
    assert.deepEqual(answers.map(event => event.data.turn), [1, 2], 'the appended turn is a new turn, not a re-read')
  } finally { await cleanup() }
})

test('a rollout is listed from its date directories, and a missing root is not an error', async () => {
  const { root, cleanup } = await fixture([meta('F:\\Project\\Demo'), userMessage(PROMPT), assistantMessage('回答', 'final_answer')])
  try {
    const nested = await readdir(join(root, '2026', '08', '17'))
    assert.equal(nested.length, 1)
    const source = new CodexSource(join(root, 'does', 'not', 'exist'))
    const store = stubStore()
    assert.equal((await source.sync(store, 'T')).size, 0, 'an absent Codex root is the ordinary case, not a failure')
    assert.equal(store.calls.length, 0)
  } finally { await cleanup() }
})

test('the harness rides along on the projected session, and the store names the thread from the real question', async () => {
  const { root, cleanup } = await fixture([
    meta('F:\\Project\\Demo'),
    userMessage('<environment_context>\n<cwd>F:\\Project\\Demo</cwd>\n</environment_context>'),
    userMessage(PROMPT),
    assistantMessage('回答', 'final_answer'),
  ])
  const directory = await mkdtemp(join(tmpdir(), 'ccsynapse-codex-store-'))
  try {
    const store = new WorkspaceStore(join(directory, 'state.json'))
    const source = new CodexSource(root)
    await source.sync(store, 'Claude Code 任务')
    await source.sync(store, 'Claude Code 任务')
    assert.equal(source.sessions.get(SESSION_ID).harness, 'codex')

    const [workspace] = await store.list()
    const projected = await store.get(workspace.id)
    const [thread] = projected.threads
    assert.equal(thread.harness, 'codex')
    // Not `<environment_context>`: codex.js filters it before the store ever
    // sees a turn, so the first user/message IS the first real question.
    assert.equal(thread.title, PROMPT)
    assert.deepEqual(thread.messages.map(message => message.kind), ['user', 'assistant'])
    assert.equal(thread.messages[0].text, PROMPT)
  } finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
})

test('a rewritten rollout reprojects instead of holding a stale ordinal', async () => {
  const { root, file, cleanup } = await fixture([
    meta('F:\\Project\\Demo'),
    userMessage('第一问'),
    assistantMessage('第一答', 'final_answer'),
    userMessage('第二问', 'turn-2'),
    assistantMessage('第二答', 'final_answer', 'turn-2'),
  ])
  try {
    const source = new CodexSource(root)
    const store = stubStore()
    await source.sync(store, 'T')
    await source.sync(store, 'T')
    assert.equal(store.projected.filter(event => event.type === 'user/message').length, 2)

    // Truncated in place: every ordinal moved, so nothing keyed to the old bytes
    // may survive. The store dedups by seq, so replaying is a no-op.
    await writeFile(file, [
      { timestamp: '2026-08-17T02:00:00.000Z', ordinal: 0, ...meta('F:\\Project\\Demo') },
      { timestamp: '2026-08-17T02:00:01.000Z', ordinal: 1, ...userMessage('只剩这一问') },
      { timestamp: '2026-08-17T02:00:02.000Z', ordinal: 2, ...assistantMessage('只剩这一答', 'final_answer') },
    ].map(entry => `${JSON.stringify(entry)}\n`).join(''), 'utf8')
    await source.sync(store, 'T')
    await source.sync(store, 'T')
    const prompts = store.projected.filter(event => event.type === 'user/message')
    assert.equal(prompts.at(-1).data.content[0].text, '只剩这一问')
    assert.equal(prompts.at(-1).seq, 1, 'the ordinal is the rewritten line position, not the old one')
    const answers = store.projected.filter(event => event.type === 'assistant/message')
    assert.equal(answers.at(-1).data.message.content[0].text, '只剩这一答')
    assert.equal(answers.at(-1).data.turn, 1, 'the turn counter restarted with the file')
    assert.equal((await readFile(file, 'utf8')).split('\n').filter(line => line.trim() !== '').length, 3)
  } finally { await cleanup() }
})

const REAL_ROOT = process.env.CCSYNAPSE_CODEX_SESSIONS ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codex', 'sessions')

test('the real Codex corpus: projected questions match the machine-recorded UserMessage count', { skip: existsSync(REAL_ROOT) ? false : 'no Codex sessions on this machine' }, async () => {
  const root = REAL_ROOT
  const rolloutFiles = (await readdir(root, { withFileTypes: true, recursive: true }))
    .filter(entry => entry.isFile() && entry.name.startsWith('rollout-'))

  // Two independent records of the same fact: the transcript's own user messages
  // (minus the injected wrappers) and the event stream's completion events.
  let recorded = 0
  for (const entry of rolloutFiles) {
    const text = await readFile(join(entry.parentPath, entry.name), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const raw = JSON.parse(line)
      if (raw.type === 'event_msg' && raw.payload?.item?.type === 'UserMessage' && raw.payload.type === 'item_completed') recorded++
    }
  }

  const store = stubStore()
  const source = new CodexSource(root)
  await source.sync(store, 'T')
  await source.sync(store, 'T')
  const prompts = store.projected.filter(event => event.type === 'user/message')
  assert.equal(prompts.length, recorded, 'the two records of "how many questions" must agree')
  assert.ok(prompts.length > 0, 'the corpus is not empty')
  // No injection wrapper and no developer payload may reach the canvas, and every
  // projected assistant message must be one of the two declared phases.
  assert.equal(store.projected.some(event => /<(environment_context|turn_aborted)>/.test(event.data?.content?.[0]?.text ?? '')), false)
  assert.equal(store.projected.some(event => /skills_instructions/.test(JSON.stringify(event.data ?? {}))), false)
  for (const event of store.projected.filter(item => item.type === 'assistant/message')) {
    assert.equal(typeof event.data.intermediate, 'boolean')
    assert.equal(typeof event.data.turn, 'number')
    assert.equal(event.data.thinking >= 0, true)
  }
})
