import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

async function loadRenderer() {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
  const start = source.indexOf('const escapeHtml')
  const end = source.indexOf('function canvasConnectors')
  const context = { globalThis: {} }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.renderMarkdown = renderMarkdown`, context)
  return context.globalThis.renderMarkdown
}

async function loadEscapeHtml() {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
  const start = source.indexOf('const escapeHtml')
  const end = source.indexOf('function canvasConnectors')
  const context = { globalThis: {} }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.escapeHtml = escapeHtml`, context)
  return context.globalThis.escapeHtml
}

test('renders PowerShell marker-only diagnostic lines without stalling', async () => {
  const renderMarkdown = await loadRenderer()
  const input = 'cmd : Access is denied.\nAt line:1 char:1\n+ \n+ ~~~~~\n    + CategoryInfo : PermissionDenied'
  const result = renderMarkdown(input)

  assert.match(result, /cmd : Access is denied/)
  assert.match(result, /CategoryInfo/)
})

test('escapeHtml sanitises XSS payloads in card title and question text', async (t) => {
  const escapeHtml = await loadEscapeHtml()
  const payloads = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    "' onmouseover='alert(1)",
    '<svg onload=alert(1)>',
  ]
  for (const payload of payloads) {
    const escaped = escapeHtml(payload)
    // After escaping, no literal unescaped angle bracket must remain
    assert.ok(!escaped.includes('<'), `unescaped < remains: ${payload}`)
    assert.ok(!escaped.includes('>'), `unescaped > remains: ${payload}`)
    // Must contain at least one entity-encoded character
    assert.ok(
      escaped.includes('&lt;') || escaped.includes('&gt;') || escaped.includes('&amp;') ||
      escaped.includes('&quot;') || escaped.includes('&#39;'),
      `no escaping at all: ${payload}`
    )
  }
})

test('conversationCard title and question are HTML-escaped', async (t) => {
  const escapeHtml = await loadEscapeHtml()
  const xssTitle = '<script>alert("xss")</script>'
  const html = escapeHtml(xssTitle)
  assert.ok(!html.includes('<script>'), 'raw <script> tag must not appear in escaped output')
  assert.ok(html.includes('&lt;script&gt;'), 'script tag must be entity-encoded')
})
