// Checks a built .tuqplugin's manifest with the official author tool (G-08): the package is unpacked into dist/, integrity.json is left out
// (the tool's stage must not contain generated files), and `tuq-plugin-tool validate <stage>` runs for TeamUQ 1.7.1 / win32-x64
// (Manifest V2 schema, Core support, every referenced entry / view / icon / native file present). Nothing is read from teamuq-electron.
//   node scripts/plugin/check-manifest.mjs [file.tuqplugin]
// Fails (exit 1) when validate fails, or when a view icon is missing, is not a PNG, is not square, or is 30 KB or more.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DIST, ROOT, WORK } from './lib/paths.mjs'
import { parseArgs } from './lib/pack.mjs'
import { PLUGIN_ID } from './lib/manifest.mjs'
import { TARGET, validateStage } from './lib/tuqTool.mjs'

const args = parseArgs(process.argv.slice(2))
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const file = path.resolve(args._[0] ?? path.join(DIST, `${PLUGIN_ID}-${VERSION}-win.tuqplugin`))
const TAR = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'

const work = path.join(WORK, 'manifest-check')
const unpacked = path.join(work, 'package')
fs.rmSync(unpacked, { recursive: true, force: true })
fs.mkdirSync(unpacked, { recursive: true })
const untar = spawnSync(TAR, ['-xf', file, '-C', unpacked], { encoding: 'utf8' })
if (untar.status !== 0) throw new Error(`cannot unpack ${file}: ${untar.stderr}`)
for (const generated of ['integrity.json', 'signature.json', 'delegation.json']) fs.rmSync(path.join(unpacked, generated), { force: true })

const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'))
const validated = validateStage(unpacked)
const report = {
  file: path.basename(file),
  id: manifest.id,
  version: manifest.version,
  minCoreVersion: manifest.minCoreVersion,
  target: { ...TARGET },
  validate: { command: validated.command, exit: validated.exit, stdout: validated.json ?? validated.stdout.trim(), stderr: validated.stderr.trim() },
  icons: [],
  permissions: manifest.permissions,
  backendMethods: manifest.backendMethods,
  nativeFiles: manifest.native?.files ?? [],
}

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
if (validated.exit !== 0) problems.push(`tuq-plugin-tool validate exit ${validated.exit}: ${validated.stderr.trim()}`)
report.ok = problems.length === 0
report.problems = problems
fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
