/**
 * taskline — every long-running job's progress, live above the prompt.
 *
 * Polls ~/.claude/progress/*.json (PROTOCOL.md) and the watchers once a
 * second, keeps a smoothed speed per task for the ETA, and draws the band.
 * Everything that can fail is caught: a broken file or an unreadable log costs
 * that one task, never the band and never the session.
 */
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { Celebration, Layout, Prefs, Snapshot, Task } from '../types'
import { CELEBRATE_FPS, CELEBRATE_MS, encodeCells, frame, needs, planScene, seedOf } from './celebrate'
import type { Scene } from './celebrate'
import { advanceAll } from './eta'
import { PALETTE, barColumns, layoutRows } from './layout'
import type { Row } from './layout'
import { MAX_FILE_BYTES, idOfFile, parseTask } from './protocol'
import { DEFAULT_TIMING, phaseOf, pidsToCheck } from './state'
import type { Timing } from './state'
import { buildViews, expiredFiles, finished, isAnimated } from './views'
import { TAIL_BYTES, countMatches, expandHome, newestMatch, parseWatchers, readLog, splitGlob, watcherTask } from './watchers'
import type { Reading, Watcher } from './watchers'

const EMPTY: Snapshot = { tasks: [], alive: {}, rates: {} }
const DEFAULT_PREFS: Prefs = { layout: 'auto', hidden: false }

// --- what the band draws, in $.state (keys written out: the directory reads them) ------

async function getSnapshot($: EngineInterface): Promise<Snapshot> {
  const { value } = await $.state.get({ plugin: 'taskline', key: 'snapshot' })
  return value ?? EMPTY
}
async function setSnapshot($: EngineInterface, value: Snapshot): Promise<void> {
  await $.state.set({ plugin: 'taskline', key: 'snapshot' }, value)
}
async function getPrefs($: EngineInterface): Promise<Prefs> {
  const { value } = await $.state.get({ plugin: 'taskline', key: 'prefs' })
  return value ?? DEFAULT_PREFS
}
async function setPrefs($: EngineInterface, value: Prefs): Promise<void> {
  await $.state.set({ plugin: 'taskline', key: 'prefs' }, value)
}
async function getCelebration($: EngineInterface): Promise<Celebration | null> {
  const { value } = await $.state.get({ plugin: 'taskline', key: 'celebration' })
  return value ?? null
}
async function setCelebration($: EngineInterface, value: Celebration | null): Promise<void> {
  await $.state.set({ plugin: 'taskline', key: 'celebration' }, value)
}
/** The Raster the finish is drawn in; `$.ui.blit` repaints it by this key. */
const RASTER_KEY = 'taskline-check'
/** The finish's rows at most: the large show and a row of air for the sparks. */
const CELEBRATE_ROWS = needs(2).rows + 1

const LAYOUTS: readonly Layout[] = ['auto', 'single', 'stacked']
const TICK_MS = 250
const POLL_EVERY = 4 // ticks → 1 s
const PID_EVERY_MS = 5000
const CLEANUP_EVERY_MS = 5000
/** Up to this size a log is read whole and its tail cut here; larger ones go through `tail`. */
const READ_WHOLE_BELOW = 256 * 1024

type Config = {
  layout: Layout
  maxTasks: number
  timing: Timing
  color: boolean
  animation: boolean
  celebrate: boolean
  cleanup: boolean
  progressDir: string
  watchersFile: string
}

const pos = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)

export function configOf(options: PluginOptions): Config {
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d)
  return {
    layout: LAYOUTS.includes(options.layout as Layout) ? (options.layout as Layout) : 'auto',
    maxTasks: Math.round(pos(options.maxTasks, 3)),
    timing: {
      stalledAfter: pos(options.stalledAfter, DEFAULT_TIMING.stalledAfter),
      doneVisible: pos(options.doneVisible, DEFAULT_TIMING.doneVisible),
      errorVisible: pos(options.errorVisible, DEFAULT_TIMING.errorVisible),
    },
    color: options.color !== false,
    animation: options.animation !== false,
    celebrate: options.celebrate !== false,
    cleanup: options.cleanup !== false,
    progressDir: str(options.progressDir, '~/.claude/progress'),
    watchersFile: str(options.watchersFile, '~/.claude/taskline/watchers.json'),
  }
}

// --- module state (rebuilt on reload; what the band draws lives in $.state) ---------

let timer: Timer | undefined
let ticks = 0
let polling = false
let animated = false
let home = ''
let colorEnv = true
let canRun = true
/** progress file name → what it was the last time it was read */
const files = new Map<string, { mtimeMs: number; size: number; task: Task | null }>()
let watcherCfg: { mtimeMs: number; watchers: Watcher[]; errors: string[] } = { mtimeMs: -1, watchers: [], errors: [] }
/** watcher id → cache of its last reading, keyed by the source's mtime/size */
const readings = new Map<string, { key: string; reading: Reading | null }>()
const firstSeen = new Map<string, number>()
/** watcher id → the file a globbed path resolved to last time: a new file is a new run */
const resolved = new Map<string, string>()
let lastPidCheck = 0
let lastCleanup = 0
let demo: Timer | undefined

// the finish: one at a time, the rest queued
let showTimer: Timer | undefined
const queue: Celebration[] = []
/** the band's instance and the Raster as last drawn there: what a blit must match */
let mounted: { requestId: string; cols: number; rows: number } | null = null
let scene: { key: string; scene: Scene | null } | null = null

function sceneFor(c: Celebration, cols: number, rows: number, color: boolean): Scene | null {
  const key = `${c.id}:${c.startedAt}:${cols}:${rows}:${color}`
  if (scene?.key !== key) scene = { key, scene: planScene({ cols, rows, seed: seedOf(key), color, accent: PALETTE.accent, bar: c.bar }) }
  return scene.scene
}

async function celebrate($: EngineInterface, cfg: Config, c: Celebration): Promise<void> {
  if (!cfg.celebrate) return
  const current = await getCelebration($)
  const now = await $.clock.now()
  if (current && now - current.startedAt < CELEBRATE_MS) {
    if (queue.length < 3) queue.push(c)
    return
  }
  await setCelebration($, { ...c, startedAt: now })
  $.ui.invalidate('ui.render')
  showTimer?.cancel()
  showTimer = $.clock.every(Math.round(1000 / CELEBRATE_FPS), () => void step($, cfg))
}

/** One frame of the finish: repaint the Raster in place; at the end, the next one or nothing. */
async function step($: EngineInterface, cfg: Config): Promise<void> {
  const c = await getCelebration($)
  const now = await $.clock.now()
  if (!c || now - c.startedAt >= CELEBRATE_MS) {
    showTimer?.cancel()
    showTimer = undefined
    await setCelebration($, null)
    $.ui.invalidate('ui.render')
    const nextUp = queue.shift()
    if (nextUp) await celebrate($, cfg, nextUp)
    return
  }
  const sc = mounted ? sceneFor(c, mounted.cols, mounted.rows, cfg.color && colorEnv) : null
  if (!mounted || !sc) return
  const cells = encodeCells(frame(sc, now - c.startedAt))
  await $.ui.blit({ requestId: mounted.requestId, key: RASTER_KEY, cells }).catch(() => undefined)
}

const dirOf = (cfg: Config) => expandHome(cfg.progressDir, home).replace(/\/+$/, '')

async function readFiles($: EngineInterface, cfg: Config): Promise<Task[]> {
  const dir = dirOf(cfg)
  const entries = await $.fs.list(dir).catch(() => [])
  const seen = new Set<string>()
  const tasks: Task[] = []
  for (const entry of entries) {
    const id = idOfFile(entry.name)
    if (!id || entry.kind !== 'file' || entry.size > MAX_FILE_BYTES) continue
    seen.add(entry.name)
    const cached = files.get(entry.name)
    let task = cached?.task ?? null
    if (!cached || cached.mtimeMs !== entry.mtimeMs || cached.size !== entry.size) {
      const path = `${dir}/${entry.name}`
      const text = await $.fs.read(path).catch(() => null)
      const parsed = typeof text === 'string' ? parseTask(text, id, entry.mtimeMs, path) : null
      // a file caught mid-write by a non-atomic writer keeps its last good state
      task = parsed ?? cached?.task ?? null
      files.set(entry.name, { mtimeMs: entry.mtimeMs, size: entry.size, task })
    }
    if (task) tasks.push(task)
  }
  for (const name of [...files.keys()]) if (!seen.has(name)) files.delete(name)
  return tasks
}

async function loadWatchers($: EngineInterface, cfg: Config): Promise<Watcher[]> {
  const path = expandHome(cfg.watchersFile, home)
  const st = await $.fs.stat(path).catch(() => null)
  if (!st) {
    watcherCfg = { mtimeMs: -1, watchers: [], errors: [] }
    return []
  }
  if (st.mtimeMs !== watcherCfg.mtimeMs) {
    const text = await $.fs.read(path).catch(() => null)
    const parsed = typeof text === 'string' ? parseWatchers(text) : { watchers: [], errors: [`cannot read ${path}`] }
    watcherCfg = { mtimeMs: st.mtimeMs, ...parsed }
    for (const err of parsed.errors) $.ui.log(`taskline: ${err}`, { to: 'debug' })
  }
  return watcherCfg.watchers
}

async function tail($: EngineInterface, path: string, size: number): Promise<string | null> {
  if (size <= READ_WHOLE_BELOW) {
    const text = await $.fs.read(path).catch(() => null)
    return typeof text === 'string' ? text.slice(-TAIL_BYTES) : null
  }
  if (!canRun) return null
  const r = await $.process.run(['tail', '-c', String(TAIL_BYTES), path], { timeoutMs: 3000 }).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout : null
}

/** The file a watcher reads: its path, or for `fetch*.log` the newest match in that folder. */
async function resolvePath($: EngineInterface, w: Watcher): Promise<string | null> {
  const path = expandHome(w.path, home)
  const g = w.type === 'dircount' ? null : splitGlob(path)
  if (!g) return path
  const entries = await $.fs.list(g.dir).catch(() => [])
  const name = newestMatch(entries, g.glob)
  return name ? `${g.dir === '/' ? '' : g.dir}/${name}` : null
}

async function measure($: EngineInterface, w: Watcher, path: string): Promise<Reading | null> {
  const st = await $.fs.stat(path).catch(() => null)
  if (!st) return null
  const key = `${path}:${st.mtimeMs}:${st.size}`
  const cached = readings.get(w.id)
  if (cached?.key === key) return cached.reading
  let reading: Reading | null = null
  if (w.type === 'filesize' && st.kind === 'file') reading = { done: st.size, mtimeMs: st.mtimeMs }
  if (w.type === 'logtail' && st.kind === 'file') {
    const text = await tail($, path, st.size)
    const r = text === null ? null : readLog(w, text)
    reading = r ? { ...r, mtimeMs: st.mtimeMs } : null
  }
  if (w.type === 'dircount' && st.kind === 'dir') {
    const entries = await $.fs.list(path).catch(() => [])
    const newest = entries.reduce((m, e) => Math.max(m, e.mtimeMs), st.mtimeMs)
    reading = { done: countMatches(w, entries), mtimeMs: newest }
  }
  readings.set(w.id, { key, reading })
  return reading
}

async function readWatchers($: EngineInterface, cfg: Config, now: number): Promise<Task[]> {
  const tasks: Task[] = []
  const live = new Set<string>()
  for (const w of await loadWatchers($, cfg)) {
    live.add(w.id)
    const path = await resolvePath($, w).catch(() => null)
    if (!path) continue
    if (resolved.has(w.id) && resolved.get(w.id) !== path) firstSeen.delete(w.id) // another file: a new run
    resolved.set(w.id, path)
    const reading = await measure($, w, path).catch(() => null)
    if (!reading) continue
    if (now - reading.mtimeMs > w.activeWithin * 1000) {
      firstSeen.delete(w.id) // idle: the next activity is a new run
      continue
    }
    if (!firstSeen.has(w.id)) firstSeen.set(w.id, Math.min(now, reading.mtimeMs))
    const task = watcherTask(w, reading, now, firstSeen.get(w.id)!, path)
    if (task) tasks.push(task)
  }
  for (const id of [...readings.keys()]) if (!live.has(id)) readings.delete(id)
  for (const id of [...resolved.keys()]) if (!live.has(id)) resolved.delete(id)
  return tasks
}

/** pid → alive. `kill -0` answers EPERM for another user's live process: that is alive too. */
async function checkPids($: EngineInterface, pids: number[], prev: Record<string, boolean>): Promise<Record<string, boolean>> {
  const alive: Record<string, boolean> = {}
  for (const pid of pids) {
    if (!canRun) break
    const r = await $.process.run(['kill', '-0', String(pid)], { timeoutMs: 2000 }).catch(() => {
      canRun = false // no host processes on this surface: liveness stays unknown
      return null
    })
    if (r) alive[String(pid)] = r.exitCode === 0 || /not permitted/i.test(r.stderr)
    else if (prev[String(pid)] !== undefined) alive[String(pid)] = prev[String(pid)]!
  }
  return alive
}

async function removeFiles($: EngineInterface, cfg: Config, tasks: readonly Task[]): Promise<number> {
  const dir = dirOf(cfg)
  // only our own kind of file, only in our directory
  const paths = tasks.map(t => t.path).filter((p): p is string => !!p && p.startsWith(`${dir}/`) && !!idOfFile(p.slice(dir.length + 1)))
  if (!paths.length || !canRun) return 0
  const r = await $.process.run(['rm', '-f', '--', ...paths], { timeoutMs: 3000 }).catch(() => null)
  if (r?.exitCode !== 0) return 0
  for (const p of paths) files.delete(p.slice(dir.length + 1))
  return paths.length
}

async function poll($: EngineInterface, cfg: Config): Promise<void> {
  if (polling) return
  polling = true
  try {
    const now = await $.clock.now()
    const prev = await getSnapshot($)
    const tasks = [...(await readFiles($, cfg)), ...(await readWatchers($, cfg, now))]

    let alive = prev.alive
    if (now - lastPidCheck >= PID_EVERY_MS || pidsToCheck(tasks).some(p => prev.alive[String(p)] === undefined)) {
      lastPidCheck = now
      alive = await checkPids($, pidsToCheck(tasks), prev.alive)
    }
    const next: Snapshot = { tasks, alive, rates: advanceAll(prev.rates, tasks) }
    for (const t of finished(prev.tasks, tasks)) await celebrate($, cfg, { id: t.id, label: t.label, startedAt: now, bar: barColumns(t) })

    if (cfg.cleanup && now - lastCleanup >= CLEANUP_EVERY_MS) {
      lastCleanup = now
      const expired = expiredFiles(next, now, cfg.timing)
      if (expired.length && (await removeFiles($, cfg, expired))) {
        const gone = new Set(expired.map(t => t.id))
        next.tasks = next.tasks.filter(t => t.source !== 'file' || !gone.has(t.id))
      }
    }

    if (JSON.stringify(next) !== JSON.stringify(prev)) await setSnapshot($, next)
    const views = buildViews(next, now, cfg.timing)
    animated = isAnimated(views)
    // ages, countdowns and the display window of done tasks move with time alone
    if (views.length || prev.tasks.length) $.ui.invalidate('ui.render')
  } catch (err) {
    $.ui.log(`taskline: poll failed: ${(err as Error).message}`, { to: 'debug' })
  } finally {
    polling = false
  }
}

// --- demo: three fake jobs, written as real progress files -------------------------------

async function runDemo($: EngineInterface, cfg: Config): Promise<void> {
  demo?.cancel()
  const dir = dirOf(cfg)
  const t0 = await $.clock.now()
  const s = (ms: number) => ms / 1000
  const write = (id: string, body: Record<string, unknown>) =>
    $.fs.write(`${dir}/${id}.json`, JSON.stringify({ v: 1, id, ...body })).catch(() => undefined)
  const GB = 3.1e9
  await write('demo-stuck', {
    label: 'Tiles', icon: '⬇', done: 412, total: 3400, unit: 'files',
    started_at: s(t0 - 600_000), updated_at: s(t0 - 95_000),
  })
  demo = $.clock.every(500, () => {
    void (async () => {
      const now = await $.clock.now()
      const el = now - t0
      const f = Math.min(1, el / 24_000)
      // a download that speeds up and slows down, like a real one
      const wobble = f + 0.03 * Math.sin(el / 1500) * (1 - f) * f
      await write('demo-download', {
        label: 'Bridge', icon: '⬇', done: Math.round(1000 * Math.min(1, wobble)), total: 1000, unit: 'files',
        bytes: Math.round(GB * Math.min(1, wobble)), bytes_total: GB,
        status: f >= 1 ? 'done' : 'running', started_at: s(t0), updated_at: s(now),
      })
      await write('demo-scan', {
        label: 'Index', icon: '🔍', done: Math.round(el / 7), total: null, unit: 'items',
        status: el >= 30_000 ? 'done' : 'running', started_at: s(t0), updated_at: s(now),
      })
      if (el >= 34_000) {
        demo?.cancel()
        demo = undefined
        await write('demo-stuck', {
          label: 'Tiles', icon: '⬇', done: 412, total: 3400, unit: 'files', status: 'error',
          message: 'HTTP 503 from tile server', started_at: s(t0 - 600_000), updated_at: s(now),
        })
      }
    })()
  })
}

// --- the band ---------------------------------------------------------------------------

function statusText(s: Snapshot, now: number, cfg: Config, prefs: Prefs): string {
  const lines = [`taskline — ${s.tasks.length} task(s) · layout ${prefs.layout}${prefs.hidden ? ' · hidden' : ''}`]
  for (const t of s.tasks) {
    const phase = phaseOf(t, now, cfg.timing, t.pid === undefined ? undefined : s.alive[String(t.pid)])
    const of = t.total === null ? '?' : String(t.total)
    lines.push(`  ${t.id.padEnd(22)} ${phase.padEnd(8)} ${t.done}/${of} ${t.unit}${t.message ? `  ${t.message}` : ''}`)
    if (t.path) lines.push(`  ${' '.repeat(22)} ${t.source === 'watcher' ? 'watching' : 'file'} ${t.path}`)
  }
  lines.push(`progress files: ${dirOf(cfg)}`)
  lines.push(`watchers: ${expandHome(cfg.watchersFile, home)} (${watcherCfg.watchers.length} active)`)
  for (const err of watcherCfg.errors) lines.push(`  ⚠ ${err}`)
  return lines.join('\n')
}

const HELP = [
  'Commands:',
  '  /taskline                      list tasks, watchers and where they come from',
  '  /taskline clear [all]          remove finished tasks (all: stalled ones too)',
  '  /taskline rm <id>              remove one task',
  '  /taskline hide | show          hide or show the band',
  '  /taskline layout auto|single|stacked',
  '  /taskline demo                 three fake jobs for 35 s',
  '  /taskline check                play the finish (the bar bursts, CHECK!!)',
].join('\n')

export const register: Register = (on, options) => {
  const cfg = configOf(options)

  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    const noColor = await $.env.get('NO_COLOR').catch(() => undefined)
    colorEnv = !noColor
    const stored = (await $.store.get('prefs').catch(() => null)) as Partial<Prefs> | null
    await setPrefs($, {
      layout: LAYOUTS.includes(stored?.layout as Layout) ? (stored!.layout as Layout) : cfg.layout,
      hidden: stored?.hidden === true,
    })
    await $.command.register({
      name: 'taskline',
      description: 'Progress of long-running jobs: list, clear, hide/show, layout, demo',
      argumentHint: '[clear [all]|rm <id>|hide|show|layout auto|single|stacked|demo|check|help]',
      immediate: true,
    })
    timer?.cancel()
    ticks = 0
    timer = $.clock.every(TICK_MS, () => {
      ticks += 1
      if (ticks % POLL_EVERY === 1) void poll($, cfg)
      else if (animated && cfg.animation) $.ui.invalidate('ui.render')
    })
    void poll($, cfg)
    return next(e)
  })

  on('command.run', { command: 'taskline' }, async ($, e) => {
    const [cmd = '', arg = ''] = e.args.trim().split(/\s+/)
    const prefs = await getPrefs($)
    const save = async (p: Prefs) => {
      await setPrefs($, p)
      await $.store.set('prefs', p)
      $.ui.invalidate('ui.render')
    }
    const now = await $.clock.now()
    const snap = await getSnapshot($)

    switch (cmd.toLowerCase()) {
      case '':
      case 'ls':
      case 'list':
      case 'status':
        return { text: statusText(snap, now, cfg, prefs) }
      case 'hide':
        await save({ ...prefs, hidden: true })
        return { text: 'taskline hidden (/taskline show brings it back)' }
      case 'show':
        await save({ ...prefs, hidden: false })
        return { text: 'taskline shown' }
      case 'layout': {
        if (!LAYOUTS.includes(arg as Layout)) return { text: `layout is ${prefs.layout}; choose ${LAYOUTS.join(', ')}` }
        await save({ ...prefs, layout: arg as Layout })
        return { text: `layout ${arg}` }
      }
      case 'clear': {
        const all = arg === 'all'
        const doomed = snap.tasks.filter(t => {
          if (t.source !== 'file') return false
          const phase = phaseOf(t, now, cfg.timing, t.pid === undefined ? undefined : snap.alive[String(t.pid)])
          return phase !== 'running' && (all || phase !== 'stalled')
        })
        const n = await removeFiles($, cfg, doomed)
        await poll($, cfg)
        return { text: n ? `removed ${n} task(s)` : canRun ? 'nothing to clear' : 'cannot remove files on this surface' }
      }
      case 'rm': {
        const task = snap.tasks.find(t => t.id === arg && t.source === 'file')
        if (!task) return { text: `no progress file "${arg}" (watchers are configured in ${cfg.watchersFile})` }
        const n = await removeFiles($, cfg, [task])
        await poll($, cfg)
        return { text: n ? `removed ${arg}` : `could not remove ${arg}` }
      }
      case 'check':
        if (!cfg.celebrate) return { text: 'the finish is off (celebrate in /config)' }
        await celebrate($, cfg, { id: 'taskline-check', label: 'taskline', startedAt: now, bar: [2, 22] })
        return { text: 'CHECK!!' }
      case 'demo':
        await runDemo($, cfg)
        await poll($, cfg)
        return { text: 'demo running for 35 s (above the prompt)' }
      default:
        return { text: HELP }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const prefs = await getPrefs($)
    const snap = await getSnapshot($)
    const now = await $.clock.now()
    const cel = await getCelebration($)
    const showing = cel && cfg.celebrate && !prefs.hidden && now - cel.startedAt < CELEBRATE_MS ? cel : null
    if (prefs.hidden || (snap.tasks.length === 0 && !showing)) return next(e)

    const views = buildViews(snap, now, cfg.timing)
    if (views.length === 0 && !showing) return next(e)
    const color = cfg.color && colorEnv
    const width = e.props.bodyColumns
    const budget = Math.max(1, e.props.maxRows - 1)

    // the finish takes the rows it can get above the tasks; one row stays for them
    let raster: { rows: number; scene: Scene } | null = null
    if (showing && e.surface === 'terminal' && cfg.animation) {
      const rowsFree = Math.min(CELEBRATE_ROWS, budget - (views.length ? 1 : 0))
      const sc = rowsFree > 0 ? sceneFor(showing, width, rowsFree, color) : null
      if (sc) raster = { rows: rowsFree, scene: sc }
    }
    mounted = raster ? { requestId: e.requestId, cols: width, rows: raster.rows } : null
    const used = raster ? raster.rows : showing ? 1 : 0
    const rows: Row[] = views.length
      ? layoutRows(views, {
          width,
          layout: prefs.layout,
          maxTasks: cfg.maxTasks,
          maxRows: Math.max(1, budget - used),
          nowMs: now,
          color,
        })
      : []
    if (rows.length === 0 && !showing) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    let top: ReturnType<typeof h> | null = null
    if (raster && e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      top = (
        <Raster
          key={RASTER_KEY}
          columns={width}
          rows={raster.rows}
          cells={encodeCells(frame(raster.scene, now - showing!.startedAt))}
        />
      )
    } else if (showing) {
      // no room, no animation, or a surface without a Raster: the finish in one line
      top = (
        <Box key="taskline-check-line" flexDirection="row">
          <Text color={color ? PALETTE.ok : undefined} bold wrap="truncate-end">
            {`✔ CHECK!!`}
          </Text>
          <Text dimColor wrap="truncate-end">{`  ${showing.label}`}</Text>
        </Box>
      )
    }

    const band = (
      <Box key="taskline" flexDirection="column">
        {top}
        {rows.map((row, i) => (
          <Box key={`row-${i}`} flexDirection="row">
            {row.map((s, j) => (
              <Text key={`s-${i}-${j}`} color={s.color} dimColor={s.dim} bold={s.bold} wrap="truncate-end">
                {s.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
    // other plugins' bands stay: ours goes first, theirs below
    const below = await next(e)
    return below ? (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    ) : (
      band
    )
  })
}
