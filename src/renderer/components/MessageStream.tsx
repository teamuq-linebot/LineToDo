import { useEffect, useState } from 'react'
import type { RawLineMessage, LineBridgeStatus } from '../types/api'
import { useLineStream } from '../hooks/useLineStream'
import { formatCallRecord } from '../lib/callRecord'

/**
 * MessageStream — 「即時訊息流」清單。
 * 顯示 main 經由 watch_json.py 即時推來的 LINE 新訊息（最新在頂），
 * 並在頂部顯示 LINE 橋接狀態（啟動/運行/錯誤）。
 *
 * 本里程碑的可視驗收點：App 啟動後，這個清單應出現 LINE 新訊息（或近期訊息）。
 */

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

/**
 * 依 contentType 渲染單則訊息內容（比照來源訊息彈窗）：
 *   1  且有 msgId → 圖片縮圖（點開 lightbox；載入失敗→「尚未下載」）
 *   14 且有 msgId → 檔案卡（📎＋檔名＋大小＋開啟/另存；失敗給 inline 小字）
 *   其餘 / 缺 msgId → 純文字（formatCallRecord）
 * bytes 全程只在 main，此處僅持 msgId，keyMaterial 不跨橋。
 * 註：DRY 共用元件（與彈窗共用）列為後續重構，本批為低風險先落地。
 */
function MessageContent({
  m,
  onOpenLightbox
}: {
  m: RawLineMessage
  onOpenLightbox: (url: string) => void
}): JSX.Element {
  const [imgFailed, setImgFailed] = useState(false)
  const [fileErr, setFileErr] = useState('')

  if (m.contentType === 1 && m.msgId) {
    if (imgFailed) return <span className="sm-media-missing">尚未下載</span>
    const url = `linemedia://media/${encodeURIComponent(m.msgId)}`
    return (
      <span className="sm-media">
        <img
          className="sm-thumb"
          src={url}
          alt="圖片"
          onClick={() => onOpenLightbox(url)}
          onError={() => setImgFailed(true)}
        />
      </span>
    )
  }

  if (m.contentType === 14 && m.msgId) {
    const id = m.msgId
    return (
      <>
        <span className="sm-file">
          <span className="sm-file-icon">📎</span>
          <span className="sm-file-name">{m.origFilename ?? '檔案'}</span>
          <span className="sm-file-size">{formatSize(m.fileSize)}</span>
          <span className="sm-file-actions">
            <button
              type="button"
              onClick={() =>
                void window.api.media.open(id).then((r) => setFileErr(r.ok ? '' : '無法開啟檔案'))
              }
            >
              開啟
            </button>
            <button
              type="button"
              onClick={() =>
                void window.api.media
                  .saveAs(id)
                  .then((r) => setFileErr(r.ok || r.canceled ? '' : '無法另存檔案'))
              }
            >
              另存
            </button>
          </span>
        </span>
        {fileErr && (
          <span
            style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--red, #f26d6d)' }}
          >
            {fileErr}
          </span>
        )}
      </>
    )
  }

  return <>{formatCallRecord(m.text)}</>
}

function MessageRow({
  m,
  onOpenLightbox
}: {
  m: RawLineMessage
  onOpenLightbox: (url: string) => void
}): JSX.Element {
  const arrow = m.direction === 'out' ? '→' : '←'
  const hhmm = m.time?.length >= 16 ? m.time.slice(11, 16) : m.time
  return (
    <li className={`msg-row ${m.direction}`}>
      <span className="msg-time">{hhmm}</span>
      <span className="msg-arrow">{arrow}</span>
      <span className="msg-chat" title={m.chatId}>
        {m.isGroup ? '👥 ' : ''}
        {m.chat}
      </span>
      <span className="msg-sender">{m.sender}</span>
      <span className="msg-text">
        {m.unsent && <span className="unsent-badge">🚫 已收回</span>}
        {m.unsent ? (
          <span className="sm-unsent">
            <MessageContent m={m} onOpenLightbox={onOpenLightbox} />
          </span>
        ) : (
          <MessageContent m={m} onOpenLightbox={onOpenLightbox} />
        )}
      </span>
    </li>
  )
}

export function MessageStream(): JSX.Element {
  const { messages, status } = useLineStream()
  const st = statusLabel(status)
  // 媒體：lightbox 放大檢視中的圖片 URL（null = 未開）。
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  // Esc 關閉 lightbox。
  useEffect(() => {
    if (!lightboxSrc) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setLightboxSrc(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lightboxSrc])

  return (
    <section className="stream">
      <div className="stream-bar">
        <span className={`dot ${st.cls}`} />
        <span className="stream-status">LINE 橋接：{st.text}</span>
        {status && status.restarts > 0 && (
          <span className="muted">（重啟 {status.restarts} 次）</span>
        )}
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {messages.length} 則
        </span>
      </div>

      {messages.length === 0 ? (
        <div className="stream-empty muted">
          尚無訊息。watch_json.py 正在輪詢 LINE；有新訊息（或近期訊息）時會即時出現在這裡。
          <br />
          若顯示「橋接錯誤」，常見原因：LINE 未開啟（金鑰需從其記憶體讀取）或金鑰已過期。
        </div>
      ) : (
        <ul className="stream-list">
          {messages.map((m, i) => (
            <MessageRow key={`${m.chatId}-${m.ts}-${i}`} m={m} onOpenLightbox={setLightboxSrc} />
          ))}
        </ul>
      )}

      {lightboxSrc && (
        <div className="sm-lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="圖片放大" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  )
}
