// Pre-warm the ccSynapse server if it is not already listening.
// Called by the SessionStart hook — must exit quickly so the session
// does not stall. On Windows `node ... &` is unreliable from a hook
// command string; use child_process.spawn with detached: true instead.
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.CCSYNAPSE_PORT ?? 3080)
const HERE = dirname(fileURLToPath(import.meta.url))

function probe() {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port: PORT, path: '/api/workspaces', method: 'GET' }, res => resolve(res.statusCode === 200))
    req.on('error', () => resolve(false))
    req.setTimeout(800, () => { req.destroy(); resolve(false) })
    req.end()
  })
}

const alive = await probe()
if (!alive) {
  const child = spawn(process.execPath, [join(HERE, 'index.js')], {
    detached: true, stdio: 'ignore',
    env: { ...process.env },
  })
  child.unref()
}
// Exit immediately — hook must not block the session.
process.exit(0)
