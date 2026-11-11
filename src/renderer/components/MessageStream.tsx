import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatDTO, ChatListPrefsDTO, MessageDTO, RawLineMessage, LineBridgeStatus } from '../../shared/api'
import { useBackendPhase, useLineStream } from '../hooks/useLineStream'
import type { BackendPhaseSource } from '../hooks/useLineStream'
import type { BackendDiagnostics, BackendPhase } from '../platform/pluginTransport'
import { backendErrorText, describePhase } from '../lib/backendError'
import { formatCallRecord } from '../lib/callRecord'
import { hasSavedMessageText, mergeMessageCopies, recalledMessageNotice, recalledMessageText } from '../lib/recalledMessage'
import { useLineTodoApi } from '../platform/LineTodoApi'
import { displayChatName } from '../lib/displayChatName'
import { chatMessageTimeLabel, compareChatMessageTimes } from '../lib/chatList'
import { GroupTopicsPanel } from '../features/groupTopics/GroupTopicsPanel'
import { ChatRefreshControl } from '../features/chatRefresh/ChatRefreshControl'
import { ChatTodosPanel } from '../features/chatTodos/ChatTodosPanel'
import { ChatPromptPanel } from '../features/chatPrompt/ChatPromptPanel'
import { MediaFileActions, MediaImage } from './MediaView'
import { ContextMenu, ContextMenuItem } from './ContextMenu'
import { AvatarZoomDialog } from './AvatarZoomDialog'
import { HeaderStatus } from './HeaderStatusSlot'
import { focusFirstMenuItem, useContextMenuKeys } from '../hooks/useContextMenuKeys'
import { layoutScale, placeFixedMenu, type MenuPlacement } from '../lib/zoom'

interface ConversationEntry {
  chatId: string
  name: string
  isGroup: boolean
  latestMessageTs: number | null
  latest: RawLineMessage | null
  loadedCount: number
}

type PaneView = 'messages' | 'topicsTodos' | 'aiSettings'

const HISTORY_PAGE_SIZE = 100

const EMPTY_PREFS: ChatListPrefsDTO = { prefsReady: false, topicsAvailable: false, pinned: [], hidden: [], todoOff: [], topicsOn: [] }
const LIST_MENU_WIDTH = 168
const LIST_ACTION_ERROR = '操作失敗，請再試一次'

type ListAction = 'pin' | 'unpin' | 'ignore' | 'restore' | 'hide' | 'unhide'

interface ListMenuState {
  chatId: string
  placement: MenuPlacement
}

const withoutId = (list: string[], id: string): string[] => list.filter((item) => item !== id)
const withId = (list: string[], id: string): string[] => (list.includes(id) ? list : [...list, id])

/** 動作成功後，在畫面上套用與後端相同的結果（後端同一個交易寫好了，不必再讀一次）。 */
function patchPrefs(prefs: ChatListPrefsDTO, chatId: string, action: ListAction): ChatListPrefsDTO {
  switch (action) {
    case 'pin': return { ...prefs, pinned: withId(prefs.pinned, chatId) }
    case 'unpin': return { ...prefs, pinned: withoutId(prefs.pinned, chatId) }
    case 'ignore': return { ...prefs, todoOff: withId(prefs.todoOff, chatId), topicsOn: withoutId(prefs.topicsOn, chatId) }
    case 'restore': return { ...prefs, todoOff: withoutId(prefs.todoOff, chatId), topicsOn: prefs.topicsAvailable ? withId(prefs.topicsOn, chatId) : prefs.topicsOn }
    case 'hide': return { ...prefs, hidden: withId(prefs.hidden, chatId), pinned: withoutId(prefs.pinned, chatId), todoOff: withId(prefs.todoOff, chatId), topicsOn: withoutId(prefs.topicsOn, chatId) }
    case 'unhide': return { ...prefs, hidden: withoutId(prefs.hidden, chatId) }
  }
}

/**
 * 狀態列的一句話。外掛版有 phase（pluginTransport.ts）：逾時與無法連線不可隱藏（紅點＋「重試」），啟動中與連線中分開寫；
 * standalone 沒有 phase（null），維持原本的文字。`retrying`＝使用者剛按了「重試」，等結果回來之前不再顯示舊的逾時。
 */
function statusLabel(s: LineBridgeStatus | null, phase: BackendPhase | null, retrying: boolean): { text: string; cls: string; retry: boolean } {
  if (retrying) return { text: '重試中…', cls: '', retry: false }
  const described = describePhase(phase)
  if (described && described.tone === 'err') return { text: described.text, cls: 'err', retry: described.retry }
  if (!s) return { text: described?.text ?? '連線中…', cls: '', retry: false }
  return { ...bridgeLabel(s), retry: false }
}

function bridgeLabel(s: LineBridgeStatus): { text: string; cls: string } {
  switch (s.state) {
    case 'running':
      return { text: `運行中 · 已收 ${s.messageCount} 則`, cls: 'ok' }
    case 'starting':
      return { text: '啟動中…', cls: '' }
    case 'error':
      return { text: `橋接錯誤：${s.lastError ?? '未知'}（將自動重試）`, cls: 'err' }
    case 'stopped':
    default:
      return { text: '已停止', cls: '' }
  }
}

/** bytes → 「NN.N KB」/「NN.N MB」（< 1 KB 顯示 B）；null/undefined 回空字串。 */
function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function chatTimeLabel(chat: ConversationEntry): string {
  return chatMessageTimeLabel(chat.latestMessageTs ?? null)
}

function messageTimeLabel(message: RawLineMessage): string {
  const time = message.time ?? ''
  return time.length >= 16 ? time.slice(11, 16) : time || '--:--'
}

function compareMessages(a: RawLineMessage, b: RawLineMessage): number {
  return a.ts - b.ts || a.time.localeCompare(b.time)
}

function messageKey(message: RawLineMessage): string {
  if (message.msgId) return `id:${message.msgId}`
  return `${message.chatId}:${message.ts}:${message.sender}:${message.text}`
}

function avatarMark(label: string, isGroup: boolean): string {
  if (isGroup) return '群'
  return [...label.trim()][0] ?? '友'
}

// A failed host asset must remain a text avatar for this renderer session. Keeping
// the failed source outside the component also prevents remounts (for example,
// scrolling a row out and back in) from showing Chromium's broken-image glyph.
const failedAvatarSources = new Set<string>()
const MAX_FAILED_AVATAR_SOURCES = 256

function sameIds(current: string[], next: string[]): boolean {
  return current.length === next.length && current.every((id, index) => id === next[index])
}

function mergeRecord(current: Record<string, string>, incoming: Record<string, string>): Record<string, string> {
  let changed = false
  for (const [key, value] of Object.entries(incoming)) {
    if (current[key] !== value) { changed = true; break }
  }
  return changed ? { ...current, ...incoming } : current
}

function rememberFailedAvatarSource(source: string): void {
  failedAvatarSources.delete(source)
  failedAvatarSources.add(source)
  if (failedAvatarSources.size > MAX_FAILED_AVATAR_SOURCES) {
    const oldest = failedAvatarSources.values().next().value
    if (oldest) failedAvatarSources.delete(oldest)
  }
}

function useAvatarPhoto(url: string | undefined): { photo: string | null; onError: () => void } {
  const [failedSource, setFailedSource] = useState<string | null>(() =>
    url && failedAvatarSources.has(url) ? url : null
  )

  useEffect(() => {
    setFailedSource(url && failedAvatarSources.has(url) ? url : null)
  }, [url])

  const photo = !url || failedSource === url || failedAvatarSources.has(url) ? null : url
  return {
    photo,
    onError: () => {
      if (!url) return
      rememberFailedAvatarSource(url)
      setFailedSource(url)
    }
  }
}

function AvatarImage({ src, onError }: { src: string; onError: () => void }): JSX.Element {
  return <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={onError} />
}

function AvatarGlyph({ url, label, isGroup }: { url?: string; label: string; isGroup: boolean }): JSX.Element | string {
  const { photo, onError } = useAvatarPhoto(url)
  if (!photo) return avatarMark(label, isGroup)
  return <AvatarImage src={photo} onError={onError} />
}

/** 有照片時是可點的按鈕（點了放大，只顯示大頭貼與名字）；只有字母時維持原本不可點的圓形標記。 */
function ZoomableAvatar({ url, label, name, isGroup, className, title, chatId }: {
  url?: string
  label: string
  name: string
  isGroup: boolean
  className: string
  title?: string
  chatId?: string
}): JSX.Element {
  const { photo, onError } = useAvatarPhoto(url)
  const [zoomSrc, setZoomSrc] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const close = (): void => {
    setZoomSrc(null)
    triggerRef.current?.focus()
  }
  return (
    <>
      {photo ? (
        <button
          ref={triggerRef}
          type="button"
          className={`${className} avatar-zoom-trigger`}
          aria-label={name}
          title={title}
          data-avatar-chat-id={chatId}
          onClick={() => setZoomSrc(photo)}
        >
          <AvatarImage src={photo} onError={onError} />
        </button>
      ) : (
        <span className={className} aria-hidden="true" title={title} data-avatar-chat-id={chatId}>
          {avatarMark(label, isGroup)}
        </span>
      )}
      {zoomSrc && <AvatarZoomDialog src={zoomSrc} name={name} onClose={close} />}
    </>
  )
}

function waitedSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} 秒`
}

function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.floor(ms / 1000)} 秒`
  if (minutes < 60) return `${minutes} 分鐘`
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分鐘`
}

/**
 * 「診斷」（原生 <details>，預設收合）：phase、各 core 呼叫已等待秒數、最近一次錯誤碼、後端 pid／uptime（backend.info）。
 * 只在展開時才每秒更新、才讀 backend.info；讀不到的值顯示「未知」，不會顯示成 0。
 */
function BackendDiagnosticsPanel({ source }: { source: BackendPhaseSource }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<BackendDiagnostics | null>(null)
  const [backend, setBackend] = useState<{ pid: number | null; uptimeMs: number | null } | 'unknown' | null>(null)

  useEffect(() => {
    if (!open) return undefined
    let active = true
    setSnapshot(source.backendDiagnostics())
    const timer = setInterval(() => setSnapshot(source.backendDiagnostics()), 1000)
    source.info().then((info) => {
      if (!active) return
      setBackend({
        pid: typeof info.pid === 'number' && Number.isFinite(info.pid) ? info.pid : null,
        uptimeMs: typeof info.uptimeMs === 'number' && Number.isFinite(info.uptimeMs) ? info.uptimeMs : null
      })
    }, () => { if (active) setBackend('unknown') })
    return () => { active = false; clearInterval(timer) }
  }, [open, source])

  const coreCalls = snapshot?.calls.filter((call) => call.lane === 'core') ?? []
  const phaseText = snapshot ? (describePhase(snapshot.phase)?.text ?? '正常') : '…'
  const backendText = backend === null ? '讀取中…'
    : backend === 'unknown' ? '未知'
      : `pid ${backend.pid ?? '未知'} · 已執行 ${backend.uptimeMs === null ? '未知' : formatUptime(backend.uptimeMs)}`
  return (
    <details className="stream-diag" data-testid="backend-diagnostics" onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>診斷</summary>
      <dl className="stream-diag-body">
        <div><dt>狀態</dt><dd data-diag="phase">{phaseText}</dd></div>
        <div><dt>等待中的讀取</dt><dd data-diag="calls">{snapshot === null ? '…' : coreCalls.length === 0 ? '無' : coreCalls.map((call) => `${call.path} ${waitedSeconds(call.waitedMs)}${call.running ? '' : '（排隊）'}`).join('、')}</dd></div>
        <div><dt>最近錯誤</dt><dd data-diag="error">{snapshot === null ? '…' : snapshot.lastError ? `${snapshot.lastError.code}（${snapshot.lastError.path}）` : '無'}</dd></div>
        <div><dt>後端</dt><dd data-diag="backend">{backendText}</dd></div>
      </dl>
    </details>
  )
}

function previewText(message: RawLineMessage): string {
  if (message.unsent) return '已收回訊息'
  if (message.contentType === 1) return '圖片'
  if (message.contentType === 14) return message.origFilename || '檔案'
  return formatCallRecord(message.text)?.replace(/\s+/g, ' ').trim() || '訊息'
}

function fromMessageDTO(message: MessageDTO, chat: ChatDTO | undefined, chatNameOverride?: string): RawLineMessage {
  return {
    msgId: message.msgId,
    chatId: message.chatId,
    chat: displayChatName(chatNameOverride ?? chat?.name, message.chatId, chat?.isGroup ?? false),
    isGroup: chat?.isGroup ?? false,
    ts: message.ts,
    time: message.timeIso,
    direction: message.direction,
    sender: message.sender ?? '',
    text: message.text ?? '',
    contentType: message.contentType,
    origFilename: message.origFilename,
    fileSize: message.fileSize,
    unsent: message.unsent
  }
}

function mergeHistoryRows(previous: MessageDTO[], incoming: MessageDTO[]): MessageDTO[] {
  const byId = new Map(previous.map((message) => [message.msgId, message]))
  for (const message of incoming) {
    const prior = byId.get(message.msgId)
    if (!prior) {
      byId.set(message.msgId, message)
      continue
    }
    byId.set(message.msgId, {
      ...prior,
      ...message,
      text: hasSavedMessageText(prior.text) ? prior.text : message.text,
      contentType: prior.contentType !== 0 ? prior.contentType : message.contentType,
      origFilename: prior.origFilename ?? message.origFilename,
      fileSize: prior.fileSize ?? message.fileSize,
      unsent: prior.unsent || message.unsent
    })
  }
  return [...byId.values()].sort((a, b) => a.ts - b.ts || a.msgId.localeCompare(b.msgId))
}

function mergeExistingRows(previous: MessageDTO[], incoming: MessageDTO[]): MessageDTO[] {
  const incomingById = new Map(incoming.map((message) => [message.msgId, message]))
  return previous.map((message) => {
    const updated = incomingById.get(message.msgId)
    return updated ? mergeHistoryRows([message], [updated])[0] : message
  })
}

function localDayKey(ts: number): string {
  const date = new Date(ts)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dayDividerLabel(key: string): string {
  const today = localDayKey(Date.now())
  const yesterdayDate = new Date()
  yesterdayDate.setDate(yesterdayDate.getDate() - 1)
  const yesterday = localDayKey(yesterdayDate.getTime())
  if (key === today) return '今天'
  if (key === yesterday) return '昨天'
  const [year, month, day] = key.split('-')
  return `${year}年${Number(month)}月${Number(day)}日`
}

/** 依 contentType 渲染訊息內容，並沿用目前宿主提供的媒體能力。 */
function MessageContent({
  m,
  onOpenLightbox
}: {
  m: RawLineMessage
  onOpenLightbox: (url: string) => void
}): JSX.Element {
  const [fileErr, setFileErr] = useState('')

  if (m.contentType === 1 && m.msgId) {
    return <MediaImage msgId={m.msgId} as="div" onOpenLightbox={onOpenLightbox} />
  }

  if (m.contentType === 14 && m.msgId) {
    const id = m.msgId
    return (
      <>
        <span className="sm-file">
          <span className="sm-file-icon">📎</span>
          <span className="sm-file-name">{m.origFilename ?? '檔案'}</span>
          <span className="sm-file-size">{formatSize(m.fileSize)}</span>
          <MediaFileActions msgId={id} onError={setFileErr} />
        </span>
        {fileErr && <span className="chat-file-error" role="alert">{fileErr}</span>}
      </>
    )
  }

  const text = recalledMessageText(m)
  const notice = recalledMessageNotice(m)
  return (
    <>
      <span style={m.text.length > 0 && m.text.trim().length === 0 ? { whiteSpace: 'pre-wrap' } : undefined}>
        {formatCallRecord(text)}
      </span>
      {notice && <span className="recalled-message-notice" role="note">{notice}</span>}
    </>
  )
}

function MessageRow({
  m,
  onOpenLightbox,
  avatarUrl,
  senderOverride
}: {
  m: RawLineMessage
  onOpenLightbox: (url: string) => void
  avatarUrl?: string
  senderOverride?: string
}): JSX.Element {
  const incoming = m.direction === 'in'
  const sender = senderOverride || m.sender || (incoming ? '對方' : '我')
  return (
    <li
      className={`chat-message ${incoming ? 'incoming' : 'outgoing'}`}
      data-avatar-message-id={incoming && m.msgId?.startsWith('i:') ? m.msgId : undefined}
      data-avatar-message-chat-id={incoming && m.msgId?.startsWith('i:') ? m.chatId : undefined}
    >
      {incoming && (
        <ZoomableAvatar url={avatarUrl} label={sender} name={sender} isGroup={false} className="chat-message-avatar" title={sender} />
      )}
      <div className="chat-message-content">
        <span className="chat-message-sender">{sender}</span>
        <div className="chat-message-bottom-row">
          <div className="chat-message-bubble">
            {m.unsent && <span className="unsent-badge">🚫 已收回</span>}
            <div className="chat-message-body">
              <MessageContent m={m} onOpenLightbox={onOpenLightbox} />
            </div>
          </div>
          <time className="chat-message-time">{messageTimeLabel(m)}</time>
        </div>
      </div>
    </li>
  )
}

/** 「LINE 橋接 ▶ 診斷」狀態列。聊天頁把它送到最上面的標題列（HeaderStatusSlot）；沒有標題列插槽時留在原位。 */
function BridgeStatusBar({ st, status, phaseSource, onRetry }: {
  st: { text: string; cls: string; retry: boolean }
  status: LineBridgeStatus | null
  phaseSource: BackendPhaseSource | null
  onRetry: () => void
}): JSX.Element {
  return (
    <div className="stream-bar">
      <span className={`dot ${st.cls}`} />
      <span className="stream-status" role={st.cls === 'err' ? 'alert' : undefined}>LINE 橋接：{st.text}</span>
      {st.retry && <button type="button" className="link-btn stream-retry" onClick={onRetry}>重試</button>}
      {status && status.restarts > 0 && <span className="muted">（重啟 {status.restarts} 次）</span>}
      {phaseSource && <BackendDiagnosticsPanel source={phaseSource} />}
    </div>
  )
}

export function MessageStream(): JSX.Element {
  const api = useLineTodoApi()
  const { messages, status, error, retry: retryStream } = useLineStream()
  const { source: phaseSource, phase } = useBackendPhase()
  const [retrying, setRetrying] = useState(false)
  const st = statusLabel(status, phase, retrying)
  const [chats, setChats] = useState<ChatDTO[]>([])
  const [recentRows, setRecentRows] = useState<MessageDTO[]>([])
  const [chatAvatarUrls, setChatAvatarUrls] = useState<Record<string, string>>({})
  const [chatDisplayNames, setChatDisplayNames] = useState<Record<string, string>>({})
  const [messageAvatarUrls, setMessageAvatarUrls] = useState<Record<string, string>>({})
  const [messageDisplayNames, setMessageDisplayNames] = useState<Record<string, string>>({})
  const [visibleChatAvatarIds, setVisibleChatAvatarIds] = useState<string[]>([])
  const [visibleMessageAvatarIds, setVisibleMessageAvatarIds] = useState<string[]>([])
  const [chatLoadError, setChatLoadError] = useState('')
  const [historyLoadError, setHistoryLoadError] = useState('')
  const [loadingChats, setLoadingChats] = useState(true)
  const [historyByChat, setHistoryByChat] = useState<Record<string, MessageDTO[]>>({})
  const [hasOlderByChat, setHasOlderByChat] = useState<Record<string, boolean>>({})
  const [historyLoadingChatId, setHistoryLoadingChatId] = useState<string | null>(null)
  const [olderLoadingChatId, setOlderLoadingChatId] = useState<string | null>(null)
  const [historyErrorByChat, setHistoryErrorByChat] = useState<Record<string, string>>({})
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [paneView, setPaneView] = useState<PaneView>('messages')
  const [customizedChatIds, setCustomizedChatIds] = useState<ReadonlySet<string>>(new Set())
  const [mobileView, setMobileView] = useState<'list' | 'conversation'>('list')
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<ChatListPrefsDTO>(EMPTY_PREFS)
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  const [prefError, setPrefError] = useState('')
  const [listMenu, setListMenu] = useState<ListMenuState | null>(null)
  const listMenuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const rowButtons = useRef(new Map<string, HTMLButtonElement>())
  const prefsSeq = useRef(0)
  const messageLogRef = useRef<HTMLDivElement | null>(null)
  const previousChatIdRef = useRef<string | null>(null)
  const pinnedToBottomRef = useRef(true)
  const historyRequestIds = useRef(new Map<string, number>())
  const persistedRefreshIds = useRef(new Map<string, number>())
  const mountedRef = useRef(true)
  const loadSeq = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  /** 置頂／隱藏／忽略狀態只是列表的修飾：讀不到就當成都沒有（不顯示錯誤、不擋聊天室清單）。 */
  const readPrefs = useCallback((): Promise<ChatListPrefsDTO> => {
    const read = api.db.chats.listPrefs
    if (typeof read !== 'function') return Promise.resolve(EMPTY_PREFS)
    return Promise.resolve().then(() => read()).then(
      (value) => (value && Array.isArray(value.pinned) && Array.isArray(value.hidden) ? value : EMPTY_PREFS),
      () => EMPTY_PREFS
    )
  }, [api])

  /** 讀聊天室清單與最近訊息（掛載時、以及逾時／失敗後的「重試」）。較新的一輪開始後，舊一輪的結果一律丟掉。 */
  const reload = useCallback((): Promise<void> => {
    loadSeq.current += 1
    const seq = loadSeq.current
    const live = (): boolean => mountedRef.current && loadSeq.current === seq
    setLoadingChats(true)
    setChatLoadError('')
    setHistoryLoadError('')
    const chatsDone = api.db.chats.list().then((rows) => {
      if (live()) setChats(rows)
    }, (loadError: unknown) => {
      if (live()) setChatLoadError(backendErrorText(loadError, '讀取聊天室清單失敗'))
    }).finally(() => {
      if (live()) setLoadingChats(false)
    })
    const prefsStart = prefsSeq.current
    const prefsDone = readPrefs().then((next) => {
      if (live() && prefsSeq.current === prefsStart) setPrefs(next)
    }).finally(() => {
      if (live()) setPrefsLoaded(true)
    })
    const rowsDone = api.db.messages.list({ limit: 1000 }).then((rows) => {
      if (live()) setRecentRows(rows)
    }, (loadError: unknown) => {
      if (live()) setHistoryLoadError(backendErrorText(loadError, '讀取最近訊息失敗；仍可查看即時訊息'))
    })
    return Promise.all([chatsDone, rowsDone, prefsDone]).then(() => undefined)
  }, [api, readPrefs])

  useEffect(() => {
    void reload()
    return () => { loadSeq.current += 1 }
  }, [reload])

  const retryAll = useCallback((): void => {
    setRetrying(true)
    void Promise.all([reload(), retryStream()]).finally(() => {
      if (mountedRef.current) setRetrying(false)
    })
  }, [reload, retryStream])

  const chatById = useMemo(() => new Map(chats.map((chat) => [chat.chatId, chat])), [chats])

  const loadedMessages = useMemo(() => {
    const byKey = new Map<string, RawLineMessage>()
    for (const message of recentRows) {
      const raw = fromMessageDTO(message, chatById.get(message.chatId), chatDisplayNames[message.chatId])
      const key = messageKey(raw)
      const previous = byKey.get(key)
      byKey.set(key, previous ? mergeMessageCopies(previous, raw) : raw)
    }
    for (const rows of Object.values(historyByChat)) {
      for (const message of rows) {
        const raw = fromMessageDTO(message, chatById.get(message.chatId), chatDisplayNames[message.chatId])
        const key = messageKey(raw)
        const previous = byKey.get(key)
        byKey.set(key, previous ? mergeMessageCopies(previous, raw) : raw)
      }
    }
    // 即時列補足聊天室資訊；資料庫已有的原文／媒體欄優先，收回旗標單調累積。
    for (const message of messages) {
      const key = messageKey(message)
      const previous = byKey.get(key)
      byKey.set(key, previous ? mergeMessageCopies(previous, message) : message)
    }
    return [...byKey.values()].sort(compareMessages)
  }, [chatById, chatDisplayNames, historyByChat, messages, recentRows])

  const loadedRowsByChat = useMemo(() => {
    const byChat = new Map<string, Map<string, MessageDTO>>()
    for (const message of [...recentRows, ...Object.values(historyByChat).flat()]) {
      let rows = byChat.get(message.chatId)
      if (!rows) {
        rows = new Map()
        byChat.set(message.chatId, rows)
      }
      rows.set(message.msgId, message)
    }
    return new Map([...byChat].map(([chatId, rows]) => [
      chatId,
      [...rows.values()].sort((a, b) => b.ts - a.ts || a.msgId.localeCompare(b.msgId))
    ]))
  }, [historyByChat, recentRows])
  const loadedRowsByChatRef = useRef(loadedRowsByChat)
  loadedRowsByChatRef.current = loadedRowsByChat

  const conversations = useMemo(() => {
    const byChat = new Map<string, ConversationEntry>()
    for (const chat of chats) {
      byChat.set(chat.chatId, {
        chatId: chat.chatId,
        name: displayChatName(chatDisplayNames[chat.chatId] ?? chat.name, chat.chatId, chat.isGroup),
        isGroup: chat.isGroup,
        latestMessageTs: chat.latestMessageTs ?? null,
        latest: null,
        loadedCount: 0
      })
    }
    for (const message of loadedMessages) {
      let entry = byChat.get(message.chatId)
      if (!entry) {
        entry = {
          chatId: message.chatId,
          name: displayChatName(message.chat, message.chatId, message.isGroup),
          isGroup: message.isGroup,
          latestMessageTs: message.ts,
          latest: null,
          loadedCount: 0
        }
        byChat.set(message.chatId, entry)
      }
      entry.loadedCount += 1
      if (!entry.latest || compareMessages(message, entry.latest) > 0) {
        entry.latest = message
        if (entry.latestMessageTs === null || message.ts > entry.latestMessageTs) entry.latestMessageTs = message.ts
        if (!chatById.has(message.chatId) && message.chat) entry.name = message.chat
      }
    }
    return [...byChat.values()].sort((a, b) => {
      const byMessageTime = compareChatMessageTimes(a.latestMessageTs, b.latestMessageTs)
      return byMessageTime || a.name.localeCompare(b.name)
    })
  }, [chatById, chatDisplayNames, chats, loadedMessages])

  const pinnedSet = useMemo(() => new Set(prefs.pinned), [prefs.pinned])
  const hiddenSet = useMemo(() => new Set(prefs.hidden), [prefs.hidden])
  const ignoredSet = useMemo(() => {
    const topicsOn = new Set(prefs.topicsOn)
    return new Set(prefs.todoOff.filter((id) => !topicsOn.has(id)))
  }, [prefs.todoOff, prefs.topicsOn])

  const orderedConversations = useMemo(() => {
    if (pinnedSet.size === 0) return conversations
    return [...conversations.filter((chat) => pinnedSet.has(chat.chatId)), ...conversations.filter((chat) => !pinnedSet.has(chat.chatId))]
  }, [conversations, pinnedSet])

  useEffect(() => {
    if (!prefsLoaded) return
    if (selectedChatId && conversations.some((chat) => chat.chatId === selectedChatId)) return
    setSelectedChatId(orderedConversations.find((chat) => !hiddenSet.has(chat.chatId))?.chatId ?? null)
  }, [conversations, orderedConversations, hiddenSet, prefsLoaded, selectedChatId])

  const activeConversation = conversations.find((chat) => chat.chatId === selectedChatId) ?? null
  const activeChatId = activeConversation?.chatId ?? null

  const chatPrompts = api.hostAi?.chatPrompts
  useEffect(() => {
    if (!chatPrompts || !activeChatId) return
    let cancelled = false
    chatPrompts.list().then(
      (items) => { if (!cancelled) setCustomizedChatIds(new Set(items.map((item) => item.chatId))) },
      () => { /* 標記只是提示：讀不到就不顯示 */ }
    )
    return () => { cancelled = true }
  }, [chatPrompts, activeChatId])

  const activeMessages = useMemo(() => {
    if (!activeChatId) return []
    return loadedMessages.filter((message) => message.chatId === activeChatId).sort(compareMessages)
  }, [activeChatId, loadedMessages])
  const activeAvatarMessageIds = useMemo(
    () => activeMessages.filter((message) => message.direction === 'in' && message.msgId?.startsWith('i:')).slice(-200).map((message) => message.msgId as string),
    [activeMessages],
  )

  useEffect(() => {
    const nodes = typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll<HTMLElement>('[data-avatar-chat-id],[data-avatar-message-id]'))
      : []
    const visible = new Set<Element>()
    const publish = (): void => {
      const chatsVisible = new Set<string>(activeChatId ? [activeChatId] : [])
      const messagesVisible = new Set<string>()
      for (const node of visible) {
        const chat = node.getAttribute('data-avatar-chat-id')
        const msg = node.getAttribute('data-avatar-message-id')
        if (chat) chatsVisible.add(chat)
        if (msg) messagesVisible.add(msg)
      }
      const nextChats = [...chatsVisible]
      const nextMessages = [...messagesVisible].slice(-200)
      setVisibleChatAvatarIds((current) => sameIds(current, nextChats) ? current : nextChats)
      setVisibleMessageAvatarIds((current) => sameIds(current, nextMessages) ? current : nextMessages)
    }
    if (typeof IntersectionObserver === 'undefined') {
      // The native browser path observes viewport visibility; the renderer unit fixture has no observer.
      setVisibleChatAvatarIds(activeChatId ? [activeChatId] : [])
      setVisibleMessageAvatarIds(activeAvatarMessageIds)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0) visible.add(entry.target)
        else visible.delete(entry.target)
      }
      publish()
    }, { rootMargin: '80px' })
    for (const node of nodes) observer.observe(node)
    publish()
    return () => observer.disconnect()
  }, [activeChatId, activeAvatarMessageIds, conversations, prefs])

  useEffect(() => {
    const prepare = api.media?.avatarUrls
    if (!prepare || visibleChatAvatarIds.length === 0) {
      setChatAvatarUrls({})
      setChatDisplayNames({})
      return
    }
    let active = true
    const controller = new AbortController()
    void prepare(visibleChatAvatarIds, { signal: controller.signal }).then((batch) => {
      if (!active) return
      setChatAvatarUrls((current) => mergeRecord(current, batch.urls))
      setChatDisplayNames((current) => mergeRecord(current, batch.names))
    })
    return () => { active = false; controller.abort() }
  }, [api, visibleChatAvatarIds])

  useEffect(() => {
    const prepare = api.media?.messageAvatarUrls
    if (!prepare || !activeChatId || visibleMessageAvatarIds.length === 0) {
      setMessageAvatarUrls({})
      setMessageDisplayNames({})
      return
    }
    let active = true
    const controller = new AbortController()
    void prepare(activeChatId, visibleMessageAvatarIds, { signal: controller.signal }).then((batch) => {
      if (!active) return
      setMessageAvatarUrls((current) => mergeRecord(current, batch.urls))
      setMessageDisplayNames((current) => mergeRecord(current, batch.names))
    })
    return () => { active = false; controller.abort() }
  }, [api, activeChatId, visibleMessageAvatarIds])
  const latestActiveMessage = activeMessages[activeMessages.length - 1] ?? null

  const searchableMessageTextByChat = useMemo(() => {
    const byChat = new Map<string, string>()
    for (const message of loadedMessages) {
      const text = [
        message.direction === 'out' ? '我' : '',
        message.sender,
        previewText(message),
        message.text,
        message.origFilename ?? ''
      ].join(' ').toLocaleLowerCase()
      byChat.set(message.chatId, `${byChat.get(message.chatId) ?? ''} ${text}`)
    }
    return byChat
  }, [loadedMessages])

  const loadChatHistory = useCallback(async (chatId: string, retry = false): Promise<void> => {
    if (!retry && Object.prototype.hasOwnProperty.call(historyByChat, chatId)) return
    const requestId = (historyRequestIds.current.get(chatId) ?? 0) + 1
    historyRequestIds.current.set(chatId, requestId)
    setHistoryLoadingChatId(chatId)
    setHistoryErrorByChat((current) => ({ ...current, [chatId]: '' }))
    try {
      const rows = await api.db.messages.recentByChat(chatId, HISTORY_PAGE_SIZE)
      if (!mountedRef.current || historyRequestIds.current.get(chatId) !== requestId) return
      setHistoryByChat((current) => ({
        ...current,
        [chatId]: mergeHistoryRows(current[chatId] ?? [], rows)
      }))
      setHasOlderByChat((current) => ({ ...current, [chatId]: rows.length === HISTORY_PAGE_SIZE }))
    } catch (loadError) {
      if (!mountedRef.current || historyRequestIds.current.get(chatId) !== requestId) return
      setHistoryErrorByChat((current) => ({
        ...current,
        [chatId]: backendErrorText(loadError, '讀取此聊天室訊息失敗')
      }))
    } finally {
      if (mountedRef.current && historyRequestIds.current.get(chatId) === requestId) {
        setHistoryLoadingChatId((current) => current === chatId ? null : current)
      }
    }
  }, [api, historyByChat])

  const refreshLoadedRows = useCallback(async (chatId: string): Promise<void> => {
    const requestId = (persistedRefreshIds.current.get(chatId) ?? 0) + 1
    persistedRefreshIds.current.set(chatId, requestId)
    const refreshedById = new Map<string, MessageDTO>()
    const attemptedIds = new Set<string>()

    while (mountedRef.current && persistedRefreshIds.current.get(chatId) === requestId) {
      const loaded = loadedRowsByChatRef.current.get(chatId) ?? []
      const pending = loaded.filter((message) => !attemptedIds.has(message.msgId))
      if (pending.length === 0) break

      // Refresh only the already-loaded pages. Each request stays within the normal
      // 100-row UI page size; the number of requests follows the loaded row count.
      const page = pending.slice(0, HISTORY_PAGE_SIZE)
      const wantedIds = new Set(page.map((message) => message.msgId))
      const rows = await api.db.messages.list({
        chatId,
        beforeTs: page[0].ts + 1,
        limit: page.length
      })
      if (!mountedRef.current || persistedRefreshIds.current.get(chatId) !== requestId) return
      for (const message of page) attemptedIds.add(message.msgId)
      for (const row of rows) {
        if (wantedIds.has(row.msgId)) refreshedById.set(row.msgId, row)
      }
    }

    if (!mountedRef.current || persistedRefreshIds.current.get(chatId) !== requestId || refreshedById.size === 0) return
    const refreshed = [...refreshedById.values()]
    setRecentRows((current) => mergeExistingRows(current, refreshed))
    setHistoryByChat((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, chatId)) return current
      return { ...current, [chatId]: mergeExistingRows(current[chatId], refreshed) }
    })
  }, [api])

  useEffect(() => {
    if (activeChatId) void loadChatHistory(activeChatId)
  }, [activeChatId, loadChatHistory])

  useEffect(() => {
    const offPersisted = api.db.onMessagesPersisted((event) => {
      const affectedChatIds = event.chatIds.length > 0
        ? event.chatIds
        : [...loadedRowsByChatRef.current.keys()]
      for (const chatId of affectedChatIds) {
        if (loadedRowsByChatRef.current.has(chatId)) void refreshLoadedRows(chatId)
      }
    })
    return offPersisted
  }, [api, refreshLoadedRows])

  useLayoutEffect(() => {
    const log = messageLogRef.current
    if (!log) return
    if (previousChatIdRef.current !== activeChatId) {
      previousChatIdRef.current = activeChatId
      pinnedToBottomRef.current = true
    }
    if (pinnedToBottomRef.current) {
      log.scrollTop = log.scrollHeight
    }
  }, [activeChatId, activeMessages.length, latestActiveMessage])

  useEffect(() => {
    if (!lightboxSrc) return
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setLightboxSrc(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lightboxSrc])

  const shownConversations = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return orderedConversations.filter((chat) => {
      if (!needle) return !hiddenSet.has(chat.chatId)
      const searchable = `${chat.name} ${searchableMessageTextByChat.get(chat.chatId) ?? ''}`.toLocaleLowerCase()
      return searchable.includes(needle)
    })
  }, [hiddenSet, orderedConversations, search, searchableMessageTextByChat])

  /** 在聊天頁以外改了開關（議題與待辦分頁）再回到訊息時，列表上的「已忽略」要跟上：重讀一次。 */
  const previousPaneView = useRef<PaneView>(paneView)
  useEffect(() => {
    const was = previousPaneView.current
    previousPaneView.current = paneView
    if (paneView !== 'messages' || was === 'messages') return undefined
    const start = prefsSeq.current
    let live = true
    void readPrefs().then((next) => {
      if (live && mountedRef.current && prefsSeq.current === start) setPrefs(next)
    })
    return () => { live = false }
  }, [paneView, readPrefs])

  function focusRowOrSearch(chatId: string | undefined): void {
    setTimeout(() => {
      const button = chatId ? rowButtons.current.get(chatId) : undefined
      if (button) button.focus?.()
      else searchRef.current?.focus?.()
    }, 0)
  }

  function closeListMenu(refocus: boolean): void {
    setListMenu(null)
    if (refocus) focusRowOrSearch(listMenu?.chatId)
  }

  /** anchor：選單左緣要對齊的位置與錨點上下緣（實際像素，滑鼠位置或列的 rect）。 */
  function openListMenu(chatId: string, anchor: { top: number; bottom: number; left: number }): void {
    setPrefError('')
    // 畫面縮放（lib/zoom.ts）之後 rect／clientX 是實際像素、fixed 的 left／top 是縮放前的長度 → 由 placeFixedMenu 換算（它以右緣對齊，所以右緣＝左緣＋實際寬度）；下方不夠 → 往上開
    const scale = layoutScale()
    const placement = placeFixedMenu({ top: anchor.top, bottom: anchor.bottom, right: anchor.left + LIST_MENU_WIDTH * scale }, { width: window.innerWidth, height: window.innerHeight }, scale, LIST_MENU_WIDTH, 2, 140)
    setListMenu({ chatId, placement })
    focusFirstMenuItem(listMenuRef)
  }

  const onRowKeyDown = useContextMenuKeys({
    open: listMenu !== null,
    menuRef: listMenuRef,
    onOpen: (event) => {
      const button = event.currentTarget
      const chatId = button.getAttribute('data-chat-id')
      if (!chatId) return
      const rect = button.getBoundingClientRect?.() ?? { top: 0, bottom: 0, left: 0 }
      openListMenu(chatId, { top: rect.top, bottom: rect.bottom, left: rect.left + 24 })
    },
    onClose: closeListMenu
  })
  const onListMenuKeyDown = useContextMenuKeys({ open: listMenu !== null, menuRef: listMenuRef, onOpen: () => undefined, onClose: closeListMenu })

  async function runListAction(chatId: string, action: ListAction): Promise<void> {
    const index = shownConversations.findIndex((chat) => chat.chatId === chatId)
    const usable = (chat: ConversationEntry): boolean => chat.chatId !== chatId && !hiddenSet.has(chat.chatId)
    const neighbor = shownConversations.slice(index + 1).find(usable) ?? shownConversations.slice(0, Math.max(0, index)).reverse().find(usable)
    setListMenu(null)
    setPrefError('')
    try {
      const result = action === 'pin' || action === 'unpin' ? await api.db.chats.setPinned(chatId, action === 'pin')
        : action === 'ignore' || action === 'restore' ? await api.db.chats.setIgnored(chatId, action === 'ignore')
          : await api.db.chats.setHidden(chatId, action === 'hide')
      if (!mountedRef.current) return
      if (!result.ok) {
        setPrefError(LIST_ACTION_ERROR)
        focusRowOrSearch(chatId)
        return
      }
      prefsSeq.current += 1
      setPrefs((current) => patchPrefs(current, chatId, action))
      if (action === 'hide' && activeChatId === chatId) setSelectedChatId(neighbor?.chatId ?? null)
      focusRowOrSearch(action === 'hide' && !search.trim() ? neighbor?.chatId : chatId)
    } catch (actionError) {
      if (!mountedRef.current) return
      setPrefError(backendErrorText(actionError, LIST_ACTION_ERROR))
      focusRowOrSearch(chatId)
    }
  }

  async function loadOlderMessages(): Promise<void> {
    if (!activeChatId || olderLoadingChatId === activeChatId) return
    const oldest = activeMessages[0]
    if (!oldest) return
    const log = messageLogRef.current
    const priorHeight = log?.scrollHeight ?? 0
    const priorTop = log?.scrollTop ?? 0
    setOlderLoadingChatId(activeChatId)
    setHistoryErrorByChat((current) => ({ ...current, [activeChatId]: '' }))
    try {
      const rows = await api.db.messages.list({ chatId: activeChatId, beforeTs: oldest.ts, limit: HISTORY_PAGE_SIZE })
      const older = rows.slice().reverse()
      setHistoryByChat((current) => ({
        ...current,
        [activeChatId]: [...older, ...(current[activeChatId] ?? [])]
      }))
      setHasOlderByChat((current) => ({ ...current, [activeChatId]: rows.length === HISTORY_PAGE_SIZE }))
      requestAnimationFrame(() => {
        if (messageLogRef.current && activeChatId === previousChatIdRef.current) {
          messageLogRef.current.scrollTop = priorTop + messageLogRef.current.scrollHeight - priorHeight
        }
      })
    } catch (loadError) {
      setHistoryErrorByChat((current) => ({ ...current, [activeChatId]: backendErrorText(loadError, '載入較早訊息失敗') }))
    } finally {
      setOlderLoadingChatId((current) => current === activeChatId ? null : current)
    }
  }

  return (
    <section className="stream chat-stream">
      <HeaderStatus>
        <BridgeStatusBar st={st} status={status} phaseSource={phaseSource} onRetry={retryAll} />
      </HeaderStatus>
      {error && <div className="set-notice err stream-error" role="alert">{error}</div>}
      {historyLoadError && (
        <div className="stream-load-note" role="status">
          <span>{historyLoadError}</span>
          <button type="button" className="link-btn" onClick={retryAll}>重試</button>
        </div>
      )}

      <div className={`chat-workspace mobile-show-${mobileView}`}>
        <aside className="chat-sidebar" aria-label="聊天室列表">
          <div className="chat-sidebar-heading">
            <h2>聊天室</h2>
            <span aria-label={`${shownConversations.length} 個聊天室`}>{shownConversations.length}</span>
          </div>
          <label className="chat-search-wrap">
            <span className="chat-search-icon" aria-hidden="true">⌕</span>
            <span className="sr-only">搜尋聊天、已載入訊息與發話者</span>
            <input
              type="search"
              className="chat-search"
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜尋聊天和訊息"
              aria-label="搜尋聊天、已載入訊息與發話者"
            />
            {search && <button type="button" className="chat-search-clear" aria-label="清除搜尋" onClick={() => setSearch('')}>×</button>}
          </label>
          {chatLoadError && (
            <div className="chat-action-error chat-load-error" role="alert">
              <span>{chatLoadError}</span>
              <button type="button" className="link-btn" onClick={retryAll}>重試</button>
            </div>
          )}
          {prefError && <div className="chat-action-error" role="alert">{prefError}</div>}
          <ul className="chat-list">
            {loadingChats && conversations.length === 0 && <li className="chat-list-empty muted" role="status">{phase === 'starting' ? describePhase(phase)?.text : '正在載入聊天室…'}</li>}
            {!loadingChats && !chatLoadError && conversations.length === 0 && <li className="chat-list-empty muted">目前尚無聊天資料</li>}
            {!loadingChats && conversations.length > 0 && shownConversations.length === 0 && (
              <li className="chat-list-empty muted">
                <span>找不到符合的聊天室</span>
                {search && <button type="button" className="link-btn" onClick={() => setSearch('')}>清除搜尋</button>}
              </li>
            )}
            {shownConversations.map((chat) => {
              const active = chat.chatId === activeChatId
              const pinned = pinnedSet.has(chat.chatId)
              const hidden = hiddenSet.has(chat.chatId)
              const ignored = ignoredSet.has(chat.chatId)
              const previewSender = chat.latest?.direction === 'out' ? '我' : chat.latest?.msgId ? (messageDisplayNames[chat.latest.msgId] ?? chat.latest.sender) : chat.latest?.sender
              return (
                <li
                  key={chat.chatId}
                  data-avatar-chat-id={chat.chatId}
                  className={`chat-list-row${active ? ' active' : ''}${ignored ? ' ignored' : ''}`}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    openListMenu(chat.chatId, { top: event.clientY, bottom: event.clientY, left: event.clientX })
                  }}
                >
                  <button
                    type="button"
                    className={`chat-list-item${active ? ' active' : ''}`}
                    ref={(element) => {
                      if (element) rowButtons.current.set(chat.chatId, element)
                      else rowButtons.current.delete(chat.chatId)
                    }}
                    data-chat-id={chat.chatId}
                    aria-pressed={active}
                    aria-haspopup="menu"
                    aria-expanded={listMenu?.chatId === chat.chatId}
                    onKeyDown={onRowKeyDown}
                    onClick={() => {
                      setSelectedChatId(chat.chatId)
                      setMobileView('conversation')
                    }}
                  >
                    <span className={`chat-avatar${chat.isGroup ? ' group' : ''}`} aria-hidden="true">
                      <AvatarGlyph url={chatAvatarUrls[chat.chatId]} label={chat.name} isGroup={chat.isGroup} />
                    </span>
                    <span className="chat-list-copy">
                      <span className="chat-list-line">
                        <span className="chat-list-name" title={chat.name}>{chat.name}</span>
                        {pinned && <><span className="chat-pin-mark" aria-hidden="true">📌</span><span className="sr-only">已置頂</span></>}
                        {hidden && <span className="chat-list-flag">已隱藏</span>}
                        {ignored && !hidden && <span className="sr-only">已忽略</span>}
                        <time className="chat-list-time">{chatTimeLabel(chat)}</time>
                      </span>
                      <span className="chat-list-preview">
                        {chat.latest
                          ? <>{previewSender && <span className="chat-list-sender">{previewSender}：</span>}{previewText(chat.latest)}</>
                          : '尚無已載入訊息'}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="chat-search-hint">搜尋範圍：目前已載入的聊天室名稱、訊息與發話者，不含完整歷史。</p>
        </aside>

        <section className="chat-pane" aria-label={activeConversation?.name ?? '聊天室內容'}>
          {activeConversation ? (
            <>
              <header className="chat-pane-header">
                <button type="button" className="chat-back-button" onClick={() => setMobileView('list')} aria-label="返回聊天室列表">‹ <span>聊天室</span></button>
                <ZoomableAvatar url={chatAvatarUrls[activeConversation.chatId]} label={activeConversation.name} name={activeConversation.name} isGroup={activeConversation.isGroup} className={`chat-avatar chat-pane-avatar${activeConversation.isGroup ? ' group' : ''}`} chatId={activeConversation.chatId} />
                <div className="chat-pane-title">
                  <h2>{activeConversation.name}</h2>
                  <span>{activeConversation.isGroup ? '群組' : '聊天室'} · {activeConversation.loadedCount} 則已載入訊息</span>
                </div>
                <div className="chat-pane-view-toggle" role="group" aria-label="聊天室檢視">
                  <button type="button" className={paneView === 'messages' ? 'selected' : ''} aria-pressed={paneView === 'messages'} onClick={() => setPaneView('messages')}>訊息</button>
                  <button type="button" className={paneView === 'topicsTodos' ? 'selected' : ''} aria-pressed={paneView === 'topicsTodos'} onClick={() => setPaneView('topicsTodos')}>議題與待辦</button>
                  {chatPrompts && (
                    <button type="button" className={paneView === 'aiSettings' ? 'selected' : ''} aria-pressed={paneView === 'aiSettings'} onClick={() => setPaneView('aiSettings')}>
                      AI 設定
                      {customizedChatIds.has(activeConversation.chatId) && <span className="pane-tab-dot" data-testid="ai-settings-customized" role="img" aria-label="已自訂" />}
                    </button>
                  )}
                </div>
              </header>
              {paneView === 'topicsTodos' ? (
                <div className="chat-topics-todos-content" data-testid="chat-topics-todos-content" aria-label={`${activeConversation.name}的議題與待辦`}>
                  <ChatRefreshControl
                    key={`refresh-${activeConversation.chatId}`}
                    chatId={activeConversation.chatId}
                    todoOn={!prefs.todoOff.includes(activeConversation.chatId)}
                    topicsOn={prefs.topicsOn.includes(activeConversation.chatId)}
                  />
                  <GroupTopicsPanel key={`topics-${activeConversation.chatId}`} chatId={activeConversation.chatId} chatName={activeConversation.name} chatIsGroup={activeConversation.isGroup} embedded />
                  <ChatTodosPanel
                    key={`todos-${activeConversation.chatId}`}
                    chatId={activeConversation.chatId}
                    chatName={activeConversation.name}
                  />
                </div>
              ) : paneView === 'aiSettings' && chatPrompts ? (
                <ChatPromptPanel
                  key={activeConversation.chatId}
                  chatId={activeConversation.chatId}
                  chatName={activeConversation.name}
                  control={chatPrompts}
                  onChanged={(next) => setCustomizedChatIds((current) => {
                    const updated = new Set(current)
                    if (next.overridePrompt !== null || next.overrideName !== null) updated.add(next.chatId)
                    else updated.delete(next.chatId)
                    return updated
                  })}
                />
              ) : (
                <div className="chat-message-view">
                  <div
                    className="chat-message-log"
                    ref={messageLogRef}
                    role="log"
                    aria-label="選定聊天室訊息"
                    aria-live="polite"
                    onScroll={(event) => {
                      const log = event.currentTarget
                      pinnedToBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 96
                    }}
                  >
                    {historyLoadingChatId === activeChatId && activeMessages.length === 0 && <p className="chat-history-status" role="status">正在載入訊息…</p>}
                    {hasOlderByChat[activeConversation.chatId] && (
                      <div className="chat-load-older-wrap">
                        <button type="button" className="chat-load-older" disabled={olderLoadingChatId === activeChatId} onClick={() => void loadOlderMessages()}>
                          {olderLoadingChatId === activeChatId ? '載入中…' : '載入較早訊息'}
                        </button>
                      </div>
                    )}
                    {historyErrorByChat[activeConversation.chatId] && (
                      <div className="chat-history-error" role="alert">
                        {historyErrorByChat[activeConversation.chatId]}
                        <button type="button" className="link-btn" onClick={() => void loadChatHistory(activeConversation.chatId, true)}>重試</button>
                      </div>
                    )}
                    {activeMessages.length === 0 && historyLoadingChatId !== activeChatId && !historyErrorByChat[activeConversation.chatId] && (
                      <p className="chat-history-status muted">這個聊天室目前沒有已載入的訊息。</p>
                    )}
                    <ol className="chat-message-list">
                      {activeMessages.map((message, index) => {
                        const day = localDayKey(message.ts)
                        const previousDay = index > 0 ? localDayKey(activeMessages[index - 1].ts) : ''
                        return (
                          <Fragment key={messageKey(message)}>
                            {day && day !== previousDay && <li className="chat-date-divider"><span>{dayDividerLabel(day)}</span></li>}
                            <MessageRow m={message} onOpenLightbox={setLightboxSrc} avatarUrl={message.msgId ? messageAvatarUrls[message.msgId] : undefined} senderOverride={message.msgId ? messageDisplayNames[message.msgId] : undefined} />
                          </Fragment>
                        )
                      })}
                    </ol>
                  </div>
                  <DisabledMessageComposer />
                </div>
              )}
            </>
          ) : (
            <div className="chat-pane-empty">
              <span className="chat-pane-empty-icon" aria-hidden="true">☷</span>
              <h2>{conversations.length === 0 ? (chatLoadError ? '尚未讀到聊天室' : loadingChats ? '正在載入聊天室…' : '目前尚無聊天資料') : '選擇聊天室以查看訊息'}</h2>
              <p>選擇左側對話後，這裡會顯示已載入的訊息。</p>
            </div>
          )}
        </section>
      </div>

      {listMenu && (
        <ContextMenu
          menuRef={listMenuRef}
          className="chat-list-menu"
          style={{ ...listMenu.placement }}
          onDismiss={() => closeListMenu(false)}
          onKeyDown={(event) => {
            if (event.key === 'Tab') closeListMenu(false)
            else onListMenuKeyDown(event)
          }}
        >
          {hiddenSet.has(listMenu.chatId) ? (
            <ContextMenuItem onClick={() => void runListAction(listMenu.chatId, 'unhide')}>取消隱藏</ContextMenuItem>
          ) : (
            <>
              <ContextMenuItem onClick={() => void runListAction(listMenu.chatId, pinnedSet.has(listMenu.chatId) ? 'unpin' : 'pin')}>
                {pinnedSet.has(listMenu.chatId) ? '取消置頂' : '置頂'}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => void runListAction(listMenu.chatId, ignoredSet.has(listMenu.chatId) ? 'restore' : 'ignore')}>
                {ignoredSet.has(listMenu.chatId) ? '恢復' : '忽略'}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => void runListAction(listMenu.chatId, 'hide')}>隱藏</ContextMenuItem>
            </>
          )}
        </ContextMenu>
      )}

      {lightboxSrc && (
        <div className="sm-lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="圖片放大" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </section>
  )
}

function DisabledMessageComposer(): JSX.Element {
  return (
    <div className="chat-message-composer" role="group" aria-label="訊息輸入區；功能尚未開啟">
      <div className="chat-composer-actions">
        <button type="button" className="chat-composer-control" disabled aria-label="附加檔案功能尚未開啟" title="功能尚未開啟">
          <span aria-hidden="true">＋</span>
        </button>
        <button type="button" className="chat-composer-control" disabled aria-label="表情符號功能尚未開啟" title="功能尚未開啟">
          <span aria-hidden="true">☺</span>
        </button>
      </div>
      <input
        type="text"
        className="chat-composer-input"
        disabled
        aria-label="訊息輸入功能尚未開啟"
        placeholder="訊息功能尚未開啟"
      />
      <button type="button" className="chat-composer-control chat-composer-send" disabled aria-label="傳送功能尚未開啟" title="功能尚未開啟">
        <span aria-hidden="true">➤</span>
      </button>
      <span className="chat-composer-status">功能尚未開啟</span>
    </div>
  )
}
