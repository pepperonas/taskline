/**
 * Renders the README images from the mod's own layout code (hooks/layout.ts),
 * so every picture shows exactly what the band draws — no mock-ups.
 *
 *   npm run screenshots        # docs/hero.png, states, widths, celebrate (+ .gif with ffmpeg), social
 *
 * Uses Playwright with the installed Google Chrome (or Playwright's Chromium).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

import { CELEBRATE_MS, DEFAULT_COLOR, frame as celebration, needs, planScene } from '../hooks/celebrate.ts'
import type { Scene } from '../hooks/celebrate.ts'
import { PALETTE, barColumns, layoutRows } from '../hooks/layout.ts'
import type { Row, Seg, TaskView } from '../hooks/layout.ts'
import type { Task } from '../types/index.d.ts'

const ROOT = resolve(import.meta.dirname, '..')
const DOCS = join(ROOT, 'docs')
const TMP = join(DOCS, '.render')
const NOW = new Date(2026, 9, 5, 14, 17, 0).getTime()

const task = (over: Partial<Task>): Task => ({
  id: 'x', label: 'x', done: 0, total: 100, unit: 'files', status: 'running', updatedAt: NOW - 400, startedAt: NOW - 300_000, source: 'file', ...over,
})
const view = (over: Partial<Task>, extra: Partial<TaskView> = {}): TaskView => ({
  task: task(over), phase: 'running', speed: null, bytesSpeed: null, eta: null, ...extra,
})

const BRIDGE = view(
  { id: 'bridge', label: 'Bridge', icon: '⬇', done: 275, total: 1000, unit: 'files', bytes: 3.1e9 },
  { speed: 3.4, bytesSpeed: 38.2e6, eta: 80 },
)
const TILES = view({ id: 'tiles', label: 'Tiles', icon: '⬇', done: 412, total: 3400, updatedAt: NOW - 135_000 }, { phase: 'stalled' })
const INDEX = view({ id: 'index', label: 'Index', icon: '🔍', done: 18_342, total: null, unit: 'items' }, { speed: 212 })
const STATES: [string, TaskView][] = [
  ['running · bytes beside files', BRIDGE],
  ['running · byte unit', view({ id: 'iso', label: 'ubuntu.iso', icon: '⬇', done: 1.24e9, total: 6.1e9, unit: 'bytes' }, { speed: 41e6, eta: 118 })],
  ['unknown total', INDEX],
  ['stalled', TILES],
  ['aborted (process gone)', view({ id: 'render', label: 'Render', done: 61, total: 240, pid: 4242 }, { phase: 'aborted' })],
  ['error', view({ id: 'sync', label: 'Sync', status: 'error', message: 'HTTP 503 from tile server' }, { phase: 'error' })],
  ['done', view({ id: 'thumbs', label: 'Thumbs', icon: '🖼', done: 5000, total: 5000, status: 'done', startedAt: NOW - 252_000 }, { phase: 'done' })],
]

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const span = (s: Seg) => `<span style="${s.color ? `color:${s.color};` : ''}${s.dim ? 'opacity:.5;' : ''}${s.bold ? 'font-weight:700;' : ''}">${esc(s.text)}</span>`
const line = (row: Row) => `<div class="row">${row.map(span).join('')}</div>`
const rows = (views: TaskView[], width: number, layout: 'auto' | 'single' | 'stacked' = 'auto') =>
  layoutRows(views, { width, layout, maxTasks: 3, maxRows: 6, nowMs: NOW, color: true }).map(line).join('')

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:transparent;font-family:"SF Mono",Menlo,"JetBrains Mono",monospace;font-size:15px;color:#e6edf3;padding:24px;display:inline-block}
.term{background:#0d1117;border:1px solid #30363d;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.45);overflow:hidden}
.bar{height:34px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;padding:0 14px;gap:8px}
.dot{width:12px;height:12px;border-radius:50%}
.title{flex:1;text-align:center;color:#8b949e;font-size:13px;margin-right:52px}
.body{padding:18px 22px;line-height:1.55}
.row{white-space:pre;height:1.55em}
.dim{opacity:.5}.acc{color:#d2a8ff}.ok{color:#7ee787}
.box{border:1px solid #484f58;border-radius:6px;padding:4px 10px;margin:6px 0 2px;white-space:pre}
.cap{color:#8b949e;font-size:12.5px;padding:10px 0 4px 2px;font-family:-apple-system,"Segoe UI",sans-serif}
.cap:first-child{padding-top:0}
.grid{display:grid;grid-template-columns:auto 1fr;column-gap:24px;align-items:center}
.grid .cap{padding:0}
.cells{display:flex}.cells i{display:block;width:1ch;height:1.55em;flex:none}
`

const frame = (title: string, body: string, cols: number) => `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="term" style="width:calc(${cols}ch + 46px)"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">${esc(title)}</span></div>
<div class="body">${body}</div></div>`

// --- the finish: the Raster's own cells, each drawn as two exact half-cell pixels ------------

const FINISHED = view(
  { id: 'bridge', label: 'Bridge', icon: '⬇', done: 20, total: 20, unit: 'songs', status: 'done', startedAt: NOW - 192_000, updatedAt: NOW },
  { phase: 'done' },
)
const CEL_COLS = 120
const CEL_SCENE: Scene = planScene({ cols: CEL_COLS, rows: needs(2).rows + 1, seed: 20261006, color: true, accent: PALETTE.accent, bar: barColumns(FINISHED.task) })!
const css = (c: number) => (c === DEFAULT_COLOR ? 'transparent' : `#${c.toString(16).padStart(6, '0')}`)
function raster(s: Scene, t: number): string {
  const f = celebration(s, t)
  let html = ''
  for (let r = 0; r < s.rows; r++) {
    html += '<div class="row cells">'
    for (let c = 0; c < s.cols; c++) {
      const o = (r * s.cols + c) * 3
      const ch = f[o]!
      const fg = css(f[o + 1]!)
      const fill = fg === 'transparent' ? '#e6edf3' : fg
      const top = ch === 0x2580 || ch === 0x2588 ? fill : 'transparent'
      const bot = ch === 0x2584 || ch === 0x2588 ? fill : ch === 0x2580 ? css(f[o + 2]!) : 'transparent'
      html += ch === 0x20 ? '<i></i>' : `<i style="background:linear-gradient(${top} 0 50%,${bot} 50% 100%)"></i>`
    }
    html += '</div>'
  }
  return html
}
const finishBody = (t: number) => `<div class="row"><span class="acc">⏺</span> Downloading and importing the 20 songs</div>
${raster(CEL_SCENE, t)}${rows([FINISHED], CEL_COLS)}
<div class="box">&gt; <span class="dim"> </span></div>`
const CEL_MOMENTS: [number, string][] = [
  [140, 'the bar bursts'],
  [330, 'sparks and a shock ring'],
  [720, 'the check draws itself'],
  [1480, 'CHECK!! — a light sweeps across'],
]

const PAGES: Record<string, string> = {
  hero: frame(
    'claude — ~/projects/gta2d',
    `<div class="row"><span class="acc">⏺</span> Started the bridge fetch in the background; it reports to taskline.</div>
<div class="row"><span class="dim">  ⎿  python fetch.py --all &amp;</span></div>
<div class="row"> </div>
${rows([TILES, BRIDGE, INDEX], 132)}
<div class="box">&gt; <span class="dim">check the tiles job — it looks stuck</span></div>
<div class="row dim">  ⏵⏵ accept edits on · 1 background task</div>`,
    132,
  ),
  states: frame('taskline — every state', STATES.map(([cap, v]) => `<div class="grid"><div class="cap" style="width:24ch">${cap}</div>${rows([v], 92, 'stacked')}</div>`).join(''), 120),
  celebrate: frame(
    'taskline — when a bar fills',
    CEL_MOMENTS.map(([t, cap]) => `<div class="cap">${t} ms · ${cap}</div>${raster(CEL_SCENE, t)}${rows([FINISHED], CEL_COLS)}`).join(''),
    CEL_COLS,
  ),
  widths: frame(
    'taskline — the same three jobs at four widths',
    [140, 100, 72, 44].map(w => `<div class="cap">${w} columns</div><div style="width:${w}ch;border-right:1px dashed #30363d">${rows([TILES, BRIDGE, INDEX], w)}</div>`).join(''),
    140,
  ),
}

/** The 1280×640 card for GitHub's social preview and the top of the README. */
const SOCIAL = `<!doctype html><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:1280px;height:640px;overflow:hidden;font-family:-apple-system,"SF Pro Display","Segoe UI",sans-serif;color:#e6edf3;
background:radial-gradient(1200px 600px at 85% -10%,#12304d 0%,transparent 60%),radial-gradient(900px 500px at -10% 110%,#0f3326 0%,transparent 55%),#0b0e14}
.wrap{position:absolute;inset:0;padding:64px 72px;display:flex;flex-direction:column}
.kicker{font-size:22px;letter-spacing:.18em;text-transform:uppercase;color:#8b949e;font-weight:600}
h1{font-size:92px;line-height:1;margin:14px 0 10px;font-weight:800;letter-spacing:-.02em}
h1 span{background:linear-gradient(90deg,#79c0ff,#3fb950 55%,#d29922);-webkit-background-clip:text;background-clip:text;color:transparent}
p{font-size:30px;color:#c9d1d9;max-width:1000px;line-height:1.3}
.term{margin-top:auto;background:#0d1117ee;border:1px solid #30363d;border-radius:14px;padding:20px 26px;font-family:"SF Mono",Menlo,monospace;font-size:21px;line-height:1.7;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.row{white-space:pre;height:1.7em}
.foot{position:absolute;right:72px;top:70px;font-size:20px;color:#8b949e;text-align:right;line-height:1.5}
.foot b{color:#e6edf3}
</style><body><div class="wrap">
<div class="kicker">Claude Code mod</div>
<h1>task<span>line</span></h1>
<p>Every long-running job, live above the prompt — bar, speed, ETA, and a loud warning when one stalls or dies.</p>
<div class="term">${rows([TILES, BRIDGE, INDEX], 90, 'stacked')}</div>
</div><div class="foot"><b>github.com/pepperonas/taskline</b><br>MIT · celox.io</div></body>`

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
  const page = await browser.newPage({ deviceScaleFactor: 2 })
  for (const [name, html] of Object.entries(PAGES)) {
    const file = join(TMP, `${name}.html`)
    writeFileSync(file, html)
    await page.goto(`file://${file}`)
    await page.locator('body').screenshot({ path: join(DOCS, `${name}.png`), omitBackground: true })
    console.log(`docs/${name}.png`)
  }
  await gif(browser)
  const icon = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
  await icon.goto(`file://${join(DOCS, 'icon.svg')}`)
  await icon.screenshot({ path: join(ROOT, '.claude-plugin', 'icon.png') })
  console.log('.claude-plugin/icon.png')
  const card = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 })
  const file = join(TMP, 'social.html')
  writeFileSync(file, SOCIAL)
  await card.goto(`file://${file}`)
  await card.screenshot({ path: join(DOCS, 'social.png') })
  console.log('docs/social.png')
  await browser.close()
  rmSync(TMP, { recursive: true, force: true })
}

/** docs/celebrate.gif: every frame of the finish at 30 fps, if ffmpeg is there. */
async function gif(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  } catch {
    console.log('docs/celebrate.gif skipped (no ffmpeg)')
    return
  }
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const dir = join(TMP, 'gif')
  mkdirSync(dir, { recursive: true })
  const times: number[] = []
  for (let t = -400; t <= CELEBRATE_MS + 500; t += 1000 / 30) times.push(Math.round(t))
  for (const [i, t] of times.entries()) {
    const file = join(dir, 'f.html')
    writeFileSync(file, frame('claude — ~/claude/beat-byte', t < 0 ? `<div class="row"><span class="acc">⏺</span> Downloading and importing the 20 songs</div>${'<div class="row"> </div>'.repeat(CEL_SCENE.rows)}${rows([{ ...FINISHED, task: { ...FINISHED.task, done: 19, status: 'running' }, phase: 'running', speed: 0.1, bytesSpeed: 9.6e6, eta: 8 }], CEL_COLS)}<div class="box">&gt; <span class="dim"> </span></div>` : finishBody(t), CEL_COLS))
    await page.goto(`file://${file}`)
    await page.locator('.term').screenshot({ path: join(dir, `f${String(i).padStart(3, '0')}.png`) })
  }
  const out = join(DOCS, 'celebrate.gif')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(dir, 'f%03d.png'),
    '-vf', 'split[a][b];[a]palettegen=max_colors=192:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a', '-loop', '0', out])
  console.log('docs/celebrate.gif')
}

void main()
