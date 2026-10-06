import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { compilePattern, countMatches, expandHome, globToRegExp, newestMatch, parseWatchers, quantity, readLog, splitGlob, watcherTask } from '../hooks/watchers.ts'

const NOW = 1_000_000_000

test('expandHome only touches a leading ~', () => {
  assert.equal(expandHome('~/x/y', '/Users/me'), '/Users/me/x/y')
  assert.equal(expandHome('~', '/Users/me/'), '/Users/me/')
  assert.equal(expandHome('/a/~/b', '/Users/me'), '/a/~/b')
})

test('globToRegExp: *, ?, classes, braces, and literal dots', () => {
  const g = globToRegExp('tile_??.{png,jpg}')
  assert.ok(g.test('tile_01.png') && g.test('tile_ab.jpg'))
  assert.ok(!g.test('tile_1.png') && !g.test('tile_01xpng') && !g.test('tile_01.gif'))
  assert.ok(globToRegExp('*.json').test('a.json') && !globToRegExp('*.json').test('a.json.tmp'))
  assert.ok(globToRegExp('[ab]*').test('b1') && !globToRegExp('[ab]*').test('c1'))
})

test('quantity reads counts, separators and size suffixes', () => {
  assert.equal(quantity('1,234'), 1234)
  assert.equal(quantity("1'234"), 1234)
  assert.equal(quantity('3.1 GB'), 3.1e9)
  assert.equal(quantity('512MiB'), 512 * 1024 ** 2)
  assert.equal(quantity('20k'), 20_000)
  assert.ok(Number.isNaN(quantity('abc')))
  assert.ok(Number.isNaN(quantity(undefined)))
})

test('Python-style named groups work', () => {
  const re = compilePattern('(?P<done>\\d+)/(?P<total>\\d+)')
  assert.equal(re.exec('12/40')?.groups?.done, '12')
})

test('parseWatchers: defaults per type, bad entries reported not fatal', () => {
  const { watchers, errors } = parseWatchers(JSON.stringify({
    watchers: [
      { type: 'filesize', path: '~/dl/big.iso', total_bytes: '4.7 GB', label: 'ISO' },
      { type: 'logtail', path: '~/fetch.log', pattern: '(?<done>\\d+)/(?<total>\\d+)' },
      { type: 'dircount', path: '/out/tiles', glob: '*.png', total: 5000, id: 'tiles' },
      { type: 'nope', path: '/x' },
      { type: 'logtail', path: '/y.log', pattern: 'no group here' },
      { type: 'logtail', path: '/z.log', pattern: '(' },
      { type: 'filesize' },
      { type: 'dircount', path: '/out/tiles' },
      { type: 'filesize', path: '/off', enabled: false },
    ],
  }))
  assert.deepEqual(watchers.map(w => [w.id, w.type, w.unit, w.total]), [
    ['big.iso', 'filesize', 'bytes', 4.7e9],
    ['fetch.log', 'logtail', 'items', null],
    ['tiles', 'dircount', 'files', 5000],
  ])
  assert.equal(watchers[0]!.label, 'ISO')
  assert.equal(errors.length, 5, errors.join('\n'))
  assert.ok(errors.some(e => e.includes('duplicate id')))
})

test('parseWatchers: broken JSON is one error, a bare array is accepted', () => {
  assert.equal(parseWatchers('{').errors.length, 1)
  assert.equal(parseWatchers('[{"type":"filesize","path":"/a"}]').watchers.length, 1)
  assert.equal(parseWatchers('{"x":1}').errors.length, 1)
})

test('the shipped example config is valid', () => {
  const text = readFileSync(resolve(import.meta.dirname, '../examples/watchers.json'), 'utf8')
  const { watchers, errors } = parseWatchers(text)
  assert.deepEqual(errors, [])
  assert.ok(watchers.length >= 3)
})

test('readLog takes the LAST match, with sizes and a message', () => {
  const [w] = parseWatchers(JSON.stringify([{
    type: 'logtail', path: '/f.log',
    pattern: '\\[(?<done>[\\d,]+)/(?<total>[\\d,]+)\\] (?<bytes>[\\d.]+ ?[KMG]B)(?: (?<message>.*))?$',
  }])).watchers
  const log = ['[1/1,000] 1.0 MB first', '[274/1,000] 3.0 GB a', 'noise line', '[275/1,000] 3.1 GB tiles/x.png', ''].join('\n')
  assert.deepEqual(readLog(w!, log), { done: 275, total: 1000, bytes: 3.1e9, message: 'tiles/x.png' })
  assert.equal(readLog(w!, 'nothing to see'), null)
})

test('readLog survives patterns that match the empty string', () => {
  const [w] = parseWatchers('[{"type":"logtail","path":"/f","pattern":"(?<done>\\\\d*)"}]').watchers
  assert.doesNotThrow(() => readLog(w!, 'abc 12'))
})

test('countMatches ignores directories and dotfiles', () => {
  const [w] = parseWatchers('[{"type":"dircount","path":"/d","glob":"*.png"}]').watchers
  const entries = [
    { name: 'a.png', kind: 'file' }, { name: 'b.png', kind: 'file' }, { name: '.c.png', kind: 'file' },
    { name: 'd.png', kind: 'dir' }, { name: 'e.jpg', kind: 'file' },
  ]
  assert.equal(countMatches(w!, entries), 2)
})

test('watcherTask: idle sources stay out, totals and done are derived', () => {
  const [w] = parseWatchers('[{"type":"filesize","path":"/x.iso","total_bytes":1000,"active_within":60}]').watchers
  assert.equal(watcherTask(w!, { done: 10, mtimeMs: NOW - 61_000 }, NOW, NOW, '/x.iso'), null)
  const t = watcherTask(w!, { done: 400, mtimeMs: NOW - 1000 }, NOW, NOW - 30_000, '/x.iso')!
  assert.deepEqual([t.id, t.done, t.total, t.unit, t.status, t.source, t.startedAt], ['watch.x.iso', 400, 1000, 'bytes', 'running', 'watcher', NOW - 30_000])
  assert.equal(watcherTask(w!, { done: 1000, mtimeMs: NOW }, NOW, NOW, '/x.iso')!.status, 'done')
  // a total read from the log beats the configured one
  const [l] = parseWatchers('[{"type":"logtail","path":"/l","pattern":"(?<done>\\\\d+)","total":10}]').watchers
  assert.equal(watcherTask(l!, { done: 5, total: 50, mtimeMs: NOW }, NOW, NOW, '/l')!.total, 50)
  // a watcher's stalled_after travels with its task
  const [s] = parseWatchers('[{"type":"logtail","path":"/l","pattern":"(?<done>\\\\d+)","stalled_after":600}]').watchers
  assert.equal(watcherTask(s!, { done: 5, mtimeMs: NOW }, NOW, NOW, '/l')!.stalledAfter, 600)
})

test('splitGlob: a glob in the file name splits off its folder; plain paths and folder globs do not', () => {
  const g = splitGlob('/w/beat work/fetch*.log')!
  assert.ok(g.glob)
  assert.equal(g.dir, '/w/beat work')
  assert.ok(g.glob.test('fetch3.log') && g.glob.test('fetch.log') && !g.glob.test('fetch3.log.bak'))
  assert.equal(splitGlob('/w/fetch3.log'), null)
  assert.equal(splitGlob('/w/*/fetch*.log'), null) // one level: only the last segment
  assert.equal(splitGlob('*.log'), null) // no folder to list
  assert.equal(splitGlob('/w/run-{a,b}.log')?.dir, '/w')
})

test('newestMatch: the most recently modified matching file, never a folder or a dotfile', () => {
  const glob = globToRegExp('fetch*.log')
  const entries = [
    { name: 'fetch.log', kind: 'file', mtimeMs: 100 },
    { name: 'fetch3.log', kind: 'file', mtimeMs: 300 },
    { name: 'fetch2.log', kind: 'file', mtimeMs: 200 },
    { name: 'fetch9.log', kind: 'dir', mtimeMs: 900 },
    { name: '.fetch8.log', kind: 'file', mtimeMs: 800 },
    { name: 'other.log', kind: 'file', mtimeMs: 700 },
  ]
  assert.equal(newestMatch(entries, glob), 'fetch3.log')
  assert.equal(newestMatch(entries.slice(3), glob), null)
  // equal times: the later name wins, so fetch10 beats fetch9 only by time, but a tie is stable
  assert.equal(newestMatch([{ name: 'b.log', kind: 'file', mtimeMs: 5 }, { name: 'a.log', kind: 'file', mtimeMs: 5 }], globToRegExp('*.log')), 'b.log')
})

test('parseWatchers keeps a globbed path for filesize and logtail as written', () => {
  const { watchers, errors } = parseWatchers(
    JSON.stringify([{ type: 'logtail', path: '~/w/fetch*.log', pattern: '(?<done>\\d+)' }, { type: 'filesize', path: '~/dl/*.iso', total_bytes: 10 }]),
  )
  assert.deepEqual(errors, [])
  assert.equal(watchers[0]!.path, '~/w/fetch*.log')
  assert.ok(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(watchers[0]!.id), `id ${watchers[0]!.id} is path-safe`)
  assert.ok(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(watchers[1]!.id), `id ${watchers[1]!.id} is path-safe`)
})
