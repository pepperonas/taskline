/** Pure formatting: sizes, counts, durations, bars, and terminal cell widths. */

// --- cell widths ----------------------------------------------------------------

const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
]

function isWide(c: number): boolean {
  let lo = 0
  let hi = WIDE.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = WIDE[mid]!
    if (c < a) hi = mid - 1
    else if (c > b) lo = mid + 1
    else return true
  }
  return false
}

const ZERO = (c: number) =>
  c === 0x200d || c === 0xfe0e || (c >= 0x300 && c <= 0x36f) || (c >= 0x1f3fb && c <= 0x1f3ff) || (c >= 0xe0020 && c <= 0xe007f)

/** Width of a string in terminal cells (emoji and CJK count 2). */
export function cellWidth(s: string): number {
  let w = 0
  let prevNarrowSymbol = false
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c === 0xfe0f) {
      // VS16 turns a text-style symbol (⬇, ✔) into a two-cell emoji
      if (prevNarrowSymbol) w += 1
      prevNarrowSymbol = false
      continue
    }
    if (ZERO(c)) continue
    const wide = isWide(c)
    w += wide ? 2 : 1
    prevNarrowSymbol = !wide && c >= 0x2000
  }
  return w
}

/** Cut `s` to at most `max` cells, ending in `…` when cut. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return ''
  if (cellWidth(s) <= max) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = cellWidth(ch)
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

// --- numbers ----------------------------------------------------------------------

/** 1234567 → "1,234,567"; fractions to one decimal. */
export function count(n: number): string {
  if (!Number.isFinite(n)) return '?'
  const rounded = Math.abs(n) >= 100 || Number.isInteger(n) ? Math.round(n) : Math.round(n * 10) / 10
  const [int, frac] = String(Math.abs(rounded)).split('.')
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (rounded < 0 ? '-' : '') + grouped + (frac ? `.${frac}` : '')
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** Decimal (SI) sizes like Finder and most download tools: 3100000000 → "3.1 GB". */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  let i = 0
  let v = n
  while (v >= 1000 && i < SIZE_UNITS.length - 1) {
    v /= 1000
    i += 1
  }
  if (i === 0) return `${Math.round(v)} B`
  const text = v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(1)
  // 999.96 MB rounds to "1000 MB": carry into the next unit
  if (text === '1000' && i < SIZE_UNITS.length - 1) return `1.0 ${SIZE_UNITS[i + 1]}`
  return `${text} ${SIZE_UNITS[i]}`
}

/** A quantity in its unit: bytes as sizes, everything else as a count. */
export function amount(n: number, unit: string): string {
  return unit === 'bytes' ? bytes(n) : count(n)
}

/** Units per second, or per minute when slow. */
export function rate(perSecond: number, unit: string): string {
  if (!Number.isFinite(perSecond) || perSecond <= 0) return ''
  if (unit === 'bytes') return `${bytes(perSecond)}/s`
  if (perSecond >= 1) return `${count(perSecond >= 10 ? Math.round(perSecond) : Math.round(perSecond * 10) / 10)}/s`
  const perMinute = perSecond * 60
  if (perMinute >= 1) return `${count(Math.round(perMinute * 10) / 10)}/min`
  return `${count(Math.round(perMinute * 60 * 10) / 10)}/h`
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Seconds as a clock: 45 → "0:45", 80 → "1:20", 3723 → "1:02:03", from a day on "4d 3h". */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '?'
  const s = Math.round(seconds)
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`
}

/** An age in words for "stalled 2m": 45 → "45s", 130 → "2m", 7300 → "2h", 3 days → "3d". */
export function age(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Percent 0..100, one decimal under 10 % so early progress is visible. */
export function percent(fraction: number): string {
  const p = Math.max(0, Math.min(1, fraction)) * 100
  if (p > 0 && p < 10) return `${p.toFixed(1)}%`
  // never claim 100 % before it is
  return `${p >= 99.5 && p < 100 ? 99 : Math.round(p)}%`
}

// --- bars and spinners ------------------------------------------------------------------

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A bar of `width` cells with eighth-cell precision: [filled, empty]. */
export function bar(fraction: number, width: number): [string, string] {
  if (width <= 0) return ['', '']
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
  const eighths = Math.round(f * width * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8]!
  const filled = '█'.repeat(full) + part
  return [filled, '░'.repeat(width - full - (part ? 1 : 0))]
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** The spinner frame for a moment in time (8 frames per second). */
export function spinner(nowMs: number): string {
  return SPINNER[Math.floor(nowMs / 125) % SPINNER.length]!
}
