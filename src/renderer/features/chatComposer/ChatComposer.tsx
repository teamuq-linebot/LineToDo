/**
 * ChatComposer.tsx — 聊天室下方的輸入列（pro 外掛版；`api.linejsOutbound` 存在時由 MessageStream 掛載，key={chatId}）。
 *
 * 常駐：附件（＋）、多行輸入框、傳送；狀態一行只在非閒置時出現；「無法確認」時上方有警示與「我已確認」。按需：「詳細」。
 * 只在點「傳送」或 Ctrl/⌘+Enter 時送出（Enter 換行；輸入法組字中不觸發）；按下後同步鎖住，連按只送一次。
 * 附件與文字擇一（附件不附帶文字）。切換聊天室＝重新掛載：未送出的草稿與附件丟棄，已送出的由 backend 繼續，切回時從 status 恢復。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { outboundErrorText, outboundUnknownReason } from '../../../shared/linejsOutbound'
import type { LineJsLoginControl, LineJsOutboundControl } from '../../../shared/linejsOutbound'
import { attachmentError, attachmentKind, createOutboundFlow } from './outboundFlow'
import type { ComposerState, OutboundFlow } from './outboundFlow'
import { LineLoginDialog } from './LineLoginDialog'

export interface ChatComposerProps {
  chatId: string
  chatName: string
  isGroup: boolean
  control: LineJsOutboundControl
  /** 有＝未登入時顯示「登入 LINE」按鈕（彈窗）；沒有＝維持文字提示。 */
  login?: LineJsLoginControl
}

const EDITABLE: ReadonlySet<string> = new Set(['idle', 'sent', 'failed', 'needs_login', 'loading'])
const SENDABLE: ReadonlySet<string> = new Set(['idle', 'sent', 'failed'])
/** 代表已有 LINEJS session 的輸入列狀態：登入彈窗開著時遇到就收起（不取消）。loading／needs_login（含 restoring）／unavailable 不算。 */
const SESSION_PHASES: ReadonlySet<string> = new Set(['idle', 'sending', 'sent', 'failed', 'blocked', 'unknown'])
const KIND_LABEL: Readonly<Record<string, string>> = { text: '文字', image: '圖片', file: '檔案' }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / 104857.6) / 10} MB`
}

function statusText(state: ComposerState): string | null {
  switch (state.phase) {
    case 'unavailable': return '傳送功能目前無法使用'
    case 'needs_login': return state.restoring ? '正在連線 LINE…' : '需先到「設定 › LINE 附件下載」登入 LINE 才能傳送'
    case 'blocked':
      if (state.blockedReason === 'chat_unsupported') return '此聊天室不支援傳送'
      if (state.blockedReason === 'account_unverified') return '無法確認登入的 LINE 帳號，暫時無法傳送'
      return '登入的 LINE 帳號與目前讀取的 LINE 不同，無法傳送'
    case 'sending':
      if (state.step === 'reading') return '準備附件…'
      if (state.step === 'staging') return `準備附件 ${state.progress ?? 0}%`
      return '傳送中…'
    case 'sent': return '已送出（LINE 已接受；不代表對方已讀）'
    case 'failed': return `傳送失敗：${outboundErrorText(state.code ?? '')}（草稿已保留）`
    default: return null
  }
}

function Details({ state }: { state: ComposerState }): JSX.Element | null {
  if (state.phase !== 'sent' && state.phase !== 'failed' && state.phase !== 'unknown' && state.phase !== 'blocked') return null
  const rows: Array<[string, string]> = []
  if (state.phase === 'unknown') rows.push(['為何無法確認', outboundUnknownReason(state.code ?? '')])
  if (state.code) rows.push(['錯誤碼', state.code])
  if (state.jobPhase) rows.push(['階段', state.jobPhase])
  if (state.detail) rows.push(['LINE 代碼', state.detail])
  if (state.kind) rows.push(['種類', `${KIND_LABEL[state.kind] ?? state.kind}${state.size ? `・${formatBytes(state.size)}` : ''}`])
  if (state.at) rows.push(['時間', new Date(state.at).toLocaleString()])
  if (state.messageId) rows.push(['LINE 訊息 ID', state.messageId])
  if (state.blockedReason) rows.push(['原因', state.blockedReason])
  if (rows.length === 0) return null
  return (
    <details className="chat-composer-details" data-testid="chat-composer-details">
      <summary>詳細</summary>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </details>
  )
}

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const { chatId, chatName, control, login } = props
  const [state, setState] = useState<ComposerState>({ phase: 'loading' })
  const [loginOpen, setLoginOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [attachment, setAttachment] = useState<File | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const flowRef = useRef<OutboundFlow | null>(null)
  const sendingRef = useRef(false)
  const composingRef = useRef(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const flow = createOutboundFlow({ control, chatId, onChange: setState })
    flowRef.current = flow
    void flow.refresh()
    return () => { flow.dispose(); if (flowRef.current === flow) flowRef.current = null }
  }, [control, chatId])

  useEffect(() => {
    if (!attachment || attachmentKind(attachment.type) !== 'image' || typeof URL.createObjectURL !== 'function') { setPreview(null); return undefined }
    const url = URL.createObjectURL(attachment)
    setPreview(url)
    return () => { URL.revokeObjectURL(url) }
  }, [attachment])

  const phase = state.phase
  const editable = EDITABLE.has(phase) && attachment === null
  const sendable = SENDABLE.has(phase) && (attachment !== null || draft.trim() !== '')
  const canAttach = SENDABLE.has(phase)
  // 未登入（非恢復中）且有登入控制物件：狀態列換成「登入 LINE」按鈕；恢復中仍只顯示「正在連線 LINE…」。
  const loginAvailable = phase === 'needs_login' && state.restoring !== true && login !== undefined
  // 彈窗開著時，輸入列的輪詢遇到 restoring（session 寫入中）或暫時錯誤都不收起；只有確認已有 session 才收起（REV-CL-001）。
  const sessionReady = SESSION_PHASES.has(phase)
  useEffect(() => { if (sessionReady) setLoginOpen(false) }, [sessionReady]) // 登入完成（或別處登入）後自動收起彈窗

  const send = (): void => {
    const flow = flowRef.current
    if (!flow || sendingRef.current || !SENDABLE.has(flow.state().phase)) return
    const file = attachment
    const text = draft
    if (!file && !text.trim()) return
    sendingRef.current = true // 同步鎖：連按／Ctrl+Enter 連發只會送一次
    setPickError(null) // 之前的選檔錯誤不得遮蓋這次送出的「已送出／傳送失敗」
    const work = file ? flow.sendAttachment(file) : flow.sendText(text)
    void work.finally(() => {
      sendingRef.current = false
      if (flowRef.current !== flow || flow.state().phase !== 'sent') return
      if (file) setAttachment((currentFile) => (currentFile === file ? null : currentFile))
      else setDraft((currentText) => (currentText === text ? '' : currentText))
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
    const native = event.nativeEvent as { isComposing?: boolean } | undefined
    if (composingRef.current || native?.isComposing || event.keyCode === 229) return
    event.preventDefault()
    send()
  }

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0] ?? null
    event.target.value = ''
    if (!file) return
    const invalid = attachmentError(file)
    if (invalid) { setPickError(invalid); return }
    setPickError(null)
    flowRef.current?.dismiss()
    setAttachment(file)
  }

  const removeAttachment = (): void => { setAttachment(null); setPickError(null) }
  const status = pickError ? `無法附加：${outboundErrorText(pickError)}` : loginAvailable ? null : statusText(state)
  const placeholder = attachment ? '附件不附帶文字' : '輸入訊息…'

  return (
    <div className="chat-message-composer chat-composer-live" data-testid="chat-composer" data-phase={phase} role="group" aria-label={`傳送訊息到 ${chatName}`}>
      {phase === 'unknown' && (
        <div className="chat-composer-alert" role="alert" data-testid="chat-composer-unknown">
          <strong>無法確認是否已送出</strong>
          <span>請到 LINE 確認這則訊息是否已出現；確認前不會自動重送，也無法在此聊天室再次傳送。</span>
          <button type="button" className="chat-composer-ack" data-testid="chat-composer-ack" onClick={() => { void flowRef.current?.acknowledge() }}>我已確認</button>
        </div>
      )}
      {attachment && (
        <div className="chat-composer-chip" data-testid="chat-composer-chip">
          {preview && <img src={preview} alt="" className="chat-composer-thumb" />}
          <span className="chat-composer-chip-name" title={attachment.name}>{attachment.name || '附件'}</span>
          <span className="chat-composer-chip-size">{formatBytes(attachment.size)}</span>
          <button type="button" className="link-btn" onClick={removeAttachment} disabled={phase === 'sending'} aria-label="移除附件">移除</button>
        </div>
      )}
      <div className="chat-composer-row">
        <button
          type="button"
          className="chat-composer-control"
          data-testid="chat-composer-attach"
          aria-label="附加圖片或檔案"
          title="附加圖片或檔案"
          disabled={!canAttach}
          onClick={() => fileRef.current?.click()}
        >
          <span aria-hidden="true">＋</span>
        </button>
        <input ref={fileRef} type="file" hidden tabIndex={-1} data-testid="chat-composer-file" onChange={onPick} />
        <textarea
          className="chat-composer-input chat-composer-textarea"
          data-testid="chat-composer-input"
          rows={1}
          value={draft}
          disabled={!editable}
          placeholder={placeholder}
          aria-label="訊息"
          onChange={(event) => { setDraft(event.target.value); flowRef.current?.dismiss() }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
        />
        <button
          type="button"
          className="chat-composer-control chat-composer-send"
          data-testid="chat-composer-send"
          aria-label="傳送（Ctrl+Enter）"
          title="傳送（Ctrl+Enter）"
          disabled={!sendable}
          onClick={send}
        >
          <span aria-hidden="true">➤</span>
        </button>
      </div>
      {loginAvailable && (
        <div className="chat-composer-statusline">
          <button type="button" className="chat-composer-login" data-testid="chat-composer-login" onClick={() => setLoginOpen(true)}>登入 LINE</button>
        </div>
      )}
      {status && (
        <div className="chat-composer-statusline">
          <span className="chat-composer-status" role="status" data-testid="chat-composer-status">{status}</span>
          <Details state={state} />
        </div>
      )}
      {!status && phase === 'unknown' && <Details state={state} />}
      {loginOpen && login && (
        <LineLoginDialog
          login={login}
          sessionReady={sessionReady}
          onAuthenticated={() => { setLoginOpen(false); void flowRef.current?.refresh() }}
          onClose={() => setLoginOpen(false)}
        />
      )}
    </div>
  )
}
