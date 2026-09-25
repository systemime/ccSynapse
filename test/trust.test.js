// The API can spawn a `claude` agent, so the request fence is a security
// boundary, not a formality. Each case below is a way loopback traffic can still
// be hostile; the last one was a live hole found by probing the running server.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { trustSet, hostTrusted, proxied, originTrusted, rejectStatus } from '../server/trust.js'

const TRUSTED = trustSet([])
const request = (headers, method = 'POST') => ({ headers, method })

test('a Host that is not an allowed authority is rejected', () => {
  assert.equal(rejectStatus(request({ host: 'evil.example.com' }), TRUSTED), 403)
  assert.equal(rejectStatus(request({ host: 'evil.example.com:3080' }), TRUSTED), 403)
  assert.equal(rejectStatus(request({ host: '127.0.0.1:3080', 'content-type': 'application/json' }), TRUSTED), null)
  assert.equal(rejectStatus(request({ host: 'localhost', 'content-type': 'application/json' }), TRUSTED), null)
})

test('a host:port entry matches exactly; a bare host entry ignores the request port', () => {
  // Upstream stripped the port only from the request, so a documented
  // `host:port` entry could never match anything at all.
  const withPort = trustSet(['myhost:3456'])
  assert.equal(hostTrusted(request({ host: 'myhost:3456' }), withPort), true, 'exact authority')
  assert.equal(hostTrusted(request({ host: 'myhost' }), withPort), false, 'a different authority than configured')

  const bare = trustSet(['myhost'])
  assert.equal(hostTrusted(request({ host: 'myhost' }), bare), true)
  assert.equal(hostTrusted(request({ host: 'myhost:3456' }), bare), true, 'request port dropped')
  assert.equal(hostTrusted(request({ host: 'other:3456' }), bare), false)
})

test('proxied requests are rejected even when Host claims localhost', () => {
  // A reverse proxy in front makes the peer address meaningless.
  for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'via']) {
    assert.equal(proxied(request({ host: 'localhost', [header]: '203.0.113.9' })), true, header)
    assert.equal(rejectStatus(request({ host: 'localhost', 'content-type': 'application/json', [header]: '203.0.113.9' }), TRUSTED), 403)
  }
})

test('a cross-site Origin is rejected', () => {
  assert.equal(originTrusted(request({ origin: 'https://evil.example' }), TRUSTED), false)
  assert.equal(rejectStatus(request({ host: '127.0.0.1:3080', origin: 'https://evil.example', 'content-type': 'application/json' }), TRUSTED), 403)
  assert.equal(originTrusted(request({ origin: 'http://localhost:3080' }), TRUSTED), true)
  assert.equal(originTrusted(request({ origin: 'not a url' }), TRUSTED), false)
})

test('a safelisted content type cannot carry a body, because it skips the preflight', () => {
  // text/plain and form encoding are CORS-safelisted: a malicious page can send
  // them cross-origin with no preflight at all. Requiring JSON forces the
  // browser to preflight, and this server sends no CORS headers.
  assert.equal(rejectStatus(request({ host: '127.0.0.1:3080', 'content-type': 'text/plain' }), TRUSTED), 415)
  assert.equal(rejectStatus(request({ host: '127.0.0.1:3080', 'content-type': 'application/x-www-form-urlencoded' }), TRUSTED), 415)
  assert.equal(rejectStatus(request({ host: '127.0.0.1:3080' }), TRUSTED), 415)
  assert.equal(rejectStatus(request({ host: '127.0.0.1:3080', 'content-type': 'application/json; charset=utf-8' }), TRUSTED), null)
})

test('reads need no content type, and a non-browser client may omit Origin', () => {
  assert.equal(rejectStatus(request({ host: '127.0.0.1:3080' }, 'GET'), TRUSTED), null)
  assert.equal(rejectStatus(request({ host: '127.0.0.1:3080' }, 'HEAD'), TRUSTED), null)
  // curl and the test suite send no Origin; Host and proxy checks already gated it.
  assert.equal(rejectStatus(request({ host: 'localhost', 'content-type': 'application/json' }), TRUSTED), null)
})
