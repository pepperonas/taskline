import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cellWidth } from '../hooks/format.ts'
import { clip, fitTask, layoutRows, LEVELS, PALETTE, rowWidth, single, taskSegs } from '../hooks/layout.ts'
import type { Row, TaskView } from '../hooks/layout.ts'
import type { Task } from '../types/index.d.ts'

const NOW = 1_000_000_000
const task = (over: Partial<Task> = {}): Task => ({
  id: 'bridge', label: 'Bridge', icon: '⬇', done: 275, total: 1000, unit: 'files', status: 'running',
  updatedAt: NOW, startedAt: NOW - 60_000, source: 'file', ...over,
})
const view = (over: Partial<Task> = {}, extra: Partial<TaskView> = {}): TaskView => ({
  task: task(over), phase: 'running', speed: 4.6, bytesSpeed: null, eta: 80, ...extra,
})
const text = (row: Row) => row.map(s => s.text).join('')
const opts = { layout: 'auto' as const, maxTasks: 3, maxRows: 10, nowMs: NOW, color: true }

test('a running task at full detail reads like the spec example', () => {
  const v = view({ bytes: 3.1e9 }, { bytesSpeed: 12e6 })
  assert.equal(text(taskSegs(v, LEVELS[0]!, NOW, true)), '⬇ Bridge █████▌░░░░░░░░░░░░░░ 275/1,000 files · 3.1 GB · 12 MB/s · ETA 1:20')
})

test('every level is narrower than or as wide as the one before', () => {
  for (const v of [view({ bytes: 3.1e9 }, { bytesSpeed: 12e6 }), view({ total: null }), view({}, { phase: 'stalled' })]) {
    let last = Infinity
    for (const lv of LEVELS) {
      const w = rowWidth(taskSegs(v, lv, NOW, true))
      assert.ok(w <= last, `level widths must not grow (${w} > ${last})`)
      last = w
    }
  }
})

test('fitTask: never wider than asked, at any width', () => {
  const vs = [view({ bytes: 3.1e9 }), view({ total: null }), view({}, { phase: 'stalled' }), view({ status: 'error', message: 'HTTP 503 '.repeat(20) }, { phase: 'error' })]
  for (const v of vs) {
    for (let w = 1; w <= 120; w++) assert.ok(rowWidth(fitTask(v, w, NOW, true).segs) <= w, `width ${w}`)
  }
})

test('shrinking order: bar first, then extras, then the label', () => {
  const v = view({ bytes: 3.1e9, label: 'A rather long label' }, { bytesSpeed: 12e6 })
  const wide = text(fitTask(v, 200, NOW, true).segs)
  assert.ok(wide.includes('A rather long label') && wide.includes('12 MB/s'))
  const mid = fitTask(v, 60, NOW, true)
  assert.ok(mid.level > 0)
  assert.ok(text(mid.segs).includes('ETA'), 'ETA survives longer than the rate')
  const narrow = text(fitTask(v, 18, NOW, true).segs)
  assert.ok(narrow.includes('%'), narrow)
})

test('unknown total: spinner and count, no bar, no ETA', () => {
  const t = text(taskSegs(view({ total: null, done: 1234, unit: 'items' }, { eta: null }), LEVELS[0]!, NOW, true))
  assert.match(t, /^⬇ Bridge [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1,234 items · 4.6\/s$/)
  assert.ok(!t.includes('█') && !t.includes('ETA'))
})

test('stalled: warning color, age, no speed or ETA', () => {
  const segs = taskSegs(view({ updatedAt: NOW - 150_000 }, { phase: 'stalled' }), LEVELS[0]!, NOW, true)
  assert.match(text(segs), /⏸ stalled 2m$/)
  assert.ok(!text(segs).includes('ETA'))
  assert.ok(segs.some(s => s.color === PALETTE.warn))
})

test('error shows the message in red; aborted says so with the percent', () => {
  const err = taskSegs(view({ status: 'error', message: 'HTTP 503' }, { phase: 'error' }), LEVELS[0]!, NOW, true)
  assert.equal(text(err), '⬇ Bridge ✖ HTTP 503')
  assert.ok(err.some(s => s.color === PALETTE.error))
  assert.equal(text(taskSegs(view({ pid: 4 }, { phase: 'aborted' }), LEVELS[0]!, NOW, true)), '⬇ Bridge ✖ aborted · at 28%')
})

test('done: green check, the full count and how long it took', () => {
  const segs = taskSegs(view({ status: 'done', done: 990 }, { phase: 'done' }), LEVELS[0]!, NOW, true)
  assert.equal(text(segs), '⬇ Bridge ✔ 1,000/1,000 files in 1:00')
  assert.ok(segs.some(s => s.color === PALETTE.ok))
})

test('bytes as the unit are shown as sizes', () => {
  const t = text(taskSegs(view({ unit: 'bytes', done: 1.2e9, total: 3.1e9 }), LEVELS[0]!, NOW, true))
  assert.ok(t.includes('1.2 GB/3.1 GB'), t)
})

test('color off: no color anywhere, the text stays the same', () => {
  const v = view({}, { phase: 'stalled' })
  const on = taskSegs(v, LEVELS[0]!, NOW, true)
  const off = taskSegs(v, LEVELS[0]!, NOW, false)
  assert.equal(text(on), text(off))
  assert.ok(off.every(s => s.color === undefined))
})

test('single: everything on one line when it fits, "+N more" when it does not', () => {
  const vs = [view({ id: 'a', label: 'Alpha' }), view({ id: 'b', label: 'Beta' }), view({ id: 'c', label: 'Gamma' })]
  const wide = single(vs, 300, NOW, true)!
  assert.equal(wide.level, 0)
  assert.equal(text(wide.row).split(' │ ').length, 3)
  const tight = single(vs, 30, NOW, true)!
  assert.ok(rowWidth(tight.row) <= 30)
  assert.match(text(tight.row), /\+\d more$/)
})

test('layoutRows auto: one line if it fits richly, otherwise one row per task', () => {
  const vs = [view({ id: 'a', label: 'Alpha' }), view({ id: 'b', label: 'Beta' })]
  assert.equal(layoutRows(vs, { ...opts, width: 200 }).length, 1)
  const rows = layoutRows(vs, { ...opts, width: 60 })
  assert.equal(rows.length, 2)
  for (const r of rows) assert.ok(rowWidth(r) <= 60)
})

test('layoutRows: maxTasks folds the rest, in every layout, never wider than the band', () => {
  const vs = ['a', 'b', 'c', 'd', 'e'].map(id => view({ id, label: id.toUpperCase() }))
  for (const layout of ['auto', 'single', 'stacked'] as const) {
    for (const width of [20, 40, 80, 160, 300]) {
      const rows = layoutRows(vs, { ...opts, layout, width, maxTasks: 3 })
      assert.ok(rows.length >= 1 && rows.length <= 3, `${layout}@${width}: ${rows.length} rows`)
      for (const r of rows) assert.ok(rowWidth(r) <= width, `${layout}@${width}: ${text(r)}`)
      const all = rows.map(text).join('\n')
      assert.match(all, /\+\d more/, `${layout}@${width} must say tasks are hidden`)
    }
  }
})

test('stacked with overflow: maxTasks rows, the last one counts what is hidden', () => {
  const vs = ['a', 'b', 'c', 'd', 'e'].map(id => view({ id }))
  const rows = layoutRows(vs, { ...opts, layout: 'stacked', width: 200, maxTasks: 3 })
  assert.equal(rows.length, 3)
  assert.equal(text(rows[2]!), '+3 more')
})

test('the band never takes more rows than it has', () => {
  const vs = ['a', 'b', 'c', 'd'].map(id => view({ id }))
  const rows = layoutRows(vs, { ...opts, layout: 'stacked', width: 200, maxTasks: 10, maxRows: 2 })
  assert.equal(rows.length, 2)
  assert.equal(text(rows[1]!), '+3 more')
  assert.equal(layoutRows(vs, { ...opts, layout: 'stacked', width: 200, maxTasks: 10, maxRows: 1 }).length, 1)
})

test('nothing to draw, or no room, is no rows', () => {
  assert.deepEqual(layoutRows([], { ...opts, width: 100 }), [])
  assert.deepEqual(layoutRows([view()], { ...opts, width: 2 }), [])
})

test('clip cuts mid-segment with an ellipsis and keeps styles', () => {
  const row = [{ text: 'abcdef', color: 'x' }, { text: 'ghi' }]
  const c = clip(row, 4)
  assert.deepEqual(c, [{ text: 'abc…', color: 'x' }])
  assert.equal(cellWidth(text(clip(row, 7))), 7)
})
