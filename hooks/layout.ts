/**
 * Turning tasks into rows of styled text that fit the band. Pure.
 *
 * Every task can be drawn at several detail levels, richest first. Fitting
 * walks down the levels — shorter bar, fewer extras, shorter label — and only
 * when even the leanest level does not fit are tasks folded into "+N more".
 */
import type { Layout, Task } from '../types'
import type { Phase } from './state'
import { age, amount, bar, bytes, cellWidth, count, duration, percent, rate, spinner, truncate } from './format'

export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean }
export type Row = Seg[]

export type TaskView = {
  task: Task
  phase: Phase
  /** units of the measured quantity per second, if known */
  speed: number | null
  /** bytes per second when bytes are counted beside another unit */
  bytesSpeed: number | null
  /** seconds left, if known */
  eta: number | null
}

export const PALETTE = {
  accent: '#79c0ff',
  ok: '#3fb950',
  warn: '#d29922',
  error: '#f85149',
} as const

type Level = {
  bar: number
  unitWord: boolean
  bytes: boolean
  rate: boolean
  eta: boolean
  labelMax: number
  pctOnly: boolean
}

export const LEVELS: readonly Level[] = [
  { bar: 20, unitWord: true, bytes: true, rate: true, eta: true, labelMax: 32, pctOnly: false },
  { bar: 12, unitWord: true, bytes: true, rate: true, eta: true, labelMax: 24, pctOnly: false },
  { bar: 10, unitWord: true, bytes: true, rate: false, eta: true, labelMax: 20, pctOnly: false },
  { bar: 8, unitWord: false, bytes: false, rate: false, eta: true, labelMax: 16, pctOnly: false },
  { bar: 6, unitWord: false, bytes: false, rate: false, eta: true, labelMax: 14, pctOnly: true },
  { bar: 4, unitWord: false, bytes: false, rate: false, eta: true, labelMax: 12, pctOnly: true },
  { bar: 0, unitWord: false, bytes: false, rate: false, eta: true, labelMax: 10, pctOnly: true },
  { bar: 0, unitWord: false, bytes: false, rate: false, eta: false, labelMax: 8, pctOnly: true },
  { bar: 0, unitWord: false, bytes: false, rate: false, eta: false, labelMax: 3, pctOnly: true },
]

/** Levels up to this one still count as "fits on one line" in auto layout. */
export const AUTO_SINGLE_MAX_LEVEL = 2
const SEP = ' │ '

export const rowWidth = (row: readonly Seg[]): number => row.reduce((w, s) => w + cellWidth(s.text), 0)

type Paint = (color: string) => string | undefined

function head(t: Task, lv: Level, paint: Paint, color?: string): Seg[] {
  const segs: Seg[] = []
  if (t.icon) segs.push({ text: `${t.icon} `, color: paint(color ?? PALETTE.accent) })
  const label = truncate(t.label, lv.labelMax)
  if (label) segs.push({ text: label, bold: true })
  return segs
}

function counter(t: Task, lv: Level): string {
  if (t.total === null) return `${amount(t.done, t.unit)}${lv.unitWord && t.unit !== 'bytes' ? ` ${t.unit}` : ''}`
  if (lv.pctOnly) return percent(t.done / t.total)
  const of = t.unit === 'bytes' ? `${bytes(t.done)}/${bytes(t.total)}` : `${count(t.done)}/${count(t.total)}`
  return `${of}${lv.unitWord && t.unit !== 'bytes' ? ` ${t.unit}` : ''}`
}

/** The secondary byte count: "3.1 GB" or "3.1/8.0 GB" style, only beside a non-byte unit. */
function byteNote(t: Task): string | null {
  if (t.bytes === undefined || t.unit === 'bytes') return null
  return t.bytesTotal ? `${bytes(t.bytes)}/${bytes(t.bytesTotal)}` : bytes(t.bytes)
}

function speedNote(v: TaskView): string | null {
  if (v.bytesSpeed && v.bytesSpeed > 0) return rate(v.bytesSpeed, 'bytes')
  if (v.speed && v.speed > 0) {
    const unit = v.task.bytesTotal && v.task.bytes !== undefined ? 'bytes' : v.task.unit
    return rate(v.speed, unit) || null
  }
  return null
}

const dot = (): Seg => ({ text: ' · ', dim: true })

/** One task at one detail level. */
export function taskSegs(v: TaskView, lv: Level, nowMs: number, color: boolean): Seg[] {
  const paint: Paint = c => (color ? c : undefined)
  const t = v.task
  const segs: Seg[] = []
  const sp = (): Seg => ({ text: ' ' })
  const extras = (list: (string | null | false | undefined)[], style: Partial<Seg> = { dim: true }) => {
    for (const text of list) if (text) segs.push(dot(), { text, ...style })
  }
  const label = head(t, lv, paint, v.phase === 'error' || v.phase === 'aborted' ? PALETTE.error : undefined)
  segs.push(...label)
  const gap = () => {
    if (label.length) segs.push(sp())
  }

  if (v.phase === 'error') {
    gap()
    segs.push({ text: '✖', color: paint(PALETTE.error), bold: true })
    if (lv.labelMax > 3) segs.push({ text: ` ${truncate(t.message ?? 'error', Math.max(8, lv.labelMax * 2))}`, color: paint(PALETTE.error) })
    return segs
  }
  if (v.phase === 'aborted') {
    gap()
    segs.push({ text: '✖ aborted', color: paint(PALETTE.error), bold: true })
    if (t.total !== null) extras([lv.labelMax > 3 && `at ${percent(t.done / t.total)}`])
    return segs
  }
  if (v.phase === 'done') {
    gap()
    segs.push({ text: '✔', color: paint(PALETTE.ok), bold: true })
    if (lv.labelMax > 3) {
      const done = t.total !== null && !lv.pctOnly ? counter({ ...t, done: Math.max(t.done, t.total) }, { ...lv, pctOnly: false }) : null
      if (done) segs.push({ text: ` ${done}`, color: paint(PALETTE.ok) })
      const took = t.startedAt && t.updatedAt > t.startedAt ? duration((t.updatedAt - t.startedAt) / 1000) : null
      if (took && lv.eta) segs.push({ text: ` in ${took}`, dim: true })
    }
    return segs
  }

  const stalled = v.phase === 'stalled'
  const tone = stalled ? PALETTE.warn : PALETTE.accent
  gap()
  if (t.total === null) {
    segs.push({ text: stalled ? '⏸' : spinner(nowMs), color: paint(tone) }, sp(), { text: counter(t, lv) })
  } else {
    if (lv.bar > 0) {
      const [filled, empty] = bar(t.done / t.total, lv.bar)
      if (filled) segs.push({ text: filled, color: paint(tone) })
      if (empty) segs.push({ text: empty, dim: true })
      segs.push(sp())
    }
    segs.push({ text: counter(t, lv) })
  }
  if (stalled) {
    segs.push(dot(), { text: `⏸ stalled ${age((nowMs - t.updatedAt) / 1000)}`, color: paint(PALETTE.warn) })
    return segs
  }
  extras([lv.bytes && byteNote(t), lv.rate && speedNote(v)])
  if (lv.eta && v.eta !== null && t.total !== null) extras([`ETA ${duration(v.eta)}`], {})
  return segs
}

/** The richest level of one task that fits `width`, or the leanest one cut to fit. */
export function fitTask(v: TaskView, width: number, nowMs: number, color: boolean): { segs: Seg[]; level: number } {
  for (let i = 0; i < LEVELS.length; i++) {
    const segs = taskSegs(v, LEVELS[i]!, nowMs, color)
    if (rowWidth(segs) <= width) return { segs, level: i }
  }
  return { segs: clip(taskSegs(v, LEVELS[LEVELS.length - 1]!, nowMs, color), width), level: LEVELS.length - 1 }
}

/** Cut a row to `width` cells; never wraps. */
export function clip(row: readonly Seg[], width: number): Seg[] {
  const out: Seg[] = []
  let left = width
  for (const s of row) {
    const w = cellWidth(s.text)
    if (w <= left) {
      out.push(s)
      left -= w
      continue
    }
    if (left > 0) out.push({ ...s, text: truncate(s.text, left) })
    break
  }
  return out
}

const more = (n: number): Seg => ({ text: `+${n} more`, dim: true })
const countMore = (row: Row): number => Number(/^\+(\d+) more$/.exec(row[row.length - 1]?.text ?? '')?.[1] ?? 0)

/** All tasks on one row at one shared level; null when they do not fit. */
function singleAt(views: readonly TaskView[], level: number, width: number, extra: number, nowMs: number, color: boolean): Row | null {
  const row: Row = []
  views.forEach((v, i) => {
    if (i > 0) row.push({ text: SEP, dim: true })
    row.push(...taskSegs(v, LEVELS[level]!, nowMs, color))
  })
  if (extra > 0) row.push({ text: SEP, dim: true }, more(extra))
  return rowWidth(row) <= width ? row : null
}

/** One row: richest shared level for as many tasks as fit, the rest as "+N more". */
export function single(
  views: readonly TaskView[],
  width: number,
  nowMs: number,
  color: boolean,
  maxLevel = LEVELS.length - 1,
  alsoHidden = 0,
): { row: Row; level: number } | null {
  for (let shown = views.length; shown >= 1; shown--) {
    for (let level = 0; level <= maxLevel; level++) {
      const row = singleAt(views.slice(0, shown), level, width, views.length - shown + alsoHidden, nowMs, color)
      if (row) return { row, level }
    }
  }
  return null
}

/**
 * The band: rows for the visible tasks (already sorted).
 * @param maxTasks how many tasks to draw at most; the rest fold into "+N more"
 * @param maxRows how many rows the band may take
 */
export function layoutRows(
  views: readonly TaskView[],
  opts: { width: number; layout: Layout; maxTasks: number; maxRows: number; nowMs: number; color: boolean },
): Row[] {
  const { width, nowMs, color } = opts
  if (views.length === 0 || width < 4) return []
  const cap = Math.max(1, opts.maxTasks)
  const capped = views.slice(0, cap)
  const hidden = views.length - capped.length

  const one = (maxLevel?: number): Row[] | null => {
    const fit = single(capped, width, nowMs, color, maxLevel, hidden)
    return fit ? [fit.row] : null
  }

  const rows = Math.max(1, opts.maxRows)
  if (opts.layout === 'single' || Math.min(rows, cap) === 1) return one() ?? [clip([more(views.length)], width)]
  if (opts.layout === 'auto' && capped.length > 1) {
    const fits = one(AUTO_SINGLE_MAX_LEVEL)
    const folded = fits?.[0]!.some(s => /^\+\d+ more$/.test(s.text))
    if (fits && (!folded || hidden > 0 && countMore(fits[0]!) === hidden)) return fits
  }

  // stacked: one task per row
  const overflow = views.length > Math.min(cap, rows)
  const n = overflow ? Math.min(cap, rows) - 1 : views.length
  const out: Row[] = views.slice(0, Math.max(0, n)).map(v => fitTask(v, width, nowMs, color).segs)
  if (overflow) out.push([more(views.length - n)])
  return out
}
