/**
 * Watchers: progress for jobs that report nothing themselves, read from what
 * they leave on disk. The pure half — config, matching, task building. The
 * file system half lives in register.tsx.
 *
 *   filesize  a file growing towards a known size (a download)
 *   logtail   the last match of a regex in the tail of a log (fetch.log)
 *   dircount  files matching a glob in a directory, towards a known count
 */
import type { Task } from '../types'
import { ID_RE, sanitize } from './protocol'

export type WatcherType = 'filesize' | 'logtail' | 'dircount'

export type Watcher = {
  id: string
  type: WatcherType
  label: string
  icon?: string
  /** as written in the config, `~` not yet expanded */
  path: string
  unit: string
  total: number | null
  /** filesize: the expected size; logtail: a fallback for a missing bytes_total group */
  bytesTotal?: number
  /** logtail */
  pattern?: RegExp
  /** dircount */
  glob?: RegExp
  /** seconds: a source not modified for longer is not shown at all */
  activeWithin: number
}

/** What a watcher measured on one poll. */
export type Reading = {
  done: number
  total?: number | null
  bytes?: number
  bytesTotal?: number
  message?: string
  /** epoch ms of the source's last modification */
  mtimeMs: number
}

export const DEFAULT_ACTIVE_WITHIN = 600
/** The tail of a log that a logtail watcher reads. */
export const TAIL_BYTES = 64 * 1024

const TYPES: readonly WatcherType[] = ['filesize', 'logtail', 'dircount']

/** `~/x` → `/Users/me/x`. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home.replace(/\/$/, '')}/${path.slice(2)}`
  return path
}

/** A shell glob for one directory level (`*`, `?`, `[abc]`, `{png,jpg}`) as a RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  let inClass = false
  let inBrace = false
  for (const ch of glob) {
    if (inClass) {
      re += ch === ']' ? ']' : ch === '\\' ? '\\\\' : ch
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else if (ch === '[') {
      re += '['
      inClass = true
    } else if (ch === '{') {
      re += '(?:'
      inBrace = true
    } else if (ch === '}' && inBrace) {
      re += ')'
      inBrace = false
    } else if (ch === ',' && inBrace) re += '|'
    else re += ch.replace(/[.+^$()|\\/]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** Python's `(?P<name>…)` is the common spelling in the wild; JS wants `(?<name>…)`. */
export function compilePattern(pattern: string): RegExp {
  return new RegExp(pattern.replace(/\(\?P</g, '(?<'), 'gm')
}

/** "1,234" → 1234 · "3.1 GB" → 3.1e9 · "512MiB" → 536870912. NaN when not a number. */
export function quantity(text: string | undefined): number {
  if (text === undefined) return NaN
  const m = /^\s*([0-9][0-9,_' ]*(?:\.[0-9]+)?|\.[0-9]+)\s*(?:([kKmMgGtTpP])(i)?)?[bB]?\s*$/.exec(text)
  if (!m) return NaN
  const n = Number(m[1]!.replace(/[,_' ]/g, ''))
  if (!m[2]) return n
  const exp = 'kmgtp'.indexOf(m[2].toLowerCase()) + 1
  return n * (m[3] ? 1024 : 1000) ** exp
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : typeof v === 'string' && quantity(v) > 0 ? quantity(v) : undefined

/** Parse watchers.json. Bad entries are skipped and reported, never fatal. */
export function parseWatchers(text: string): { watchers: Watcher[]; errors: string[] } {
  const errors: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { watchers: [], errors: [`watchers.json is not valid JSON: ${(err as Error).message}`] }
  }
  const list = Array.isArray(raw) ? raw : (raw as { watchers?: unknown })?.watchers
  if (!Array.isArray(list)) return { watchers: [], errors: ['watchers.json: expected {"watchers": [...]}'] }

  const watchers: Watcher[] = []
  const seen = new Set<string>()
  list.forEach((entry, i) => {
    const where = `watcher #${i + 1}`
    if (!entry || typeof entry !== 'object') return void errors.push(`${where}: not an object`)
    const o = entry as Record<string, unknown>
    if (o.enabled === false) return
    const type = o.type as WatcherType
    if (!TYPES.includes(type)) return void errors.push(`${where}: type must be one of ${TYPES.join(', ')}`)
    if (typeof o.path !== 'string' || !o.path) return void errors.push(`${where}: path is missing`)
    const base = o.path.replace(/\/+$/, '').split('/').pop() ?? type
    const id = typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[._-]+/, '') || type
    if (seen.has(id)) return void errors.push(`${where}: duplicate id "${id}"`)

    const w: Watcher = {
      id,
      type,
      label: sanitize(o.label, 40) ?? id,
      path: o.path,
      unit: sanitize(o.unit, 16) ?? (type === 'filesize' ? 'bytes' : type === 'dircount' ? 'files' : 'items'),
      total: num(o.total) ?? null,
      activeWithin: num(o.active_within) ?? DEFAULT_ACTIVE_WITHIN,
    }
    const icon = sanitize(o.icon, 2)
    if (icon) w.icon = icon

    if (type === 'filesize') {
      const size = num(o.total_bytes) ?? num(o.total)
      w.unit = 'bytes'
      w.total = size ?? null
    }
    if (type === 'logtail') {
      if (typeof o.pattern !== 'string') return void errors.push(`${where}: logtail needs a pattern`)
      try {
        w.pattern = compilePattern(o.pattern)
      } catch (err) {
        return void errors.push(`${where}: bad pattern: ${(err as Error).message}`)
      }
      if (!/\(\?P?<done>/.test(o.pattern)) return void errors.push(`${where}: the pattern needs a (?<done>…) group`)
      const bt = num(o.total_bytes)
      if (bt) w.bytesTotal = bt
    }
    if (type === 'dircount') w.glob = globToRegExp(typeof o.glob === 'string' && o.glob ? o.glob : '*')

    seen.add(id)
    watchers.push(w)
  })
  return { watchers, errors }
}

/** The last match of a logtail pattern in a chunk of log. null when nothing matched. */
export function readLog(w: Watcher, text: string): Omit<Reading, 'mtimeMs'> | null {
  if (!w.pattern) return null
  w.pattern.lastIndex = 0
  let last: RegExpExecArray | null = null
  for (let m = w.pattern.exec(text); m; m = w.pattern.exec(text)) {
    if (m[0] === '') w.pattern.lastIndex += 1
    last = m
  }
  const g = last?.groups
  if (!g) return null
  const done = quantity(g.done)
  if (!Number.isFinite(done)) return null
  const reading: Omit<Reading, 'mtimeMs'> = { done }
  const total = quantity(g.total)
  if (total > 0) reading.total = total
  const b = quantity(g.bytes)
  if (b >= 0) reading.bytes = b
  const bt = quantity(g.bytes_total)
  if (bt > 0) reading.bytesTotal = bt
  const msg = sanitize(g.message, 200)
  if (msg) reading.message = msg
  return reading
}

/** Count the names in a directory listing that match a dircount watcher. */
export function countMatches(w: Watcher, entries: readonly { name: string; kind: string }[]): number {
  const glob = w.glob ?? /^/
  return entries.filter(e => e.kind !== 'dir' && !e.name.startsWith('.') && glob.test(e.name)).length
}

/**
 * The task a reading stands for, or null when the source is idle (not
 * modified within `activeWithin`) — an old log of a finished job stays out.
 * @param firstSeen when the watcher first saw this source active (its "start")
 */
export function watcherTask(w: Watcher, r: Reading, now: number, firstSeen: number, path: string): Task | null {
  if (now - r.mtimeMs > w.activeWithin * 1000) return null
  const total = r.total ?? w.total
  const task: Task = {
    id: `watch.${w.id}`,
    label: w.label,
    done: r.done,
    total: total && total > 0 ? total : null,
    unit: w.unit,
    status: total && total > 0 && r.done >= total ? 'done' : 'running',
    updatedAt: r.mtimeMs,
    startedAt: Math.min(firstSeen, r.mtimeMs),
    source: 'watcher',
    path,
  }
  if (w.icon) task.icon = w.icon
  if (r.bytes !== undefined) task.bytes = r.bytes
  const bt = r.bytesTotal ?? w.bytesTotal
  if (bt) task.bytesTotal = bt
  if (r.message) task.message = r.message
  return task
}
