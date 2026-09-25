// Request trust fence for the local API.
//
// The canvas can spawn a `claude` agent, so "it came from 127.0.0.1" is not
// sufficient grounds to act. Three checks, each covering a way loopback traffic
// can still be hostile — modelled on cc-haha's documented access control:
//
//   1. Host     — a DNS-rebinding page makes the browser send the attacker's
//                 hostname, so a Host allowlist blocks it (dsh-synapse's fence,
//                 kept as-is, including its port-normalization fix).
//   2. Proxy    — a TCP peer of 127.0.0.1 does not prove a local user when a
//                 reverse proxy sits in front and rewrites Host to localhost.
//                 Proxy-trace headers give the proxy away.
//   3. Origin   — a browser always sends Origin on a state-changing request, so
//                 an allowlist stops cross-site requests. This one matters most,
//                 because the other two are satisfied by a plain cross-origin
//                 POST from any page the user happens to visit.
//
// The content-type requirement in `methodAllowed` closes the same gap from the
// other side: `text/plain` and `application/x-www-form-urlencoded` are
// CORS-safelisted, so a request with them skips the preflight that would
// otherwise block a cross-site POST. Only a JSON content type (never
// safelisted) can carry a body, which forces the browser to preflight — and
// this server answers no preflight and sends no CORS headers, so it fails there.

const PROXY_TRACE_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via',
]

/** Authorities allowed to reach the API, normalized once at construction. */
export function trustSet(extraHosts = []) {
  return new Set(['localhost', '127.0.0.1', '[::1]', ...extraHosts.map(host => String(host).trim().toLowerCase()).filter(Boolean)])
}

const stripPort = value => value.replace(/:\d+$/, '')

/**
 * Host allowlist. An entry matches exactly, or matches once the request's port
 * is dropped, so a bare `myhost` accepts `myhost:3456` while `myhost:3456` only
 * accepts that exact authority. Upstream dsh-synapse stripped the port from the
 * request but never tried the un-stripped form, so a documented `host:port`
 * entry could not match anything.
 */
export function hostTrusted(request, trusted) {
  const raw = (typeof request.headers.host === 'string' ? request.headers.host : '').toLowerCase()
  return trusted.has(raw) || trusted.has(stripPort(raw))
}

/** True when a proxy forwarded the request, whatever Host it rewrote to. */
export function proxied(request) {
  return PROXY_TRACE_HEADERS.some(header => request.headers[header] !== undefined)
}

/**
 * Origin allowlist. A missing Origin means a non-browser client (curl, the
 * tests, a script), which the Host and proxy checks already gated; browsers
 * always attach Origin to a POST, so its absence is not a bypass.
 */
export function originTrusted(request, trusted) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try { return trusted.has(stripPort(new URL(origin).host)) } catch { return false }
}

const isJson = request => String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')

/**
 * @returns {number|null} the status to reject with, or null when the request may proceed
 */
export function rejectStatus(request, trusted) {
  if (!hostTrusted(request, trusted)) return 403
  if (proxied(request)) return 403
  if (!originTrusted(request, trusted)) return 403
  if (request.method !== 'GET' && request.method !== 'HEAD' && !isJson(request)) return 415
  return null
}
