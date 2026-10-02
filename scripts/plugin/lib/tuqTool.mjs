// The official TeamUQ author tool (tuq-plugin-tool.mjs, vendored in scripts/plugin/vendor/ with its sha256), run as a child process (G-08):
// `validate <stage>`, `pack <stage> --unsigned`, `verify <file>`. Every run keeps the exact command line, exit code, stdout and stderr,
// so the build report and the evidence show what the tool itself said. The tool is checked against its recorded sha256 before every use.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from './paths.mjs'

export const TOOL_DIR = path.join(ROOT, 'scripts', 'plugin', 'vendor')
export const TOOL_FILE = path.join(TOOL_DIR, 'tuq-plugin-tool.mjs')
export const TOOL_RECORD = JSON.parse(fs.readFileSync(path.join(TOOL_DIR, 'tuq-plugin-tool.json'), 'utf8'))

/** The Core the package is validated for (the tool's own default is the Core it was built from; we pass it explicitly). */
export const TARGET = Object.freeze({ coreVersion: TOOL_RECORD.builtFromCore, platform: 'win32-x64', osVersion: '26200' })

export function assertToolIntact() {
  const bytes = fs.readFileSync(TOOL_FILE)
  const actual = crypto.createHash('sha256').update(bytes).digest('hex')
  if (actual !== TOOL_RECORD.sha256) throw new Error(`${TOOL_FILE}: sha256 ${actual} differs from the recorded ${TOOL_RECORD.sha256} (scripts/plugin/vendor/tuq-plugin-tool.json)`)
  return { file: TOOL_FILE, sha256: actual, bytes: bytes.length, builtFromCore: TOOL_RECORD.builtFromCore }
}

const targetArgs = (target) => ['--core-version', target.coreVersion, '--platform', target.platform, '--os-version', target.osVersion]

/** Runs the tool; never throws for a non-zero exit (the caller decides). `json` is the parsed stdout when it is JSON. */
export function runTool(args, { cwd = ROOT, timeoutMs = 300_000 } = {}) {
  assertToolIntact()
  const run = spawnSync(process.execPath, [TOOL_FILE, ...args], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 })
  let json = null
  try { json = JSON.parse(run.stdout) } catch { json = null }
  const rel = (p) => (path.isAbsolute(p) ? path.relative(cwd, p).split(path.sep).join('/') || '.' : p)
  return {
    command: ['node', path.relative(cwd, TOOL_FILE).split(path.sep).join('/'), ...args.map(rel)].join(' '),
    exit: run.status,
    signal: run.signal,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    json,
  }
}

export const validateStage = (stageDir, target = TARGET) => runTool(['validate', stageDir, ...targetArgs(target)])

export const packUnsigned = (stageDir, outFile, overridesFile, target = TARGET) =>
  runTool(['pack', stageDir, '--unsigned', '--out', outFile, ...(overridesFile ? ['--overrides', overridesFile] : []), ...targetArgs(target)])

export const verifyPackage = (file, target = TARGET) => runTool(['verify', file, ...targetArgs(target)])
