/**
 * Engine tests: the mod loaded by Claude Code's own host (`claude plugin test .`).
 * The file system, the clock and host processes are faked beneath the plugin.
 */
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/me'
const DIR = `${HOME}/.claude/progress`
const WATCHERS = `${HOME}/.claude/taskline/watchers.json`
const T0 = 1_759_700_000_000

const BAND = {
  plugin: 'taskline',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

type File = { text: string; mtimeMs: number }

/** The world beneath the plugin: files, clock, env, store, processes. */
function world(on: any, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  mock.env(on, { HOME, ...env })
  const files = new Map<string, File>()
  const dead = new Set<number>()
  const removed: string[] = []
  const write = (path: string, text: string) => files.set(path, { text, mtimeMs: clock.now() })
  const task = (id: string, body: Record<string, unknown>) =>
    write(`${DIR}/${id}.json`, JSON.stringify({ v: 1, updated_at: clock.now() / 1000, ...body }))

  const enoent = () => {
    throw new Error('ENOENT')
  }
  on('fs.list', (_$: any, e: any) => {
    const prefix = `${e.path}/`
    const names = [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    return {
      value: names.map(p => {
        const f = files.get(p)!
        return { name: p.slice(prefix.length), kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false }
      }),
    }
  })
  on('fs.read', (_$: any, e: any) => (files.has(e.path) ? { value: files.get(e.path)!.text } : enoent()))
  on('fs.stat', (_$: any, e: any) => {
    const f = files.get(e.path)
    if (f) return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
    if ([...files.keys()].some(p => p.startsWith(`${e.path}/`))) return { value: { kind: 'dir', size: 0, mtimeMs: clock.now(), isLink: false } }
    return enoent()
  })
  on('fs.write', (_$: any, e: any) => {
    write(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_$: any, e: any) => {
    const [cmd, ...args] = e.argv as string[]
    if (cmd === 'kill') {
      const pid = Number(args[1])
      return { value: dead.has(pid) ? { exitCode: 1, stdout: '', stderr: 'kill: No such process' } : { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (cmd === 'rm') {
      for (const p of args.filter(a => a.startsWith('/'))) {
        files.delete(p)
        removed.push(p)
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    return { value: { exitCode: 127, stdout: '', stderr: 'not faked' } }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  // the engine's own band beneath: an empty one marked so we can see it is kept
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine-band</Text>
  })
  return { clock, files, write, task, dead, removed }
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const mount = ($: any, surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = 140): Promise<any> =>
  $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns }, surface, viewport: { columns: bodyColumns + 5, rows: 40 } })
const shown = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('')
const run = ($: any, args: string) => $.command.run({ command: 'taskline', args } as never) as Promise<{ text: string }>
/** one poll: the timer polls once a second */
const tick = (clock: any) => clock.advance(1000)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`nothing to show: only the engine's band (${surface})`, async ($, on) => {
    const w = world(on)
    await start($)
    await tick(w.clock)
    const ui = await mount($, surface)
    expect(await shown(ui)).toBe('engine-band')
  })

  test(`a running task: label, bar, count, rate, ETA, engine band kept (${surface})`, async ($, on) => {
    const w = world(on)
    w.task('bridge', { label: 'Bridge', icon: '⬇', done: 100, total: 1000, unit: 'files', started_at: (T0 - 100_000) / 1000 })
    await start($)
    await tick(w.clock)
    w.task('bridge', { label: 'Bridge', icon: '⬇', done: 110, total: 1000, unit: 'files', started_at: (T0 - 100_000) / 1000 })
    await tick(w.clock)
    const ui = await mount($, surface)
    const t = await shown(ui)
    expect(t).toContain('⬇ Bridge')
    expect(t).toContain('█')
    expect(t).toContain('110/1,000 files')
    expect(t).toContain('10/s')
    expect(t).toContain('ETA 1:2') // 890 left at 10/s ≈ 1:29, counting down
    expect(t).toContain('engine-band')
  })
}

test('a task that stops updating turns stalled, then recovers', async ($, on) => {
  const w = world(on)
  w.task('tiles', { label: 'Tiles', done: 5, total: 50 })
  await start($)
  await w.clock.advance(61_000)
  const ui = await mount($)
  expect(await shown(ui)).toContain('⏸ stalled 1m')
  w.task('tiles', { label: 'Tiles', done: 6, total: 50 })
  await tick(w.clock)
  expect(await shown(ui)).not.toContain('stalled')
})

test('a dead writer process shows as aborted', async ($, on) => {
  const w = world(on)
  w.task('job', { label: 'Job', done: 5, total: 50, pid: 4242 })
  await start($)
  await tick(w.clock)
  const ui = await mount($)
  expect(await shown(ui)).not.toContain('aborted')
  w.dead.add(4242)
  await w.clock.advance(6000) // the pid check runs every 5 s
  expect(await shown(ui)).toContain('✖ aborted')
})

test('done shows in green, then disappears and its file is cleaned up', async ($, on) => {
  const w = world(on)
  w.task('dl', { label: 'DL', done: 50, total: 50, status: 'done', started_at: (T0 - 30_000) / 1000 })
  await start($)
  await tick(w.clock)
  const ui = await mount($)
  const check = await ui.find({ type: 'Text', text: '✔' })
  expect(check?.props.color).toBe('#3fb950')
  expect(await shown(ui)).toContain('50/50 items in 0:30')
  await w.clock.advance(15_000)
  expect(await shown(ui)).toBe('engine-band')
  expect(w.removed).toEqual([`${DIR}/dl.json`])
})

test('errors stay with their message until cleared', async ($, on) => {
  const w = world(on)
  w.task('fx', { label: 'Fx', done: 3, total: 9, status: 'error', message: 'HTTP 503' })
  await start($)
  await w.clock.advance(60_000)
  const ui = await mount($)
  expect(await shown(ui)).toContain('✖ HTTP 503')
  expect((await run($, 'clear')).text).toContain('removed 1')
  expect(await shown(ui)).toBe('engine-band')
})

test('a broken file costs only itself', async ($, on) => {
  const w = world(on)
  w.write(`${DIR}/broken.json`, '{"v":1,"done":')
  w.write(`${DIR}/.tmp.json.1.tmp`, 'garbage')
  w.task('ok', { label: 'Fine', done: 1, total: 2 })
  await start($)
  await tick(w.clock)
  const t = await shown(await mount($))
  expect(t).toContain('Fine')
  expect(t).not.toContain('broken')
})

test('a logtail watcher reads the last match of the log', async ($, on) => {
  const w = world(on)
  w.write(WATCHERS, JSON.stringify({ watchers: [{ id: 'fetch', type: 'logtail', label: 'Fetch', path: '~/work/fetch.log', pattern: '\\[(?P<done>\\d+)/(?P<total>\\d+)\\]', unit: 'files' }] }))
  w.write(`${HOME}/work/fetch.log`, '[1/400] a\n[2/400] b\n[37/400] c\n')
  await start($)
  await tick(w.clock)
  const t = await shown(await mount($))
  expect(t).toContain('Fetch')
  expect(t).toContain('37/400 files')
})

test('NO_COLOR removes every color', async ($, on) => {
  const w = world(on, { NO_COLOR: '1' })
  w.task('x', { label: 'X', done: 1, total: 4 })
  await start($)
  await tick(w.clock)
  const ui = await mount($)
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.some((t: any) => t.text.includes('█'))).toBe(true)
  expect(texts.every((t: any) => t.props.color === undefined)).toBe(true)
})

test('narrow band: one task per row, nothing wider than the band', async ($, on) => {
  const w = world(on)
  for (const id of ['a', 'b', 'c', 'd']) w.task(id, { label: `Task ${id}`, done: 1, total: 4 })
  await start($)
  await tick(w.clock)
  const ui = await mount($, 'terminal', 48)
  const rows = (await ui.findAll({ type: 'Box' })).filter((b: any) => String(b.key ?? '').startsWith('row-'))
  expect(rows.length).toBe(3) // maxTasks 3: two tasks and "+2 more"
  for (const r of rows) expect([...r.text].length).toBeLessThanOrEqual(48)
  expect(await shown(ui)).toContain('+2 more')
})

test('/taskline hide, show and layout persist', async ($, on) => {
  const w = world(on)
  w.task('x', { label: 'X', done: 1, total: 4 })
  await start($)
  await tick(w.clock)
  const ui = await mount($)
  await run($, 'hide')
  expect(await shown(ui)).toBe('engine-band')
  await run($, 'show')
  expect(await shown(ui)).toContain('X')
  expect((await run($, 'layout sideways')).text).toContain('choose auto, single, stacked')
  expect((await run($, 'layout stacked')).text).toBe('layout stacked')
  expect((await run($, '')).text).toContain('layout stacked')
})

test('/taskline lists tasks and reports a broken watchers file', async ($, on) => {
  const w = world(on)
  w.write(WATCHERS, '{ nope')
  w.task('x', { label: 'X', done: 1, total: 4 })
  await start($)
  await tick(w.clock)
  const text = (await run($, 'ls')).text
  expect(text).toContain('x')
  expect(text).toContain('running')
  expect(text).toContain('not valid JSON')
})

test('/taskline demo writes three jobs that show up', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'demo')
  await w.clock.advance(3000)
  const t = await shown(await mount($))
  expect(t).toContain('Bridge')
  expect(t).toContain('Index')
  expect(t).toContain('Tiles')
})

test('a file caught mid-write keeps its last good state', async ($, on) => {
  const w = world(on)
  w.task('dl', { label: 'DL', done: 40, total: 100 })
  await start($)
  await tick(w.clock)
  w.write(`${DIR}/dl.json`, '{"v":1,"done":4') // a non-atomic writer, caught halfway
  await tick(w.clock)
  expect(await shown(await mount($))).toContain('40/100')
})

test('a survey owns the band: taskline steps aside', async ($, on) => {
  const w = world(on)
  w.task('x', { label: 'X', done: 1, total: 4 })
  await start($)
  await tick(w.clock)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal', viewport: { columns: 145, rows: 40 } } as never)
  expect(await shown(ui)).toBe('engine-band')
})

test('with cleanup off, a finished task still hides after doneVisible and its file stays', { options: { cleanup: false, doneVisible: 5 } }, async ($, on) => {
  const w = world(on)
  w.task('dl', { label: 'DL', done: 5, total: 5, status: 'done' })
  await start($)
  await tick(w.clock)
  const ui = await mount($)
  expect(await shown(ui)).toContain('DL')
  await w.clock.advance(6000)
  expect(await shown(ui)).toBe('engine-band')
  expect(w.removed).toEqual([])
  expect(w.files.has(`${DIR}/dl.json`)).toBe(true)
})
