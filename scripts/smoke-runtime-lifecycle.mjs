import assert from 'node:assert/strict'
import * as fs from 'node:fs'
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
    const lockError = Object.assign(new Error('injected lock write failure'), { code: 'EIO' })
    const realLockFs = {
      closeSync: fs.closeSync, existsSync: fs.existsSync, fstatSync: fs.fstatSync,
      lstatSync: fs.lstatSync, mkdirSync: fs.mkdirSync, openSync: fs.openSync,
      readFileSync: fs.readFileSync, unlinkSync: fs.unlinkSync, writeFileSync: fs.writeFileSync
    }
    const writeFailureDir = join(dataDir, 'lock-write-failure')
    await assert.rejects(createLineTodoRuntime({
      dataDir: writeFailureDir, api: {}, async start() {}, async stop() {},
      ownerLockFs: { ...realLockFs, writeFileSync() { throw lockError } }
    }), (error) => error?.code === 'OWNER_LOCK_WRITE_FAILED')
    assert.equal(fs.existsSync(join(writeFailureDir, '.line-todo-owner.lock')), false, 'write failure removes only its new lock')
    const writeRetry = await createLineTodoRuntime({ dataDir: writeFailureDir, api: {}, async start() {}, async stop() {} })
    await writeRetry.dispose()

    const closeFailureDir = join(dataDir, 'lock-close-failure')
    await assert.rejects(createLineTodoRuntime({
      dataDir: closeFailureDir, api: {}, async start() {}, async stop() {},
      ownerLockFs: { ...realLockFs, closeSync(fd) { fs.closeSync(fd); throw Object.assign(new Error('injected close failure'), { code: 'EIO' }) } }
    }), (error) => error?.code === 'OWNER_LOCK_WRITE_FAILED')
    assert.equal(fs.existsSync(join(closeFailureDir, '.line-todo-owner.lock')), false, 'close failure removes only its new lock')
    const closeRetry = await createLineTodoRuntime({ dataDir: closeFailureDir, api: {}, async start() {}, async stop() {} })
    await closeRetry.dispose()

    const replacementDir = join(dataDir, 'lock-replacement')
    const replacementPath = join(replacementDir, '.line-todo-owner.lock')
    const displacedPath = join(replacementDir, '.line-todo-owner.created-by-test')
    await assert.rejects(createLineTodoRuntime({
      dataDir: replacementDir, api: {}, async start() {}, async stop() {},
      ownerLockFs: { ...realLockFs, writeFileSync() {
        fs.renameSync(replacementPath, displacedPath)
        fs.writeFileSync(replacementPath, 'competing-owner-record', { flag: 'wx' })
        throw lockError
      } }
    }), (error) => error?.code === 'OWNER_LOCK_WRITE_FAILED')
    assert.equal(fs.readFileSync(replacementPath, 'utf8'), 'competing-owner-record', 'cleanup must preserve a replacement owner lock')
    assert.equal(fs.existsSync(displacedPath), true, 'cleanup must not remove the file created by the failed call from its moved path')
    fs.unlinkSync(replacementPath)
    fs.unlinkSync(displacedPath)

    const mediaDir = join(dataDir, 'media-admission')
    let ipcRegistered = true
    let mediaHandlerRegistered = true
    let mediaDisposed = false
    let openFinished = false
    let protocolFinished = false
    let releaseOpen
    let releaseProtocol
    const openGate = new Promise((resolve) => { releaseOpen = () => { openFinished = true; resolve({ ok: true }) } })
    const protocolGate = new Promise((resolve) => { releaseProtocol = () => { protocolFinished = true; resolve({ ok: true }) } })
    const mediaProtocolHandler = () => {
      if (!mediaHandlerRegistered) throw new Error('media protocol is unregistered')
      return protocolGate
    }
    const mediaRuntime = await createLineTodoRuntime({
      dataDir: mediaDir,
      api: { media: {
        open() { if (!ipcRegistered) throw new Error('IPC is unregistered'); return openGate },
        protocol() { return mediaProtocolHandler() }
      } },
      async start() {}, async stop() {},
      stopAcceptingRequests() { ipcRegistered = false; mediaHandlerRegistered = false },
      dispose() {
        assert.equal(ipcRegistered, false, 'IPC must be removed before database disposal')
        assert.equal(mediaHandlerRegistered, false, 'media handler must be removed before database disposal')
        assert.equal(openFinished, true, 'in-flight media API work must drain before database disposal')
        assert.equal(protocolFinished, true, 'in-flight protocol work must drain before database disposal')
        mediaDisposed = true
      }
    })
    await mediaRuntime.start()
    const openRequest = mediaRuntime.api.media.open()
    const protocolRequest = mediaRuntime.api.media.protocol()
    let mediaDisposeDone = false
    const mediaDisposing = mediaRuntime.dispose().then(() => { mediaDisposeDone = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(ipcRegistered, false)
    assert.equal(mediaHandlerRegistered, false)
    assert.equal(mediaDisposeDone, false, 'database disposal must wait for in-flight media operations')
    assert.throws(() => mediaRuntime.api.media.open(), /stopped/, 'new IPC media work must be rejected after shutdown begins')
    assert.throws(() => mediaProtocolHandler(), /unregistered/, 'new direct protocol work must be rejected after handler removal')
    releaseOpen()
    releaseProtocol()
    await Promise.all([openRequest, protocolRequest])
    await mediaDisposing
    assert.equal(mediaDisposed, true)

    console.log('runtime lifecycle smoke: PASS (cross-process exclusion, start/stop/restart, API/media drain, owner-lock write/close failure retry, competing-lock preservation)')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}
