import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MessageDTO } from '../../types/api'
import { formatCallRecord } from '../../lib/callRecord'

/**
 * SourceMessagesModal — 來源訊息彈窗。
 *
 * 由卡片「來源訊息 (N)」開啟，顯示該對話「過去 24 小時」完整對話（氣泡串，最新在下），
 * 可往上一次載入更早 100 筆並維持捲動位置。該 todo 的來源訊息以琥珀色高亮並加「來源」標籤。
 *
 * 資料層走 Batch 2a 的 preload 契約（window.api.db.messages）：
 *   - byChatSince(chatId, sinceMs) → 過去 24h 全窗（回舊→新）
 *   - list({ chatId, beforeTs, limit }) → 往前分頁（回新→舊，prepend 前反轉成舊→新）
 * （modal 掛在 TodoCard 內、無 useTodos hook 可用；直接消費 preload API，與 hook helper 等價。）
 */

interface Props {
  chatId: string
  chatName: string | null
  sourceMsgIds: string[]
  onClose: () => void
}

const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 100
/** 自動補載安全上限：避免極活躍群一次撈爆。達任一上限即停止補載。 */
const MAX_AUTO_BATCHES = 10
const MAX_AUTO_MESSAGES = 1000

/** MessageDTO → 「MM/DD HH:mm」。優先用 timeIso（本地秒精度、無 tz），退回 ts。 */
function fmtTime(m: MessageDTO): string {
  const iso = m.timeIso
  if (iso) {
    const g = iso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
    if (g) return `${g[2]}/${g[3]} ${g[4]}:${g[5]}`
  }
  const d = new Date(m.ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** bytes → 「NN.N KB」/「NN.N MB」（< 1 KB 顯示 B）；null 回空字串。 */
function formatSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

export function SourceMessagesModal({
  chatId,
  chatName,
  sourceMsgIds,
  onClose
}: Props): JSX.Element {
  // messages 一律維持「舊→新」：最新在陣列尾、畫面底部。
  const [messages, setMessages] = useState<MessageDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [noMore, setNoMore] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const didInitialScroll = useRef(false)
  // prepend 後要補回的捲動高度差（維持視覺位置）。
  const pendingPrepend = useRef<{ prevHeight: number; prevTop: number } | null>(null)
  // 落點編排狀態：settle 後停止自動補載與再定位；autoBatches 記自動補載批數（安全上限用）。
  const didSettle = useRef(false)
  const autoBatches = useRef(0)
  const [srcTooEarly, setSrcTooEarly] = useState(false)
  // 媒體：圖片載入失敗的 msgId（onError → 改渲染「尚未下載」）。
  const [failedImgIds, setFailedImgIds] = useState<Set<string>>(new Set())
  // 媒體：lightbox 放大檢視中的圖片 URL（null = 未開）。
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  // 媒體：檔案開啟/另存失敗的輕量提示（msgId → 訊息）。
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})

  const sourceSet = useMemo(() => new Set(sourceMsgIds), [sourceMsgIds])

  // 開窗載入過去 24 小時（舊→新）。
  useEffect(() => {
    let alive = true
    setLoading(true)
    window.api.db.messages
      .byChatSince(chatId, Date.now() - DAY_MS)
      .then((list) => {
        if (!alive) return
        setMessages(list)
        setNoMore(false)
        setLoading(false)
      })
      .catch((err) => {
        if (!alive) return
        console.error('[SourceMessagesModal] byChatSince 失敗：', err)
        setMessages([])
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [chatId])

  // Esc 關閉。lightbox 開啟時，Esc 先關 lightbox、不關整個 modal。
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      if (lightboxSrc) {
        setLightboxSrc(null)
        return
      }
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, lightboxSrc])

  // 捲動控制：初次載入後停在底部（最新）；prepend 後補回高度差維持位置。
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const p = pendingPrepend.current
    if (p) {
      el.scrollTop = p.prevTop + (el.scrollHeight - p.prevHeight)
      pendingPrepend.current = null
      return
    }
    if (!loading && !didInitialScroll.current && messages.length > 0) {
      el.scrollTop = el.scrollHeight
      didInitialScroll.current = true
    }
  }, [messages, loading])

  const loadEarlier = useCallback(async (): Promise<void> => {
    if (loadingEarlier || noMore || messages.length === 0) return
    const el = bodyRef.current
    const prevHeight = el ? el.scrollHeight : 0
    const prevTop = el ? el.scrollTop : 0
    setLoadingEarlier(true)
    try {
      const oldestTs = messages[0].ts
      // list 回新→舊，反轉成舊→新再 prepend。
      const older = await window.api.db.messages.list({
        chatId,
        beforeTs: oldestTs,
        limit: PAGE_SIZE
      })
      if (older.length < PAGE_SIZE) setNoMore(true)
      if (older.length > 0) {
        const asc = older.slice().reverse()
        pendingPrepend.current = { prevHeight, prevTop }
        setMessages((cur) => asc.concat(cur))
      }
    } catch (err) {
      console.error('[SourceMessagesModal] list（載入更早）失敗：', err)
    } finally {
      setLoadingEarlier(false)
    }
  }, [chatId, messages, loadingEarlier, noMore])

  // 落點編排：初載/補載穩定後，把最早一則來源訊息捲到可視中央。
  // 若來源早於初載 24h 窗 → 自動往上補載（重用 loadEarlier，內部沿用維持捲動位置）；
  // 受 MAX_AUTO_BATCHES / MAX_AUTO_MESSAGES 上限保護，避免無限或爆量載入。
  // 用 useLayoutEffect 於 paint 前定位，避免「先到底再跳」的抖動。didSettle 確保只做一次。
  useLayoutEffect(() => {
    if (loading || loadingEarlier || didSettle.current) return
    const loaded = new Set(messages.map((m) => m.msgId))
    const missing = sourceMsgIds.some((id) => !loaded.has(id))
    const capReached =
      autoBatches.current >= MAX_AUTO_BATCHES || messages.length >= MAX_AUTO_MESSAGES
    // 尚有來源未載入、未到頂、未觸上限 → 續補一批。
    if (missing && !noMore && !capReached && messages.length > 0) {
      autoBatches.current += 1
      void loadEarlier()
      return
    }
    // 已穩定：一次性落點。
    didSettle.current = true
    const el = bodyRef.current
    if (!el) return
    const first = el.querySelector<HTMLElement>('.sm-msg.source')
    if (first) {
      // 有來源在畫面 → 捲到最早一則來源（block:center），一眼看到來源與上下文。
      first.scrollIntoView({ block: 'center' })
      setSrcTooEarly(false)
    } else {
      // 達上限仍找不到任何來源 → 輕量提示 + 退回捲到底。
      setSrcTooEarly(sourceMsgIds.length > 0)
      el.scrollTop = el.scrollHeight
    }
  }, [loading, loadingEarlier, noMore, messages, sourceMsgIds, loadEarlier])

  // 捲到頂端自動載入更早（按鈕仍保留為明確入口）。
  function onBodyScroll(): void {
    const el = bodyRef.current
    if (el && el.scrollTop < 40) void loadEarlier()
  }

  async function openFile(msgId: string): Promise<void> {
    const res = await window.api.media.open(msgId)
    setFileErrors((e) => ({ ...e, [msgId]: res.ok ? '' : '無法開啟檔案' }))
  }

  async function saveFile(msgId: string): Promise<void> {
    const res = await window.api.media.saveAs(msgId)
    // canceled 不視為錯誤。
    setFileErrors((e) => ({ ...e, [msgId]: res.ok || res.canceled ? '' : '無法另存檔案' }))
  }

  // 依 contentType 渲染訊息內容：1=圖片縮圖（點開 lightbox）、14=檔案卡、其餘=純文字。
  function renderContent(m: MessageDTO): JSX.Element {
    const url = `linemedia://media/${encodeURIComponent(m.msgId)}`
    if (m.contentType === 1) {
      if (failedImgIds.has(m.msgId)) {
        return <div className="sm-media-missing">尚未下載</div>
      }
      return (
        <div className="sm-media">
          <img
            className="sm-thumb"
            src={url}
            alt="圖片"
            onClick={() => setLightboxSrc(url)}
            onError={() =>
              setFailedImgIds((prev) => {
                const next = new Set(prev)
                next.add(m.msgId)
                return next
              })
            }
          />
        </div>
      )
    }
    if (m.contentType === 14) {
      const err = fileErrors[m.msgId]
      return (
        <>
          <div className="sm-file">
            <span className="sm-file-icon">📎</span>
            <span className="sm-file-name">{m.origFilename ?? '檔案'}</span>
            <span className="sm-file-size">{formatSize(m.fileSize)}</span>
            <span className="sm-file-actions">
              <button onClick={() => void openFile(m.msgId)}>開啟</button>
              <button onClick={() => void saveFile(m.msgId)}>另存</button>
            </span>
          </div>
          {err && (
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--red, #f26d6d)' }}>{err}</div>
          )}
        </>
      )
    }
    return <span className="sm-text">{formatCallRecord(m.text)}</span>
  }

  return createPortal(
    <>
      <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal source-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="sm-title">{chatName ?? chatId}</div>
            <div className="sm-sub">過去 24 小時</div>
          </div>
          <button className="ghost" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </div>
        <div className="sm-body" ref={bodyRef} onScroll={onBodyScroll}>
          {loading ? (
            <div className="sm-empty muted">載入中…</div>
          ) : messages.length === 0 ? (
            <div className="sm-empty muted">此對話過去 24 小時沒有訊息</div>
          ) : (
            <>
              {srcTooEarly && (
                <div
                  className="sm-load-note"
                  style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 1,
                    alignSelf: 'stretch',
                    textAlign: 'center',
                    background: 'var(--panel)'
                  }}
                >
                  來源訊息較早，已載入最近 {messages.length} 筆，可繼續往上載入
                </div>
              )}
              {noMore ? (
                <div className="sm-load-note">已無更早訊息</div>
              ) : (
                <button
                  className="sm-load-earlier"
                  type="button"
                  onClick={() => void loadEarlier()}
                  disabled={loadingEarlier}
                >
                  {loadingEarlier ? '載入中…' : '↑ 載入更早 100 筆'}
                </button>
              )}
              {messages.map((m) => {
                const isOut = m.direction === 'out'
                const isSource = sourceSet.has(m.msgId)
                return (
                  <div
                    key={m.msgId}
                    className={`sm-msg ${isOut ? 'self' : 'other'}${isSource ? ' source' : ''}`}
                  >
                    {!isOut && <div className="sm-who">{m.sender ?? '對方'}</div>}
                    <div className="sm-bubble">
                      {isSource && <span className="sm-src-tag">來源</span>}
                      {renderContent(m)}
                    </div>
                    <div className="sm-time">{fmtTime(m)}</div>
                  </div>
                )
              })}
            </>
          )}
        </div>
      </div>
    </div>
      {lightboxSrc && (
        <div className="sm-lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="圖片放大" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </>,
    document.body
  )
}
