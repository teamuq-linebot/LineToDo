// npm run check:core-gate-conformance [-- --core <teamuq-electron checkout>]
//
// Is scripts/lib/core-invoke-gate-standin.mjs (and what the plugin tells the user while Core fences it) still TeamUQ Core? Review R1-N2.
// Needs a teamuq-electron source checkout (read-only; nothing in it is written). It is NOT part of the build, the package or `npm run test:plugin`:
// run it whenever Core moves. Without a Core checkout it FAILS (exit 2) and says why — it never reports green without having compared anything.
//
//   1. the invoke gate: ONE call sequence runs against Core's real createInstalledBackendInvokeGate (packages/platform/plugin-runtime/src/main/
//      externalBackend/backendInvokeGate.ts, bundled with esbuild into a temp dir, like Core's own backendInvokeGate.test.mjs does) and against the
//      stand-in; every call must end the same way. The composition steps (permission off / on, disable / enable) are applied to the real gate the
//      way step 2 checks Core wires them. The 30 s deadline runs on mocked timers.
//   2. the composition (apps/desktop/src/main/native/startup/pluginRuntimeComposition.ts): beforeDisable → revoke, afterEnable → activate,
//      refreshGrants → revoke when backend:invoke is revoked and NO activate when it is allowed again. If Core starts lifting the fence on re-allow,
//      this fails: the stand-in's setBackendInvokeRevoked and the fenced text (lib/backendError.ts) have to be revisited.
//   3. the switch title (packages/features/settings/.../pluginPage/pluginText.ts PERMISSION_TEXT["backend:invoke"].title) is the one the plugin
//      quotes (src/renderer/lib/backendError.ts BACKEND_INVOKE_TOGGLE_TITLE and the tests' scripts/plugin/lib/fenced-text.mjs). Review R1-N1.
//   4. the place the fenced sentences send the user (0.1.3): this Core has a plugin management page labelled 「外掛」 — 1.6.8 as a settings group
//      (packages/features/settings/.../settingsGroupConfig.ts), 1.7.1 as a My AI tab (packages/features/agent-org/.../categoryTabs.ts) — and the
//      plugin's overview (pluginPage/drawers/OverviewTab.tsx) has the section 「它可以做的事」 listing the switch by its title with an 「允許」 box, plus
//      the 恢復使用 / 重新啟動 buttons (disable → enable). The sentences (fenced-text.mjs) name those and no parent that only one version has.
//
// Where Core is looked for: --core <dir>, else $TEAMUQ_CORE_DIR, else teamuq-electron next to this checkout, else next to the main worktree
// (for a linked worktree under .teamuq/worktrees/).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mock } from 'node:test'
import { buildSync } from 'esbuild'

import { ROOT } from './lib/paths.mjs'
import {
  CORE_BACKEND_INVOKE_TITLE, CORE_PERMISSIONS_SECTION_TITLE, CORE_PLUGIN_PAGE_LABEL, EXPECTED_AI_FENCED_TEXT, EXPECTED_FENCED_TEXT, EXPECTED_TIMEOUT_TEXT,
  PLUGIN_PAGE_PLACE_TEXT, VERSION_SPECIFIC_PLACE
} from './lib/fenced-text.mjs'
import { createCoreGateStandin } from '../lib/core-invoke-gate-standin.mjs'

const GATE = 'packages/platform/plugin-runtime/src/main/externalBackend/backendInvokeGate.ts'
const COMPOSITION = 'apps/desktop/src/main/native/startup/pluginRuntimeComposition.ts'
const PLUGIN_TEXT = 'packages/features/settings/src/ui/views/Settings/sections/pluginPage/pluginText.ts'
const SETTINGS_GROUPS = 'packages/features/settings/src/ui/views/Settings/settingsGroupConfig.ts'
const MY_AI_TABS = 'packages/features/agent-org/src/ui/agent-teams/navShell/categoryTabs.ts'
const OVERVIEW = 'packages/features/settings/src/ui/views/Settings/sections/pluginPage/drawers/OverviewTab.tsx'
const CORE_FILES = [GATE, COMPOSITION, PLUGIN_TEXT, SETTINGS_GROUPS, MY_AI_TABS, OVERVIEW]

/** exit 2 = not compared (no Core source); exit 1 = compared and different */
function notRun(reason) {
  console.error(`FAIL (nothing compared): ${reason}`)
  console.error('Point it at a teamuq-electron checkout: npm run check:core-gate-conformance -- --core <dir>   or   set TEAMUQ_CORE_DIR=<dir>')
  process.exit(2)
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

function coreCandidates() {
  const args = process.argv.slice(2)
  const i = args.indexOf('--core')
  if (i >= 0) {
    if (!args[i + 1]) notRun('--core needs a directory')
    return [{ dir: path.resolve(args[i + 1]), from: '--core' }]
  }
  if (process.env.TEAMUQ_CORE_DIR) return [{ dir: path.resolve(process.env.TEAMUQ_CORE_DIR), from: 'TEAMUQ_CORE_DIR' }]
  const list = [{ dir: path.resolve(ROOT, '..', 'teamuq-electron'), from: 'next to this checkout' }]
  const common = git(ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (common) list.push({ dir: path.resolve(path.dirname(common), '..', 'teamuq-electron'), from: 'next to the main worktree' })
  return list
}

const candidates = coreCandidates()
const found = candidates.find((c) => CORE_FILES.every((f) => fs.existsSync(path.join(c.dir, f))))
if (!found) {
  const why = candidates.map((c) => `${c.dir} (${c.from}): ${fs.existsSync(c.dir) ? `missing ${CORE_FILES.filter((f) => !fs.existsSync(path.join(c.dir, f))).join(', ')}` : 'does not exist'}`)
  notRun(`no teamuq-electron source with the files this check reads.\n  ${why.join('\n  ')}`)
}
const core = found.dir
const read = (rel) => fs.readFileSync(path.join(core, rel), 'utf8')
console.log(`Core: ${core} (${found.from})`)
console.log(`  HEAD ${git(core, 'rev-parse', 'HEAD') ?? 'unknown (not a git checkout)'}${git(core, 'status', '--porcelain', '--', ...CORE_FILES) ? '  (these files have local changes)' : ''}`)
for (const f of CORE_FILES) console.log(`  ${git(core, 'hash-object', f) ?? 'n/a'.padEnd(40)}  ${f}`)

const failures = []
const check = (label, body) => {
  try { body(); console.log(`ok    ${label}`) } catch (error) { failures.push(label); console.log(`FAIL  ${label}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`) }
}

// ── 3. the switch title ──
const titleMatch = read(PLUGIN_TEXT).match(/"backend:invoke":\s*\{\s*title:\s*"([^"]+)"/u)
const productMatch = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'lib', 'backendError.ts'), 'utf8').match(/export const BACKEND_INVOKE_TOGGLE_TITLE = '([^']+)'/u)
check(`the backend:invoke switch title on Core's settings page is the one the plugin quotes (Core: 「${titleMatch?.[1]}」)`, () => {
  assert.ok(titleMatch, `${PLUGIN_TEXT}: PERMISSION_TEXT["backend:invoke"].title not found`)
  assert.ok(productMatch, 'src/renderer/lib/backendError.ts: BACKEND_INVOKE_TOGGLE_TITLE not found')
  assert.equal(productMatch[1], titleMatch[1], 'src/renderer/lib/backendError.ts BACKEND_INVOKE_TOGGLE_TITLE')
  assert.equal(CORE_BACKEND_INVOKE_TITLE, titleMatch[1], 'scripts/plugin/lib/fenced-text.mjs CORE_BACKEND_INVOKE_TITLE')
})

// ── 4. where the fenced sentences send the user (0.1.3) ──
const settingsGroup = read(SETTINGS_GROUPS).match(/id:\s*"plugins",\s*label:\s*"([^"]+)"/u)
const myAiTab = read(MY_AI_TABS).match(/\{\s*id:\s*"plugins",\s*label:\s*"([^"]+)"/u)
const pluginPages = [settingsGroup && `a settings group 「${settingsGroup[1]}」`, myAiTab && `a My AI tab 「${myAiTab[1]}」`].filter(Boolean)
check(`the plugin management page the fenced sentences name, 「${CORE_PLUGIN_PAGE_LABEL}」, exists in this Core (here: ${pluginPages.join(' and ') || 'none found'})`, () => {
  assert.ok(settingsGroup || myAiTab, `neither ${SETTINGS_GROUPS} nor ${MY_AI_TABS} has a "plugins" entry`)
  for (const found of [settingsGroup, myAiTab].filter(Boolean)) assert.equal(found[1], CORE_PLUGIN_PAGE_LABEL, 'the plugin page label')
})
const overview = read(OVERVIEW)
check(`on the plugin's overview: 「${CORE_PERMISSIONS_SECTION_TITLE}」 lists the switch by its title with an 「允許」 box; 「恢復使用」 and 「重新啟動」 are there`, () => {
  const start = overview.indexOf('function AllowSection')
  assert.ok(start >= 0, `${OVERVIEW}: AllowSection not found`)
  const allow = overview.slice(start, overview.indexOf('\nfunction ', start + 1) > 0 ? overview.indexOf('\nfunction ', start + 1) : undefined)
  assert.ok(allow.includes(`>${CORE_PERMISSIONS_SECTION_TITLE}</h3>`), `AllowSection title is not 「${CORE_PERMISSIONS_SECTION_TITLE}」`)
  assert.match(allow, /<b>\{text\.title\}<\/b>/u, 'the switch is not shown by its title (describePermission(permission).title)')
  assert.match(allow, /type="checkbox"[\s\S]*?\/> 允許/u, 'no 「允許」 checkbox')
  assert.match(overview, /btn\("恢復使用", \(\) => void page\.resume\(id\)/u, '「恢復使用」 (resume) button not found')
  assert.match(overview, /btn\("重新啟動", \(\) => void page\.restart\(id\)/u, '「重新啟動」 (restart) button not found')
})
check('the fenced sentences name that place and no parent that only one TeamUQ version has', () => {
  for (const [name, text] of Object.entries({ EXPECTED_FENCED_TEXT, EXPECTED_TIMEOUT_TEXT, EXPECTED_AI_FENCED_TEXT })) {
    assert.ok(text.includes(PLUGIN_PAGE_PLACE_TEXT), `${name} does not send the user to ${PLUGIN_PAGE_PLACE_TEXT}`)
    assert.doesNotMatch(text, VERSION_SPECIFIC_PLACE, `${name} names a version-specific place`)
  }
  for (const [name, text] of Object.entries({ EXPECTED_FENCED_TEXT, EXPECTED_AI_FENCED_TEXT })) {
    assert.ok(text.includes(`「${CORE_PERMISSIONS_SECTION_TITLE}」裡已允許「${CORE_BACKEND_INVOKE_TITLE}」`), `${name} does not point at the switch inside 「${CORE_PERMISSIONS_SECTION_TITLE}」`)
  }
})

// ── 2. the composition ──
function block(source, key) {
  const start = source.indexOf(`${key}:`)
  if (start < 0) return null
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  return null
}
const composition = read(COMPOSITION)
check('composition: disabling the plugin revokes (fences), enabling it activates (lifts the fence)', () => {
  const disable = block(composition, 'beforeDisable')
  const enable = block(composition, 'afterEnable')
  assert.ok(disable && /installedBackendInvoke\??\.revoke\(/u.test(disable), `beforeDisable no longer revokes:\n${disable}`)
  assert.ok(enable && /installedBackendInvoke\??\.activate\(/u.test(enable), `afterEnable no longer activates:\n${enable}`)
})
check('composition: turning backend:invoke off revokes; allowing it again does NOT activate (the plugin stays fenced — what the fenced text tells the user)', () => {
  const grants = block(composition, 'refreshGrants')
  assert.ok(grants, 'refreshGrants not found')
  assert.match(grants, /revoked\.includes\('backend:invoke'\)\)\s*await installedBackendInvoke\??\.revoke\(/u, `refreshGrants no longer revokes on backend:invoke:\n${grants}`)
  assert.doesNotMatch(grants, /\.activate\(/u, `refreshGrants now activates — Core lifts the fence on re-allow; revisit the stand-in (setBackendInvokeRevoked) and lib/backendError.ts:\n${grants}`)
})

// ── 1. the invoke gate ──
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'core-gate-conf-'))
let createInstalledBackendInvokeGate
try {
  const outfile = path.join(out, 'gate.mjs')
  buildSync({
    entryPoints: [path.join(core, GATE)],
    absWorkingDir: core, bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    ...(fs.existsSync(path.join(core, 'tsconfig.node.json')) ? { tsconfig: path.join(core, 'tsconfig.node.json') } : {})
  })
  ;({ createInstalledBackendInvokeGate } = await import(pathToFileURL(outfile).href))
} finally { fs.rmSync(out, { recursive: true, force: true }) }

const METHODS = ['ping', 'hang', 'tmo', 'crash', 'boom']
const PID = 'tuqdev.line-todo'

/** the backend: ping answers, hang waits for release(), tmo / crash / boom fail like the runtime would */
function backend() {
  const held = []
  return {
    held,
    release() { for (const r of held.splice(0)) r({ late: true }) },
    run(method) {
      if (method === 'ping') return { pong: true }
      if (method === 'hang') return new Promise((resolve) => held.push(resolve))
      const err = (code) => Object.assign(new Error(code), { code })
      if (method === 'tmo') throw err('plugin_call_timeout')
      if (method === 'crash') throw err('plugin_backend_exited')
      throw err('something_else')
    }
  }
}

function realSide() {
  const b = backend()
  const policy = { installed: true, enabled: true, trusted: true, grant: true, methods: METHODS }
  const stops = []
  const gate = createInstalledBackendInvokeGate({ invoke: async (_id, method) => b.run(method), stop: async (_id, why) => { stops.push(why) } }, async () => ({ ...policy }))
  return {
    b, stops,
    call: (method) => gate.invokeView(PID, 'view-1', { method, params: {} }),
    // pluginRuntimeComposition.ts refreshGrants / beforeDisable / afterEnable (checked in step 2)
    setBackendInvokeRevoked: async (revoked) => { policy.grant = !revoked; if (revoked) await gate.revoke(PID) },
    disable: async () => { policy.enabled = false; await gate.revoke(PID) },
    enable: async () => { policy.enabled = true; gate.activate(PID) },
    uninstall: async () => { policy.installed = false }
  }
}

function standinSide() {
  const b = backend()
  const s = createCoreGateStandin({ call: async (method) => b.run(method) }, { methods: METHODS })
  return {
    b, stops: s.state.stops,
    call: (method) => s.invokeView(method, {}),
    setBackendInvokeRevoked: async (revoked) => s.setBackendInvokeRevoked(revoked),
    disable: async () => s.disable(),
    enable: async () => s.enable(),
    uninstall: async () => s.uninstall()
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const summary = (r) => (r.ok ? 'ok' : r.error)

/** every backend answer here is immediate, so a call that has not ended after this many event-loop turns never will: report it, do not hang */
async function settle(promise, turns = 200) {
  let done = false
  let value
  promise.then((v) => { done = true; value = summary(v) }, (e) => { done = true; value = `threw ${e?.message ?? e}` })
  for (let i = 0; i < turns && !done; i += 1) await tick()
  return done ? value : '(no answer)'
}

async function scenario(side) {
  const log = []
  const step = async (label, promise) => { log.push([label, await settle(promise)]) }
  await step('1 ping', side.call('ping'))
  // backend:invoke turned off on the plugin page while a call is in flight
  const a = side.call('hang'); await tick(); await tick()
  await side.setBackendInvokeRevoked(true)
  await step('2 in-flight at revoke', a)
  await step('3 ping after revoke', side.call('ping'))
  // allowed again: refreshGrants does not activate
  await side.setBackendInvokeRevoked(false)
  await step('4 ping after re-allow', side.call('ping'))
  await step('5 ping after re-allow (again)', side.call('ping'))
  // disable → enable (afterEnable → activate)
  await side.disable()
  await step('6 ping while disabled', side.call('ping'))
  await side.enable()
  await step('7 ping after enable', side.call('ping'))
  // the runtime reports a call timeout while another call is in flight → fence
  const b = side.call('hang'); await tick(); await tick()
  await step('8 runtime timeout', side.call('tmo'))
  await step('9 in-flight at timeout', b)
  side.b.release(); await tick()
  await step('10 ping after timeout', side.call('ping'))
  await side.setBackendInvokeRevoked(false)
  await step('11 ping after re-allow (timeout fence)', side.call('ping'))
  await side.disable(); await side.enable()
  await step('12 ping after disable+enable', side.call('ping'))
  await step('13 method not in manifest', side.call('nope'))
  await step('14 crash', side.call('crash'))
  await step('15 other runtime error', side.call('boom'))
  // the 30 s deadline itself (mocked timers)
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const c = side.call('hang'); await tick(); await tick()
    mock.timers.tick(30_001)
    await step('16 in-flight past the 30 s deadline', c)
    await step('17 ping after deadline', side.call('ping'))
  } finally { mock.timers.reset() }
  side.b.release(); await tick()
  await side.disable(); await side.enable()
  await step('18 ping after disable+enable', side.call('ping'))
  await side.uninstall()
  await step('19 uninstalled', side.call('ping'))
  log.push(['stops', side.stops.join(',')])
  return log
}

const real = await scenario(realSide())
const standin = await scenario(standinSide())
const width = Math.max(...real.map(([l]) => l.length))
console.log(`\nthe invoke gate, step by step (Core's createInstalledBackendInvokeGate vs scripts/lib/core-invoke-gate-standin.mjs):`)
console.log(real.map(([label, value], i) => `  ${label.padEnd(width)}  core=${value.padEnd(28)} standin=${standin[i][1]}${value === standin[i][1] ? '' : '   <-- DIFFERENT'}`).join('\n'))
check(`the stand-in ends every call the way Core does (${real.length} observations)`, () => assert.deepEqual(standin, real))

if (failures.length > 0) {
  console.log(`\nDIFFERENT: ${failures.length} check(s) failed — the stand-in or the plugin's text no longer matches this Core.`)
  process.exit(1)
}
console.log('\nSAME: the stand-in, the composition it assumes, the switch title and the place the fenced sentences name all match this Core.')
