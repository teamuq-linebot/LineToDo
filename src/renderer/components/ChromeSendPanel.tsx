import { useEffect, useRef, useState } from 'react'
import type { ChromeLineApi, ChromeLineSendResult } from '../../shared/api'

/**
 * ChromeSendPanel — 草擬回覆對話框裡的「用 Chrome 發送」（外掛版：`api.chromeLine`）。
 *
 * 經 TeamUQ 共用瀏覽器裡的 LINE Chrome 外掛送出草稿。會真的送出，所以一定先顯示確認（收件聊天室、副作用），
 * 按「確定發送」才呼叫 backend；送出的是按下確定當下的草稿內容。backend 以聊天室名稱找聊天室、核對 ID 與名稱後才按 Enter，
 * 並以 LINE 的 sendMessage 回應確認送達。
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'sending' }
  | { kind: 'done'; result: ChromeLineSendResult }

interface Props {
  api: ChromeLineApi
  todoId: string
  /** 聊天室名稱（顯示用；backend 以 todo 自己查名稱）。 */
  chatName: string
  draft: string
  /** 草稿可送（產生完成、非空、對話框沒有其他動作進行中）。 */
  draftReady: boolean
  onBusyChange(busy: boolean): void
}

export function ChromeSendPanel({ api, todoId, chatName, draft, draftReady, onBusyChange }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  async function send(): Promise<void> {
    const text = draft
    setPhase({ kind: 'sending' })
    onBusyChange(true)
    let result: ChromeLineSendResult
    try {
      result = await api.send({ todoId, text })
    } catch (error) {
      result = {
        ok: false, code: 'internal', stage: 'preflight', chatName, sent: 'unknown',
        message: `用 Chrome 發送時發生錯誤：${error instanceof Error ? error.message : String(error)}。請到 LINE 確認是否已送出。`
      }
    }
    onBusyChange(false)
    if (mounted.current) setPhase({ kind: 'done', result })
  }

  if (phase.kind === 'confirm') {
    return (
      <div className="set-notice warn" role="group" aria-label="確認用 Chrome 發送">
        <span className="set-notice-icon" aria-hidden="true">⚠</span>
        <div className="set-notice-body">
          <div className="set-notice-title">要把上面的草稿送到「{chatName}」嗎？</div>
          <ul>
            <li>會用 TeamUQ 共用瀏覽器裡的 LINE Chrome 外掛<strong>直接送出</strong>，送出後無法從這裡收回。</li>
            <li>會在共用瀏覽器開啟這個聊天室，裡面的未讀訊息會變成已讀。</li>
          </ul>
          <div className="modal-actions">
            <span style={{ flex: 1 }} />
            <button type="button" className="ghost" onClick={() => setPhase({ kind: 'idle' })}>取消</button>
            <button type="button" onClick={() => void send()} disabled={!draftReady}>確定發送</button>
          </div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'sending') {
    return (
      <div className="modal-actions" aria-live="polite">
        <span className="muted draft-note">正在用 Chrome 的 LINE 外掛送到「{chatName}」（約 5–15 秒）…</span>
        <span style={{ flex: 1 }} />
        <button type="button" disabled>
          <span className="dp-spin" aria-hidden="true"></span> 發送中…
        </button>
      </div>
    )
  }

  const result = phase.kind === 'done' ? phase.result : null
  const canRetry = result === null || (!result.ok && result.sent === 'no')
  return (
    <>
      {result && (
        result.ok ? (
          <div className="set-notice" role="status">
            <span className="set-notice-icon" aria-hidden="true">✓</span>
            <div className="set-notice-body">已用 Chrome 的 LINE 外掛送到「{result.chatName}」。</div>
          </div>
        ) : (
          <div className="set-notice warn" role="alert">
            <span className="set-notice-icon" aria-hidden="true">⚠</span>
            <div className="set-notice-body">
              <div className="set-notice-title">{result.sent === 'no' ? '沒有送出' : '無法確認是否已送出'}</div>
              <div>{result.message}</div>
            </div>
          </div>
        )
      )}
      {canRetry && (
        <div className="modal-actions">
          <span className="muted draft-note">也可以直接用 Chrome 的 LINE 外掛送出。</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="ghost" onClick={() => setPhase({ kind: 'confirm' })} disabled={!draftReady}>
            用 Chrome 發送…
          </button>
        </div>
      )}
    </>
  )
}
