import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

// The layout core is pure (cards in, positions out), so it runs in a vm without
// a DOM: the same slice as card-search.test.js, cut before the card builder.
async function loadLayout() {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
  const start = source.indexOf('const DEFAULT_QUICK_PHRASES')
  const end = source.indexOf('function conversationCards')
  const context = { globalThis: {}, console }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.layout = { layoutConversationGraph }`, context)
  return context.globalThis.layout
}

const card = (id, dshThreadId, parentId) => ({ id, dshThreadId, parentId, turnIndex: 0, positionLocked: false, answer: {} })
const at = ({ x, y }) => `${x},${y}`
const place = (layout, threads, cards) => {
  layout.layoutConversationGraph(cards, threads)
  return cards.map(entry => at(entry.position))
}

test('a linear session and a branch session keep their exact rows and columns', async () => {
  const layout = await loadLayout()
  const threads = [{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }]
  const cards = [
    card('a:0', 'a', null), card('a:1', 'a', 'a:0'), card('a:2', 'a', 'a:1'),
    card('a:3', 'a', 'a:2'), card('a:4', 'a', 'a:3'),
    card('b:0', 'b', 'a:1'),
  ]
  // The branch session keeps its own lane row, the linear session its one row.
  assert.deepEqual(place(layout, threads, cards), [
    '86,82', '451,82', '816,82', '1181,82', '1546,82', '816,400',
  ])
})

test('a turn asked again from an earlier point forks without moving anyone', async () => {
  const layout = await loadLayout()
  const threads = [{ id: 'a', parentId: null }]
  const build = () => [card('a:0', 'a', null), card('a:1', 'a', 'a:0'), card('a:2', 'a', 'a:0'), card('a:3', 'a', 'a:2')]
  const cards = build()
  const first = place(layout, threads, cards)
  // a:1 and a:2 hang off the same card: each sibling gets its own row, and the
  // turn after them (a:3) stays on the session's row instead of inheriting the
  // fork's. Before the fork row existed, a:2 took a:1's cell and the collision
  // solver pushed it — the same numbers, but only if it happened to be placed
  // second.
  assert.deepEqual(first, ['86,82', '451,82', '451,400', '816,82'])
  assert.deepEqual(cards.map(entry => at(entry.naturalPosition)), first, 'no card is placed by collision')
  assert.deepEqual(place(layout, threads, build()), first, 'the layout is reproducible')
})

test('a fork yields to another session rather than pushing it', async () => {
  const layout = await loadLayout()
  const threads = [{ id: 'a', parentId: null }, { id: 'b', parentId: null }]
  const cards = [
    card('a:0', 'a', null), card('a:1', 'a', 'a:0'), card('a:2', 'a', 'a:0'), card('a:3', 'a', 'a:2'),
    // b's second turn already owns the cell the fork would drop into.
    card('b:0', 'b', null), card('b:1', 'b', 'b:0'), card('b:2', 'b', 'b:1'),
  ]
  assert.deepEqual(place(layout, threads, cards), [
    '86,82', '451,82', '451,718', '816,82',
    '86,400', '451,400', '816,400',
  ])
})
