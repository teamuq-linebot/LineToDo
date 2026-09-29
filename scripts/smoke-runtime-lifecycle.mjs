import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runtimeUrl = pathToFileURL(join(process.cwd(), 'src/core/runtime.ts')).href
const { createLineTodoRuntime } = await import(runtimeUrl)
const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[2] === '--compete') {
  try {
    await createLineTodoRuntime({ dataDir: process.argv[3], api: {}, async start() {}, async stop() {} })
    process.exitCode = 2
  } catch (error) {
    if (error?.code !== 'DATA_DIRECTORY_IN_USE') throw error
    console.log('second owner rejected')
  }
} else {
  const dataDir = mkdtempSync(join(tmpdir(), 'line-todo-runtime-'))
  let starts = 0
  let stops = 0
  let disposed = 0
  let releaseCall
  const api = { ping: () => new Promise((resolve) => { releaseCall = () => resolve({ ok: true }) }) }
  const ports = { dataDir, api, async start() { starts += 1 }, async stop() { stops += 1 }, async dispose() { disposed += 1 } }
  try {
    const runtime = await createLineTodoRuntime(ports)
    const competitor = spawnSync(process.execPath, ['--experimental-strip-types', scriptPath, '--compete', dataDir], { encoding: 'utf8' })
    assert.equal(competitor.status, 0, competitor.stderr)
    await Promise.all([runtime.start(), runtime.start()])
    assert.equal(starts, 1)
    const inFlight = runtime.api.ping()
    let disposedDone = false
    const disposing = runtime.dispose().then(() => { disposedDone = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(disposedDone, false, 'dispose must wait for in-flight API calls')
    releaseCall()
    assert.deepEqual(await inFlight, { ok: true })
    await disposing
    assert.equal(stops, 1)
    assert.equal(disposed, 1)
    await runtime.dispose()
    assert.equal(disposed, 1)
    await assert.rejects(runtime.start(), /disposed/)
    const reopened = await createLineTodoRuntime(ports)
    await reopened.start()
    await reopened.stop()
    await reopened.start()
    await reopened.dispose()
    assert.equal(starts, 3)
    assert.equal(stops, 3)
    console.log('runtime lifecycle smoke: PASS (cross-process owner exclusion, start idempotency, restart, in-flight drain, idempotent dispose)')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}
