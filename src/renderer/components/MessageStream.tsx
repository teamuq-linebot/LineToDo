import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatDTO, MessageDTO, RawLineMessage, LineBridgeStatus } from '../../shared/api'
import { useLineStream } from '../hooks/useLineStream'
import { backendErrorText } from '../lib/backendError'
import { formatCallRecord } from '../lib/callRecord'
import { hasSavedMessageText, mergeMessageCopies, recalledMessageNotice, recalledMessageText } from '../lib/recalledMessage'
import { useLineTodoApi } from '../platform/LineTodoApi'
import { displayChatName } from '../lib/displayChatName'
import { GroupTopicsPanel } from '../features/groupTopics/GroupTopicsPanel'
import { ChatTodosPanel } from '../features/chatTodos/ChatTodosPanel'
import { MediaFileActions, MediaImage } from './MediaView'

interface ConversationEntry {
  chatId: string
  name: string
  isGroup: boolean
  blocked: boolean
  lastSeenAt: string
  latest: RawLineMessage | null
  loadedCount: number
}

type ListFilter = 'active' | 'ignored'
type PaneView = 'messages' | 'topics' | 'todos'

const HISTORY_PAGE_SIZE = 100

function statusLabel(s: LineBridgeStatus | null): { text: string; cls: string } {
  if (!s) return { text: '連線中…', cls: '' }
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

function messageTimeLabel(message: RawLineMessage): string {
  const time = message.time ?? ''
  return time.length >= 16 ? time.slice(11, 16) : time || '--:--'
}

function chatTimeLabel(chat: ConversationEntry): string {
  if (chat.latest) return messageTimeLabel(chat.latest)
  return chat.lastSeenAt.length >= 16 ? chat.lastSeenAt.slice(11, 16) : '--:--'
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

function AvatarGlyph({ url, label, isGroup }: { url?: string; label: string; isGroup: boolean }): JSX.Element | string {
  const [failedSource, setFailedSource] = useState<string | null>(() =>
    url && failedAvatarSources.has(url) ? url : null
  )

  useEffect(() => {
    setFailedSource(url && failedAvatarSources.has(url) ? url : null)
  }, [url])

  if (!url || failedSource === url || failedAvatarSources.has(url)) return avatarMark(label, isGroup)
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => {
        rememberFailedAvatarSource(url)
        setFailedSource(url)
      }}
    />
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
        <span className="chat-message-avatar" aria-hidden="true" title={sender}>
          <AvatarGlyph url={avatarUrl} label={sender} isGroup={false} />
        </span>
      )}
      <div className="chat-message-content">
        <span className="chat-message-sender">{sender}</span>
        <div className="chat-message-bubble">
          {m.unsent && <span className="unsent-badge">🚫 已收回</span>}
          <div className="chat-message-body">
            <MessageContent m={m} onOpenLightbox={onOpenLightbox} />
          </div>
        </div>
        <time className="chat-message-time">{messageTimeLabel(m)}</time>
      </div>
    </li>
  )
}

export function MessageStream(): JSX.Element {
  const api = useLineTodoApi()
  const { messages, status, error } = useLineStream()
  const st = statusLabel(status)
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
  const [filter, setFilter] = useState<ListFilter>('active')
  const [search, setSearch] = useState('')
  const [paneView, setPaneView] = useState<PaneView>('messages')
  const [mobileView, setMobileView] = useState<'list' | 'conversation'>('list')
  const [openMenuChatId, setOpenMenuChatId] = useState<string | null>(null)
  const [actionBusyChatId, setActionBusyChatId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const messageLogRef = useRef<HTMLDivElement | null>(null)
  const previousChatIdRef = useRef<string | null>(null)
  const pinnedToBottomRef = useRef(true)
  const menuRootRef = useRef<HTMLLIElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const historyRequestIds = useRef(new Map<string, number>())
  const persistedRefreshIds = useRef(new Map<string, number>())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    let active = true
    setLoadingChats(true)
    setChatLoadError('')
    setHistoryLoadError('')
    void api.db.chats.list(true).then((rows) => {
      if (active) setChats(rows)
    }, (loadError: unknown) => {
      if (active) setChatLoadError(backendErrorText(loadError, '讀取聊天室清單失敗'))
    }).finally(() => {
      if (active) setLoadingChats(false)
    })
    void api.db.messages.list({ limit: 1000 }).then((rows) => {
      if (active) setRecentRows(rows)
    }, (loadError: unknown) => {
      if (active) setHistoryLoadError(backendErrorText(loadError, '讀取最近訊息失敗；仍可查看即時訊息'))
    })
    return () => { active = false }
  }, [api])

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
        blocked: chat.blocked,
        lastSeenAt: chat.lastSeenAt,
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
          blocked: false,
          lastSeenAt: message.time,
          latest: null,
          loadedCount: 0
        }
        byChat.set(message.chatId, entry)
      }
      entry.loadedCount += 1
      if (!entry.latest || compareMessages(message, entry.latest) > 0) {
        entry.latest = message
        entry.lastSeenAt = message.time
        if (!chatById.has(message.chatId) && message.chat) entry.name = message.chat
      }
    }
    return [...byChat.values()].sort((a, b) => {
      const aTs = a.latest?.ts ?? (Date.parse(a.lastSeenAt) || 0)
      const bTs = b.latest?.ts ?? (Date.parse(b.lastSeenAt) || 0)
      return bTs - aTs || a.name.localeCompare(b.name)
    })
  }, [chatById, chatDisplayNames, chats, loadedMessages])

  useEffect(() => {
    if (selectedChatId && conversations.some((chat) => chat.chatId === selectedChatId)) return
    const next = conversations.find((chat) => !chat.blocked)
    setSelectedChatId(next?.chatId ?? null)
  }, [conversations, selectedChatId])

  const activeConversation = conversations.find((chat) => chat.chatId === selectedChatId) ?? null
  const activeChatId = activeConversation?.chatId ?? null

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
  }, [activeChatId, activeAvatarMessageIds, conversations])

  useEffect(() => {
    const prepare = api.media?.avatarUrls
    if (!prepare || visibleChatAvatarIds.length === 0) {
      setChatAvatarUrls({})
      setChatDisplayNames({})
      return
    }
    let active = true
    void prepare(visibleChatAvatarIds).then((batch) => {
      if (!active) return
      setChatAvatarUrls((current) => mergeRecord(current, batch.urls))
      setChatDisplayNames((current) => mergeRecord(current, batch.names))
    })
    return () => { active = false }
  }, [api, visibleChatAvatarIds])

  useEffect(() => {
    const prepare = api.media?.messageAvatarUrls
    if (!prepare || !activeChatId || visibleMessageAvatarIds.length === 0) {
      setMessageAvatarUrls({})
      setMessageDisplayNames({})
      return
    }
    let active = true
    void prepare(activeChatId, visibleMessageAvatarIds).then((batch) => {
      if (!active) return
      setMessageAvatarUrls((current) => mergeRecord(current, batch.urls))
      setMessageDisplayNames((current) => mergeRecord(current, batch.names))
    })
    return () => { active = false }
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
    if (!openMenuChatId) return
    menuRootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    function onPointerDown(event: PointerEvent): void {
      if (!menuRootRef.current?.contains(event.target as Node)) setOpenMenuChatId(null)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpenMenuChatId(null)
        menuTriggerRef.current?.focus()
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && menuRootRef.current?.contains(event.target as Node)) {
        event.preventDefault()
        menuRootRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openMenuChatId])

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
    return conversations.filter((chat) => {
      if (filter === 'active' && chat.blocked) return false
      if (filter === 'ignored' && !chat.blocked) return false
      if (!needle) return true
      const searchable = `${chat.name} ${searchableMessageTextByChat.get(chat.chatId) ?? ''}`.toLocaleLowerCase()
      return searchable.includes(needle)
    })
  }, [conversations, filter, search, searchableMessageTextByChat])

  function openMenu(chatId: string, trigger: HTMLButtonElement | null): void {
    if (openMenuChatId === chatId) {
      setOpenMenuChatId(null)
      trigger?.focus()
      return
    }
    menuTriggerRef.current = trigger
    setOpenMenuChatId(chatId)
  }

  async function toggleIgnored(chat: ConversationEntry): Promise<void> {
    if (actionBusyChatId) return
    const nextBlocked = !chat.blocked
    setActionBusyChatId(chat.chatId)
    setActionError('')
    setActionNotice('')
    try {
      const updated = await api.db.chats.setBlocked(chat.chatId, nextBlocked, nextBlocked ? 'manual' : undefined)
      if (!updated || updated.chatId !== chat.chatId || updated.blocked !== nextBlocked) {
        setActionError(`${nextBlocked ? '忽略' : '恢復'}設定沒有更新，請重試。`)
        return
      }

      setChats((current) => {
        const found = current.some((item) => item.chatId === updated.chatId)
        return found
          ? current.map((item) => item.chatId === updated.chatId ? updated : item)
          : [...current, updated]
      })

      let nextChats = chats.map((item) => item.chatId === updated.chatId ? updated : item)
      if (!nextChats.some((item) => item.chatId === updated.chatId)) nextChats = [...nextChats, updated]
      try {
        const fresh = await api.db.chats.list(true)
        const freshTarget = fresh.find((item) => item.chatId === updated.chatId)
        if (freshTarget?.blocked === nextBlocked) {
          nextChats = fresh
          setChats(fresh)
        } else {
          setActionNotice('狀態已更新；重新讀取清單尚未反映此變更，請稍後重新整理。')
        }
      } catch {
        setActionNotice('狀態已更新；清單重新讀取失敗，畫面已依操作結果更新。')
      }

      if (nextBlocked) {
        setFilter('active')
        if (selectedChatId === chat.chatId) {
          setSelectedChatId(nextChats.find((item) => !item.blocked && item.chatId !== chat.chatId)?.chatId ?? null)
          setPaneView('messages')
          setMobileView('list')
        }
        setActionNotice((current) => `${current ? `${current} ` : ''}已忽略「${chat.name}」；既有訊息與待辦保留。`)
      } else {
        setFilter('active')
        setSelectedChatId(chat.chatId)
        setPaneView('messages')
        setMobileView('conversation')
        setActionNotice((current) => `${current ? `${current} ` : ''}已恢復「${chat.name}」；既有訊息與待辦保留。`)
      }
      setOpenMenuChatId(null)
    } catch (operationError) {
      setActionError(backendErrorText(operationError, `${nextBlocked ? '忽略' : '恢復'}對話失敗`))
    } finally {
      setActionBusyChatId(null)
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
      <div className="stream-bar">
        <span className={`dot ${st.cls}`} />
        <span className="stream-status">LINE 橋接：{st.text}</span>
        {status && status.restarts > 0 && <span className="muted">（重啟 {status.restarts} 次）</span>}
        <span className="muted stream-count">{status?.messageCount ?? messages.length} 則</span>
      </div>
      {error && <div className="set-notice err stream-error" role="alert">{error}</div>}
      {historyLoadError && <div className="stream-load-note" role="status">{historyLoadError}</div>}

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
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜尋聊天和訊息"
              aria-label="搜尋聊天、已載入訊息與發話者"
            />
            {search && <button type="button" className="chat-search-clear" aria-label="清除搜尋" onClick={() => setSearch('')}>×</button>}
          </label>
          <div className="chat-list-filters" role="group" aria-label="聊天室篩選">
            <button type="button" className={filter === 'active' ? 'selected' : ''} aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>
              聊天 <span>{conversations.filter((chat) => !chat.blocked).length}</span>
            </button>
            <button type="button" className={filter === 'ignored' ? 'selected' : ''} aria-pressed={filter === 'ignored'} onClick={() => setFilter('ignored')}>
              已忽略 <span>{conversations.filter((chat) => chat.blocked).length}</span>
            </button>
          </div>
          {chatLoadError && <div className="chat-action-error" role="alert">{chatLoadError}</div>}
          {actionError && <div className="chat-action-error" role="alert">{actionError}</div>}
          {actionNotice && <div className="chat-action-notice" role="status">{actionNotice}</div>}
          <ul className="chat-list">
            {loadingChats && conversations.length === 0 && <li className="chat-list-empty muted" role="status">正在載入聊天室…</li>}
            {!loadingChats && conversations.length === 0 && <li className="chat-list-empty muted">目前尚無聊天資料</li>}
            {!loadingChats && conversations.length > 0 && shownConversations.length === 0 && (
              <li className="chat-list-empty muted">
                <span>找不到符合的聊天室</span>
                {search && <button type="button" className="link-btn" onClick={() => setSearch('')}>清除搜尋</button>}
              </li>
            )}
            {shownConversations.map((chat) => {
              const active = chat.chatId === activeChatId
              const menuOpen = openMenuChatId === chat.chatId
              const previewSender = chat.latest?.direction === 'out' ? '我' : chat.latest?.msgId ? (messageDisplayNames[chat.latest.msgId] ?? chat.latest.sender) : chat.latest?.sender
              return (
                <li
                  key={chat.chatId}
                  data-avatar-chat-id={chat.chatId}
                  ref={menuOpen ? menuRootRef : null}
                  className={`chat-list-row${active ? ' active' : ''}${menuOpen ? ' menu-open' : ''}`}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    openMenu(chat.chatId, event.currentTarget.querySelector<HTMLButtonElement>('.chat-list-item'))
                  }}
                >
                  <button
                    type="button"
                    className={`chat-list-item${active ? ' active' : ''}`}
                    aria-pressed={active}
                    onClick={() => {
                      setSelectedChatId(chat.chatId)
                      setMobileView('conversation')
                    }}
                    onKeyDown={(event) => {
                      if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
                        event.preventDefault()
                        openMenu(chat.chatId, event.currentTarget)
                      }
                    }}
                  >
                    <span className={`chat-avatar${chat.isGroup ? ' group' : ''}`} aria-hidden="true">
                      <AvatarGlyph url={chatAvatarUrls[chat.chatId]} label={chat.name} isGroup={chat.isGroup} />
                    </span>
                    <span className="chat-list-copy">
                      <span className="chat-list-line">
                        <span className="chat-list-name" title={chat.name}>{chat.name}</span>
                        <time className="chat-list-time">{chatTimeLabel(chat)}</time>
                      </span>
                      <span className="chat-list-preview">
                        {chat.latest
                          ? <>{previewSender && <span className="chat-list-sender">{previewSender}：</span>}{previewText(chat.latest)}</>
                          : '尚無已載入訊息'}
                      </span>
                    </span>
                    {active && <span className="chat-selection-marker" aria-hidden="true">✓</span>}
                  </button>
                  <button
                    type="button"
                    className="chat-more-button"
                    data-chat-more={chat.chatId}
                    aria-label={`更多操作：${chat.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={(event) => {
                      event.stopPropagation()
                      openMenu(chat.chatId, event.currentTarget)
                    }}
                  >
                    ⋯
                  </button>
                  {menuOpen && (
                    <div className="chat-context-menu" role="menu" aria-label={`${chat.name}的對話操作`}>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={actionBusyChatId === chat.chatId}
                        onClick={() => void toggleIgnored(chat)}
                      >
                        {actionBusyChatId === chat.chatId ? '處理中…' : chat.blocked ? '恢復對話' : '忽略對話'}
                      </button>
                    </div>
                  )}
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
                <span className={`chat-avatar chat-pane-avatar${activeConversation.isGroup ? ' group' : ''}`} data-avatar-chat-id={activeConversation.chatId} aria-hidden="true">
                  <AvatarGlyph url={chatAvatarUrls[activeConversation.chatId]} label={activeConversation.name} isGroup={activeConversation.isGroup} />
                </span>
                <div className="chat-pane-title">
                  <h2>{activeConversation.name}</h2>
                  <span>{activeConversation.isGroup ? '群組' : '聊天室'} · {activeConversation.loadedCount} 則已載入訊息</span>
                </div>
                <div className="chat-pane-view-toggle" role="group" aria-label="聊天室檢視">
                  <button type="button" className={paneView === 'messages' ? 'selected' : ''} aria-pressed={paneView === 'messages'} onClick={() => setPaneView('messages')}>訊息</button>
                  <button type="button" className={paneView === 'topics' ? 'selected' : ''} aria-pressed={paneView === 'topics'} onClick={() => setPaneView('topics')}>議題</button>
                  <button type="button" className={paneView === 'todos' ? 'selected' : ''} aria-pressed={paneView === 'todos'} onClick={() => setPaneView('todos')}>待辦</button>
                </div>
              </header>
              {paneView === 'topics' ? (
                <div className="chat-topics-content">
                  <GroupTopicsPanel key={activeConversation.chatId} chatId={activeConversation.chatId} chatName={activeConversation.name} chatIsGroup={activeConversation.isGroup} embedded />
                </div>
              ) : paneView === 'todos' ? (
                <ChatTodosPanel
                  key={activeConversation.chatId}
                  chatId={activeConversation.chatId}
                  chatName={activeConversation.name}
                />
              ) : (
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
              )}
            </>
          ) : (
            <div className="chat-pane-empty">
              <span className="chat-pane-empty-icon" aria-hidden="true">☷</span>
              <h2>{conversations.length === 0 ? '目前尚無聊天資料' : '選擇聊天室以查看訊息'}</h2>
              <p>選擇左側對話後，這裡會顯示已載入的訊息。</p>
            </div>
          )}
        </section>
      </div>

      {lightboxSrc && (
        <div className="sm-lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="圖片放大" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </section>
  )
}
