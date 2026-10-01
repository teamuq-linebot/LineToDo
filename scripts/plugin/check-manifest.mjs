// Checks a built .tuqplugin against the TeamUQ 1.6.8 Manifest V2 contract (read only: the plugin-sdk SOURCE of the pinned commit b8b96cb3 is extracted with
// `git archive` into dist/ and bundled; nothing is written into teamuq-electron). Same job and same report shape as ai-lover's scripts/check-manifest.mjs.
//   node scripts/plugin/check-manifest.mjs [file.tuqplugin] [--core 1.6.8]
// Fails (exit 1) when the schema rejects the manifest, when the Core reports a support issue, or when a view icon is missing, is not a PNG,
// is not square, or is 30 KB or more.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DIST, ROOT, TE_COMMIT, WORK } from './lib/paths.mjs'
import { parseArgs } from './lib/pack.mjs'
import { loadTeValidators } from './lib/te-snapshot.mjs'
import { PLUGIN_ID } from './lib/manifest.mjs'

const args = parseArgs(process.argv.slice(2))
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const file = path.resolve(args._[0] ?? path.join(DIST, `${PLUGIN_ID}-${VERSION}-win.tuqplugin`))
const coreVersion = String(args.core ?? '1.6.8')
const TAR = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'

const work = path.join(WORK, 'manifest-check')
const unpacked = path.join(work, 'package')
fs.rmSync(unpacked, { recursive: true, force: true })
fs.mkdirSync(unpacked, { recursive: true })
const untar = spawnSync(TAR, ['-xf', file, '-C', unpacked], { encoding: 'utf8' })
if (untar.status !== 0) throw new Error(`cannot unpack ${file}: ${untar.stderr}`)

const { sdk } = await loadTeValidators()
const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'))
const parsed = sdk.PluginManifestV2Schema.safeParse(manifest)
const report = {
  teCommit: TE_COMMIT,
  file: path.basename(file),
  id: manifest.id,
  version: manifest.version,
  minCoreVersion: manifest.minCoreVersion,
  coreVersion,
  schemaOk: parsed.success,
  schemaIssues: parsed.success ? [] : parsed.error.issues,
  supportIssues: [],
  icons: [],
  permissions: manifest.permissions,
  nativeFiles: manifest.native?.files ?? [],
}
if (parsed.success) report.supportIssues = sdk.evaluateManifestSupport(parsed.data, { coreVersion, platform: { id: 'win32-x64', osVersion: '10.0.26200' } })

const problems = []
for (const view of manifest.contributes?.views ?? []) {
  if (view.icon === undefined) { report.icons.push({ view: view.id, icon: null }); continue }
  const target = path.join(unpacked, ...view.icon.split('/'))
  const entry = { view: view.id, icon: view.icon, exists: fs.existsSync(target) }
  if (entry.exists) {
    const bytes = fs.readFileSync(target)
    entry.bytes = bytes.length
    entry.png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    entry.width = bytes.readUInt32BE(16)
    entry.height = bytes.readUInt32BE(20)
    if (!entry.png) problems.push(`${view.icon} is not a PNG`)
    if (entry.width !== entry.height) problems.push(`${view.icon} is not square (${entry.width}x${entry.height})`)
    if (bytes.length >= 30 * 1024) problems.push(`${view.icon} is ${bytes.length} bytes (30 KB or more)`)
  } else problems.push(`${view.icon} is not in the package`)
  report.icons.push(entry)
}
if (!parsed.success) problems.push('schema rejected the manifest')
if (report.supportIssues.length > 0) problems.push(`support issues: ${JSON.stringify(report.supportIssues)}`)
report.ok = problems.length === 0
report.problems = problems
fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
