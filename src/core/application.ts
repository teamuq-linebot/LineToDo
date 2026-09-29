import { EventEmitter } from 'node:events'
import type {
  Api, BackfillProgress, LineBridgeStatus, MessagesPersistedEvent, ReconcileProgress,
  PipelineLoadStats, PipelineRunResult, PipelineStatus, ProviderHealth, RawLineMessage,
  ReviewLastDaysResult, SettingsPatch, SettingsView, TodoDTO,
  TodosChangedEvent, QwenTestResult
} from '../shared/api'
import { openDatabase } from '../main/db/database'
import { createRepositories } from '../main/db/repositories'
import type { Database } from 'better-sqlite3'

import type { UpdateTodoPatch } from '../main/db/todos.repo'

import type { AppSettings, SettingsStore } from '../main/config/settings'
import { unconfiguredHealth, LlmProviderError } from '../main/llm/provider'
import { listModels, makeQwen } from '../main/llm/qwenClient'
import { draftReply } from '../main/llm/draftReply'
import type { PipelineDefaults } from '../main/config/defaults'
import type { QwenConfig } from '../main/config/qwen'
import { reviewLastDays, backfillMediaKeys } from '../main/pipeline/backfill'
import { deriveMsgId } from '../main/db/schema'
import type { PipelineScheduler } from '../main/pipeline/scheduler'
import type { RawLineMessage as NativeLineMessage } from '../main/line/types'

export interface LineTodoApplicationPorts {
  dataDir: string
  dbPath: string
  onDatabase?(db: Database): void
  line: {
    start(): Promise<void> | void
    stop(): Promise<void> | void
    status(): LineBridgeStatus
    onMessage(cb: (message: NativeLineMessage) => void): () => void
    onStatus(cb: (status: LineBridgeStatus) => void): () => void
  }
  scheduler?: PipelineScheduler
  schedulerFactory?: (db: import('better-sqlite3').Database, repos: ReturnType<typeof createRepositories>) => PipelineScheduler
  settings: SettingsStore
  pipelineConfig: { getDefaults(): PipelineDefaults; getQwenConfig(): QwenConfig; isProviderConfigured(): boolean }
  providers: { resolveProvider(): ReturnType<typeof import('../main/llm/provider').resolveProvider> }
  media: {
    open(msgId: string, db: Database): Promise<{ ok: boolean; error?: string }>
    saveAs(msgId: string, db: Database): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  }
  app: {
    ping(): { ok: boolean; ts: number; version: string }
    openDataFolder(): Promise<{ ok: boolean }>
    openOriginal(chatId: string): Promise<{ ok: boolean; error?: string }>
  }
  onSettingsChanged?(): void
  afterPipelineRun?(result: PipelineRunResult, db: Database): void
  afterStart?(db: Database): void
  onReconcileProgress?(subscribe: (cb: (progress: ReconcileProgress) => void) => () => void): void
}

export interface LineTodoApplication {
  api: Api
  start(): Promise<void>
  stop(): Promise<void>
  dispose(): Promise<void>
}

const RECENT_DAYS = 7
const UPDATE_BUCKETS = new Set<TodoDTO['bucket']>(['todo', 'waiting', 'schedule'])
const UPDATE_COLUMNS = new Set(['todo', 'waiting', 'schedule', 'done'])

function subscribe<T>(events: EventEmitter, event: string, cb: (value: T) => void): () => void {
  events.on(event, cb)
  return () => events.off(event, cb)
}

function sanitizeTodoPatch(raw: unknown): UpdateTodoPatch | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (value.title !== undefined) {
    if (typeof value.title !== 'string' || value.title.trim() === '') return null
    patch.title = value.title.trim()
  }
  if (value.detail !== undefined) {
    if (value.detail !== null && typeof value.detail !== 'string') return null
    patch.detail = value.detail
  }
  if (value.priority !== undefined) {
    if (![1, 2, 3].includes(value.priority as number)) return null
    patch.priority = value.priority
  }
  if (value.dueAt !== undefined) {
    if (value.dueAt === null) patch.dueAt = null
    else if (typeof value.dueAt === 'string' && !Number.isNaN(Date.parse(value.dueAt))) patch.dueAt = value.dueAt
    else return null
  }
  if (value.bucket !== undefined) {
    if (typeof value.bucket !== 'string' || !UPDATE_BUCKETS.has(value.bucket as TodoDTO['bucket'])) return null
    patch.bucket = value.bucket
  }
  if (value.sourceMsgIds !== undefined) {
    if (!Array.isArray(value.sourceMsgIds) || !value.sourceMsgIds.every((id) => typeof id === 'string')) return null
    patch.sourceMsgIds = value.sourceMsgIds
  }
  return patch as UpdateTodoPatch
}

function buildSettingsView(settings: AppSettings, qwen: QwenConfig, isProviderConfigured: boolean, safeStorageAvailable: boolean): SettingsView {
  return {
    ...settings,
    hasApiKey: isProviderConfigured,
    apiKeySource: qwen.source,
    safeStorageAvailable
  }
}

export async function createLineTodoApplication(ports: LineTodoApplicationPorts): Promise<LineTodoApplication> {
  const database = openDatabase({ dbPath: ports.dbPath })
  ports.onDatabase?.(database.db)
  const repos = createRepositories(database.db)
  const settings = ports.settings
  let scheduler: PipelineScheduler
  try {
    const created = ports.scheduler ?? ports.schedulerFactory?.(database.db, repos)
    if (!created) throw new Error('PipelineScheduler must be provided by runtime composition')
    scheduler = created
  } catch (error) {
    database.close()
    throw error
  }
  const events = new EventEmitter()
  const disposers: Array<() => void> = []
  let state: 'stopped' | 'running' | 'disposed' = 'stopped'
  let transition: Promise<void> | null = null
  const recent: RawLineMessage[] = []

  disposers.push(ports.line.onMessage((message) => {
    const native = { ...message }
    delete native.keyMaterial
    delete native.oid
    delete native.sid
    const safe = {
      ...native,
      msgId: deriveMsgId(message) ?? undefined,
      origFilename: message.fileName ?? null
    } as unknown as RawLineMessage
    delete (safe as { fileName?: string }).fileName
    recent.push(safe)
    if (recent.length > 300) recent.splice(0, recent.length - 300)
    events.emit('line-message', safe)
    try {
      const persisted = repos.messages.insert(message)
      if (persisted.inserted > 0) {
        const payload: MessagesPersistedEvent = { chatIds: persisted.chatIds, inserted: persisted.inserted }
        events.emit('messages-persisted', payload)
      }
    } catch (error) {
      console.error('[db] insertMessage failed:', error)
    }
  }))
  disposers.push(ports.line.onStatus((status) => events.emit('line-status', status)))
  const onSchedulerRun = (result: PipelineRunResult) => {
    events.emit('pipeline-run', result)
    if (result.createdIds.length || result.resolvedIds.length || result.updatedIds.length) {
      const changed: TodosChangedEvent = { createdIds: result.createdIds, resolvedIds: result.resolvedIds, updatedIds: result.updatedIds }
      events.emit('todos-changed', changed)
    }
    ports.afterPipelineRun?.(result, database.db)
  }
  const onSchedulerStatus = (status: PipelineStatus) => events.emit('pipeline-status', status)
  scheduler.on('run', onSchedulerRun)
  scheduler.on('status', onSchedulerStatus)
  disposers.push(() => scheduler.off('run', onSchedulerRun), () => scheduler.off('status', onSchedulerStatus))
  const removeReconcileProgress = ports.onReconcileProgress?.((callback) => subscribe(events, 'reconcile-progress', callback))
  if (removeReconcileProgress) disposers.push(removeReconcileProgress)

  const api: Api = {
    ping: async () => ports.app.ping(),
    messages: { recent: async () => recent.slice() },
    line: {
      status: async () => ports.line.status(),
      setRunning: async (running) => { if (running) await ports.line.start(); else await ports.line.stop(); return ports.line.status() },
      onMessage: (cb) => subscribe(events, 'line-message', cb),
      onStatus: (cb) => subscribe(events, 'line-status', cb)
    },
    db: {
      messages: {
        list: async (query) => repos.messages.list(query),
        recentByChat: async (chatId, limit = 30) => repos.messages.recentByChat(chatId, limit),
        byChatSince: async (chatId, sinceMs) => repos.messages.byChatSince(chatId, sinceMs),
        count: async (chatId) => repos.messages.count(chatId)
      },
      chats: {
        list: async (includeBlocked = false) => repos.chats.list({ includeBlocked }),
        get: async (chatId) => repos.chats.get(chatId),
        setBlocked: async (chatId, blocked, reason) => repos.chats.setBlocked(chatId, !!blocked, reason ?? null),
        blockAndClear: async (chatId) => {
          repos.chats.setBlocked(chatId, true, 'manual')
          return { ok: true, dismissed: repos.todos.dismissOpenByChat(chatId) }
        },
        addIgnoreKeyword: async (chatId, keyword) => {
          const kw = (keyword ?? '').trim().toLowerCase()
          if (!chatId) return { ok: false, dismissed: 0, error: '缺少 chatId' }
          if (!kw) return { ok: false, dismissed: 0, error: '關鍵字不可為空' }
          const current = settings.get().chatIgnoreKeywords
          const existing = current[chatId] ?? []
          settings.update({ chatIgnoreKeywords: { ...current, [chatId]: Array.from(new Set([...existing, kw])) } })
          return { ok: true, dismissed: repos.todos.dismissOpenByChat(chatId, kw) }
        },
        removeIgnoreKeyword: async (chatId, keyword) => {
          if (!chatId) return { ok: false }
          const current = settings.get().chatIgnoreKeywords
          const next = { ...current }
          const values = (next[chatId] ?? []).filter((key) => key !== (keyword ?? '').trim().toLowerCase())
          if (values.length) next[chatId] = values; else delete next[chatId]
          settings.update({ chatIgnoreKeywords: next })
          return { ok: true }
        },
        openOriginal: (chatId) => ports.app.openOriginal(chatId)
      },
      todos: {
        list: async (query) => repos.todos.list(query),
        get: async (id) => repos.todos.get(id),
        openByChat: async (chatId) => repos.todos.openByChat(chatId),
        updateStatus: async (id, status) => repos.todos.updateStatus(id, status),
        update: async (id, rawPatch) => {
          if (!id || !rawPatch) return null
          const patch = sanitizeTodoPatch(rawPatch)
          return patch ? repos.todos.update(id, patch) : null
        },
        draftReply: async (id) => {
          if (!id) return { error: '缺少 todo id' }
          const todo = repos.todos.get(id)
          if (!todo) return { error: '找不到該代辦' }
          const provider = ports.providers.resolveProvider()
          if (!provider) return { error: '尚未設定 API 金鑰（請在設定頁填入，或設環境變數 QWEN_API_KEY）' }
          try {
            const chat = repos.chats.get(todo.chatId)
            const limit = ports.pipelineConfig.getDefaults().recentContextLimit || 10
            const recent = repos.messages.recentByChat(todo.chatId, Math.max(limit, 10))
            const draft = await draftReply(provider, {
              todo: { bucket: todo.bucket, title: todo.title, detail: todo.detail },
              chatName: chat?.name ?? null,
              isGroup: chat?.isGroup ?? false,
              recentMessages: recent.map((message) => ({ direction: message.direction, sender: message.sender, text: message.text, timeIso: message.timeIso }))
            }, {})
            return { draft }
          } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
        },
        moveColumn: async (id, toColumn) => {
          if (!id || !UPDATE_COLUMNS.has(toColumn)) return null
          return repos.todos.moveColumn(id, toColumn)
        }
      },
      onMessagesPersisted: (cb) => subscribe(events, 'messages-persisted', cb)
    },
    pipeline: {
      status: async () => scheduler.getStatus(),
      loadStats: async (): Promise<PipelineLoadStats> => ({ ...repos.pipeline.getChatsSeenStats(), recentDays: RECENT_DAYS, chatsWithRecentMessages: repos.messages.countChatsWithRecent(RECENT_DAYS) }),
      runOnce: async () => scheduler.triggerNow(),
      reviewLastDays: async (days = 7): Promise<ReviewLastDaysResult> => reviewLastDays(Number.isFinite(days) && days > 0 ? Math.floor(days) : 7, { db: database.db, onProgress: (progress: BackfillProgress) => events.emit('backfill-progress', progress) }),
      backfillMediaKeys: async (days = 7) => {
        try { const result = await backfillMediaKeys(Number.isFinite(days) && days > 0 ? Math.floor(days) : 7, { db: database.db }); return { ok: true, scanned: result.scanned, mediaBackfilled: result.mediaBackfilled } }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
      },
      setRunning: async (running) => scheduler.setRunning(!!running),
      testQwen: async (): Promise<QwenTestResult> => {
        const config = ports.pipelineConfig.getQwenConfig()
        if (!config.apiKey) return { ok: false, error: '尚未設定 API 金鑰（請在設定頁填入，或設環境變數 QWEN_API_KEY）' }
        return listModels(makeQwen({ apiKey: config.apiKey, baseURL: config.baseURL, timeoutMs: config.timeoutMs }))
      },
      testAiProvider: async (): Promise<ProviderHealth> => {
        const provider = ports.providers.resolveProvider()
        if (!provider) return unconfiguredHealth()
        try { return await provider.health() }
        catch (error) {
          if (error instanceof LlmProviderError) return { ok: false, code: error.code, summary: error.userMessage, details: {} }
          return { ok: false, code: 'unknown', summary: 'AI 引擎健檢失敗（詳細原因請見 log）', details: {} }
        }
      },
      onRun: (cb) => subscribe(events, 'pipeline-run', cb),
      onStatus: (cb) => subscribe(events, 'pipeline-status', cb),
      onTodosChanged: (cb) => subscribe(events, 'todos-changed', cb),
      onBackfillProgress: (cb) => subscribe(events, 'backfill-progress', cb),
      onReconcileProgress: (cb) => subscribe(events, 'reconcile-progress', cb)
    },
    settings: {
      get: async () => buildSettingsView(settings.get(), ports.pipelineConfig.getQwenConfig(), ports.pipelineConfig.isProviderConfigured(), settings.isSafeStorageAvailable()),
      update: async (patch: SettingsPatch) => { settings.update(patch); ports.onSettingsChanged?.(); return buildSettingsView(settings.get(), ports.pipelineConfig.getQwenConfig(), ports.pipelineConfig.isProviderConfigured(), settings.isSafeStorageAvailable()) },
      setApiKey: async (apiKey) => {
        if (typeof apiKey !== 'string') return { ok: false, error: '金鑰格式不正確' }
        try { settings.setApiKey(apiKey); ports.onSettingsChanged?.(); return { ok: true } }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
      },
      clearApiKey: async () => { settings.clearApiKey(); ports.onSettingsChanged?.(); return { ok: true } },
      hasSafeStorageKey: async () => settings.hasSafeStorageKey()
    },
    app: { openDataFolder: () => ports.app.openDataFolder() },
    media: { open: (msgId) => ports.media.open(msgId, database.db), saveAs: (msgId) => ports.media.saveAs(msgId, database.db) }
  }

  const stop = (): Promise<void> => {
    if (state !== 'running') return transition ?? Promise.resolve()
    if (transition) return transition.then(() => stop())
    transition = (async () => {
      try {
        await scheduler.stop()
        await ports.line.stop()
        state = 'stopped'
      } finally { transition = null }
    })()
    return transition
  }

  return {
    api,
    start(): Promise<void> {
      if (state === 'disposed') return Promise.reject(new Error('Application is disposed'))
      if (state === 'running') return transition ?? Promise.resolve()
      if (transition) return transition
      transition = (async () => {
        try {
          await ports.line.start()
          scheduler.start()
          state = 'running'
          ports.afterStart?.(database.db)
        } catch (error) {
          try { await scheduler.stop() } catch { /* preserve startup failure */ }
          try { await ports.line.stop() } catch { /* preserve startup failure */ }
          state = 'stopped'
          throw error
        } finally { transition = null }
      })()
      return transition
    },
    stop(): Promise<void> {
      return stop()
    },
    async dispose(): Promise<void> {
      if (state === 'disposed') return
      let failure: unknown
      try { await stop() } catch (error) { failure = error }
      try { for (const dispose of disposers.splice(0)) dispose() } catch (error) { failure ??= error }
      events.removeAllListeners()
      try { database.close() } catch (error) { failure ??= error }
      state = 'disposed'
      if (failure) throw failure
    }
  }
}
