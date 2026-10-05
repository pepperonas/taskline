/**
 * Drift guards: they read a file and hold it to a fact, because what they
 * catch is silent — nothing crashes, the README just tells a stale story.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const README = read('README.md')
const manifest = JSON.parse(read('.claude-plugin/plugin.json'))
const market = JSON.parse(read('.claude-plugin/marketplace.json'))
const pkg = JSON.parse(read('package.json'))
const badge = (name: string) => README.match(new RegExp(`badge/${name}-([^-?]+)-`))?.[1]
const files = (dir: string, re: RegExp) => readdirSync(join(ROOT, dir)).filter(f => re.test(f)).map(f => `${dir}/${f}`)

/** `test(` calls in a file; inside a per-surface loop each runs once per surface. */
function countTests(file: string): number {
  const src = read(file)
  const top = (src.match(/^test\(/gm) ?? []).length
  const inLoop = (src.match(/^ {2}test\(/gm) ?? []).length
  const loop = src.match(/^for \(const surface of \[(.*?)\]/m)
  return top + inLoop * (loop ? loop[1]!.split(',').length : 1)
}

/** pytest functions, parametrized ones counted per case. */
function countPytest(file: string): number {
  const src = read(file)
  let n = 0
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    if (!/^def test_/.test(line)) return
    const deco = lines[i - 1] ?? ''
    const params = /parametrize\("[^"]+", \[(.*)\]\)/.exec(deco)
    n += params ? params[1]!.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).length : 1
  })
  return n
}

test('one version everywhere: badge, plugin.json, package.json, marketplace, pyproject, module, CHANGELOG', () => {
  const v = manifest.version
  assert.match(v, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.version, v)
  assert.equal(market.plugins[0].version, v)
  assert.equal(badge('version'), v)
  assert.match(read('pyproject.toml'), new RegExp(`^version = "${v}"$`, 'm'))
  assert.match(read('python/taskline.py'), new RegExp(`^__version__ = "${v}"$`, 'm'))
  assert.ok(read('CHANGELOG.md').includes(`## [${v}] - `), `CHANGELOG has no section for ${v}`)
  assert.ok(README.includes(`- **${v}** —`), `README changelog summary misses ${v}`)
})

test('the test-count badges are the real numbers', () => {
  assert.equal(badge('node%20tests'), String(files('tests', /\.spec\.ts$/).reduce((a, f) => a + countTests(f), 0)))
  assert.equal(badge('engine%20tests'), String(files('hooks', /\.test\.tsx?$/).reduce((a, f) => a + countTests(f), 0)))
  assert.equal(badge('python%20tests'), String(files('tests', /^test_.*\.py$/).reduce((a, f) => a + countPytest(f), 0)))
})

test('the tested Claude Code version is the one the engine types were written by', () => {
  const laid = join(ROOT, '.claude-plugin/types/claude-code/index.d.ts')
  if (!existsSync(laid)) return // CI has no engine
  const built = /Written by Claude Code (\d+\.\d+\.\d+)/.exec(readFileSync(laid, 'utf8'))?.[1]
  assert.ok(README.includes(`Claude%20Code%20${built}`) || README.includes(`Claude Code ${built}`), `README should name ${built}`)
})

test('every /config field is in the configuration table with its default', () => {
  for (const [key, field] of Object.entries(manifest.userConfig as Record<string, { default: unknown }>)) {
    const row = README.split('\n').find(l => l.startsWith(`| \`${key}\` |`))
    assert.ok(row, `README configuration table misses ${key}`)
    assert.ok(row!.includes(`\`${String(field.default)}\``), `${key}: README default should be ${field.default}`)
  }
})

test('every /taskline subcommand is documented', () => {
  const src = read('hooks/register.tsx')
  const cases = [...src.matchAll(/case '([a-z]+)':/g)].map(m => m[1]!)
  for (const cmd of ['clear', 'rm', 'hide', 'show', 'layout', 'demo']) {
    assert.ok(cases.includes(cmd), `register.tsx has no case for ${cmd}`)
    assert.ok(README.includes(`/taskline ${cmd}`), `README misses /taskline ${cmd}`)
  }
})

test('every CLI command is in the usage text and the README', () => {
  const py = read('python/taskline.py')
  for (const cmd of ['set', 'add', 'done', 'fail', 'rm', 'clear', 'ls', 'dir']) {
    assert.match(py, new RegExp(`cmd == "${cmd}"`), `CLI has no ${cmd}`)
    assert.match(py, new RegExp(`^  ${cmd} `, 'm'), `USAGE misses ${cmd}`)
    assert.ok(README.includes(`\`taskline ${cmd}`), `README misses taskline ${cmd}`)
  }
})

test('every protocol field is documented in PROTOCOL.md and read by the parser', () => {
  const protocol = read('PROTOCOL.md')
  const parser = read('hooks/protocol.ts')
  const writer = read('python/taskline.py')
  for (const field of ['v', 'label', 'icon', 'done', 'total', 'unit', 'bytes', 'bytes_total', 'status', 'message', 'started_at', 'updated_at', 'pid']) {
    assert.ok(protocol.includes(`| \`${field}\` |`), `PROTOCOL.md misses ${field}`)
    assert.ok(parser.includes(`o.${field}`), `parser ignores ${field}`)
    assert.ok(writer.includes(`"${field}"`), `Python writer never writes ${field}`)
  }
})

test('watcher fields in the README table are the ones the parser reads', () => {
  const src = read('hooks/watchers.ts')
  for (const field of ['type', 'path', 'label', 'icon', 'id', 'unit', 'total', 'total_bytes', 'pattern', 'glob', 'active_within', 'enabled']) {
    assert.ok(src.includes(`o.${field}`), `watchers.ts does not read ${field}`)
    assert.ok(README.includes(`\`${field}\``), `README watcher table misses ${field}`)
  }
})

test('marketplace entry matches the manifest and the README install line', () => {
  assert.equal(market.plugins[0].name, manifest.name)
  assert.ok(README.includes(`/plugin install ${manifest.name}@${market.name}`))
  assert.ok(read('install.sh').includes(`MARKET="${market.name}"`))
  assert.ok(read('uninstall.sh').includes(`MARKET="${market.name}"`))
})

test('every image and local link in the README exists', () => {
  for (const m of README.matchAll(/(?:src="|\]\()((?!https?:|#)[^")]+)/g)) assert.ok(existsSync(join(ROOT, m[1]!)), `missing ${m[1]}`)
})

test('no lockfile ships: Claude Code would install the dev tools for every user', () => {
  assert.ok(!existsSync(join(ROOT, 'package-lock.json')))
  assert.match(read('.npmrc'), /package-lock=false/)
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'the mod has no runtime dependencies')
})

test('the README footer carries the copyright line', () => {
  assert.ok(README.trimEnd().split('\n').slice(-5).join('\n').includes('© 2026 Martin Pfeffer | [celox.io](https://celox.io)'))
})
