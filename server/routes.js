import { listAgents } from './bridge.js'
import { InputError, NotFoundError } from './workspace-store.js'

const MAX_BODY_BYTES = 32 * 1024

export function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new InputError('请求内容过大')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new InputError('请求不是有效 JSON') }
}

export function createRouter({ store, source, handleRpc, toLocal, liveTexts }) {
  async function handleApi(request, response, pathname) {
    if (pathname === '/api/agents') return sendJson(response, 200, { agents: await listAgents() })
    // Partial text of every reply currently being written, so the canvas can
    // show it before the turn ends. `liveTexts` yields [realId, text] pairs;
    // the canvas only ever speaks the local id (see toLocal in index.js).
    if (pathname === '/api/live') {
      const sessions = {}
      for (const [sessionId, text] of liveTexts()) sessions[toLocal(sessionId)] = text
      return sendJson(response, 200, { sessions })
    }
    if (pathname === '/api/reset' && request.method === 'POST') {
      return sendJson(response, 200, await store.clearLegacy([...source.sessions.values()].map(s => ({ id: toLocal(s.id) }))))
    }
    if (pathname === '/api/rpc' && request.method === 'POST') {
      return sendJson(response, 200, { messages: await handleRpc(await readJson(request)) })
    }
    if (pathname === '/api/workspaces') {
      if (request.method === 'GET') {
        const workspaces = await store.list()
        workspaces.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        return sendJson(response, 200, { workspaces })
      }
      if (request.method === 'POST') return sendJson(response, 201, { workspace: await store.create((await readJson(request)).title) })
    }
    const workspace = /^\/api\/workspaces\/([0-9a-f-]+)$/i.exec(pathname)
    if (workspace !== null) {
      if (request.method === 'GET') return sendJson(response, 200, { workspace: await store.get(workspace[1]) })
      if (request.method === 'POST') return sendJson(response, 201, { thread: await store.createThread(workspace[1], await readJson(request)) })
    }
    const branch = /^\/api\/threads\/([0-9a-f-]+)\/branch$/i.exec(pathname)
    if (branch !== null && request.method === 'POST') return sendJson(response, 201, { thread: await store.branch(branch[1], await readJson(request)) })
    const msgs = /^\/api\/threads\/([0-9a-f-]+)\/messages$/i.exec(pathname)
    if (msgs !== null && request.method === 'POST') return sendJson(response, 201, { thread: await store.addMessage(msgs[1], (await readJson(request)).text) })
    const thread = /^\/api\/threads\/([0-9a-f-]+)$/i.exec(pathname)
    if (thread !== null && request.method === 'PATCH') return sendJson(response, 200, { thread: await store.updateThread(thread[1], await readJson(request)) })
    if (thread !== null && request.method === 'DELETE') return sendJson(response, 200, await store.removeThread(thread[1]))
    if (pathname === '/api/sessions/archived' && request.method === 'GET') return sendJson(response, 200, { sessionIds: await store.listArchived() })
    const unarchive = /^\/api\/sessions\/([^/]+)\/unarchive$/.exec(pathname)
    if (unarchive !== null && request.method === 'POST') return sendJson(response, 200, await store.unarchiveThread(unarchive[1]))
    return sendJson(response, 404, { error: '接口不存在' })
  }

  return { handleApi }
}
