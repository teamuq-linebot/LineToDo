import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { createWindow } from './window'
import { LineWatcher } from './line/watcher'
import { getLineBridgeConfig } from './config/lineBridge'
import { createSettingsStore } from './config/settings'
import { createQwenConfig } from './config/qwen'
import { createPipelineConfig } from './config/defaults'
import { PipelineScheduler } from './pipeline/scheduler'
import { getLastRun } from './db/pipeline.repo'
import { createProviderRegistry, sweepCodexTmpDirs } from './llm/provider'
import { invalidateCliCache } from './llm/cli'
import { createExtractFactory } from './pipeline/runOnce'
import { createLineTodoRuntime } from '../core/runtime'
import { createLineTodoApplication } from '../core/application'
import { registerApplicationApiIpc } from './ipc/application.ipc'
import { registerLinemediaScheme, registerLinemediaHandler, openMediaFile, saveMediaAsFile } from './media/protocol'
import { backupNewMedia } from './media/backup'
import { scanRecentUnsent } from './pipeline/backfill'
import { getMessagesSince } from './line/engine/watchEngine'
import { runReconcile } from './pipeline/reconcileRunner'
import { createMediaDecryptor } from './media/decrypt'
import type { Database } from 'better-sqlite3'
import type { LineBridgeStatus, LineTodoApi } from '../shared/api'

const acceptanceMode = process.env.LINE_TODO_ACCEPTANCE_MODE === '1'
const gotLock = acceptanceMode || app.requestSingleInstanceLock()
if (!gotLock) app.quit()
if (acceptanceMode) {
  const fixtureDataDir = process.env.LINE_TODO_ACCEPTANCE_DATA_DIR?.trim()
  if (!fixtureDataDir || !resolve(fixtureDataDir)) throw new Error('LINE_TODO_ACCEPTANCE_DATA_DIR is required in acceptance mode')
  mkdirSync(fixtureDataDir, { recursive: true })
  app.setPath('userData', resolve(fixtureDataDir))
}
registerLinemediaScheme()

let mainWindow: BrowserWindow | null = null
let runtime: Awaited<ReturnType<typeof createLineTodoRuntime>> | null = null
let api: LineTodoApi | null = null
let scheduler: PipelineScheduler | null = null
let runtimeDatabase: Database | null = null
let disposeApiEvents: (() => void) | null = null
let ipcDisposer: (() => void) | null = null
let mediaProtocolDisposer: (() => Promise<void>) | null = null
let quitting = false
let lastUnsentScan = 0
let reconcileStarted = false
let settingsStore: ReturnType<typeof createSettingsStore> | null = null

function pushToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function applyLoginItemSettings(settings: ReturnType<typeof createSettingsStore>): void {
  if (!app.isPackaged || acceptanceMode) return
  app.setLoginItemSettings({ openAtLogin: settings.get().openAtLogin, path: process.execPath, args: [] })
}

function bindApiEvents(instance: LineTodoApi): () => void {
  const remove = [
    instance.line.onMessage((payload) => pushToRenderer('evt:line-message', payload)),
    instance.line.onStatus((payload) => pushToRenderer('evt:line-status', payload)),
    instance.db.onMessagesPersisted((payload) => pushToRenderer('evt:messages-persisted', payload)),
    instance.pipeline.onRun((payload) => pushToRenderer('evt:pipeline-run', payload)),
    instance.pipeline.onStatus((payload) => pushToRenderer('evt:pipeline-status', payload)),
    instance.pipeline.onTodosChanged((payload) => pushToRenderer('evt:todos-changed', payload)),
    instance.pipeline.onBackfillProgress((payload) => pushToRenderer('evt:backfill-progress', payload)),
    instance.pipeline.onReconcileProgress((payload) => pushToRenderer('evt:reconcile-progress', payload))
  ]
  return () => remove.forEach((dispose) => dispose())
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData')
  settingsStore = createSettingsStore({ userDataDir: dataDir, secrets: safeStorage })
  const settings = settingsStore
  const mediaDecryptor = createMediaDecryptor()
  const getQwenConfig = createQwenConfig({ readApiKey: settings.readApiKey, readBaseUrl: () => settings.get().aiBaseUrl })
  const getDefaults = createPipelineConfig(() => {
    const value = settings.get()
    return value.aiProvider === 'http' ? value : { ...value, concurrency: 1 }
  })
  const providers = createProviderRegistry({ getSettings: settings.get, getQwenConfig, userDataDir: dataDir })
  const makeExtract = createExtractFactory(providers.resolveProvider)
  applyLoginItemSettings(settings)

  const cfg = getLineBridgeConfig()
  const watcher = acceptanceMode ? null : new LineWatcher({ intervalSec: cfg.intervalSec, limit: cfg.limit, dbWatchEnabled: cfg.dbWatchEnabled, dbDir: cfg.dbDir })
  const fixtureMessage = {
    msgId: 'acceptance-fixture-message', chat: 'Isolated acceptance fixture', chatId: 'u-acceptance-fixture',
    isGroup: false, ts: Date.now(), time: new Date().toISOString(), direction: 'in' as const,
    sender: 'Fixture sender', text: 'Please prepare the isolated package acceptance report', contentType: 0
  }
  let fixtureDelivered = false
  const messageListeners: Array<(message: typeof fixtureMessage) => void> = []
  const linePort = acceptanceMode ? {
    start() { if (!fixtureDelivered) { fixtureDelivered = true; messageListeners.forEach((listener) => listener(fixtureMessage)) } },
    stop() {}, status: () => ({ state: 'running' as const, lastMessageAt: null, messageCount: fixtureDelivered ? 1 : 0, lastError: null, restarts: 0 }),
    onMessage(listener: (message: typeof fixtureMessage) => void) { messageListeners.push(listener); return () => { const index = messageListeners.indexOf(listener); if (index >= 0) messageListeners.splice(index, 1) } },
    onStatus() { return () => undefined },
    getMessagesSince: async (sinceMs: number) => fixtureMessage.ts > sinceMs ? [fixtureMessage] : []
  } : {
    start: () => watcher!.start(), stop: () => watcher!.stop(), status: () => watcher!.getStatus(),
    onMessage(listener: (message: typeof fixtureMessage) => void) { watcher!.on('message', listener); return () => watcher!.off('message', listener) },
    onStatus(listener: (status: LineBridgeStatus) => void) { watcher!.on('status', listener); return () => watcher!.off('status', listener) },
    getMessagesSince: (sinceMs: number, opts: { limit: number }) => getMessagesSince(sinceMs, opts)
  }
  try {
    runtime = await createLineTodoRuntime({
      dataDir,
      stopAcceptingRequests: async () => {
        let failure: unknown
        try { disposeApiEvents?.() } catch (error) { failure ??= error }
        disposeApiEvents = null
        try { ipcDisposer?.() } catch (error) { failure ??= error }
        ipcDisposer = null
        const disposeMedia = mediaProtocolDisposer
        mediaProtocolDisposer = null
        try { await disposeMedia?.() } catch (error) { failure ??= error }
        if (failure) throw failure
      },
      initialize: async () => {
        const application = await createLineTodoApplication({
          dataDir,
          dbPath: join(dataDir, 'line-todo.db'),
          onDatabase: (db) => { runtimeDatabase = db },
          settings,
          pipelineConfig: { getDefaults, getQwenConfig, isProviderConfigured: providers.isProviderConfigured },
          providers,
          onSettingsChanged: () => { scheduler?.notifySettingsChanged(); invalidateCliCache(); applyLoginItemSettings(settings) },
          line: linePort,
          makeExtract: acceptanceMode
            ? () => async (input) => ({ importance: 'action', newTodos: [{ bucket: 'todo', title: 'Manual review fixture task', detail: null, priority: 1, confidence: 0.95, sourceMsgIds: input.newMessages.map((item) => item.msgId) }], resolved: [], updates: [] })
            : makeExtract,
          schedulerFactory: (db, repos) => {
            scheduler = new PipelineScheduler({ db, getDefaults,
              getLastRun: () => getLastRun(db), isProviderConfigured: acceptanceMode ? () => true : providers.isProviderConfigured,
              makeExtract: acceptanceMode ? () => async (input) => ({ importance: 'action', newTodos: [{ bucket: 'todo', title: 'Package acceptance fixture task', detail: null, priority: 1, confidence: 0.95, sourceMsgIds: input.newMessages.map((item) => item.msgId) }], resolved: [], updates: [] }) : makeExtract,
              correctionsForChat: acceptanceMode ? () => [] : (chatId) => repos.notMine.corrections(chatId),
              onCorrectionsApplied: acceptanceMode ? undefined : (chatId,messageIds,rules) => rules.forEach(rule=>repos.notMine.effect(rule,chatId,messageIds,'runOnce')) })
            return scheduler
          },
          media: {
            open: (msgId, db) => openMediaFile(msgId, db, mediaDecryptor.decrypt),
            saveAs: (msgId, db) => saveMediaAsFile(msgId, db, mediaDecryptor.decrypt)
          },
          afterPipelineRun: (_result, db, schedule) => {
            if (acceptanceMode) return
            schedule(() => {
              try { const backup = backupNewMedia(db, { decrypt: mediaDecryptor.decrypt, resetIndex: mediaDecryptor.reset }); if (backup.backedUp) console.log(`[media-backup] backedUp=${backup.backedUp}`) }
              catch (error) { console.warn('[media-backup] failed:', (error as Error).name) }
            })
            schedule(async (signal) => {
              if (signal.aborted) return
              if (Date.now() - lastUnsentScan < 5 * 60 * 1000) return
              lastUnsentScan = Date.now()
              await scanRecentUnsent(3, { db, signal, fetchWindow: async (sinceMs) => ({ messages: await linePort.getMessagesSince(sinceMs, { limit: 5000 }) }) })
                .catch((error) => console.warn('[unsent-scan] failed:', (error as Error).name))
            })
          },
          afterStart: (db, schedule) => {
            if (acceptanceMode) return
            if (!reconcileStarted) {
              reconcileStarted = true
              const reconcile = settings.get().reconcile
              if (reconcile.enabled) schedule(async (signal) => {
                await runReconcile({ scopeMonths: reconcile.scopeMonths }, {
                db,
                checkHealth: () => ({ ok: db.pragma('quick_check', { simple: true }) === 'ok' }),
                stateFile: join(dataDir, 'reconcile-state.json'),
                lockFile: join(dataDir, '.reconcile_lock'),
                signal,
                getMessagesSince: async (sinceMs, opts) => linePort.getMessagesSince(sinceMs, opts),
                onProgress: (progress) => { if (!signal.aborted) pushToRenderer('evt:reconcile-progress', progress) }
              }).catch((error) => console.warn('[reconcile] failed:', (error as Error).name))
              })
            }
            schedule(async (signal) => {
              if (signal.aborted) return
              mkdirSync(join(dataDir, 'ai-cli-workdir'), { recursive: true })
              await sweepCodexTmpDirs({ tmpRoot: join(dataDir, 'ai-cli-tmp') })
            })
          },
          app: {
            ping: () => ({ ok: true, ts: Date.now(), version: app.getVersion() }),
            openDataFolder: async () => { await shell.openPath(dataDir); return { ok: true } },
            openOriginal: async () => { try { await shell.openExternal('line://'); return { ok: true } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } }
          },
        })
        return application
      }
    })
    mediaProtocolDisposer = registerLinemediaHandler(() => {
      if (!runtimeDatabase) throw new Error('Runtime database is not initialized')
      return runtimeDatabase
    }, mediaDecryptor.decrypt)
    api = runtime.api
    ipcDisposer = registerApplicationApiIpc(api)
    disposeApiEvents = bindApiEvents(api)
    mainWindow = createWindow()
    if (acceptanceMode) mainWindow.webContents.once('did-finish-load', () => console.log('[acceptance] renderer-loaded (isolated dataDir, fake line, fake extract, no LINE/AI I/O)'))
    if (process.env.LINE_TODO_DEBUG === '1') mainWindow.webContents.on('console-message', (_e, _level, message) => console.log(`[renderer] ${message}`))
    mainWindow.webContents.on('did-finish-load', () => {
      void runtime?.start()
    if (acceptanceMode) {
      void runtime?.start().then(() => runtime?.api.pipeline.runOnce()).then(async (result) => {
        const todos = await runtime?.api.db.todos.list({ chatId: 'u-acceptance-fixture' })
        if (result?.todosCreated !== 1 || todos?.[0]?.title !== 'Package acceptance fixture task') throw new Error('isolated acceptance API fixture failed')
        console.log('[acceptance] runtime-api-message-to-todo PASS')
        const rendererResult = await mainWindow?.webContents.executeJavaScript(`(async () => {
          const api = window.api;
          if (!api || typeof api.ping !== 'function') throw new Error('window.api unavailable');
          const ping = await api.ping();
          const settings = await api.settings.get();
          const current = await api.db.todos.list({ chatId: 'u-acceptance-fixture' });
          const changed = await api.db.todos.updateStatus(current[0].id, 'dismissed');
          const after = await api.db.todos.list({ chatId: 'u-acceptance-fixture', statuses: ['dismissed'] });
          return { ok: !!ping.ok && typeof settings.aiProvider === 'string' && !!changed && after.length === 1,
            domReady: (document.querySelector('#root')?.childElementCount ?? 0) > 0 };
        })()`)
        if (!rendererResult?.ok || !rendererResult.domReady) throw new Error('isolated renderer bridge assertion failed')
        console.log('[acceptance] renderer-window-api-read-write-dom PASS')
        app.quit()
      }).catch((error) => { console.error('[acceptance] fixture failed:', error); app.quit() })
      }
    })
  } catch (error) {
    console.error('[runtime] startup failed:', error)
    app.quit()
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow() })
})

app.on('window-all-closed', () => { void runtime?.stop(); if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', (event) => {
  if (!runtime || quitting) return
  event.preventDefault()
  quitting = true
  void runtime.dispose().then(() => {
    if (acceptanceMode) console.log(`[acceptance] runtime-dispose PASS ownerLockReleased=${!existsSync(join(app.getPath('userData'), '.line-todo-owner.lock'))}`)
    app.quit()
  }, (error) => {
    quitting = false
    console.error('[runtime] shutdown failed before resources were safely disposed:', error instanceof Error ? error.name : 'unknown')
  })
})
