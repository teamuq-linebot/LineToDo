// Verifies a built .tuqplugin with the official author tool and audits its content (G-08: no teamuq-electron checkout, no pinned 1.6.8 validators,
// no development key — the package is unsigned, G-09):
//   1. `tuq-plugin-tool verify <file>` for TeamUQ 1.7.1 / win32-x64: the same reviewArtifact Core runs when the user picks the file
//      (zip structure, integrity.json coverage and hashes, manifest schema + support, native whitelist, icon). Expected signer: unsigned.
//   2. negative controls with the same tool (the check is not vacuous): one flipped byte, an older Core (1.7.0) and another platform must be refused.
//   3. the content audit (lib/audit.mjs) on the unpacked zip: no .ps1 / line-driver, no better-sqlite3-multiple-ciphers, no key file or private-key
//      marker, no standalone better-sqlite3 11.x, no node_modules, exactly the two pinned native modules, and no signature.json / delegation.json.
//
//   node scripts/plugin/verify-artifact.mjs [file.tuqplugin] [--report <file.json>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DIST, ROOT } from './lib/paths.mjs'
import { parseArgs, sha256Hex } from './lib/pack.mjs'
import { auditPackage } from './lib/audit.mjs'
import { PLUGIN_ID } from './lib/manifest.mjs'
import { TARGET, verifyPackage } from './lib/tuqTool.mjs'
import { PINNED_NATIVE } from './build-plugin.mjs'

const TAR = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'

function walk(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else out.push({ path: path.relative(base, full).split(path.sep).join('/'), data: fs.readFileSync(full) })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** sha256 of the STANDALONE app's better-sqlite3 11.x and better-sqlite3-multiple-ciphers binaries (this worktree and the main checkout), which must never be in the package. */
function standaloneBinaries() {
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' })
  const mainTree = common.status === 0 ? path.dirname(path.resolve(ROOT, common.stdout.trim())) : null
  const found = []
  for (const base of [ROOT, mainTree]) {
    if (!base) continue
    for (const pkg of ['better-sqlite3', 'better-sqlite3-multiple-ciphers']) {
      const file = path.join(base, 'node_modules', pkg, 'build', 'Release', 'better_sqlite3.node')
      if (fs.existsSync(file)) found.push({ pkg, file: file.split(path.sep).join('/'), sha256: sha256Hex(fs.readFileSync(file)) })
    }
  }
  return found
}

const brief = (run) => ({ command: run.command, exit: run.exit, stdout: run.json ?? run.stdout.trim(), stderr: run.stderr.trim() })

export async function verifyArtifact({ file }) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-verify-'))
  const result = { file: path.basename(file), target: { ...TARGET }, steps: {}, ok: false, problems: [] }
  try {
    const bytes = fs.readFileSync(file)
    result.bytes = bytes.length
    result.sha256 = sha256Hex(bytes)

    // 1. the official review
    const verified = verifyPackage(file)
    result.steps.verify = brief(verified)
    if (verified.exit !== 0) result.problems.push(`tuq-plugin-tool verify exit ${verified.exit}: ${verified.stderr.trim()}`)
    else {
      if (verified.json?.signer?.kind !== 'unsigned') result.problems.push(`unexpected signer ${JSON.stringify(verified.json?.signer)}`)
      if (verified.json?.id !== PLUGIN_ID) result.problems.push(`unexpected plugin id ${verified.json?.id}`)
    }

    // 2. negative controls with the same tool
    const tampered = Buffer.from(bytes)
    tampered[Math.floor(tampered.length / 2)] ^= 0xff
    const tamperedFile = path.join(sandbox, 'tampered.tuqplugin')
    fs.writeFileSync(tamperedFile, tampered)
    const refusals = {
      tamperedByte: verifyPackage(tamperedFile),
      core170: verifyPackage(file, { ...TARGET, coreVersion: '1.7.0' }),
      linuxPlatform: verifyPackage(file, { ...TARGET, platform: 'linux-x64', osVersion: '6.0' }),
    }
    result.steps.negative = Object.fromEntries(Object.entries(refusals).map(([label, run]) => [label, { refused: run.exit !== 0, exit: run.exit, stderr: run.stderr.trim().slice(0, 300) }]))
    for (const [label, run] of Object.entries(refusals)) if (run.exit === 0) result.problems.push(`negative control ${label}: the tool did not refuse`)

    // 3. the content audit, on the unpacked zip (every entry, including manifest / integrity)
    const unpacked = path.join(sandbox, 'unpacked')
    fs.mkdirSync(unpacked, { recursive: true })
    const untar = spawnSync(TAR, ['-xf', file, '-C', unpacked], { encoding: 'utf8' })
    if (untar.status !== 0) throw new Error(`cannot unpack: ${untar.stderr}`)
    const entries = walk(unpacked)
    const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'))
    const integrity = JSON.parse(fs.readFileSync(path.join(unpacked, 'integrity.json'), 'utf8'))
    result.manifest = manifest
    result.steps.integrity = integrity.files.map((entry) => ({ path: entry.path, size: entry.size, kind: entry.kind, platform: entry.platform }))
    const standalone = standaloneBinaries()
    const allowedNative = Object.fromEntries((manifest.native?.files ?? []).map((entry) => [entry.path, entry.path.endsWith('koffi.node') ? PINNED_NATIVE.koffi.sha256 : PINNED_NATIVE.betterSqlite3.sha256]))
    const audit = auditPackage(entries, { allowedNative, standalone11Sha256: standalone.map((entry) => entry.sha256) })
    const unsignedOnly = entries.filter((entry) => entry.path === 'signature.json' || entry.path === 'delegation.json').map((entry) => entry.path)
    result.steps.audit = { ok: audit.ok && unsignedOnly.length === 0, problems: audit.problems, natives: audit.natives, entryCount: audit.listing.length, standalone11Compared: standalone, signatureFiles: unsignedOnly }
    result.entries = audit.listing
    result.problems.push(...audit.problems)
    if (unsignedOnly.length > 0) result.problems.push(`an unsigned package must not carry ${unsignedOnly.join(', ')}`)
    result.ok = result.problems.length === 0
  } catch (error) {
    result.ok = false
    result.problems.push(`${error.code ?? 'error'}: ${error.message}`)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const file = path.resolve(args._[0] ?? path.join(DIST, `${PLUGIN_ID}-${version}-win.tuqplugin`))
  const result = await verifyArtifact({ file })
  const text = JSON.stringify(result, null, 2)
  if (args.report) fs.writeFileSync(path.resolve(String(args.report)), text)
  console.log(text)
  process.exit(result.ok ? 0 : 1)
}
