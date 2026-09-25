import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { trustSet, rejectStatus } from '../server/trust.js'
import { createRouter, sendJson } from '../server/routes.js'
import { createRpcHandler } from '../server/rpc.js'
import { NotFoundError } from '../server/workspace-store.js'

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
