import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { analyzeBundle, assertLineJsPackageVersion, LINEJS_EXPECTED_VERSION, patchLineJsTransport } from './build-backend.mjs'

const baseSource = path.join(process.cwd(), 'node_modules/@evex-dev/linejs/dist/base-BhM9QqFh.mjs')
const requiredInputs = {
  'node_modules/better-sqlite3-plugin/lib/index.js': {},
  'node_modules/koffi/src/koffi/index.js': {},
  'src/plugin/backend/index.ts': {},
  'src/plugin/backend/stubs/llmProvider.ts': {},
}

test('LINEJS exact version and 3.6.4 transport needles fail closed', async () => {
  assert.equal(assertLineJsPackageVersion({ name: '@evex-dev/linejs', version: LINEJS_EXPECTED_VERSION }), undefined)
  assert.throws(() => assertLineJsPackageVersion({ name: '@evex-dev/linejs', version: '3.6.5' }), /only 3\.6\.4/)
  assert.throws(() => assertLineJsPackageVersion({ name: 'other', version: LINEJS_EXPECTED_VERSION }), /only 3\.6\.4/)
  const source = await readFile(baseSource, 'utf8')
  const patched = patchLineJsTransport(source)
  assert.doesNotMatch(patched, /import\(["']undici["']\)|globalThis\.fetch/)
  assert.throws(() => patchLineJsTransport(source.replace('fetchPush = async (info, init) => {', 'fetchPushReplacement = async (info, init) => {')), /client fetch needle missing/)
})

test('bundle analyzer rejects native network injection and unexpected external imports', () => {
  const clean = analyzeBundle({ text: 'const __ltKoffiNode = "native/win32-x64/koffi.node"; bundle source without native network imports', metafile: { inputs: requiredInputs, outputs: { 'index.mjs': { imports: [], bytes: 10 } } }, outfile: 'index.mjs', koffi: 'inline' })
  assert.equal(clean.ok, true, JSON.stringify(clean.problems))
  const injected = analyzeBundle({ text: 'const __ltKoffiNode = "native/win32-x64/koffi.node"; import "node:https"', metafile: { inputs: requiredInputs, outputs: { 'index.mjs': { imports: [{ path: 'node:https', external: true }], bytes: 20 } } }, outfile: 'index.mjs', koffi: 'inline' })
  assert.equal(injected.ok, false)
  assert.match(injected.problems.join('\n'), /network module|unexpected external imports/)
})

test('production bundle includes login and IMAGE/FILE callers but excludes call/voice/socket defaults', async () => {
  const bundle = await readFile('C:/Users/david/AppData/Local/Temp/teamuq-linejs-integration-20261112/candidate-backend/index.mjs', 'utf8')
  assert.match(bundle, /loginWithQR/)
  assert.match(bundle, /loginWithAuthToken/)
  assert.match(bundle, /downloadMessageData/)
  assert.match(bundle, /getData\(false\)/)
  assert.match(bundle, /LINEJS custom fetch required/)
  assert.doesNotMatch(bundle, /node:dgram|node:https|undici|createCallClient/)
})
