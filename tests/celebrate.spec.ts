import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CELEBRATE_MS, DEFAULT_COLOR, encodeCells, fadeLeft, frame, needs, planScene, rng, seedOf } from '../hooks/celebrate.ts'
import { finished } from '../hooks/views.ts'
import { barColumns } from '../hooks/layout.ts'
import type { Task } from '../types'

const BIG = needs(2)
const SMALL = needs(1)
const plan = (cols = 120, rows = BIG.rows + 1, color = true, seed = 7) => planScene({ cols, rows, seed, color, bar: [9, 29] })!

/** Lit cells (not a blank space) of a frame. */
function lit(cells: Uint32Array): number[] {
  const out: number[] = []
  for (let i = 0; i < cells.length; i += 3) if (cells[i] !== 0x20) out.push(i / 3)
  return out
}
const ALLOWED = new Set([0x20, 0x2580, 0x2584, 0x2588])

test('planScene: large when it fits, compact when only that fits, nothing below', () => {
  assert.equal(planScene({ cols: BIG.cols, rows: BIG.rows, seed: 1, color: true })?.scale, 2)
  assert.equal(planScene({ cols: BIG.cols - 1, rows: BIG.rows, seed: 1, color: true })?.scale, 1)
  assert.equal(planScene({ cols: 200, rows: BIG.rows - 1, seed: 1, color: true })?.scale, 1)
  assert.equal(planScene({ cols: SMALL.cols, rows: SMALL.rows, seed: 1, color: true })?.scale, 1)
  assert.equal(planScene({ cols: SMALL.cols - 1, rows: 40, seed: 1, color: true }), null)
  assert.equal(planScene({ cols: 300, rows: SMALL.rows - 1, seed: 1, color: true }), null)
})

test('every frame is exactly cols × rows cells of block glyphs, at every moment and size', () => {
  for (const [cols, rows] of [[120, BIG.rows + 1], [BIG.cols, BIG.rows], [SMALL.cols, SMALL.rows], [80, SMALL.rows + 1]] as const) {
    const s = planScene({ cols, rows, seed: 3, color: true, bar: [5, 25] })!
    for (let t = 0; t <= CELEBRATE_MS; t += 50) {
      const f = frame(s, t)
      assert.equal(f.length, cols * rows * 3)
      for (let i = 0; i < f.length; i += 3) {
        assert.ok(ALLOWED.has(f[i]!), `glyph ${f[i]!.toString(16)} at t=${t}`)
        for (const c of [f[i + 1]!, f[i + 2]!]) assert.ok(c === DEFAULT_COLOR || c <= 0xffffff, `colour ${c.toString(16)}`)
      }
    }
  }
})

test('it starts at the bar: the first frame lights only the bottom row, over the bar', () => {
  const s = planScene({ cols: 120, rows: BIG.rows + 1, seed: 7, color: true, bar: [40, 60] })!
  const cells = lit(frame(s, 10))
  assert.ok(cells.length > 0)
  for (const i of cells) {
    assert.equal(Math.floor(i / s.cols), s.rows - 1, 'only the bottom row')
    assert.ok(i % s.cols >= 40 && i % s.cols < 60, `column ${i % s.cols} is over the bar`)
  }
})

test('the sparks fly up and out of the bar', () => {
  const s = plan()
  const rowsLit = (t: number) => new Set(lit(frame(s, t)).map(i => Math.floor(i / s.cols)))
  assert.ok(Math.min(...rowsLit(400)) < s.rows - 4, 'sparks reach well above the bar')
  const xs = lit(frame(s, 400)).map(i => i % s.cols)
  assert.ok(Math.max(...xs) - Math.min(...xs) > 30, 'and spread wider than the bar')
})

test('at its peak the check and the word stand there, green', () => {
  const s = plan()
  const f = frame(s, 1500)
  const textRows = new Set<number>()
  let green = 0
  for (const i of lit(f)) {
    const fg = f[i * 3 + 1]!
    if (fg !== DEFAULT_COLOR && ((fg >> 8) & 255) > ((fg >> 16) & 255) && ((fg >> 8) & 255) > (fg & 255)) green++
    if (i % s.cols >= s.textX) textRows.add(Math.floor(i / s.cols))
  }
  assert.ok(green > 150, `${green} green cells`)
  assert.ok(textRows.size >= 7, 'the word is seven pixel rows of the large font')
  // a check-mark stroke left of the word
  assert.ok(lit(f).some(i => i % s.cols < s.textX - 4 && i % s.cols > s.check[0][0] - 2))
})

test('the word appears letter by letter: more of it lit as time goes on', () => {
  const s = plan()
  const right = (t: number) => Math.max(-1, ...lit(frame(s, t)).filter(i => Math.floor(i / s.cols) >= s.rows - 6).map(i => i % s.cols))
  const a = right(650)
  const b = right(800)
  const c = right(1300)
  assert.ok(a < b && b < c, `rightmost lit column ${a} < ${b} < ${c}`)
})

test('it dissolves, and is gone at the end', () => {
  const s = plan()
  const n = (t: number) => lit(frame(s, t)).length
  assert.ok(n(1800) > n(2400), 'fewer lit cells while fading')
  assert.ok(n(2400) > n(2700))
  // the word itself dissolves, not only the sparks around it
  const word = (t: number) => lit(frame(s, t)).filter(i => i % s.cols >= s.textX && Math.floor(i / s.cols) >= s.rows - 8).length
  assert.ok(word(2550) < word(1950) * 0.6, `word cells ${word(1950)} → ${word(2550)}`)
  assert.equal(n(CELEBRATE_MS), 0, 'nothing left at the end')
  assert.equal(fadeLeft(0), 1)
  assert.equal(fadeLeft(CELEBRATE_MS), 0)
})

test('the same seed draws the same show; another seed other sparks', () => {
  assert.deepEqual(frame(plan(120, BIG.rows + 1, true, 9), 300), frame(plan(120, BIG.rows + 1, true, 9), 300))
  assert.notDeepEqual(frame(plan(120, BIG.rows + 1, true, 9), 300), frame(plan(120, BIG.rows + 1, true, 10), 300))
  assert.equal(seedOf('a'), seedOf('a'))
  assert.notEqual(seedOf('a'), seedOf('b'))
  const r = rng(1)
  for (let i = 0; i < 1000; i++) {
    const v = r()
    assert.ok(v >= 0 && v < 1)
  }
})

test('without colour every cell keeps the terminal colours: shapes only', () => {
  const s = plan(120, BIG.rows + 1, false)
  for (const t of [100, 500, 1500, 2300]) {
    const f = frame(s, t)
    for (let i = 0; i < f.length; i += 3) {
      assert.equal(f[i + 1], DEFAULT_COLOR)
      assert.equal(f[i + 2], DEFAULT_COLOR)
    }
  }
  assert.ok(lit(frame(s, 1500)).length > 100)
})

test('a dark pixel stays see-through: no cell paints a near-black background', () => {
  const s = plan()
  for (const t of [200, 900, 1500, 2300]) {
    const f = frame(s, t)
    for (let i = 0; i < f.length; i += 3) {
      for (const c of [f[i + 1]!, f[i + 2]!]) {
        if (c === DEFAULT_COLOR) continue
        assert.ok(Math.max((c >> 16) & 255, (c >> 8) & 255, c & 255) >= 15, `colour ${c.toString(16)} at t=${t} would be a black patch`)
      }
    }
  }
})

test('encodeCells is little-endian u32 in padded base64', () => {
  for (const n of [1, 2, 3, 7, 300]) {
    const words = Uint32Array.from({ length: n }, (_, i) => (i * 2654435761) >>> 0)
    assert.equal(encodeCells(words), Buffer.from(words.buffer).toString('base64'))
  }
  assert.equal(encodeCells(Uint32Array.of(0x2588, 0xff8800, 0x01000000)), Buffer.from(Uint32Array.of(0x2588, 0xff8800, 0x01000000).buffer).toString('base64'))
})

const task = (id: string, status: Task['status']): Task => ({ id, label: id, done: 1, total: 1, unit: 'files', status, updatedAt: 0, source: 'file' })

test('finished: only a task seen running and now done gets its finish', () => {
  const prev = [task('a', 'running'), task('b', 'done'), task('c', 'running'), task('e', 'error')]
  const next = [task('a', 'done'), task('b', 'done'), task('c', 'running'), task('d', 'done'), task('e', 'done')]
  assert.deepEqual(finished(prev, next).map(t => t.id), ['a'])
  assert.deepEqual(finished([], next), [], 'nothing celebrates on startup')
})

test('barColumns: the bar starts after the icon and label, 20 wide', () => {
  assert.deepEqual(barColumns({ ...task('x', 'running'), label: 'Bridge', icon: '⬇' }), [9, 29])
  assert.deepEqual(barColumns({ ...task('x', 'running'), label: 'Ab' }), [3, 23])
})
