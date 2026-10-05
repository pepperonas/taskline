import { test } from 'node:test'
import assert from 'node:assert/strict'

import { idOfFile, parseTask, sanitize } from '../hooks/protocol.ts'

const MTIME = 1_759_700_000_000

test('idOfFile accepts only safe names ending in .json', () => {
  assert.equal(idOfFile('bridge.json'), 'bridge')
  assert.equal(idOfFile('gta2d.tiles-2.json'), 'gta2d.tiles-2')
  assert.equal(idOfFile('.bridge.json.123.tmp'), null)
  assert.equal(idOfFile('.hidden.json'), null)
  assert.equal(idOfFile('-x.json'), null)
  assert.equal(idOfFile('a b.json'), null)
  assert.equal(idOfFile('notes.txt'), null)
  assert.equal(idOfFile(`${'a'.repeat(65)}.json`), null)
})

test('a full v1 file parses into a task with times in ms', () => {
  const t = parseTask(
    JSON.stringify({
      v: 1, id: 'ignored', label: 'Bridge', icon: '⬇', done: 275, total: 1000, unit: 'files',
      bytes: 3.1e9, bytes_total: 8e9, status: 'running', message: 'ok', started_at: 1759700000, updated_at: 1759700123.4, pid: 4242,
    }),
    'bridge', MTIME, '/p/bridge.json',
  )
  assert.deepEqual(t, {
    id: 'bridge', label: 'Bridge', icon: '⬇', done: 275, total: 1000, unit: 'files', bytes: 3.1e9, bytesTotal: 8e9,
    status: 'running', message: 'ok', startedAt: 1759700000000, updatedAt: 1759700123400, pid: 4242, source: 'file', path: '/p/bridge.json',
  })
})

test('defaults: label = id, unit items, unknown total, mtime as updated_at, missing v is v1', () => {
  const t = parseTask('{"done": 3}', 'scan', MTIME)!
  assert.equal(t.label, 'scan')
  assert.equal(t.unit, 'items')
  assert.equal(t.total, null)
  assert.equal(t.status, 'running')
  assert.equal(t.updatedAt, MTIME)
})

test('broken or invalid files are null, never a throw', () => {
  for (const text of ['', '{', 'null', '[]', '"x"', '{"v":1}', '{"done":-1}', '{"done":"5"}', '{"v":0,"done":1}', '{"done":Infinity}']) {
    assert.equal(parseTask(text, 'x', MTIME), null, text)
  }
})

test('nonsense in optional fields falls back instead of failing', () => {
  const t = parseTask('{"done":1,"total":0,"status":"weird","pid":-4,"started_at":"yesterday","bytes":-1}', 'x', MTIME)!
  assert.equal(t.total, null)
  assert.equal(t.status, 'running')
  assert.equal(t.pid, undefined)
  assert.equal(t.startedAt, undefined)
  assert.equal(t.bytes, undefined)
})

test('a higher protocol version is read best-effort', () => {
  assert.equal(parseTask('{"v":2,"done":1,"new_field":true}', 'x', MTIME)?.done, 1)
})

test('control characters and ANSI escapes never reach the terminal', () => {
  const t = parseTask(JSON.stringify({ done: 1, label: '\u001b[31mred\u001b[0m', message: 'a\u0007b\u009bc\nd' }), 'x', MTIME)!
  assert.equal(t.label, '[31mred[0m')
  assert.equal(t.message, 'abcd')
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(t.label + t.message))
})

test('sanitize cuts by characters, not UTF-16 units', () => {
  assert.equal(sanitize('🔍🔍🔍', 2), '🔍🔍')
  assert.equal(sanitize('   ', 5), undefined)
  assert.equal(sanitize(42, 5), '42')
  assert.equal(sanitize({}, 5), undefined)
})
