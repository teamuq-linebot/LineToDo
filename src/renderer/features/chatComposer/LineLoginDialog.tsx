/**
 * LineLoginDialog.tsx — 聊天室輸入列的「登入 LINE」彈窗（pro 外掛版）。
 *
 * 開啟即呼叫 linejsMedia.startLogin，之後每秒查 linejsMedia.status 顯示 QR／等待／失敗。
 * 掃描後 LINE 要求在手機輸入 PIN 時，後端在 status 帶出 `pin`：顯示「請在手機 LINE 輸入 PIN：xxxxxx」（只在畫面上）。
 * QR 還沒出現時顯示已等待秒數（LINE 產生 QR 需要數次連線）；`restoring`＝後端正在恢復已儲存的登入。
 * - 後端已有別處（設定頁）開始的登入時回 `joined`：彈窗只接手顯示，關閉時不取消它（REV-CL-003）。
 * - 只在使用者明確關閉（✕、取消登入、Esc、點外部）或卸載（切換聊天室）時取消，而且只取消自己開始、尚未完成的登入。
 *   輸入列已有 session（`sessionReady`）時的卸載是「登入已完成」，不是取消（REV-CL-001）。
 * - 查詢失敗只顯示提示，彈窗留著；失敗時可「清除登入資料並重新登入」（與設定頁同一個 linejsMedia.logout，REV-CL-002）。
 * 登入完成（backend 回 authenticated）→ onAuthenticated。登入流程、session 寫入與防競態都在後端；這裡只顯示狀態，不讀憑證。
 * fix2（實機：手機輸入 PIN 後 backend 已登入，但彈窗停在 PIN）：
 * - 查詢逾時之後 host 才送到的 authenticated（pluginTransport `onLate`）一樣算登入完成；其他晚到的狀態可能已過時，不採用。
 * - QR／PIN 畫面上連續 `STUCK_FAILURES` 次查不到狀態：說明「若已在手機完成，請稍候或關閉視窗」，並提供「關閉視窗」——
 *   只收起彈窗、不取消登入（PIN 可能已經輸入、backend 可能正在寫入 session；取消會把它丟掉）。登入完成後輸入列自己會偵測到 session。
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { LineJsLoginControl, LineJsLoginView } from '../../../shared/linejsOutbound'

export interface LineLoginDialogProps {
  login: LineJsLoginControl
  /** 登入完成：呼叫端關閉彈窗並重新查詢輸入列狀態。 */
  onAuthenticated(): void
  /** 使用者取消／關閉：呼叫端卸載彈窗（需要的取消請求已由這裡送出）。 */
  onClose(): void
  /** 輸入列已確認有 session：此時卸載代表登入已完成，不取消。 */
  sessionReady?: boolean
}

/** 狀態輪詢間隔（ms）。 */
const POLL_MS = 1000
/** QR／PIN 畫面上連續這麼多次查不到狀態，就說明可以怎麼做（單次失敗只顯示忙碌提示）。 */
const STUCK_FAILURES = 2
const stuckText = (pin: boolean): string =>
  `${pin ? '若已在手機輸入 PIN' : '若已在手機確認登入'}，登入可能已經完成：請稍候，畫面會自動更新；或按「關閉視窗」，不會取消登入，完成後輸入列會自動可以傳送。`

const errorText = (cause: unknown): string => (cause instanceof Error && cause.message ? cause.message : 'LINE 登入失敗')
/**
 * 查詢狀態失敗的提示。畫面端等不到回覆（`view_call_timeout`，pluginTransport）多半是外掛背景工作（首次匯入 LINE 訊息）讓後端暫時忙碌：
 * 登入本身仍在進行，QR／PIN 仍有效，下一次查詢成功就會更新。
 */
const pollErrorText = (cause: unknown): string =>
  (cause as { code?: unknown } | null)?.code === 'view_call_timeout'
    ? '外掛正在處理背景工作，登入狀態稍後更新（畫面上的 QR code／PIN 仍有效）'
    : `暫時無法取得登入狀態：${errorText(cause)}`

export function LineLoginDialog({ login, onAuthenticated, onClose, sessionReady = false }: LineLoginDialogProps): JSX.Element {
  const [view, setView] = useState<LineJsLoginView>({ status: 'pending' })
  /** 開始登入／清除登入資料失敗的訊息（使用者再按一次才清掉）。 */
  const [message, setMessage] = useState<string | null>(null)
  /** 查詢狀態失敗（暫時性）：下一次查詢成功就消失，彈窗不關。 */
  const [pollError, setPollError] = useState<string | null>(null)
  /** 連續查詢失敗次數（成功就歸零）。 */
  const [failures, setFailures] = useState(0)
  const [busy, setBusy] = useState(false)
  /** 這一次登入開始的時間：QR code 還沒出現時顯示已等待幾秒（LINE 產生 QR 需要數次連線）。 */
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const titleId = useId()
  const subId = useId()
  const modalRef = useRef<HTMLDivElement | null>(null)
  const loginRef = useRef(login)
  const onAuthenticatedRef = useRef(onAuthenticated)
  const onCloseRef = useRef(onClose)
  const sessionReadyRef = useRef(sessionReady)
  /** 已成功或已送出取消：之後不再重複取消、也不再回報成功。 */
  const settledRef = useRef(false)
  /** 目前的登入是這個彈窗開始的（不是接手設定頁的）：只有這種才由彈窗取消。 */
  const ownsRef = useRef(false)
  const checkingRef = useRef(false)
  const mountedRef = useRef(false)
  loginRef.current = login
  onAuthenticatedRef.current = onAuthenticated
  onCloseRef.current = onClose
  sessionReadyRef.current = sessionReady

  const begin = async (): Promise<void> => {
    const started = await loginRef.current.startLogin()
    ownsRef.current = started.status === 'pending' && started.joined !== true
  }

  useEffect(() => {
    let alive = true
    mountedRef.current = true
    const answered = (value: { login: LineJsLoginView }): void => {
      setPollError(null)
      setFailures(0)
      setView(value.login)
      if (value.login.status === 'authenticated' && !settledRef.current) {
        settledRef.current = true
        onAuthenticatedRef.current()
      }
    }
    /** 逾時之後才到的回覆：只採用 authenticated（登入只會往完成走；其他狀態可能比之後的回覆還舊）。 */
    const late = (value: { login: LineJsLoginView }): void => {
      if (alive && value?.login?.status === 'authenticated') answered(value)
    }
    const check = async (): Promise<void> => {
      if (checkingRef.current) return
      checkingRef.current = true
      try {
        const value = await loginRef.current.status({ onLate: late })
        if (!alive) return
        answered(value)
      } catch (cause) {
        if (alive) { setPollError(pollErrorText(cause)); setFailures((count) => count + 1) }
      } finally {
        checkingRef.current = false
      }
    }
    const start = async (): Promise<void> => {
      try {
        await begin()
      } catch (cause) {
        if (alive) setMessage(errorText(cause))
      }
      await check()
    }
    void start()
    const timer = setInterval(() => { void check() }, POLL_MS)
    modalRef.current?.focus()
    return () => {
      alive = false
      clearInterval(timer)
      mountedRef.current = false
      // 卸載（切換聊天室）且自己開始的登入還沒完成：取消，不遺留 pending。輸入列已有 session＝登入完成後的收起，不取消。
      // 延到下一個 macrotask 再判斷：StrictMode 開發模式會模擬「卸載再掛載」，那時 mountedRef 會被重新設回 true，不能誤取消剛開始的登入。
      setTimeout(() => {
        if (!mountedRef.current && !settledRef.current && ownsRef.current && !sessionReadyRef.current) {
          settledRef.current = true
          void loginRef.current.cancelLogin().catch(() => {})
        }
      }, 0)
    }
  }, [])

  const cancel = (): void => {
    if (!settledRef.current && ownsRef.current) {
      settledRef.current = true
      void loginRef.current.cancelLogin().catch(() => {})
    }
    onCloseRef.current()
  }

  /** 「關閉視窗」（查不到狀態時）：只收起，不取消登入——卸載時也不取消（settled）；登入完成後輸入列自己偵測到 session。 */
  const dismiss = (): void => {
    settledRef.current = true
    onCloseRef.current()
  }

  const run = (action: () => Promise<unknown>): void => {
    setMessage(null)
    setFailures(0)
    setBusy(true)
    setStartedAt(Date.now())
    setView({ status: 'pending' })
    void action().catch((cause: unknown) => setMessage(errorText(cause))).finally(() => setBusy(false))
  }
  const retry = (): void => run(begin)
  /** 失效的已存登入資料：清除（設定頁同一個 logout）後重新開始 QR 登入。 */
  const clearAndRetry = (): void => run(async () => { await loginRef.current.logout(); await begin() })

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  }

  const failed = view.status === 'failed'
  const waiting = view.status === 'pending'
  const done = view.status === 'authenticated'
  /** QR／PIN 已在畫面上、但連續查不到狀態：使用者可能已在手機完成，告訴他可以怎麼做。 */
  const stuck = waiting && Boolean(view.pin || view.qr) && failures >= STUCK_FAILURES
  const stuckNote = stuck
    ? (
      <>
        <div className="set-notice warn" role="status" data-testid="chat-login-stuck">{stuckText(Boolean(view.pin))}</div>
        <button type="button" data-testid="chat-login-dismiss" onClick={dismiss}>關閉視窗</button>
      </>
    )
    : null

  let body: JSX.Element
  if (done) {
    body = <div className="chat-login-note" role="status">LINE 已登入</div>
  } else if (failed) {
    body = (
      <>
        <div className="set-notice err" role="alert" data-testid="chat-login-error">{view.error?.message || 'LINE 登入失敗，請重試。'}</div>
        <button type="button" data-testid="chat-login-retry" disabled={busy} onClick={retry}>重試</button>
        <button type="button" data-testid="chat-login-clear" disabled={busy} onClick={clearAndRetry}>清除登入資料並重新登入</button>
      </>
    )
  } else if (waiting && view.pin) {
    // 掃描後 LINE 要求在手機輸入 PIN：只顯示 PIN（QR 已經掃過）。PIN 只在畫面上，不寫入任何地方。
    body = (
      <>
        <div className="chat-login-pin" role="status" data-testid="chat-login-pin">請在手機 LINE 輸入 PIN：<strong>{view.pin}</strong></div>
        <div className="chat-login-note" data-testid="chat-login-waiting">輸入完成後會自動登入，等待中…</div>
        {stuckNote}
        <button type="button" data-testid="chat-login-cancel" onClick={cancel}>取消登入</button>
      </>
    )
  } else if (waiting && view.qr) {
    body = (
      <>
        <img src={view.qr} alt="LINE 登入 QR code" className="chat-login-qr" width={180} height={180} data-testid="chat-login-qr" />
        <div className="chat-login-note" role="status" data-testid="chat-login-waiting">請用手機 LINE 掃描 QR code 並確認登入，等待中…</div>
        {stuckNote}
        <button type="button" data-testid="chat-login-cancel" onClick={cancel}>取消登入</button>
      </>
    )
  } else if (waiting) {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    body = (
      <>
        <div className="chat-login-note" role="status" data-testid="chat-login-waiting">正在向 LINE 取得 QR code…{seconds >= 3 ? `（已等待 ${seconds} 秒）` : ''}</div>
        {seconds >= 10 && <div className="chat-login-note" data-testid="chat-login-slow">LINE 伺服器回應或外掛背景工作較慢時，可能需要數十秒；請保持此視窗開啟。</div>}
        <button type="button" data-testid="chat-login-cancel" onClick={cancel}>取消登入</button>
      </>
    )
  } else if (view.status === 'restoring') {
    body = <div className="chat-login-note" role="status" data-testid="chat-login-restoring">正在恢復已儲存的 LINE 登入…</div>
  } else if (view.status === 'cancelled') {
    body = (
      <>
        <div className="chat-login-note" role="status" data-testid="chat-login-cancelled">登入已取消</div>
        <button type="button" data-testid="chat-login-retry" disabled={busy} onClick={retry}>重試</button>
      </>
    )
  } else {
    body = (
      <>
        <div className="chat-login-note" role="status" data-testid="chat-login-idle">目前沒有進行中的登入</div>
        <button type="button" data-testid="chat-login-retry" disabled={busy} onClick={retry}>開始登入</button>
      </>
    )
  }

  return (
    <div className="modal-backdrop" onClick={cancel} data-testid="chat-login-backdrop">
      <div
        className="modal chat-login-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subId}
        tabIndex={-1}
        data-testid="chat-login-dialog"
        data-status={view.status}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <strong id={titleId}>登入 LINE</strong>
          <button type="button" className="ghost" onClick={cancel} aria-label="關閉對話框" data-testid="chat-login-close">✕</button>
        </div>
        <div className="chat-login-body" id={subId}>
          {message && <div className="set-notice err" role="alert">{message}</div>}
          {pollError && <div className="set-notice warn" role="status" data-testid="chat-login-poll-error">{pollError}</div>}
          {body}
        </div>
      </div>
    </div>
  )
}
