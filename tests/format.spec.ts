import { test } from 'node:test'
import assert from 'node:assert/strict'

import { age, amount, bar, bytes, cellWidth, count, duration, percent, rate, spinner, SPINNER, truncate } from '../hooks/format.ts'

test('cellWidth counts emoji and CJK as two cells, combining marks as none', () => {
  assert.equal(cellWidth('abc'), 3)
  assert.equal(cellWidth('⬇ Bridge'), 8)
  assert.equal(cellWidth('🔍'), 2)
  assert.equal(cellWidth('日本'), 4)
  assert.equal(cellWidth('é'), 1) // e + combining acute
  assert.equal(cellWidth('⬇️'), 2) // VS16 makes it an emoji
  assert.equal(cellWidth('███░░'), 5)
})

test('truncate never exceeds the width and marks the cut', () => {
  assert.equal(truncate('Bridge', 10), 'Bridge')
  assert.equal(truncate('Bridge download', 8), 'Bridge …')
  assert.equal(cellWidth(truncate('🔍🔍🔍🔍', 5)), 5)
  assert.equal(truncate('abc', 0), '')
  assert.equal(truncate('abc', 1), '…')
})

test('count groups thousands and keeps one decimal for small fractions', () => {
  assert.equal(count(0), '0')
  assert.equal(count(1234567), '1,234,567')
  assert.equal(count(2.5), '2.5')
  assert.equal(count(123.4), '123')
  assert.equal(count(NaN), '?')
})

test('bytes uses decimal units like Finder, and carries 999.96 MB to 1.0 GB', () => {
  assert.equal(bytes(0), '0 B')
  assert.equal(bytes(999), '999 B')
  assert.equal(bytes(1500), '1.5 KB')
  assert.equal(bytes(3.1e9), '3.1 GB')
  assert.equal(bytes(12_400_000), '12.4 MB')
  assert.equal(bytes(312_000_000), '312 MB')
  assert.equal(bytes(999_960_000), '1.0 GB')
  assert.equal(bytes(-1), '?')
})

test('amount and rate follow the unit', () => {
  assert.equal(amount(3.1e9, 'bytes'), '3.1 GB')
  assert.equal(amount(1200, 'files'), '1,200')
  assert.equal(rate(12_000_000, 'bytes'), '12 MB/s')
  assert.equal(rate(45, 'files'), '45/s')
  assert.equal(rate(2.25, 'files'), '2.3/s')
  assert.equal(rate(0.5, 'files'), '30/min')
  assert.equal(rate(0.001, 'files'), '3.6/h')
  assert.equal(rate(0, 'files'), '')
})

test('duration reads like a clock, days for very long waits', () => {
  assert.equal(duration(45), '0:45')
  assert.equal(duration(80), '1:20')
  assert.equal(duration(3723), '1:02:03')
  assert.equal(duration(4 * 86400 + 3 * 3600), '4d 3h')
  assert.equal(duration(-1), '?')
})

test('age is coarse', () => {
  assert.equal(age(45), '45s')
  assert.equal(age(130), '2m')
  assert.equal(age(7300), '2h')
  assert.equal(age(3 * 86400), '3d')
})

test('percent shows early progress and never claims 100 % too early', () => {
  assert.equal(percent(0), '0%')
  assert.equal(percent(0.004), '0.4%')
  assert.equal(percent(0.275), '28%')
  assert.equal(percent(0.996), '99%')
  assert.equal(percent(1), '100%')
  assert.equal(percent(1.4), '100%')
})

test('bar has exactly width cells, with eighth-cell precision', () => {
  for (const f of [0, 0.01, 0.275, 0.5, 0.999, 1]) {
    const [a, b] = bar(f, 10)
    assert.equal(cellWidth(a + b), 10, `fraction ${f}`)
  }
  assert.deepEqual(bar(0.5, 4), ['██', '░░'])
  assert.deepEqual(bar(0.0625, 2), ['▏', '░'])
  assert.deepEqual(bar(1, 3), ['███', ''])
  assert.deepEqual(bar(NaN, 3), ['', '░░░'])
  assert.deepEqual(bar(0.5, 0), ['', ''])
})

test('spinner cycles with time', () => {
  assert.equal(spinner(0), SPINNER[0])
  assert.equal(spinner(125), SPINNER[1])
  assert.equal(spinner(125 * SPINNER.length), SPINNER[0])
})
