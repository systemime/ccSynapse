import { randomUUID } from 'node:crypto'
import * as defaultBridge from './bridge.js'

/**
 * @param {{ source, aliases, locals, pendingForks, activeSessionRef, config, bridge? }} deps
 * activeSessionRef is a { id: string|null } box so the caller and this handler
 * share the same mutable value without a closure over a primitive.
 * bridge overrides the real bridge module (for tests).
 */
export function createRpcHandler({ source, aliases, locals, pendingForks, activeSessionRef, config, bridge = defaultBridge }) {
  const toLocal = id => (typeof id === 'string' ? aliases.get(id) ?? id : id)
  const toReal  = id => (typeof id === 'string' ? locals.get(id)  ?? id : id)

  function currentSession() {
    if (activeSessionRef.id !== null) {
      const active = source.sessions.get(toReal(activeSessionRef.id))
      if (active !== undefined) return { id: activeSessionRef.id, title: active.title, cwd: active.cwd }
    }
    let newest = null
    for (const session of source.sessions.values()) {
      if (newest === null || session.mtimeMs > newest.mtimeMs) newest = session
    }
    return newest === null ? null : { id: toLocal(newest.id), title: newest.title, cwd: newest.cwd }
  }

  async function handleRpc(body) {
    const messages = []
    const reply = message => { messages.push(message) }
    switch (body.type) {
      case 'synapse:request-current': {
        reply({ type: 'synapse:map-opened' })
        reply({ type: 'synapse:theme', dark: body.dark === true })
        const session = currentSession()
        if (session !== null) reply({ type: 'synapse:current-session', session })
        break
      }
      case 'synapse:activate-session': {
        activeSessionRef.id = body.sessionId ?? null
        const session = currentSession()
        if (session !== null) reply({ type: 'synapse:current-session', session })
        break
      }
      case 'synapse:open-session': {
        const real = toReal(body.sessionId)
        const cwd = source.sessions.get(real)?.cwd
        const result = bridge.openInTerminal({ sessionId: real, cwd })
        if (result.opened !== true) reply({ type: 'synapse:bridge-error', requestId: body.requestId, message: `无法打开终端：${result.reason}` })
        break
      }
      case 'synapse:fork-session': {
        const parentReal = toReal(body.sessionId)
        const record = source.sessions.get(parentReal)
        if (record === undefined) { reply({ type: 'synapse:bridge-error', requestId: body.requestId, message: '找不到要分支的会话，请稍后重试' }); break }
        const placeholder = randomUUID()
        pendingForks.set(placeholder, { parentSessionId: parentReal, cwd: record.cwd, title: record.title, seedLength: record.lastSeq ?? 0 })
        reply({ type: 'synapse:forked-session', requestId: body.requestId, session: { id: placeholder, title: `${record.title ?? '会话'} 分支`, cwd: record.cwd } })
        break
      }
      case 'synapse:send-message': {
        const text = typeof body.text === 'string' ? body.text : ''
        if (text.trim() === '') { reply({ type: 'synapse:bridge-error', requestId: body.requestId, message: '消息不能为空' }); break }
        const local = body.sessionId
        const pending = pendingForks.get(local)
        try {
          const result = pending === undefined
            ? await bridge.continueSession({ sessionId: toReal(local), text, cwd: source.sessions.get(toReal(local))?.cwd, extraArgs: config.backgroundArgs })
            : await bridge.forkSession({ sessionId: pending.parentSessionId, text, cwd: pending.cwd, extraArgs: config.backgroundArgs })
          if (result.sessionId !== null) {
            if (pending !== undefined) { aliases.set(result.sessionId, local); locals.set(local, result.sessionId) }
            activeSessionRef.id = local
          }
          reply({ type: 'synapse:message-sent', requestId: body.requestId, session: { id: local } })
        } catch (error) {
          pendingForks.delete(local)
          reply({ type: 'synapse:bridge-error', requestId: body.requestId, message: error instanceof Error ? error.message : String(error) })
        }
        break
      }
      case 'synapse:create-session': {
        try {
          const cwd = body.cwd ?? source.sessions.values().next().value?.cwd ?? process.cwd()
          const result = await bridge.createSession({ text: '', cwd, extraArgs: config.backgroundArgs })
          reply({ type: 'synapse:created-session', requestId: body.requestId, session: { id: toLocal(result.sessionId ?? ''), title: '新会话', cwd } })
        } catch (error) {
          reply({ type: 'synapse:bridge-error', requestId: body.requestId, message: error instanceof Error ? error.message : String(error) })
        }
        break
      }
      case 'synapse:close':
      case 'synapse:map-ready':
        break
      default:
        console.warn(`[ccSynapse] unhandled bridge message: ${String(body.type)}`)
    }
    return messages
  }

  return { handleRpc }
}
