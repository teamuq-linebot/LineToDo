// Test-only entry for scripts/plugin/check-browser-layout.mjs: the REAL renderer (App, MessageStream, settings…) bundled for a real browser with a fake in-memory api.
// ?many=1 adds 800 finished todos (the board's lazy column rendering);
// ?mode=settings renders the settings view alone; ?phase=timeout makes the chat header status bar show its longest form (retry + restarts + 診斷).
import { createRoot } from 'react-dom/client'
import { LineTodoApiProvider } from '../../../src/renderer/platform/LineTodoApi'
import { PLUGIN_CAPABILITIES } from '../../../src/renderer/platform/capabilities'
import { PluginRootLayout } from '../../../src/plugin/ui/PluginRootLayout'
import { BackendStatusBar } from '../../../src/plugin/ui/BackendStatusBar'
import { ResidencyStatusBar } from '../../../src/plugin/ui/ResidencyStatus'
import { RendererRoot } from '../../../src/renderer/RendererRoot'
import { SettingsPanel } from '../../../src/renderer/components/Settings/SettingsPanel'
import { ProfileMatrixSettings } from '../../../src/renderer/components/Settings/ProfileMatrixSettings'
import { ChatPromptPanel } from '../../../src/renderer/features/chatPrompt/ChatPromptPanel'
import type { ChatPromptControl } from '../../../src/shared/promptSettings'
import type { ChatProfilesControl } from '../../../src/shared/hostAi'
import type { ChatProfileConfig } from '../../../src/shared/chatProfiles'
import { installZoom } from '../../../src/renderer/lib/zoom'
import { browserUiState, UiStateProvider } from '../../../src/renderer/lib/uiState'

installZoom()
const noop = () => () => undefined
const names = ['王小明', '行銷部專案討論群組（含外部廠商與設計師）', 'Alice Chen', '家人群組', '客戶服務中心 VIP 專線客戶溝通群', '陳大文', '週末羽球團', '財務部', '工程部每日站會', '林老師', 'Supplier Taiwan Co., Ltd. Sales Team', '媽媽']
const iso = (d: number) => new Date(Date.UTC(2026, 10, 8, 3, 0, 0) - d * 3600e3).toISOString()
const chats = names.map((n, i) => ({ chatId: `c${i}`, name: n, isGroup: [1, 3, 4, 6, 8, 10].includes(i), firstSeenAt: iso(500), lastSeenAt: iso(i) }))
const longTitle = '請在本週五之前把第三季行銷預算簡報的最終版本寄給財務部並副本給所有相關部門主管，包含附件與說明文件'
const row = (i: number, bucket: string, status: string) => ({
  id: `t${i}`, chatId: `c${i % 12}`, bucket, status, title: i % 3 === 0 ? longTitle : `範例待辦 ${i}`, detail: i % 2 ? '這是一段說明文字，內容稍微長一點，用來觀察換行與截斷的行為是否正常。' : null, priority: (i % 3) + 1,
  dueAt: i % 4 === 0 ? iso(-30) : null, sourceMsgIds: [`m${i}`], confidence: 0.9, completionEvidence: status === 'suggested_done' ? '對方已回覆已收到' : null, createdAt: iso(40), updatedAt: iso(i), resolvedAt: status === 'done' ? iso(2) : null
})
const todos = [
  ...Array.from({ length: 8 }, (_, i) => row(i, 'todo', 'pending')),
  ...Array.from({ length: 4 }, (_, i) => row(100 + i, 'waiting', 'waiting_reply')),
  ...Array.from({ length: 3 }, (_, i) => row(200 + i, 'schedule', 'scheduled')),
  ...Array.from({ length: 4 }, (_, i) => row(300 + i, 'todo', 'done')),
  row(400, 'todo', 'suggested_done'),
  ...(new URLSearchParams(location.search).get('many') === '1' ? Array.from({ length: 800 }, (_, i) => row(1000 + i, 'todo', 'done')) : [])
]
const svg = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="#9ec2f5"/><text x="800" y="600" font-size="120" text-anchor="middle">IMG</text></svg>')
const photoFixture = (window as unknown as { __actualPhotoFixture?: { rows: unknown[]; urls: Record<string, string> } }).__actualPhotoFixture
// `video-cell`：每個聊天室的第 26 則（較新，落在可見範圍內）是影片（ct=2）；沒有保存檔，所以畫面應顯示「影片尚未下載」（M2 的影片格）。
// 不綁定 c0：場景點的是清單第一個聊天室，而 listPrefs 把 c1 置頂（MessageStream 置頂排前），第一個是 c1 不是 c0。
const videoCellRow = (_chatId: string, i: number) => i === 25 && new URLSearchParams(location.search).has('video-cell')
const msgs = (chatId: string) => photoFixture && chatId === 'c0' && new URLSearchParams(location.search).has('photo-cache') ? photoFixture.rows : Array.from({ length: 30 }, (_, i) => ({
  msgId: `${chatId}:m${i}`, chatId, ts: Date.UTC(2026, 10, 7, 1, i), timeIso: iso(30 - i), direction: i % 3 === 0 ? 'out' : 'in', sender: i % 3 === 0 ? null : '王小明',
  text: videoCellRow(chatId, i) ? '[video]' : i === 5 ? null : i % 4 === 0 ? '這是一段很長很長的訊息內容 '.repeat(8) + 'https://example.com/a/very/long/url/that/never/breaks/' + 'x'.repeat(60) : `訊息 ${i}`,
  contentType: videoCellRow(chatId, i) ? 2 : i === 5 ? 1 : 0, processed: true, ingestedAt: iso(1), origFilename: null, fileSize: null, unsent: false
}))
// `originals`（X7 Pro 下載原檔的版面）：第 5 則照片、第 20–22 則三張一組的照片（窄格）、第 25 則影片、第 27 則長檔名的檔案都「尚未下載」，
// 各給一種狀態（含最長的文字與按鈕）；有可下載的格子，所以標題列出現批次列。
const originalsScene = new URLSearchParams(location.search).has('originals')
const ORIGINAL_CT: Record<number, number> = { 5: 1, 20: 1, 21: 1, 22: 1, 25: 2, 27: 14 }
const ORIGINAL_STATE: Record<number, { state: string; code?: string; retryAt?: number; bytesDone?: number; declaredBytes?: number }> = {
  5: { state: 'idle' }, 20: { state: 'idle' }, 21: { state: 'running' }, 22: { state: 'failed', code: 'TRANSIENT', retryAt: 0 },
  25: { state: 'paused', code: 'hourly_limit' }, 27: { state: 'running', bytesDone: 1_200_000, declaredBytes: 2_400_000 }
}
const originalIndex = (msgId: unknown): number | null => {
  const m = /^i:c\d+-m(\d+)$/.exec(String(msgId))
  return originalsScene && m && Number(m[1]) in ORIGINAL_CT ? Number(m[1]) : null
}
const GROUP_TS = Date.UTC(2026, 10, 7, 1, 20, 0)
const withOriginals = (rows: ReturnType<typeof msgs>) => (!originalsScene ? rows : (rows as Array<Record<string, unknown>>).map((r, i) => {
  const ct = ORIGINAL_CT[i]
  if (ct === undefined) return r
  return {
    // LINE 訊息的 id（'i:' 開頭）才有原檔可下載；其他 id 不給按鈕
    ...r, msgId: `i:${String(r.chatId)}-m${i}`, contentType: ct, direction: 'in', sender: '王小明', text: ct === 14 ? '' : '[media]',
    origFilename: ct === 14 ? '第三季行銷預算簡報最終版本（含附件與各部門主管審閱說明文件）.pdf' : null, fileSize: ct === 14 ? 2_400_000 : null,
    ...(i >= 20 && i <= 22 ? { ts: GROUP_TS + (i - 20) * 1000, timeIso: new Date(GROUP_TS + (i - 20) * 1000).toISOString() } : {})
  }
}))
const messageRows = (chatId: unknown) => photoFixture && new URLSearchParams(location.search).has('photo-cache') ? photoFixture.rows : withOriginals(msgs(String(chatId)))
const settings = {
  pollIntervalSec: 60, concurrency: 2, recentContextLimit: 20, blocklist: { chatNames: ['廣告群'], senderNames: [], keywords: ['促銷'], patterns: [] } as never, chatIgnoreKeywords: { c0: ['貼圖', '早安'] }, openAtLogin: false, reconcile: { enabled: true, scopeMonths: 3 },
  aiBaseUrl: '', aiProvider: 'http', claudeCli: {} as never, codexCli: {} as never, pluginAi: { providerId: null, modelId: null, effort: null }, pluginPrompt: null, pluginMyName: '小明', pluginCombinedExtract: true, driverPost: {} as never, hasApiKey: true, apiKeySource: 'safeStorage', safeStorageAvailable: true
}
const topic = (i: number, chatId: string) => ({ topicId: `${chatId}-p${i}`, chatId, title: `議題 ${i}：第三季行銷預算簡報最終版本與各部門審閱進度`, summary: '第三季行銷預算簡報已進入最終版本確認，財務部與各部門主管的回覆陸續收到，目前尚缺兩個部門的意見。', lastSourceTs: Date.UTC(2026, 10, 7), evidenceCount: 3, evidenceMsgIds: ['m1', 'm2', 'a-very-long-evidence-message-id-without-any-break-opportunity-0123456789'], participantLowerBound: 3, userParticipation: 'i_participated', relevance: 'action', relevanceEvidenceMsgIds: [], relevanceEvidence: [], observation: 'unknown', heat: 'unvalidated', trend: 'unknown' })
const overview = chats.filter((c) => c.isGroup).map((c) => ({ chatId: c.chatId, name: c.name, enabled: true, topics: [topic(1, c.chatId), topic(2, c.chatId)], topicCount: 2, pendingCount: 0, backlogCount: 0 }))
const hostAiOptions = { defaultProviderId: 'claude', quota: { state: 'ok' }, providers: [{ id: 'claude', label: 'Claude', state: 'ready', models: [{ id: 'm1', label: 'Sonnet 長長的模型名稱用來測試換行', isDefault: true, efforts: ['low', 'medium', 'high'] }] }, { id: 'codex', label: 'Codex', state: 'unavailable', models: [] }] }
const table: Record<string, (...a: unknown[]) => unknown> = {
  'ping': () => ({ ok: true, ts: 0, version: '0.2.17' }),
  'db.chats.listPrefs': () => ({ prefsReady: true, topicsAvailable: true, pinned: ['c1'], hidden: [], todoOff: ['c5'], topicsOn: [] }),
  'db.chats.list': () => chats, 'db.chats.get': (id) => chats.find((c) => c.chatId === id) ?? null, 'db.chats.todoExtractEnabled': () => true,
  'db.messages.list': (q) => messageRows((q as { chatId?: string })?.chatId ?? 'c0'), 'db.messages.recentByChat': (id) => messageRows(id), 'db.messages.byChatSince': (id) => messageRows(id), 'db.messages.count': () => 30,
  'db.todos.list': () => todos, 'db.todos.openByChat': (id) => todos.filter((t) => t.chatId === id), 'db.todos.listNotMine': () => [], 'db.todos.listNotMineCorrections': () => [],
  'db.todos.moveColumn': () => null, 'db.todos.draftReply': () => ({ ok: true, draft: '好的，我會在週五之前寄出。' }),
  'line.status': () => ({ state: 'running', lastMessageAt: iso(1), messageCount: 1234, lastError: null, restarts: 2 }),
  'pipeline.status': () => ({ running: true, busy: false, intervalSec: 60, lastRunAt: iso(1), lineBridge: 'ok', llmStatus: 'ok', hasApiKey: true, lastError: null }),
  'pipeline.loadStats': () => ({ sampleRuns: 50, chatsSeenP50: 5, chatsSeenP90: 10, chatsSeenMax: 40, recentDays: 7, chatsWithRecentMessages: 12 }),
  'pipeline.longTaskStatus': () => ({ review: null, mediaBackfill: null }),
  'settings.get': () => settings, 'settings.hasSafeStorageKey': () => true,
  'groupTopics.overview': () => overview, 'groupTopics.list': (id) => ({ ok: true, topics: [topic(1, String(id)), topic(2, String(id))] }), 'groupTopics.pendingCount': () => 0, 'groupTopics.todoRefs': () => [],
  // 影片與已保存檔案：這份合成資料沒有保存檔＝回 null（影片格顯示「影片尚未下載」，檔案卡保持原樣）。
  'media.videoAssetUrl': () => null, 'media.savedFile': () => null,
  // X7：下載原檔的狀態（只讀本地，畫面輪詢）；其他場景沒有 originals 參數，格子查不到狀態＝不顯示任何東西
  'linejsMedia.original.status': (ids) => ({ items: (ids as string[]).map((msgId) => { const i = originalIndex(msgId); return { msgId, ...(i === null ? { state: 'unsupported' } : ORIGINAL_STATE[i]) } }), batch: null, paused: null }),
  'media.assetUrl': () => svg, 'media.assetLookup': (id) => {
    if (originalIndex(id) !== null) return { url: null, indexing: false }
    const state = window as unknown as { __actualPhotoMediaLookups?: { supplied: boolean }[] }
    state.__actualPhotoMediaLookups ??= []
    const url = photoFixture?.urls[String(id)]
    state.__actualPhotoMediaLookups.push({ supplied: Boolean(url) })
    return { url: url ?? svg, indexing: false }
  }, 'media.avatarUrls': () => ({ urls: {}, names: {} }), 'media.messageAvatarUrls': (chatId, ids) => {
    const state = window as unknown as { __actualPhotoAvatarRequests?: { chatId: unknown; ids: unknown }[] }
    state.__actualPhotoAvatarRequests ??= []
    state.__actualPhotoAvatarRequests.push({ chatId, ids })
    return { urls: {}, names: {} }
  }
}
// One stable proxy per path: panels list api objects in effect deps, a fresh proxy on every read would restart their effects forever.
const proxies = new Map<string, unknown>()
function mk(path: string): unknown {
  const cached = proxies.get(path)
  if (cached) return cached
  const proxy = new Proxy(function () { /* */ }, {
    get(_t, prop: string) { return prop === 'then' ? undefined : prop === 'call' ? Function.prototype.call : mk(path ? `${path}.${prop}` : prop) },
    apply(_t, _this, args) {
      const last = path.split('.').pop() as string
      if (/^on[A-Z]/.test(last)) return () => undefined
      const fn = table[path]
      return Promise.resolve(fn ? fn(...args) : { ok: true })
    }
  })
  proxies.set(path, proxy)
  return proxy
}
const promptState = { initialPrompt: '預設提示 '.repeat(60), activePrompt: '預設提示 '.repeat(60), customized: false, revision: 'r1', maxChars: 12000, outputFormat: '{"todos":[{"title":"...","detail":"..."}]}', topicAppendix: '已啟用議題的群組，系統會另外附加固定段落。', myName: '小明', nameRevision: 'n1', maxNameChars: 40 }
const chatState = (chatId: string) => ({ chatId, revision: 'c1', overridePrompt: null, overrideName: null, effectivePrompt: '預設提示 '.repeat(40), effectiveName: '小明', promptSource: 'default', nameSource: 'default', defaultName: '小明', maxChars: 12000, maxNameChars: 40, corrupt: false })
const fixtureKinds = ['group', 'non_group', 'unknown'] as const
const fixtureNatures = [
  ['work_project', '工作／專案協作'], ['time_schedule', '時間／行程協調'], ['announcement_event', '公告／活動資訊'],
  ['social_life', '社交／生活互動'], ['mixed_unclassified', '混合／未分類'], ['custom_weekend_trip', '週末旅行規劃']
]
const profileMatrix = Object.fromEntries(fixtureKinds.map((kind) => [kind, Object.fromEntries(fixtureNatures.map(([id]) => [id, { todoInstruction: `${kind}待辦規則：${id}`, topicInstruction: `${kind}議題規則：${id}` }]))])) as ChatProfileConfig['matrix']
let profileConfig: ChatProfileConfig = { schemaVersion: 1, revision: 'fixture-profile-r1', customNatures: [{ id: 'custom_weekend_trip', label: '週末旅行規劃' }], matrix: profileMatrix, updatedAt: '2026-01-01T00:00:00.000Z' }
const profileControl: ChatProfilesControl = {
  getConfig: async () => profileConfig,
  saveConfig: async (config, expectedRevision) => {
    if (expectedRevision !== profileConfig.revision) throw new Error('revision_conflict')
    profileConfig = { ...config, revision: `fixture-profile-r${Number(profileConfig.revision.slice(-1)) + 1}` }
    return profileConfig
  },
  getChat: async () => null,
  saveChat: async (_id, value) => ({ ...value, revision: 'fixture-chat-r2', resetLegacyTodo: Boolean(value.resetLegacyTodo) }),
  resolve: async (chatId) => ({ chatId, chatKind: 'group', natureId: 'work_project', natureLabel: '工作／專案協作', todo: { instruction: '合成目前待辦規則', source: 'matrix' }, topic: { instruction: '合成目前議題規則', source: 'matrix' }, myName: { value: null, source: 'none' }, revision: 'fixture-chat-r1', archivedNature: false }),
  suggestRule: async (_chatId, kind) => ({ kind, chatKind: 'group', natureId: 'work_project', baseRule: kind === 'todo' ? '合成目前待辦規則' : '合成目前議題規則', baseProfileRevision: 'fixture-chat-r1', draftRule: '合成 AI 建議草稿', changes: ['增加具體判斷條件'], modelId: 'synthetic-fixture' })
}
const chatPromptControl: ChatPromptControl = { get: async (chatId) => ({ chatId, revision: 'prompt-r1', overridePrompt: null, overrideName: null, effectivePrompt: '合成抽取規則', effectiveName: null, promptSource: 'default', nameSource: 'none', defaultName: null, maxChars: 12000, maxNameChars: 40, corrupt: false }), save: async () => { throw new Error('unused') }, reset: async () => { throw new Error('unused') }, list: async () => [] }
const hostAiCtl = { getOptions: async () => hostAiOptions, getSelection: async () => ({ providerId: null, modelId: null, effort: null }), setSelection: async (s: unknown) => s,
  prompts: { get: async () => promptState, save: async () => promptState, reset: async () => promptState, saveName: async () => promptState, refine: async () => ({ prompt: 'x', changes: ['a'], modelId: null }) },
  chatPrompts: { get: async (id: string) => chatState(id), save: async (id: string) => chatState(id), reset: async (id: string) => chatState(id), list: async () => [] }, profiles: profileControl }
const base = mk('') as Record<string, unknown>
const api = new Proxy({} as Record<string, unknown>, { get: (_t, p: string) => (p === 'then' ? undefined : p === 'hostAi' ? hostAiCtl : p === 'plugin' ? pluginSource : base[p]) })
const phase = new URLSearchParams(location.search).get('phase') === 'timeout' ? 'timeout' : 'ready'
const pluginSource = {
  backendPhase: () => phase,
  onBackendPhase: () => () => undefined,
  backendDiagnostics: () => ({ phase, calls: [{ path: 'db.chats.list', lane: 'core', waitedMs: 12000, running: true }], lastError: { code: 'view_call_timeout', path: 'db.chats.list' }, timeouts: 1 }),
  info: async () => ({ pid: 12345, uptimeMs: 3723000 })
}
const w = window as never as { tuqPlugin?: unknown }
w.tuqPlugin = { presentation: { get: async () => ({ mode: 'tab' }), request: async (m: string) => ({ ok: true, state: { mode: m } }), onChange: () => () => undefined } }
const src = { backendLink: () => ({ state: 'ok', code: null }) as never, onBackendLink: noop, residency: async () => ({ supported: false }) as never, onResidency: noop }
const mode = new URLSearchParams(location.search).get('mode') ?? 'board'
const root = createRoot(document.getElementById('root')!)
if (mode === 'chat-profile-assist') {
  root.render(<LineTodoApiProvider api={api as never} capabilities={PLUGIN_CAPABILITIES}><div className="settings-wrap"><ChatPromptPanel chatId="synthetic-profile-chat" chatName="合成聊天室" control={chatPromptControl} /></div></LineTodoApiProvider>)
} else if (mode === 'profile-matrix') {
  root.render(<div className="settings-wrap"><ProfileMatrixSettings control={profileControl} /></div>)
} else if (mode === 'settings') {
  root.render(<LineTodoApiProvider api={api as never} capabilities={PLUGIN_CAPABILITIES}><UiStateProvider value={browserUiState()}><div className="app-shell"><main className="app-main"><SettingsPanel /></main></div></UiStateProvider></LineTodoApiProvider>)
} else {
  root.render(
    <PluginRootLayout header={<BackendStatusBar source={src as never} />} footer={<ResidencyStatusBar source={src as never} />}>
      <RendererRoot api={api as never} capabilities={PLUGIN_CAPABILITIES} uiState={browserUiState()} />
    </PluginRootLayout>
  )
}
