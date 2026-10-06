/**
 * The finish: when a bar fills, it bursts into sparks, a shock ring runs out,
 * a check mark draws itself and CHECK!! drops in letter by letter, a light
 * sweeps across, embers rise, and the whole thing dissolves. Pure.
 *
 * Drawn on a pixel canvas twice as tall as the band's rows: each cell shows
 * two pixels with a half block (top pixel as foreground, bottom as background),
 * so motion is smooth vertically too. Light adds up (sparks crossing glow
 * brighter), a pixel too dark to see stays the terminal's own background — the
 * band must stay see-through on a translucent terminal.
 *
 * Every frame is a function of `t` alone (positions are integrated in closed
 * form), so any moment renders exactly, in a test or a screenshot.
 */

/** How long the whole show runs, ms. */
export const CELEBRATE_MS = 2800
/** Frames per second the mod repaints at while it runs. */
export const CELEBRATE_FPS = 30

/** A cell's colour meaning "the terminal's own" (bit 24 alone). */
export const DEFAULT_COLOR = 0x01000000
const SPACE = 0x20
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const FULL = 0x2588 // █

type RGB = readonly [number, number, number]

const hex = (h: string): RGB => {
  const n = parseInt(h.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
const WHITE: RGB = [1, 1, 1]
const HOT: RGB = hex('#fff1c2')
const GREEN: RGB = hex('#3fb950')
const GREEN_HI: RGB = hex('#7ee787')
const GREEN_DEEP: RGB = hex('#196c2e')
const SHADOW: RGB = hex('#0b3d1a')
const GOLD: RGB = hex('#ffd36b')

/** Below this (brightest channel) a pixel is not drawn at all. */
const VISIBLE = 0.07

// --- the CHECK!! font: 7 rows, bold, proportional ------------------------------------------

const GLYPHS: Record<string, readonly string[]> = {
  C: ['.###.', '##.##', '##...', '##...', '##...', '##.##', '.###.'],
  H: ['##.##', '##.##', '##.##', '#####', '##.##', '##.##', '##.##'],
  E: ['#####', '##...', '##...', '####.', '##...', '##...', '#####'],
  K: ['##..#', '##.##', '####.', '###..', '####.', '##.##', '##..#'],
  '!': ['##', '##', '##', '##', '##', '..', '##'],
}
export const WORD = 'CHECK!!'
const GLYPH_H = 7

// --- deterministic randomness --------------------------------------------------------------

/** mulberry32: a small, good, seedable PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A stable 32-bit seed from a string (FNV-1a). */
export function seedOf(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

// --- easing --------------------------------------------------------------------------------

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3
const easeInOut = (x: number) => {
  const v = clamp01(x)
  return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2
}
const backOut = (x: number) => {
  const v = clamp01(x)
  const c = 1.9
  return 1 + (c + 1) * (v - 1) ** 3 + c * (v - 1) ** 2
}
const mix = (a: RGB, b: RGB, f: number): RGB => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]

/** 4×4 Bayer thresholds, 0..1: an ordered dissolve instead of a hard cut. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16)

// --- the scene -----------------------------------------------------------------------------

type Particle = {
  x0: number
  y0: number
  vx: number
  vy: number
  born: number
  life: number
  size: number
  twinkle: number
  ember: boolean
}

export type Scene = {
  /** cells */
  cols: number
  rows: number
  /** pixels: cols × rows*2 */
  w: number
  h: number
  /** font pixel size in canvas pixels: 2 (large) or 1 (compact) */
  scale: 1 | 2
  color: boolean
  accent: RGB
  /** where the bar was, in canvas pixels, on the bottom pixel row */
  barX0: number
  barX1: number
  /** the check mark: three points in canvas pixels, and its stroke width */
  check: readonly [readonly [number, number], readonly [number, number], readonly [number, number]]
  stroke: number
  /** text origin (top-left), canvas pixels */
  textX: number
  textY: number
  particles: Particle[]
}

/** Width in font pixels of the word, letters 1 apart. */
function wordWidth(): number {
  let w = 0
  for (const ch of WORD) w += GLYPHS[ch]![0]!.length + 1
  return w - 1
}

/** The size the show needs: [columns, rows] for each scale. */
export function needs(scale: 1 | 2): { cols: number; rows: number } {
  const textW = wordWidth() * scale
  const checkH = GLYPH_H * scale + 2 * scale
  const checkW = Math.round(checkH * 1.25)
  return { cols: checkW + 4 * scale + textW + 6, rows: Math.ceil((checkH + 2) / 2) + 2 }
}

/**
 * Lay the show out in a band of `cols` × `rows` cells, or null when even the
 * compact one does not fit (the caller falls back to one line of text).
 * @param bar the bar's columns in the row beneath, [from, to)
 */
export function planScene(opts: {
  cols: number
  rows: number
  seed: number
  color: boolean
  accent?: string
  bar?: readonly [number, number]
}): Scene | null {
  const { cols, rows } = opts
  const scale: 1 | 2 | null = cols >= needs(2).cols && rows >= needs(2).rows ? 2 : cols >= needs(1).cols && rows >= needs(1).rows ? 1 : null
  if (scale === null) return null
  const w = cols
  const h = rows * 2
  const textW = wordWidth() * scale
  const checkH = GLYPH_H * scale + 2 * scale
  const checkW = Math.round(checkH * 1.25)
  const gap = 4 * scale
  const total = checkW + gap + textW
  const left = Math.floor((w - total) / 2)
  const bottom = h - 2 // a pixel row of air above the task row beneath
  const top = bottom - checkH
  const stroke = scale === 2 ? 2.6 : 1.7
  const check = [
    [left + checkW * 0.04, top + checkH * 0.56],
    [left + checkW * 0.36, top + checkH * 0.92],
    [left + checkW * 0.97, top + checkH * 0.06],
  ] as const
  const textY = bottom - GLYPH_H * scale - Math.round(scale / 2)

  const bar0 = Math.max(0, Math.min(w - 2, opts.bar?.[0] ?? left))
  const bar1 = Math.max(bar0 + 2, Math.min(w, opts.bar?.[1] ?? left + 20))

  const rand = rng(opts.seed)
  const particles: Particle[] = []
  // the burst: out of the bar, mostly up and out, a fountain more than a sphere
  const n = Math.max(70, Math.min(260, (bar1 - bar0) * 9))
  const mid = (bar0 + bar1) / 2
  for (let i = 0; i < n; i++) {
    const x0 = bar0 + rand() * (bar1 - bar0)
    const out = (x0 - mid) / Math.max(1, (bar1 - bar0) / 2) // -1 … 1 along the bar
    const ang = -Math.PI / 2 + out * 0.9 + (rand() - 0.5) * 1.9
    const speed = (24 + rand() ** 0.6 * 72) * (scale === 2 ? 1.15 : 0.9)
    particles.push({
      x0,
      y0: h - 1,
      vx: Math.cos(ang) * speed * 1.7, // cells are tall: stretch sideways so the cloud reads round
      vy: Math.sin(ang) * speed,
      born: 40 + rand() * 120,
      life: 520 + rand() * 900,
      size: rand() < 0.14 ? 1.6 : 1,
      twinkle: rand() < 0.3 ? rand() * 6.28 : -1,
      ember: false,
    })
  }
  // embers: slow sparks rising off the word while it holds
  for (let i = 0; i < 34; i++) {
    particles.push({
      x0: left + rand() * total,
      y0: top + rand() * checkH,
      vx: (rand() - 0.5) * 10,
      vy: -(6 + rand() * 14),
      born: 950 + rand() * 1100,
      life: 600 + rand() * 700,
      size: 1,
      twinkle: rand() * 6.28,
      ember: true,
    })
  }
  return {
    cols,
    rows,
    w,
    h,
    scale,
    color: opts.color,
    accent: hex(opts.accent ?? '#79c0ff'),
    barX0: bar0,
    barX1: bar1,
    check,
    stroke,
    textX: left + checkW + gap,
    textY,
    particles,
  }
}

// --- drawing -------------------------------------------------------------------------------

/** Light on the canvas: additive, so crossings glow. */
class Canvas {
  readonly px: Float32Array
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = new Float32Array(w * h * 3)
  }
  add(x: number, y: number, c: RGB, k: number): void {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h || k <= 0) return
    const i = (yi * this.w + xi) * 3
    this.px[i] = this.px[i]! + c[0] * k
    this.px[i + 1] = this.px[i + 1]! + c[1] * k
    this.px[i + 2] = this.px[i + 2]! + c[2] * k
  }
  /** a soft dot of radius r, spread over the pixels it covers */
  dot(x: number, y: number, r: number, c: RGB, k: number): void {
    if (r <= 1) {
      this.add(x, y, c, k)
      return
    }
    const R = Math.ceil(r)
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy)
        if (d <= r) this.add(x + dx, y + dy, c, k * (1 - d / (r + 0.6)))
      }
  }
}

/** Distance from p to segment ab. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 ? clamp01(((px - ax) * dx + (py - ay) * dy) / l2) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** The check mark drawn up to `p` (0..1 of its length): [segments to measure against]. */
function checkPath(s: Scene, p: number): { segs: [number, number, number, number][]; tip: [number, number] | null } {
  const [a, b, c] = s.check
  const l1 = Math.hypot(b[0] - a[0], b[1] - a[1])
  const l2 = Math.hypot(c[0] - b[0], c[1] - b[1])
  const d = clamp01(p) * (l1 + l2)
  if (d <= 0) return { segs: [], tip: null }
  if (d <= l1) {
    const f = d / l1
    const tip: [number, number] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
    return { segs: [[a[0], a[1], tip[0], tip[1]]], tip }
  }
  const f = (d - l1) / l2
  const tip: [number, number] = [b[0] + (c[0] - b[0]) * f, b[1] + (c[1] - b[1]) * f]
  return { segs: [[a[0], a[1], b[0], b[1]], [b[0], b[1], tip[0], tip[1]]], tip: p >= 1 ? null : tip }
}

// the timeline, ms
const T = {
  flash: [0, 160],
  ring: [70, 720],
  check: [360, 820],
  text: 600, // first letter; then one every `letter`
  letter: 55,
  pop: 200,
  sweep: [1180, 1820],
  fade: [2050, CELEBRATE_MS],
} as const

/** 0..1: how much of the logo is left during the fade. */
export function fadeLeft(t: number): number {
  return 1 - easeInOut((t - T.fade[0]) / (T.fade[1] - T.fade[0]))
}

/** Paint the scene at `t` ms into a fresh canvas. */
function paint(s: Scene, t: number): { canvas: Canvas; logo: Uint8Array } {
  const cv = new Canvas(s.w, s.h)
  /** which pixels belong to the check and the word: they dissolve, sparks just dim */
  const logo = new Uint8Array(s.w * s.h)
  const fade = fadeLeft(t)

  // 1. the bar, white-hot for a moment, then gone into its sparks
  if (t < T.flash[1]) {
    const f = t / T.flash[1]
    const k = 1.5 * (1 - f) ** 1.5
    const c = mix(s.accent, WHITE, 0.7)
    for (let x = s.barX0; x < s.barX1; x++) {
      cv.add(x, s.h - 1, c, k)
      cv.add(x, s.h - 2, c, k * 0.35 * (1 - f))
    }
  }

  // 2. the shock ring out of the bar's middle
  if (t >= T.ring[0] && t < T.ring[1]) {
    const f = (t - T.ring[0]) / (T.ring[1] - T.ring[0])
    const cx = (s.barX0 + s.barX1) / 2
    const cy = s.h - 1
    const rx = 6 + easeOut(f) * s.w * 0.55
    const ry = rx * 0.5
    const k = 0.75 * (1 - f) ** 2
    const c = mix(s.accent, WHITE, 0.5)
    const y0 = Math.max(0, Math.floor(cy - ry - 2))
    for (let y = y0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        const d = Math.hypot((x - cx) / rx, (y - cy) / ry)
        const off = (d - 1) * rx
        if (off > -3 && off < 3) cv.add(x, y, c, k * Math.exp(-(off * off) / 1.3))
      }
  }

  // 3. the check mark draws itself, a pen of light at its tip
  const cp = (t - T.check[0]) / (T.check[1] - T.check[0])
  if (cp > 0 && fade > 0) {
    const { segs, tip } = checkPath(s, easeInOut(cp))
    const r = s.stroke / 2
    const [minY, maxY] = [Math.min(...s.check.map(p => p[1])) - 3, Math.max(...s.check.map(p => p[1])) + 3]
    const [minX, maxX] = [Math.min(...s.check.map(p => p[0])) - 3, Math.max(...s.check.map(p => p[0])) + 3]
    const settle = clamp01((t - T.check[1]) / 300)
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(s.h - 1, Math.ceil(maxY)); y++)
      for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(s.w - 1, Math.ceil(maxX)); x++) {
        let d = Infinity
        let ds = Infinity
        for (const g of segs) {
          d = Math.min(d, segDist(x, y, g[0], g[1], g[2], g[3]))
          ds = Math.min(ds, segDist(x - 1, y - 1, g[0], g[1], g[2], g[3]))
        }
        const cover = clamp01(r + 0.5 - d)
        const shadow = clamp01(r + 0.5 - ds)
        if (shadow > 0 && cover === 0) cv.add(x, y, SHADOW, shadow * 1.4)
        if (cover > 0) {
          // lit from above: lighter at the top of the stroke, freshly drawn parts glow white
          const v = 1 - (y - minY) / (maxY - minY)
          const base = mix(GREEN, GREEN_HI, v * 0.8)
          cv.add(x, y, mix(WHITE, base, 0.35 + 0.65 * settle), cover * (1.05 + 0.5 * (1 - settle)))
          logo[y * s.w + x] = 1
        }
      }
    if (tip) cv.dot(tip[0], tip[1], s.stroke + 0.8, WHITE, 1.6)
  }

  // 4. CHECK!! drops in, letter by letter, white first, then green
  let gx = s.textX
  const shade: number[] = []
  let i = 0
  for (const ch of WORD) {
    const g = GLYPHS[ch]!
    const born = T.text + i * T.letter
    const f = (t - born) / T.pop
    if (f > 0 && fade > 0) {
      const dy = Math.round((1 - backOut(f)) * -3 * s.scale)
      const heat = 1 - easeOut(f)
      for (let row = 0; row < g.length; row++)
        for (let col = 0; col < g[row]!.length; col++) {
          if (g[row]![col] !== '#') continue
          for (let sy = 0; sy < s.scale; sy++)
            for (let sx = 0; sx < s.scale; sx++) {
              const x = gx + col * s.scale + sx
              const y = s.textY + row * s.scale + sy + dy
              const v = 1 - (row * s.scale + sy) / (GLYPH_H * s.scale)
              const base = mix(GREEN_DEEP, GREEN_HI, 0.35 + 0.65 * v)
              cv.add(x, y, mix(base, WHITE, heat * 0.85), 1 + heat * 0.6)
              if (x >= 0 && y >= 0 && x < s.w && y < s.h) {
                logo[y * s.w + x] = 1
                shade.push(x + 1, y + 1)
              }
            }
        }
    }
    gx += (g[0]!.length + 1) * s.scale
    i++
  }

  // the word's drop shadow falls only where no letter is: on a letter it would light it up in stripes
  for (let j = 0; j < shade.length; j += 2) {
    const x = shade[j]!
    const y = shade[j + 1]!
    if (x < s.w && y < s.h && !logo[y * s.w + x]) cv.add(x, y, SHADOW, 1.3 / s.scale)
  }

  // 5. a sweep of light across the logo
  if (t >= T.sweep[0] && t < T.sweep[1]) {
    const f = easeInOut((t - T.sweep[0]) / (T.sweep[1] - T.sweep[0]))
    const pos = -12 + f * (s.w + 24)
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        if (!logo[y * s.w + x]) continue
        const d = (x + 0.6 * y - pos) / 2.6
        cv.add(x, y, WHITE, 0.95 * Math.exp(-d * d))
      }
  }

  // 6. sparks and embers
  const k = 2.1 // drag, 1/s
  const g = 60 // gravity, px/s²
  for (const p of s.particles) {
    const age = t - p.born
    if (age < 0 || age > p.life) continue
    const a = age / p.life
    const bright = (1 - a) ** 1.4
    let c: RGB
    if (p.ember) c = mix(GOLD, GREEN_HI, a)
    else c = a < 0.18 ? mix(HOT, s.accent, a / 0.18) : a < 0.55 ? mix(s.accent, GREEN_HI, (a - 0.18) / 0.37) : mix(GREEN_HI, GREEN_DEEP, (a - 0.55) / 0.45)
    const tw = p.twinkle < 0 ? 1 : 0.55 + 0.45 * Math.sin(age / 38 + p.twinkle)
    // the trail: the same spark a moment ago, dimmer
    for (const [lag, dim] of [
      [0, 1],
      [14, 0.45],
      [28, 0.2],
    ] as const) {
      const tau = Math.max(0, age - lag) / 1000
      const e = 1 - Math.exp(-k * tau)
      const x = p.x0 + (p.vx / k) * e
      const y = p.y0 + (p.vy / k) * e + (g / k) * (tau - e / k)
      const kk = bright * tw * dim * (p.ember ? 0.6 : 1.25)
      if (p.size > 1 && lag === 0) cv.dot(x, y, p.size, c, kk)
      else cv.add(x, y, c, kk)
    }
  }

  // the fade dims the sparks; the logo dissolves in an ordered pattern
  if (fade < 1)
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        const i3 = (y * s.w + x) * 3
        const keep = logo[y * s.w + x] ? (fade > BAYER[(y & 3) * 4 + (x & 3)]! ? 0.55 + 0.45 * fade : 0) : fade
        cv.px[i3]! *= keep
        cv.px[i3 + 1]! *= keep
        cv.px[i3 + 2]! *= keep
      }
  return { canvas: cv, logo }
}

const rgb24 = (r: number, g: number, b: number) => (Math.round(clamp01(r) * 255) << 16) | (Math.round(clamp01(g) * 255) << 8) | Math.round(clamp01(b) * 255)

/**
 * The cells at `t`: `cols * rows` triplets [codePoint, foreground, background],
 * as a Raster takes them. Nothing to see after CELEBRATE_MS: all blank.
 */
export function frame(s: Scene, t: number): Uint32Array {
  const out = new Uint32Array(s.cols * s.rows * 3)
  const { canvas } = paint(s, t)
  const px = canvas.px
  const pixel = (x: number, y: number): number | null => {
    const i = (y * s.w + x) * 3
    const r = px[i]!
    const g = px[i + 1]!
    const b = px[i + 2]!
    if (Math.max(r, g, b) < VISIBLE) return null
    return s.color ? rgb24(r, g, b) : DEFAULT_COLOR
  }
  for (let row = 0; row < s.rows; row++)
    for (let x = 0; x < s.cols; x++) {
      const top = pixel(x, row * 2)
      const bot = pixel(x, row * 2 + 1)
      const o = (row * s.cols + x) * 3
      if (top === null && bot === null) out.set([SPACE, DEFAULT_COLOR, DEFAULT_COLOR], o)
      else if (bot === null) out.set([UPPER, top!, DEFAULT_COLOR], o)
      else if (top === null) out.set([LOWER, bot, DEFAULT_COLOR], o)
      else if (!s.color) out.set([FULL, DEFAULT_COLOR, DEFAULT_COLOR], o)
      else out.set([UPPER, top, bot], o)
    }
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Cells → the Raster's `cells`: padded base64 of little-endian u32s. */
export function encodeCells(words: Uint32Array): string {
  const bytes = new Uint8Array(words.length * 4)
  for (let i = 0; i < words.length; i++) {
    const v = words[i]!
    bytes[i * 4] = v & 255
    bytes[i * 4 + 1] = (v >>> 8) & 255
    bytes[i * 4 + 2] = (v >>> 16) & 255
    bytes[i * 4 + 3] = (v >>> 24) & 255
  }
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += `${B64[n >> 18]}${B64[(n >> 12) & 63]}==`
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += `${B64[n >> 18]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`
  }
  return out
}
