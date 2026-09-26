import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

// Same slice as markdown-renderer.test.js: the search core is pure, so it can
// run in a vm without a DOM.
async function loadSearch() {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
  const start = source.indexOf('const escapeHtml')
  const end = source.indexOf('function canvasConnectors')
  const context = { globalThis: {} }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.cardSearch = { cardSearchHits, cardSearchHitHtml }`, context)
  return context.globalThis.cardSearch
}

const cards = [
  { id: 'a:turn:0', question: 'ccSynapse 的画布怎么用？', answer: { text: '拖动、缩放，双击卡片看详情。' } },
  { id: 'a:turn:1', question: '搜索功能在哪里？', answer: { text: '按 Ctrl+K 打开搜索，输入 ccSynapse 即可过滤。' } },
  { id: 'a:turn:2', question: '无关的一轮', answer: null },
]

test('matches question and answer text, case-insensitively', async () => {
  const { cardSearchHits } = await loadSearch()
  const hits = cardSearchHits(cards, 'ccsynapse')
  // Spread re-creates the array in this realm: a vm array has a different
  // prototype, which deepStrictEqual rejects.
  assert.deepEqual([...hits.map(hit => hit.cardId)], ['a:turn:0', 'a:turn:1'])
  assert.equal(hits[0].where, '提问')
  assert.equal(hits[1].where, '回答')
  assert.match(hits[1].snippet, /Ctrl\+K 打开搜索/)
})

test('no match yields no hits, empty query searches nothing', async () => {
  const { cardSearchHits } = await loadSearch()
  assert.equal(cardSearchHits(cards, '不存在的词').length, 0)
  assert.equal(cardSearchHits(cards, '   ').length, 0)
  assert.equal(cardSearchHits(cards, 'ccSynapse').length, 2)
})

test('hit markup escapes question and answer payloads', async () => {
  const { cardSearchHits, cardSearchHitHtml } = await loadSearch()
  const payload = '<img src=x onerror=alert(1)>'
  const hits = cardSearchHits([{ id: 'x:turn:0', question: payload, answer: { text: `${payload} 回答里的命中` } }], '命中')
  assert.equal(hits.length, 1)
  const html = cardSearchHitHtml(hits[0], 0, true)
  assert.ok(!html.includes('<img'), 'raw <img> must not survive into the row markup')
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /data-hit-index="0"/)
  assert.match(html, /class="card-search-hit active"/)
})
