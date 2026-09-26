import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { trustSet, rejectStatus } from '../server/trust.js'
import { createRouter, sendJson } from '../server/routes.js'
import { createRpcHandler } from '../server/rpc.js'
import { WorkspaceStore, NotFoundError } from '../server/workspace-store.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mockReq(method, headers = {}, body = null) {
  const req = new PassThrough()
  req.method = method
  req.headers = { host: '127.0.0.1', ...headers }
  if (body !== null) req.push(JSON.stringify(body))
  req.push(null)
  return req
}

function mockRes() {
  const res = {}
  res.writeHead = (status, hdrs) => { res.status = status; res.headers = hdrs ?? {} }
  res.end = (raw) => { try { res.body = JSON.parse(raw) } catch { res.body = raw } }
  return res
}

function stubStore(overrides = {}) {
  return {
    list: async () => [],
    get: async () => { throw new NotFoundError('not found') },
    create: async (title) => ({ id: 'ws-1', title }),
    createThread: async () => { throw new NotFoundError('not found') },
    removeThread: async () => { throw new NotFoundError('not found') },
    updateThread: async () => { throw new NotFoundError('not found') },
    addMessage: async () => { throw new NotFoundError('not found') },
    branch: async () => { throw new NotFoundError('not found') },
    clearLegacy: async () => ({}),
    listArchived: async () => [],
    unarchiveThread: async () => { throw new NotFoundError('not found') },
    ...overrides,
  }
}

function stubSource(sessions = new Map()) {
  return { sessions }
}

// Mirrors the error handling in index.js so route tests can check 404 responses.
async function callApi(handleApi, req, pathname) {
  const res = mockRes()
  try {
    await handleApi(req, res, pathname)
  } catch (err) {
    if (err instanceof NotFoundError) sendJson(res, 404, { error: err.message })
    else throw err
  }
  return res
}

// ---------------------------------------------------------------------------
// trust gate integration (complements trust.test.js unit tests)
// ---------------------------------------------------------------------------

test('非 JSON content-type 的 POST 被拒绝 → 415', () => {
  const TRUSTED = trustSet([])
  const req = { headers: { host: '127.0.0.1', 'content-type': 'text/plain' }, method: 'POST' }
  assert.equal(rejectStatus(req, TRUSTED), 415)
})

test('带 X-Forwarded-For 的请求被拒绝 → 403', () => {
  const TRUSTED = trustSet([])
  const req = { headers: { host: '127.0.0.1', 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, method: 'POST' }
  assert.equal(rejectStatus(req, TRUSTED), 403)
})

test('跨域 Origin 被拒绝 → 403', () => {
  const TRUSTED = trustSet([])
  const req = { headers: { host: '127.0.0.1', 'content-type': 'application/json', origin: 'https://evil.example' }, method: 'POST' }
  assert.equal(rejectStatus(req, TRUSTED), 403)
})

test('合法本地请求通过信任闸 → null', () => {
  const TRUSTED = trustSet([])
  const req = { headers: { host: '127.0.0.1', 'content-type': 'application/json' }, method: 'POST' }
  assert.equal(rejectStatus(req, TRUSTED), null)
})

// ---------------------------------------------------------------------------
// route status codes
// ---------------------------------------------------------------------------

test('GET /api/workspaces → 200', async () => {
  const { handleApi } = createRouter({
    store: stubStore({ list: async () => [] }),
    source: stubSource(),
    handleRpc: async () => [],
    toLocal: id => id,
  })
  const res = await callApi(handleApi, mockReq('GET'), '/api/workspaces')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.workspaces, [])
})

test('不存在的 API 路由 → 404', async () => {
  const { handleApi } = createRouter({
    store: stubStore(),
    source: stubSource(),
    handleRpc: async () => [],
    toLocal: id => id,
  })
  const res = await callApi(handleApi, mockReq('GET'), '/api/does-not-exist')
  assert.equal(res.status, 404)
})

// ---------------------------------------------------------------------------
// RPC fork-session 占位符别名闭环
// ---------------------------------------------------------------------------

test('synapse:fork-session 返回含 placeholder sessionId 的响应', async () => {
  const parentId = 'parent-session-id'
  const sessions = new Map([
    [parentId, { cwd: '/workspace', title: '主会话', lastSeq: 3, mtimeMs: Date.now() }],
  ])
  const pendingForks = new Map()
  const { handleRpc } = createRpcHandler({
    source: stubSource(sessions),
    aliases: new Map(),
    locals: new Map(),
    pendingForks,
    activeSessionRef: { id: null },
    config: { backgroundArgs: [] },
    bridge: {
      continueSession: async () => { throw new Error('stub: should not be called') },
      forkSession:     async () => { throw new Error('stub: should not be called') },
      createSession:   async () => { throw new Error('stub: should not be called') },
      openInTerminal:  ()      => ({ opened: false, reason: 'test' }),
    },
  })

  const messages = await handleRpc({ type: 'synapse:fork-session', sessionId: parentId, requestId: 'req-1' })

  assert.equal(messages.length, 1)
  const [msg] = messages
  assert.equal(msg.type, 'synapse:forked-session')
  assert.equal(msg.requestId, 'req-1')
  assert.match(msg.session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(msg.session.cwd, '/workspace')

  // placeholder is tracked so send-message can resolve it later
  assert.ok(pendingForks.has(msg.session.id))
})

test('synapse:send-message 拿到真实 id 后回调 onAlias(real, placeholder)', async () => {
  const parentId = 'parent-session-id'
  const sessions = new Map([
    [parentId, { cwd: '/workspace', title: '主会话', lastSeq: 3, mtimeMs: Date.now() }],
  ])
  const pendingForks = new Map()
  const aliases = new Map()
  const locals = new Map()
  const seen = []
  const { handleRpc } = createRpcHandler({
    source: stubSource(sessions),
    aliases,
    locals,
    pendingForks,
    activeSessionRef: { id: null },
    config: { backgroundArgs: [] },
    onAlias: (realId, localId) => seen.push([realId, localId]),
    bridge: {
      continueSession: async () => { throw new Error('stub: should not be called') },
      forkSession:     async () => ({ shortId: null, sessionId: 'real-session-id', forked: true }),
      createSession:   async () => { throw new Error('stub: should not be called') },
      openInTerminal:  ()      => ({ opened: false, reason: 'test' }),
    },
  })

  const [forked] = await handleRpc({ type: 'synapse:fork-session', sessionId: parentId, requestId: 'req-1' })
  await handleRpc({ type: 'synapse:send-message', sessionId: forked.session.id, text: '继续', requestId: 'req-2' })

  assert.deepEqual(seen, [['real-session-id', forked.session.id]])
  assert.equal(aliases.get('real-session-id'), forked.session.id)
  assert.equal(locals.get(forked.session.id), 'real-session-id')
})

// ---------------------------------------------------------------------------
// 画布分支别名的持久化（重启后不丢）
// ---------------------------------------------------------------------------

test('setAlias 落到用户状态文件，新的 store 实例能读回', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccsynapse-alias-'))
  const dataFile = join(directory, 'workspaces.json')
  await new WorkspaceStore(dataFile).setAlias('real-session-id', 'placeholder-id')

  // 重启：同一文件上新建实例
  const reopened = new WorkspaceStore(dataFile)
  assert.deepEqual(await reopened.listAliases(), { 'real-session-id': 'placeholder-id' })

  // 别名是不可重建的用户状态 → 必须进 workspaces.json，不能只在投影缓存里
  const state = JSON.parse(await readFile(dataFile, 'utf8'))
  assert.deepEqual(state.sessionAliases, { 'real-session-id': 'placeholder-id' })
  const projection = await readFile(join(directory, 'workspaces-projection.json'), 'utf8').catch(() => '')
  assert.ok(!projection.includes('placeholder-id'))
})

test('老 workspaces.json 没有 sessionAliases 字段时归一为空对象', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ccsynapse-alias-legacy-'))
  const dataFile = join(directory, 'workspaces.json')
  await writeFile(dataFile, JSON.stringify({ version: 4, hiddenSessionIds: [], workspaces: [] }))

  const store = new WorkspaceStore(dataFile)
  assert.deepEqual(await store.listAliases(), {})
  await store.setAlias('real-session-id', 'placeholder-id')
  assert.deepEqual(await store.listAliases(), { 'real-session-id': 'placeholder-id' })
})

// ---------------------------------------------------------------------------
// NotFoundError propagation → 404
// ---------------------------------------------------------------------------

test('GET /api/workspaces/:id — workspace 不存在时返回 404', async () => {
  const { handleApi } = createRouter({
    store: stubStore(), // get() throws NotFoundError by default
    source: stubSource(),
    handleRpc: async () => [],
    toLocal: id => id,
  })
  const id = '00000000-0000-0000-0000-000000000001'
  const res = await callApi(handleApi, mockReq('GET'), `/api/workspaces/${id}`)
  assert.equal(res.status, 404)
  assert.ok(typeof res.body.error === 'string')
})
