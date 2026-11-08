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
const msgs = (chatId: string) => Array.from({ length: 30 }, (_, i) => ({
  msgId: `${chatId}:m${i}`, chatId, ts: Date.UTC(2026, 10, 7, 1, i), timeIso: iso(30 - i), direction: i % 3 === 0 ? 'out' : 'in', sender: i % 3 === 0 ? null : '王小明',
  text: i === 5 ? null : i % 4 === 0 ? '這是一段很長很長的訊息內容 '.repeat(8) + 'https://example.com/a/very/long/url/that/never/breaks/' + 'x'.repeat(60) : `訊息 ${i}`, contentType: i === 5 ? 1 : 0, processed: true, ingestedAt: iso(1), origFilename: null, fileSize: null, unsent: false
}))
const settings = {
  pollIntervalSec: 60, concurrency: 2, recentContextLimit: 20, blocklist: { chatNames: ['廣告群'], senderNames: [], keywords: ['促銷'], patterns: [] } as never, chatIgnoreKeywords: { c0: ['貼圖', '早安'] }, openAtLogin: false, reconcile: { enabled: true, scopeMonths: 3 },
  aiBaseUrl: '', aiProvider: 'http', claudeCli: {} as never, codexCli: {} as never, pluginAi: { providerId: null, modelId: null, effort: null }, pluginPrompt: null, pluginMyName: '小明', pluginCombinedExtract: true, driverPost: {} as never, hasApiKey: true, apiKeySource: 'safeStorage', safeStorageAvailable: true
}
const topic = (i: number, chatId: string) => ({ topicId: `${chatId}-p${i}`, chatId, title: `議題 ${i}：${longTitle.slice(0, 30)}`, summary: '摘要文字 '.repeat(14), lastSourceTs: Date.UTC(2026, 10, 7), evidenceCount: 3, evidenceMsgIds: ['m1', 'm2', 'a-very-long-evidence-message-id-without-any-break-opportunity-0123456789'], participantLowerBound: 3, userParticipation: 'i_participated', relevance: 'action', relevanceEvidenceMsgIds: [], relevanceEvidence: [], observation: 'unknown', heat: 'unvalidated', trend: 'unknown' })
const overview = chats.filter((c) => c.isGroup).map((c) => ({ chatId: c.chatId, name: c.name, enabled: true, topics: [topic(1, c.chatId), topic(2, c.chatId)], topicCount: 2, pendingCount: 0, backlogCount: 0 }))
const hostAiOptions = { defaultProviderId: 'claude', quota: { state: 'ok' }, providers: [{ id: 'claude', label: 'Claude', state: 'ready', models: [{ id: 'm1', label: 'Sonnet 長長的模型名稱用來測試換行', isDefault: true, efforts: ['low', 'medium', 'high'] }] }, { id: 'codex', label: 'Codex', state: 'unavailable', models: [] }] }
const table: Record<string, (...a: unknown[]) => unknown> = {
  'ping': () => ({ ok: true, ts: 0, version: '0.2.17' }),
  'db.chats.listPrefs': () => ({ prefsReady: true, topicsAvailable: true, pinned: ['c1'], hidden: [], todoOff: ['c5'], topicsOn: [] }),
  'db.chats.list': () => chats, 'db.chats.get': (id) => chats.find((c) => c.chatId === id) ?? null, 'db.chats.todoExtractEnabled': () => true,
  'db.messages.list': (q) => msgs(String((q as { chatId?: string })?.chatId ?? 'c0')), 'db.messages.recentByChat': (id) => msgs(String(id)), 'db.messages.byChatSince': (id) => msgs(String(id)), 'db.messages.count': () => 30,
  'db.todos.list': () => todos, 'db.todos.openByChat': (id) => todos.filter((t) => t.chatId === id), 'db.todos.listNotMine': () => [], 'db.todos.listNotMineCorrections': () => [],
  'db.todos.moveColumn': () => null, 'db.todos.draftReply': () => ({ ok: true, draft: '好的，我會在週五之前寄出。' }),
  'line.status': () => ({ state: 'running', lastMessageAt: iso(1), messageCount: 1234, lastError: null, restarts: 2 }),
  'pipeline.status': () => ({ running: true, busy: false, intervalSec: 60, lastRunAt: iso(1), lineBridge: 'ok', llmStatus: 'ok', hasApiKey: true, lastError: null }),
  'pipeline.loadStats': () => ({ sampleRuns: 50, chatsSeenP50: 5, chatsSeenP90: 10, chatsSeenMax: 40, recentDays: 7, chatsWithRecentMessages: 12 }),
  'pipeline.longTaskStatus': () => ({ review: null, mediaBackfill: null }),
  'settings.get': () => settings, 'settings.hasSafeStorageKey': () => true,
  'groupTopics.overview': () => overview, 'groupTopics.list': (id) => ({ ok: true, topics: [topic(1, String(id)), topic(2, String(id))] }), 'groupTopics.pendingCount': () => 0, 'groupTopics.todoRefs': () => [],
  'media.assetUrl': () => svg, 'media.assetLookup': () => ({ url: svg, indexing: false }), 'media.avatarUrls': () => ({ urls: {}, names: {} }), 'media.messageAvatarUrls': () => ({ urls: {}, names: {} })
}
// One stable proxy per path: panels list api objects in effect deps, a fresh proxy on every read would restart their effects forever.
const proxies = new Map<string, unknown>()
function mk(path: string): unknown {
  const cached = proxies.get(path)
  if (cached) return cached
  const proxy = new Proxy(function () { /* */ }, {
    get(_t, prop: string) { return prop === 'then' ? undefined : mk(path ? `${path}.${prop}` : prop) },
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
const hostAiCtl = { getOptions: async () => hostAiOptions, getSelection: async () => ({ providerId: null, modelId: null, effort: null }), setSelection: async (s: unknown) => s,
  prompts: { get: async () => promptState, save: async () => promptState, reset: async () => promptState, saveName: async () => promptState, refine: async () => ({ prompt: 'x', changes: ['a'], modelId: null }) },
  chatPrompts: { get: async (id: string) => chatState(id), save: async (id: string) => chatState(id), reset: async (id: string) => chatState(id), list: async () => [] } }
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
if (mode === 'settings') {
  root.render(<LineTodoApiProvider api={api as never} capabilities={PLUGIN_CAPABILITIES}><UiStateProvider value={browserUiState()}><div className="app-shell"><main className="app-main"><SettingsPanel /></main></div></UiStateProvider></LineTodoApiProvider>)
} else {
  root.render(
    <PluginRootLayout header={<BackendStatusBar source={src as never} />} footer={<ResidencyStatusBar source={src as never} />}>
      <RendererRoot api={api as never} capabilities={PLUGIN_CAPABILITIES} uiState={browserUiState()} />
    </PluginRootLayout>
  )
}
