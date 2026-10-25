import { useLineTodoApi } from '../platform/LineTodoApi'
import { REPLY_DRAFT_MAX_AGE_MS, parseText, useUiState } from '../lib/uiState'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import type {
  DriverFollowUpAction,
  DriverFollowUpResult,
  DriverPostResult,
  DriverPostStage,
  DriverQuietAction,
  DriverStatus,
  TodoDTO,
  VisibilityHint
} from '../types/api'

/**
 * DraftReplyDialog — 「草擬回覆」對話框（IMPLEMENTATION_PLAN.md §5 todos:draftReply）＋「填入 LINE」（driver_post）。
 *
 * 開啟即呼叫 AI 產一段草稿；可重新產生、可複製。主機提供 api.driver 且設定開啟時，多一個「填入 LINE」：
 * 在 LINE 開啟該聊天室並把草稿填進輸入框，**永遠不會送出**，Enter 由使用者自己在 LINE 按。
 *
 * 版面、狀態與文案照已核可的原型（output/sw/line-todo-driver-post-20260929/ui-prototype.html、ui-decisions.md）：
 *   - 初始：可填入／功能關閉／聊天室沒有名稱等前置問題／helper 環境問題
 *   - 填入中：7 段進度（前 3 段只讀取）；等安靜期時顯示「請暫時放開滑鼠與鍵盤…」與倒數
 *   - 成功：切到 LINE／從 LINE 清除這段草稿／關閉；成功後在對話框按 Enter＝按「切到 LINE」（ui-decisions 第 2 點，不會送出）。
 *     review F1：放開 Enter 才觸發、自動重複的 Enter 不觸發、連按只觸發一次；helper 另外在切前景前守門。
 *   - 失敗：訊息本文與副作用列都來自 main 的 messages.ts（result.body／result.tail），「複製」任何時候都可以用
 */

interface Props {
  todo: TodoDTO
  chatName: string | null
  onClose: () => void
}

type OkResult = Extract<DriverPostResult, { ok: true }>
type FailResult = Extract<DriverPostResult, { ok: false }>

type Phase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'success'; result: OkResult; at: number }
  | { kind: 'fail'; result: FailResult }

interface QuietState {
  action: DriverQuietAction
  maxWaitMs: number
  startedAt: number
}

interface FollowUpView {
  tone: 'ok' | 'warn'
  text: string
  alert: boolean
}

/** DriverPostStage → 使用者看到的 7 段（原型 STEPS）。 */
const STEP_OF_STAGE: Record<DriverPostStage, number> = {
  preflight: 0,
  host_start: 0,
  locate_line: 0,
  read_order: 1,
  read_list: 2,
  locate_row: 2,
  activate_line: 3,
  open_chat: 3,
  verify_open: 4,
  check_input_empty: 5,
  fill: 5,
  hand_back: 6,
  cleanup: 6
}

function stepLabels(x: string, verifyRead: boolean): string[] {
  return [
    '檢查 LINE 視窗',
    '讀取 LINE 聊天列表的順序（本機資料）',
    `比對 LINE 畫面上的聊天列表，找出「${x}」在哪一列`,
    `切到 LINE，開啟「${x}」`,
    `確認開啟的是「${x}」${verifyRead ? '（含已讀檢查）' : ''}`,
    '填入草稿（不會送出）',
    '切回 line-todo'
  ]
}

/** 使用者自己就能排除的停止原因：藍框（原型 guide）。 */
const GUIDE_CODES = new Set<FailResult['code']>([
  'line_not_running',
  'line_no_window',
  'line_activate_failed',
  'line_multiple_windows',
  'line_search_active',
  'user_busy',
  'list_changing',
  'list_unrecognized',
  'list_order_mismatch',
  'target_not_visible',
  'row_changed',
  'occluded'
])

const QUIET_TEXT: Record<DriverQuietAction, (x: string) => { what: string; verb: string; say: string }> = {
  activate: () => ({
    what: '正要把 LINE 切到前景。偵測到你正在操作，要等你停下一下、而且沒有按著任何鍵才會切換，避免你的操作落到 LINE。',
    verb: '切換',
    say: '正要把 LINE 切到前景'
  }),
  click: (x) => ({
    what: `正要在 LINE 點擊「${x}」這一列。偵測到你正在操作，要等你停下約半秒才會點擊，避免點錯聊天室。`,
    verb: '點擊',
    say: `正要在 LINE 點擊「${x}」`
  }),
  fill: (x) => ({
    what: `正要把草稿填入「${x}」的輸入框。偵測到你正在操作，要等你停下約半秒、而且沒有按著任何鍵才會填入，避免把字打進 LINE。`,
    verb: '填入',
    say: `正要把草稿填入「${x}」`
  })
}

const FOCUSABLE = 'button:not([disabled]), textarea, summary, input:not([disabled]), select:not([disabled]), [href]'

/**
 * 成功後「Enter＝切到 LINE」的防連發（review F1）：一次 Enter 觸發之後，這段時間內的 Enter 不再觸發。
 * 連按兩下（兩下間隔通常 < 0.5 秒）只會觸發一次；和 helper 端 500 ms 安靜期守門是兩道獨立防線。
 */
const ENTER_REFIRE_GUARD_MS = 1000

// 已產生／編輯過的草稿保留多久（G-04：畫面被重建後直接還原，不再向 AI 要一份）：24 小時，定義在 uiState.ts 的 UI_DRAFT_RETENTION。
// review N1：使用者關閉對話框就刪除；沒關就被重建的，過期後由看板啟動時／每小時的清除刪掉。
const parseReplyDraft = parseText(16 * 1024)

export function DraftReplyDialog({ todo, chatName, onClose }: Props): JSX.Element {
  const api = useLineTodoApi()
  const driverApi = api.driver
  const uid = useId()
  // G-04：上次的草稿（外掛版存在 UI 狀態；standalone 不保存）。有就直接用，不再花一次 AI 呼叫；「重新產生」仍可要新的。
  const ui = useUiState()
  const replyDraftKey = `reply.draft.${todo.id}`
  const [restoredDraft] = useState(() => ui.read(replyDraftKey, parseReplyDraft, { maxAgeMs: REPLY_DRAFT_MAX_AGE_MS }))
  const [draft, setDraft] = useState(restoredDraft ?? '')
  // 掛載時就會開始草擬：從 true 開始，初始焦點才會等 textarea 出現後再放（不會被「AI 草擬中…」換掉）。
  const [loading, setLoading] = useState(restoredDraft === undefined)
  const [error, setError] = useState<string | null>(null)
  // 草稿（AI 產生的或使用者改過的）一改變就保存。
  useEffect(() => {
    if (!loading && !error && draft !== '') ui.write(replyDraftKey, draft)
  }, [ui, replyDraftKey, draft, loading, error])
  const [copied, setCopied] = useState(false)

  // ── 填入 LINE ──
  /** null＝查詢中；false＝主機沒有提供或查詢失敗（只能複製）。 */
  const [status, setStatus] = useState<DriverStatus | false | null>(null)
  const [verifyRead, setVerifyRead] = useState(true)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [step, setStep] = useState(0)
  const [quiet, setQuiet] = useState<QuietState | null>(null)
  const [tick, setTick] = useState(0)
  const [follow, setFollow] = useState<FollowUpView | null>(null)
  const [followBusy, setFollowBusy] = useState(false)
  const [cleared, setCleared] = useState(false)
  const [expired, setExpired] = useState(false)
  const [livePolite, setLivePolite] = useState('')
  const [liveAssert, setLiveAssert] = useState('')

  const runningRef = useRef(false)
  /** 後續動作進行中（同步鎖；state 要等下一次 render 才看得到）。 */
  const followBusyRef = useRef(false)
  /** 這一次 Enter 的按下（非自動重複）發生在成功畫面上；放開時才觸發「切到 LINE」。 */
  const enterArmedRef = useRef(false)
  /** 上一次由 Enter 觸發「切到 LINE」的時間。 */
  const lastEnterFireRef = useRef(-Infinity)
  const modalRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const progTitleRef = useRef<HTMLSpanElement>(null)
  const resTitleRef = useRef<HTMLHeadingElement>(null)
  const openerRef = useRef<HTMLElement | null>(typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null)
  const initialFocusDone = useRef(false)

  const x = chatName ?? todo.chatId
  const running = phase.kind === 'running'
  const ids = {
    title: `${uid}-title`,
    sub: `${uid}-sub`,
    reason: `${uid}-reason`,
    host: `${uid}-host`
  }

  async function generate(): Promise<void> {
    setLoading(true)
    setError(null)
    setCopied(false)
    try {
      const res = await api.db.todos.draftReply(todo.id)
      if (res.error) {
        setError(res.error)
        setDraft('')
      } else {
        setDraft(res.draft ?? '')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (!driverApi) {
      setStatus(false)
      return
    }
    try {
      setStatus(await driverApi.status({ todoId: todo.id }))
    } catch {
      // 主機沒有註冊 driver（例如驗收模式）→ 退回只能複製。
      setStatus(false)
    }
  }, [driverApi, todo.id])

  useEffect(() => {
    if (restoredDraft === undefined) void generate()
    void refreshStatus()
    api.settings
      .get()
      .then((v) => setVerifyRead(v.driverPost?.verifyReadByDb !== false))
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todo.id])

  // 關閉後焦點回到開啟對話框的按鈕（notes §3.1）。
  useEffect(() => {
    const opener = openerRef.current
    return () => {
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
    }
  }, [])

  // 草稿載入後，初始焦點放在 textarea（notes §3.1）。
  useEffect(() => {
    if (!loading && !error && !initialFocusDone.current && textRef.current) {
      initialFocusDone.current = true
      textRef.current.focus()
    }
  }, [loading, error])

  const say = (text: string, assertive = false): void => {
    const set = assertive ? setLiveAssert : setLivePolite
    set('')
    setTimeout(() => set(text), 30)
  }

  // 進度（含 waitingForQuiet）。
  useEffect(() => {
    if (!driverApi) return undefined
    return driverApi.onProgress((p) => {
      if (!runningRef.current) return
      if (p.waitingForQuiet === true) {
        const action = p.quietAction ?? 'click'
        const maxWaitMs = p.quietMaxWaitMs && p.quietMaxWaitMs > 0 ? p.quietMaxWaitMs : 3000
        setQuiet({ action, maxWaitMs, startedAt: Date.now() })
        setStep((s) => Math.max(s, STEP_OF_STAGE[p.stage]))
        // 只在開始等候時朗讀一次（notes §3.3）。
        say(`請暫時放開滑鼠與鍵盤。${QUIET_TEXT[action](x).say}，最多再等 ${Math.round(maxWaitMs / 1000)} 秒。`, true)
        return
      }
      setQuiet(null)
      if (p.waitingForQuiet === false) return
      setStep(STEP_OF_STAGE[p.stage])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverApi, x])

  // 進度朗讀（只換清單內容，不重建標題）。
  useEffect(() => {
    if (!running) return
    say(`第 ${step + 1} / 7 段：${stepLabels(x, verifyRead)[step]}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, running])

  // 等候倒數（0.1 秒更新；倒數本身 aria-hidden）。
  useEffect(() => {
    if (!quiet) return undefined
    const t = setInterval(() => setTick((n) => n + 1), 100)
    return () => clearInterval(t)
  }, [quiet])

  // 焦點：開始填入 → 進度標題；結束 → 結果標題（notes §3.1）。
  useEffect(() => {
    if (phase.kind === 'running') progTitleRef.current?.focus()
    if (phase.kind === 'success' || phase.kind === 'fail') resTitleRef.current?.focus()
  }, [phase])

  // 成功後 5 分鐘：「切到 LINE」「清除」失效（原型 4f）。
  useEffect(() => {
    if (phase.kind !== 'success') return undefined
    const left = phase.result.followUpTtlMs - (Date.now() - phase.at)
    if (left <= 0) {
      setExpired(true)
      return undefined
    }
    const t = setTimeout(() => setExpired(true), left)
    return () => clearTimeout(t)
  }, [phase])

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(draft)
      setCopied(true)
      say('已複製草稿')
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('複製失敗（剪貼簿不可用）')
    }
  }

  async function fill(): Promise<void> {
    if (!driverApi || runningRef.current) return
    runningRef.current = true
    setStep(0)
    setQuiet(null)
    setFollow(null)
    setCleared(false)
    setExpired(false)
    setPhase({ kind: 'running' })
    let r: DriverPostResult
    try {
      r = await driverApi.postDraft({ todoId: todo.id, text: draft })
    } catch (err) {
      // IPC 本身失敗（不是 driver 的停止）：沒有 messages.ts 的訊息可用，只能顯示例外文字。
      const text = err instanceof Error ? err.message : String(err)
      r = {
        ok: false,
        attemptId: '-',
        code: 'internal',
        message: text,
        body: text,
        tail: null,
        stage: 'preflight',
        draftLeftInLine: 'none',
        lineSideEffects: { activated: false, searchChanged: false, searchRestored: false, chatOpened: false }
      }
    }
    runningRef.current = false
    setQuiet(null)
    setPhase(r.ok ? { kind: 'success', result: r, at: Date.now() } : { kind: 'fail', result: r })
    void refreshStatus()
  }

  // 視窗失去焦點時，已按下但還沒放開的 Enter 作廢（放開事件可能落在別的視窗）。
  useEffect(() => {
    const disarm = (): void => {
      enterArmedRef.current = false
    }
    window.addEventListener('blur', disarm)
    return () => window.removeEventListener('blur', disarm)
  }, [])

  async function followUp(action: DriverFollowUpAction): Promise<void> {
    if (phase.kind !== 'success' || !driverApi || followBusy || followBusyRef.current || expired || cleared) return
    followBusyRef.current = true
    setFollowBusy(true)
    let r: DriverFollowUpResult
    try {
      r = action === 'focusLine' ? await driverApi.focusLine(phase.result.attemptId) : await driverApi.clearFilled(phase.result.attemptId)
    } catch (err) {
      r = { ok: false, action, code: 'internal', message: err instanceof Error ? err.message : String(err), activated: false }
    }
    followBusyRef.current = false
    setFollowBusy(false)
    if (r.ok && r.outcome === 'cleared') {
      setCleared(true)
      setFollow({ tone: 'ok', text: r.message, alert: false })
      say(r.message)
      resTitleRef.current?.focus()
    } else if (r.ok) {
      setFollow({ tone: 'ok', text: r.message, alert: false })
    } else if (r.code === 'attempt_expired') {
      setExpired(true)
      setFollow(null)
    } else {
      setFollow({ tone: 'warn', text: r.message, alert: true })
    }
  }

  function close(): void {
    if (runningRef.current) return
    // 使用者自己關閉＝這份草稿用完了：從 UI 狀態刪掉（review N1）。畫面被重建（不是關閉）時不會走到這裡，草稿照 G-04 保留。
    ui.remove(replyDraftKey)
    onClose()
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    // 其他按鍵：作廢尚未放開的 Enter。
    if (e.key !== 'Enter') enterArmedRef.current = false
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Tab' && modalRef.current) {
      // 焦點鎖定在對話框內（notes §3.1）。
      const nodes = Array.from(modalRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement)
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !modalRef.current.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !modalRef.current.contains(active))) {
        e.preventDefault()
        first.focus()
      }
      return
    }
    // ui-decisions 第 2 點：填入成功後，在對話框按 Enter＝按「切到 LINE」（不會送出）。textarea 裡的 Enter 維持換行。
    // review F1：按下時只「預備」，放開（keyup）才觸發；自動重複的 Enter（e.repeat）不預備、不觸發。
    // 所以按住 Enter 只會在放開時觸發一次，而且 helper 會再等放開後的安靜期才切到 LINE。
    if (e.key === 'Enter' && enterShortcutApplies(e)) {
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) enterArmedRef.current = true
    }
  }

  function enterShortcutApplies(e: ReactKeyboardEvent<HTMLDivElement>): boolean {
    if (phase.kind !== 'success' || cleared) return false
    const target = e.target as HTMLElement
    return !(target.tagName === 'TEXTAREA' || e.nativeEvent.isComposing)
  }

  function onKeyUp(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'Enter') return
    const armed = enterArmedRef.current
    enterArmedRef.current = false
    if (!armed || !enterShortcutApplies(e)) return
    e.preventDefault()
    e.stopPropagation()
    // 同一次按壓只觸發一次；連按兩下只觸發一次（進行中不再觸發，觸發後 ENTER_REFIRE_GUARD_MS 內也不再觸發）。
    const t = Date.now()
    if (followBusyRef.current || t - lastEnterFireRef.current < ENTER_REFIRE_GUARD_MS) return
    lastEnterFireRef.current = t
    void followUp('focusLine')
  }

  // ── 呈現 ──
  const st = status || null
  const driverOn = !!st && st.enabled
  const hostProblem = driverOn ? st.lastHostProblem : null
  const targetProblem = driverOn ? st.targetProblem : null
  const draftReady = !loading && !error && draft.trim() !== ''

  let area: JSX.Element | null = null
  let note: JSX.Element | string = ''
  let copyPrimary = false
  let fillBtn: JSX.Element | null = null

  if (phase.kind === 'idle') {
    if (!driverOn) {
      note = (
        <>
          只草擬，<strong>不會送出</strong>。複製後請自行貼到 LINE。
        </>
      )
      copyPrimary = true
      if (st && !st.enabled) area = <div className="dp-sub">可在「設定 › 填入 LINE」開啟自動填入。</div>
    } else if (targetProblem) {
      note = '不會送出：Enter 由你自己在 LINE 按。'
      copyPrimary = true
      fillBtn = (
        <>
          <button type="button" disabled aria-describedby={ids.reason}>
            填入 LINE
          </button>
          <div className="dp-reason" id={ids.reason}>
            {targetProblem.message}
          </div>
        </>
      )
    } else if (hostProblem) {
      note = '不會送出：Enter 由你自己在 LINE 按。'
      copyPrimary = true
      area = (
        <div className="set-notice warn" id={ids.host}>
          <span className="set-notice-icon" aria-hidden="true">
            ⚠
          </span>
          <div className="set-notice-body">
            <div className="set-notice-title">目前無法使用「填入 LINE」</div>
            <div>{hostProblem.message}</div>
          </div>
        </div>
      )
      fillBtn = (
        <button type="button" disabled aria-describedby={ids.host}>
          填入 LINE
        </button>
      )
    } else {
      note = '不會送出：Enter 由你自己在 LINE 按。'
      area = <IntroNotice x={x} />
      fillBtn = (
        <button type="button" onClick={() => void fill()} disabled={!draftReady}>
          填入 LINE
        </button>
      )
    }
  } else if (phase.kind === 'running') {
    note = '開啟與填入的瞬間請放開滑鼠與鍵盤。全程約 13–20 秒。'
    area = <Progress step={step} labels={stepLabels(x, verifyRead)} quiet={quiet} tick={tick} x={x} titleRef={progTitleRef} />
    fillBtn = (
      <button type="button" disabled>
        <span className="dp-spin" aria-hidden="true"></span> 填入中…
      </button>
    )
  } else if (phase.kind === 'success') {
    note = '草稿還沒有送出。'
    area = (
      <SuccessBlock
        r={phase.result}
        x={x}
        cleared={cleared}
        expired={expired}
        follow={follow}
        busy={followBusy}
        titleRef={resTitleRef}
        onFocusLine={() => void followUp('focusLine')}
        onClear={() => void followUp('clearFilled')}
        onDone={close}
      />
    )
    fillBtn = (
      <button type="button" className="ghost" onClick={() => void fill()} disabled={!draftReady || !driverOn}>
        填入 LINE
      </button>
    )
  } else {
    note = '不會送出：Enter 由你自己在 LINE 按。'
    copyPrimary = /複製/.test(phase.result.body)
    area = <FailBlock r={phase.result} x={x} titleRef={resTitleRef} />
    fillBtn = (
      <button type="button" className={copyPrimary ? 'ghost' : ''} onClick={() => void fill()} disabled={!draftReady || !driverOn}>
        填入 LINE
      </button>
    )
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal draft-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-describedby={ids.sub}
        aria-busy={running || undefined}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        <div className="modal-head">
          <strong id={ids.title}>草擬回覆</strong>
          <button type="button" className="ghost" onClick={close} disabled={running} aria-label="關閉對話框">
            ✕
          </button>
        </div>
        <div className="modal-sub muted" id={ids.sub}>
          給「{x}」 · 針對：{todo.title}
        </div>

        {loading ? (
          <div className="draft-box muted">AI 草擬中…</div>
        ) : error ? (
          <div className="draft-box draft-err">{error}</div>
        ) : (
          <textarea
            ref={textRef}
            className="draft-box draft-text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            spellCheck={false}
            readOnly={running}
            aria-readonly={running || undefined}
            aria-label="草稿內容（可編輯）"
          />
        )}

        {area && <div className="dp-area">{area}</div>}

        <div className="modal-actions">
          <span className="muted draft-note">{note}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="ghost" onClick={() => void generate()} disabled={loading || running}>
            重新產生
          </button>
          <button type="button" className={copyPrimary ? '' : 'ghost'} onClick={() => void copy()} disabled={loading || running || !draft}>
            {copied ? '已複製 ✓' : '複製'}
          </button>
          {fillBtn}
        </div>

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {livePolite}
        </div>
        <div className="sr-only" aria-live="assertive" aria-atomic="true">
          {liveAssert}
        </div>
      </div>
    </div>
  )
}

function IntroNotice({ x }: { x: string }): JSX.Element {
  return (
    <div className="set-notice">
      <span className="set-notice-icon" aria-hidden="true">
        ℹ
      </span>
      <div className="set-notice-body">
        <div>
          按「填入 LINE」會在 LINE 的聊天列表找到「{x}」並開啟，把草稿填入輸入框，<strong>不會送出</strong>
          。你確認 LINE 上方的聊天室名稱後，自己按 Enter 送出。
        </div>
        <ul>
          <li>開啟聊天室會讓 LINE 跳到前景，並把該聊天室標為已讀。</li>
          <li>「{x}」要在 LINE 聊天列表目前的畫面上看得到；看不到時會告訴你往哪裡捲。</li>
        </ul>
      </div>
    </div>
  )
}

function Progress(props: {
  step: number
  labels: string[]
  quiet: QuietState | null
  tick: number
  x: string
  titleRef: RefObject<HTMLSpanElement>
}): JSX.Element {
  const { step, labels, quiet, x } = props
  const items: JSX.Element[] = []
  labels.forEach((label, i) => {
    if (i === 3)
      items.push(
        <li key="sep" className="dp-sep" aria-hidden="true">
          以下會切換 LINE 畫面
        </li>
      )
    const state = i < step ? 'done' : i === step ? 'cur' : 'todo'
    items.push(
      <li key={i} className={state} aria-current={state === 'cur' ? 'step' : undefined}>
        <span className="dp-ico" aria-hidden="true">
          {state === 'done' ? '✓' : state === 'cur' ? <span className="dp-spin"></span> : '·'}
        </span>
        <span>
          {label}
          <span className="sr-only">{state === 'done' ? '（完成）' : state === 'cur' ? '（進行中）' : '（尚未開始）'}</span>
        </span>
        {i <= 2 && state === 'cur' && <span className="dp-tag">只讀取，LINE 畫面不會變動</span>}
      </li>
    )
  })
  let quietBox: JSX.Element | null = null
  if (quiet) {
    const left = Math.max(0, quiet.maxWaitMs - (Date.now() - quiet.startedAt))
    const t = QUIET_TEXT[quiet.action](x)
    quietBox = (
      <div className="set-notice warn">
        <span className="set-notice-icon" aria-hidden="true">
          ✋
        </span>
        <div className="set-notice-body">
          <div className="set-notice-title">請暫時放開滑鼠與鍵盤…</div>
          <div>{t.what}</div>
          <div className="dp-bar" aria-hidden="true">
            <span style={{ width: `${(left / quiet.maxWaitMs) * 100}%` }}></span>
          </div>
          <div className="muted" aria-hidden="true">
            最多再等 <b>{(left / 1000).toFixed(1)}</b> 秒；等不到就停止，不會{t.verb}。
          </div>
        </div>
      </div>
    )
  }
  return (
    <>
      <div className="dp-steps-head">
        <span ref={props.titleRef} tabIndex={-1}>
          填入 LINE 進行中
        </span>
        <span className="muted">
          第 {step + 1} / {labels.length} 段
        </span>
      </div>
      <ol className="dp-steps" aria-label="填入 LINE 進度">
        {items}
      </ol>
      {quietBox}
    </>
  )
}

function SuccessBlock(props: {
  r: OkResult
  x: string
  cleared: boolean
  expired: boolean
  follow: FollowUpView | null
  busy: boolean
  titleRef: RefObject<HTMLHeadingElement>
  onFocusLine: () => void
  onClear: () => void
  onDone: () => void
}): JSX.Element {
  const { r, x, cleared, expired, follow, busy } = props
  return (
    <section className="dp-result ok">
      <h3 ref={props.titleRef} tabIndex={-1}>
        <span aria-hidden="true">✓ </span>
        {cleared ? (
          <>
            已清除：<span className="nm">{x}</span> 的草稿
          </>
        ) : (
          <>
            已填入：<span className="nm">{x}</span>
          </>
        )}
      </h3>
      {cleared ? (
        <p>LINE 裡已經沒有這段草稿。需要的話可以再按一次「填入 LINE」，或按「複製」自行貼上。</p>
      ) : (
        <p>
          請到 LINE 確認視窗上方的聊天室名稱是「<strong>{x}</strong>」，再自己按 Enter 送出。
        </p>
      )}
      {follow && (
        <div className={`dp-inline-msg ${follow.tone}`} role={follow.alert ? 'alert' : 'status'}>
          {follow.text}
        </div>
      )}
      {!cleared && r.handBackNote && <div className="dp-inline-msg warn">{r.handBackNote}</div>}
      {!cleared && expired && <div className="dp-inline-msg warn">{r.expiredNote}</div>}
      {cleared ? (
        <div className="dp-acts">
          <button type="button" className="ghost" onClick={props.onDone}>
            關閉
          </button>
        </div>
      ) : (
        <>
          <div className="dp-acts">
            <button type="button" onClick={props.onFocusLine} disabled={expired || busy}>
              切到 LINE
            </button>
            <button type="button" className="ghost danger" onClick={props.onClear} disabled={expired || busy}>
              從 LINE 清除這段草稿
            </button>
            <button type="button" className="ghost" onClick={props.onDone}>
              關閉
            </button>
          </div>
          {/* review F2：沒能切回 line-todo 時，鍵盤焦點可能還在 LINE 的輸入框（handBackNote 說按 Enter 會直接送出），
              這裡不能再說「在這裡按 Enter……不會送出」，只保留有效時間。 */}
          <div className="dp-sub">
            {r.handedBack ? '在這裡按 Enter 等同按「切到 LINE」（不會送出，Enter 要到 LINE 自己按）。' : ''}「切到 LINE」和「清除」
            {Math.round(r.followUpTtlMs / 60000)} 分鐘內有效。
          </div>
          <details>
            <summary>辨識細節</summary>
            <p>{r.details}</p>
          </details>
        </>
      )}
    </section>
  )
}

function FailBlock({ r, x, titleRef }: { r: FailResult; x: string; titleRef: RefObject<HTMLHeadingElement> }): JSX.Element {
  const vis = r.visibility
  // review F3：點擊沒有拿到結果就停止 → 「可能已開啟」，樣式和已開啟相同（警示），標題不說「有開啟」。
  const maybeOpened = !r.lineSideEffects.chatOpened && r.lineSideEffects.chatOpenUncertain === true
  const opened = r.lineSideEffects.chatOpened || maybeOpened
  const draftInLine = r.draftLeftInLine !== 'none'
  const isNv = r.code === 'target_not_visible'
  let header = '已停止，沒有填入'
  if (isNv && vis && vis.direction !== 'edge') header = '請先在 LINE 捲動聊天列表'
  else if (isNv) header = `請把「${x}」捲離列表邊緣`
  else if (draftInLine) header = '已停止，請到 LINE 檢查輸入框'
  else if (maybeOpened) header = '已停止，沒有填入（可能已開啟聊天室）'
  else if (opened) header = '已停止，沒有填入（有開啟聊天室）'
  const tone = opened || draftInLine ? 'err' : GUIDE_CODES.has(r.code) ? '' : 'warn'

  let effect: JSX.Element | null = null
  if (r.tail) {
    if (draftInLine) {
      effect = (
        <p className="dp-effect unknown">
          <b aria-hidden="true">⚠ </b>
          {r.tail}
        </p>
      )
    } else if (opened) {
      // 「已開啟一個聊天室（可能已變成已讀）」以警示色強調（原型 fx=opened）。
      const cut = r.tail.indexOf('，')
      effect = (
        <p className="dp-effect opened">
          <b aria-hidden="true">⚠ </b>
          {cut > 0 ? (
            <>
              <b>{r.tail.slice(0, cut)}</b>
              {r.tail.slice(cut)}
            </>
          ) : (
            r.tail
          )}
        </p>
      )
    } else if (r.lineSideEffects.activated) {
      effect = <p className="dp-effect">{r.tail}</p>
    } else {
      effect = (
        <p className="dp-effect">
          <span aria-hidden="true">✓ </span>
          {r.tail}
        </p>
      )
    }
  }
  return (
    <section className={`dp-result${tone ? ' ' + tone : ''}`} role="alert">
      <h3 ref={titleRef} tabIndex={-1}>
        {header}
      </h3>
      <p>{r.body}</p>
      {isNv && vis && <NotVisibleHint vis={vis} x={x} />}
      {effect}
      <details>
        <summary>技術細節</summary>
        <p>
          錯誤碼：<code>{r.code}</code>
          {vis ? `（${vis.direction}${vis.edgeSide ? '／' + vis.edgeSide : ''}）` : ''} · 階段：<code>{r.stage}</code>
          。回報問題時可以附上這一行；不含草稿內容。
        </p>
      </details>
    </section>
  )
}

/** target_not_visible 的方向示意（aria-hidden；完整資訊在訊息文字裡）。 */
function NotVisibleHint({ vis, x }: { vis: VisibilityHint; x: string }): JSX.Element {
  const rows = (n: number): JSX.Element[] => Array.from({ length: n }, (_, i) => <div key={i} className="nv-row"></div>)
  let col: JSX.Element
  let big: string
  let hint: string
  if (vis.direction === 'below') {
    col = (
      <>
        <div className="nv-view">
          <span className="nv-view-label">目前畫面</span>
          {rows(4)}
        </div>
        <div className="nv-gap">
          ⋮<br />約 {vis.rows} 列<br />⋮
        </div>
        <div className="nv-row nv-target">{x}</div>
      </>
    )
    big = `往下捲 ↓ 約 ${vis.rows} 列`
    hint = `捲到看得到「${x}」、而且它不在最上或最下一列，再按一次「填入 LINE」。`
  } else if (vis.direction === 'above') {
    col = (
      <>
        <div className="nv-row nv-target">{x}</div>
        <div className="nv-gap">
          ⋮<br />約 {vis.rows} 列<br />⋮
        </div>
        <div className="nv-view">
          <span className="nv-view-label">目前畫面</span>
          {rows(4)}
        </div>
      </>
    )
    big = `往上捲 ↑ 約 ${vis.rows} 列`
    // 原型的範例是釘選聊天室；VisibilityHint 沒有「是否釘選」，所以不加釘選說明。
    hint = `捲到看得到「${x}」、而且它不在最上或最下一列，再按一次「填入 LINE」。`
  } else {
    const top = vis.edgeSide === 'top'
    col = (
      <div className="nv-view">
        <span className="nv-view-label">目前畫面</span>
        {top && <div className="nv-row nv-edge">{x}</div>}
        {rows(3)}
        {!top && <div className="nv-row nv-edge">{x}</div>}
      </div>
    )
    big = top ? '稍微往上捲 1–2 列' : '稍微往下捲 1–2 列'
    hint = `讓「${x}」上下都還有其他聊天室，程式才能確認位置。`
  }
  return (
    <div className="nv" aria-hidden="true">
      <div className="nv-col">{col}</div>
      <div className="nv-say">
        <span className="nv-big">{big}</span>
        <span>{hint}</span>
      </div>
    </div>
  )
}
