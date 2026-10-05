import { test } from 'node:test'
import assert from 'node:assert/strict'

import { advance, advanceAll, etaSeconds, measured, rateKeys, speed, TAU_MS } from '../hooks/eta.ts'
import type { Task } from '../types/index.d.ts'

const task = (over: Partial<Task> = {}): Task => ({
  id: 't', label: 't', done: 0, total: 100, unit: 'files', status: 'running', updatedAt: 0, source: 'file', ...over,
})

test('the first sample has no rate; the second gives the instant rate', () => {
  const a = advance(undefined, 10, 1000)
  assert.equal(a.ema, null)
  const b = advance(a, 30, 3000)
  assert.equal(b.ema, 10) // 20 units in 2 s
})

test('the EMA moves towards a new speed with a time-based weight', () => {
  let s = advance(advance(undefined, 0, 0), 10, 1000) // 10/s
  s = advance(s, 10 + 20 * (TAU_MS / 1000), 1000 + TAU_MS) // 20/s for one tau
  const expected = 20 * (1 - Math.exp(-1)) + 10 * Math.exp(-1)
  assert.ok(Math.abs(s.ema! - expected) < 1e-9)
})

test('irregular sample spacing does not distort the rate', () => {
  // steady 5/s sampled at uneven intervals stays 5/s
  let s = advance(undefined, 0, 0)
  let v = 0
  let t = 0
  for (const dt of [300, 1700, 900, 4000, 100]) {
    t += dt
    v += (5 * dt) / 1000
    s = advance(s, v, t)
  }
  assert.ok(Math.abs(s.ema! - 5) < 1e-9)
})

test('the same timestamp twice adds nothing; a counter that went back starts over', () => {
  const a = advance(advance(undefined, 0, 0), 10, 1000)
  assert.equal(advance(a, 50, 1000), a)
  const reset = advance(a, 3, 2000)
  assert.deepEqual(reset, { t: 2000, v: 3, ema: null, t0: 2000, v0: 3 })
})

test('speed falls back to the average since the first sample, then since started_at', () => {
  assert.equal(speed(undefined, 50, 0, 10_000), 5)
  assert.equal(speed(undefined, 0, 0, 10_000), null)
  assert.equal(speed(undefined, 50, undefined, 10_000), null)
  const first = advance(undefined, 10, 1000)
  assert.equal(speed(first, 10, 0, 1000), 10) // only one sample: started_at average
})

test('ETA counts down between updates and is null when it cannot be known', () => {
  assert.equal(etaSeconds(100, 10, 0, 0), 10)
  assert.equal(etaSeconds(100, 10, 0, 4000), 6)
  assert.equal(etaSeconds(100, 10, 0, 60_000), 0)
  assert.equal(etaSeconds(100, null, 0, 0), null)
  assert.equal(etaSeconds(100, 0, 0, 0), null)
  assert.equal(etaSeconds(0, 10, 0, 0), null)
})

test('ETA is computed from bytes when the byte total is known', () => {
  assert.deepEqual(measured(task({ done: 3, total: 10, bytes: 500, bytesTotal: 1000 })), { value: 500, total: 1000, unit: 'bytes' })
  assert.deepEqual(measured(task({ done: 3, total: 10, bytes: 500 })), { value: 3, total: 10, unit: 'files' })
})

test('bytes beside another unit get their own rate state', () => {
  assert.deepEqual(rateKeys(task({ bytes: 5 })), { main: 't', bytes: 't#bytes' })
  assert.deepEqual(rateKeys(task({ bytes: 5, bytesTotal: 9 })), { main: 't', bytes: null })
  assert.deepEqual(rateKeys(task({ unit: 'bytes' })), { main: 't', bytes: null })
})

test('advanceAll keeps states of live tasks and drops gone ones', () => {
  const prev = { gone: { t: 0, v: 0, ema: 1, t0: 0, v0: 0 } }
  const next = advanceAll(prev, [task({ id: 'a', done: 5, updatedAt: 1000, bytes: 10 })])
  assert.deepEqual(Object.keys(next).sort(), ['a', 'a#bytes'])
})
