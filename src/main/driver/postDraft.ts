/**
 * postDraft.ts — driver_post 狀態機 v3（design-v3 §5；沿用 design-v2 §3、design-v1 §3 未變更的部分）。
 *
 *   S0 preflight → S1 host_start → S2 locate_line → S3 read_order（DB-A）→ S4 read_list（擷取＋R1–R3）
 *   → S5 locate_row（DB-B、L1–L8；list_changing 最多重試 1 次）→ S6 activate_line（定位後才切前景）
 *   → S7 open_chat（guardedClick）→ S8 verify_open（C1、C2、C3）→ S10 check_input_empty → S11 fill
 *   → S12 hand_back → S13 cleanup
 *
 * 只填入、永遠不送出（I2、I11）。依賴只經由 port 注入（LineUiPortV3、LineOrderPort），不 import psHost。
 * 不變條件（M4 以呼叫紀錄驗證）：
 *   I1  setEdit 只在 C1、C2 通過且 C3 沒有否決之後
 *   I4  guardedClick 只在 locateTarget ok（L1–L8 全過）且 S6 列表再確認之後；只點 S5 算出的列
 *   I12 不寫搜尋框、不捲動（port 沒有這類指令）
 *   I13 列的選擇只來自 DB 名次與錨點位移
 *   S6 之前不切前景（唯一例外：LINE 最小化時的還原）
 * 稽核 log 一行，不含名稱、OCR 原文、草稿。
 *
 * Batch 5：
 *   - waitingForQuiet：helper 在守門指令開始等安靜期時通知（port.onQuietWait），這裡轉成 DriverPostProgress
 *     { waitingForQuiet:true, quietAction, quietMaxWaitMs }；該指令回來後送 { waitingForQuiet:false }。
 *   - 後續動作 focusLine／clearFilled：只接受最近一次成功填入、5 分鐘內的 attemptId；下一次 postDraft 開始時清除。
 *     和 postDraft 共用互斥（busy）。不注入任何按鍵。
 */
import { IDENTIFY_RULES, normalizeName, rowReadings, titleReadings, cpLen } from './identify'
import {
  LOCATE_RULES,
  dbAck,
  indexOrder,
  judgeOpen,
  locateTarget,
  orderStable,
  stableRanges,
  type LocateRow,
  type OpenEvidence,
  type VisibilityHint
} from './locate'
import { FOLLOW_UP_EXPIRED_NOTE, HAND_BACK_FAILED_NOTE, detailsText, followUpMessage, messageFor, messageParts } from './messages'
import { orderRStar, SELF_CHAT_NAME, type OrderRow, type OrderSnapshot } from './order'
import {
  QUIET,
  ROW_CONFIGS,
  TITLE_CONFIGS,
  HOST_TIMEOUTS_MS,
  PortCommandError,
  PortTimeoutError,
  PortUnavailableError,
  type LineOrderPort,
  type LineUiPortV3,
  type HostHello,
  type ListRowV3,
  type PortResult,
  type QuietGuardedCommand,
  type TitleReadings
} from './port'
import type {
  DraftLeftInLine,
  DriverFollowUpAction,
  DriverFollowUpResult,
  DriverPostErrorCode,
  DriverPostMode,
  DriverPostProgress,
  DriverPostRequest,
  DriverPostResult,
  DriverPostStage,
  DriverQuietAction,
  DriverStatus,
  LineSideEffects,
  LocateEvidence
} from './types'

/** v1 常數（不是設定）。 */
export const POST_RULES = {
  maxTextLen: 5000,
  minIntervalMs: 3000,
  wholeOperationMs: HOST_TIMEOUTS_MS.wholeOperation,
  titleRereadMs: 300,
  followUpTtlMs: 5 * 60 * 1000
} as const

export interface PostDraftDeps {
  ui: LineUiPortV3
  order: LineOrderPort
  getSettings(): { enabled: boolean; mode: DriverPostMode; verifyReadByDb: boolean }
  getTodo(todoId: string): { chatId: string } | null
  /** line-todo DB 的聊天室名稱（顯示用與 S0 檢查）。 */
  getChatName(chatId: string): string | null
  /** 測試允許清單（LINE_TODO_DRIVER_TEST_ALLOW）；null＝沒有設定。 */
  testAllowlist(): string[] | null
  /** line-todo 主視窗 HWND（交還焦點用）；取不到為 null。 */
  lineTodoHwnd(): bigint | null
  /** 交還焦點失敗時（flashFrame＋通知，不含草稿）。 */
  onHandBackFailed?(chatName: string): void
  progress?(p: DriverPostProgress): void
  log?(line: string): void
  now?(): number
  sleep?(ms: number): Promise<void>
  newAttemptId?(): string
  /** 整體逾時（預設 30 s）；測試用。 */
  wholeOperationMs?: number
}

/** 填入成功後，Batch 5 的後續動作（切到 LINE、清除草稿）需要的記憶體內資料。不寫檔。 */
export interface FollowUpRecord {
  attemptId: string
  text: string
  approvedTitleHash: string
  /** line-todo DB 的聊天室名稱（只供訊息顯示）。 */
  chatName: string
  at: number
}

const QUIET_ACTION: Record<QuietGuardedCommand, DriverQuietAction> = { activateLine: 'activate', guardedClick: 'click', setEdit: 'fill' }

class Stop extends Error {
  constructor(
    public readonly code: DriverPostErrorCode,
    public readonly extra: { otherChatName?: string; seenTitle?: string; visibility?: VisibilityHint } = {}
  ) {
    super(code)
  }
}
class Cancelled extends Error {}

interface Ctx {
  attemptId: string
  todoId: string
  chatId: string
  stage: DriverPostStage
  left: DraftLeftInLine
  fx: LineSideEffects
  cancelled: boolean
  sessionStarted: boolean
  /** 已送出 waitingForQuiet:true、還沒送 false。 */
  quietShown: boolean
  /** guardedClick 已送出、還沒拿到結果（review F3：這時停止就無法確定是否已開啟聊天室）。 */
  clickPending: boolean
  startedAt: number
  // 稽核
  retry: number
  rank?: number
  pinned?: boolean
  offset?: number
  anchors?: number
  path?: 'T' | 'A' | 'B'
  row?: number
  win?: string
  selOk?: boolean
  titleSim?: number
  titleGap?: number
  titlePass?: number
  dbAck?: string
  dbMs: number[]
  lineVer?: string | null
}

const norm = (s: string): string => s.replace(/\r\n?/g, '\n')

export function createPostDraft(deps: PostDraftDeps) {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const newId = deps.newAttemptId ?? (() => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
  let busy = false
  let lastStart = -Infinity
  let followUp: FollowUpRecord | null = null

  /** 回報用的副作用：點擊沒有拿到結果就停止 → chatOpenUncertain（review F3）。 */
  function effects(ctx: Ctx): LineSideEffects {
    return ctx.clickPending && !ctx.fx.chatOpened ? { ...ctx.fx, chatOpenUncertain: true } : { ...ctx.fx }
  }

  function failResult(ctx: Ctx, code: DriverPostErrorCode, chatName: string | undefined, extra: Stop['extra'] = {}): DriverPostResult {
    const fx = effects(ctx)
    const parts = messageParts(code, {
      chatName,
      otherChatName: extra.otherChatName,
      seenTitle: extra.seenTitle,
      visibility: extra.visibility,
      stage: ctx.stage,
      draftLeftInLine: ctx.left,
      lineSideEffects: fx
    })
    return {
      ok: false,
      attemptId: ctx.attemptId,
      code,
      message: parts.tail && parts.inMessage ? parts.body + parts.tail : parts.body,
      body: parts.body,
      tail: parts.tail,
      stage: ctx.stage,
      draftLeftInLine: ctx.left,
      lineSideEffects: fx,
      ...(extra.otherChatName ? { otherChatName: extra.otherChatName } : {}),
      ...(extra.seenTitle ? { seenTitle: extra.seenTitle } : {}),
      ...(extra.visibility ? { visibility: extra.visibility } : {})
    }
  }

  function audit(ctx: Ctx, result: string, startedAt: number): void {
    const t = deps.ui.telemetry?.()
    const q = t?.quietWaitMs ?? {}
    const f = (v: unknown): string => (v === undefined || v === null ? '-' : String(v))
    deps.log?.(
      `[driver] attempt=${ctx.attemptId} todo=${ctx.todoId} chat=${ctx.chatId} result=${result} stage=${ctx.stage} left=${ctx.left} ` +
        `opened=${ctx.fx.chatOpened ? 1 : ctx.clickPending ? '?' : 0} activated=${ctx.fx.activated ? 1 : 0} ` +
        `rank=${f(ctx.rank)} pinned=${ctx.pinned === undefined ? '-' : ctx.pinned ? 1 : 0} off=${f(ctx.offset)} anchors=${f(ctx.anchors)} ` +
        `path=${f(ctx.path)} row=${f(ctx.row)} win=${f(ctx.win)} retry=${ctx.retry} selOk=${ctx.selOk === undefined ? '-' : ctx.selOk ? 1 : 0} ` +
        `titleSim=${f(ctx.titleSim)} titleGap=${f(ctx.titleGap)} titlePass=${ctx.titlePass === undefined ? '-' : ctx.titlePass + '/3'} dbAck=${f(ctx.dbAck)} ` +
        `quietWaitMs=${f(q.activateLine)},${f(q.guardedClick)},${f(q.setEdit)} activityDuringRun=${t?.activity ? 1 : 0} ` +
        `dbMs=${ctx.dbMs.join(',') || '-'} lineVer=${f(ctx.lineVer)} ms=${now() - startedAt}`
    )
  }

  async function postDraft(req: DriverPostRequest): Promise<DriverPostResult> {
    const startedAt = now()
    const ctx: Ctx = {
      attemptId: newId(),
      todoId: String(req?.todoId ?? ''),
      chatId: '-',
      stage: 'preflight',
      left: 'none',
      fx: { activated: false, searchChanged: false, searchRestored: false, chatOpened: false },
      cancelled: false,
      sessionStarted: false,
      quietShown: false,
      clickPending: false,
      startedAt,
      retry: 0,
      dbMs: []
    }
    let chatName: string | undefined
    const settings = deps.getSettings()
    // S0 ①–③（互斥之前的檢查不佔用 busy）
    if (!settings.enabled) return failResult(ctx, 'disabled', undefined)
    if (busy) return failResult(ctx, 'busy', undefined)
    if (now() - lastStart < POST_RULES.minIntervalMs) return failResult(ctx, 'rate_limited', undefined)
    busy = true
    lastStart = now()
    // design-v2 §9.2：上一次成功填入的後續資料在下一次 postDraft 開始時清除。
    followUp = null
    deps.ui.onQuietWait?.((e) => {
      if (ctx.cancelled) return
      ctx.quietShown = true
      deps.progress?.({ attemptId: ctx.attemptId, stage: ctx.stage, waitingForQuiet: true, quietAction: QUIET_ACTION[e.command], quietMaxWaitMs: e.maxWaitMs })
    })
    try {
      let timer: NodeJS.Timeout | null = null
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), deps.wholeOperationMs ?? POST_RULES.wholeOperationMs)
      })
      const work = run(ctx, req, settings, (n) => (chatName = n)).then(
        (r) => ({ kind: 'done' as const, r }),
        (e: unknown) => ({ kind: 'error' as const, e })
      )
      const first = await Promise.race([work, timeout])
      if (timer) clearTimeout(timer)
      let result: DriverPostResult
      if (first === 'timeout') {
        // 整體逾時：取消後續所有 port 呼叫，終止 helper（design-v1 §3.2）。
        ctx.cancelled = true
        // 寫入指令已送出但沒有回應：無法確定輸入框狀態（design-v1 §3.2）。
        if (ctx.stage === 'fill' && ctx.left === 'none') ctx.left = 'unknown'
        try {
          await deps.ui.dispose()
        } catch {
          // ignore
        }
        result = failResult(ctx, 'timeout', chatName)
      } else if (first.kind === 'done') {
        result = first.r
      } else {
        result = await onError(ctx, first.e, chatName)
      }
      audit(ctx, result.ok ? 'ok' : result.code, startedAt)
      return result
    } finally {
      deps.ui.onQuietWait?.(null)
      busy = false
    }
  }

  async function onError(ctx: Ctx, e: unknown, chatName: string | undefined): Promise<DriverPostResult> {
    let code: DriverPostErrorCode
    let extra: Stop['extra'] = {}
    if (e instanceof Stop) {
      code = e.code
      extra = e.extra
    } else if (e instanceof Cancelled) {
      code = 'timeout'
    } else if (e instanceof PortTimeoutError) {
      code = 'timeout'
      if (ctx.stage === 'fill' && ctx.left === 'none') ctx.left = 'unknown'
    } else if (e instanceof PortUnavailableError) {
      code = 'host_unavailable'
    } else if (e instanceof PortCommandError) {
      code = mapCommandError(e.message)
    } else {
      code = 'internal'
    }
    // S12（必要時）：LINE 曾被我們切到前景 → 交還焦點（不改變 LINE 的內容）。
    if (ctx.fx.activated && !ctx.cancelled) {
      const hwnd = deps.lineTodoHwnd()
      if (hwnd) {
        try {
          await deps.ui.handBackFocus(hwnd)
        } catch {
          // 不影響原本的結果
        }
      }
    }
    await endSession(ctx)
    return failResult(ctx, code, chatName, extra)
  }

  function mapCommandError(msg: string): DriverPostErrorCode {
    if (msg === 'line_not_running' || msg.startsWith('line_not_running')) return 'line_not_running'
    if (msg.startsWith('line_no_window')) return 'line_no_window'
    if (msg.startsWith('line_multiple_windows')) return 'line_multiple_windows'
    if (msg.startsWith('ocr_unavailable')) return 'ocr_unavailable'
    return 'line_ui_unrecognized'
  }

  async function endSession(ctx: Ctx): Promise<void> {
    if (ctx.cancelled || !ctx.sessionStarted) return
    try {
      await deps.ui.endSession()
    } catch {
      // 清理失敗只寫 log
    }
  }

  async function run(
    ctx: Ctx,
    req: DriverPostRequest,
    settings: ReturnType<PostDraftDeps['getSettings']>,
    setName: (n: string) => void
  ): Promise<DriverPostResult> {
    const stage = (s: DriverPostStage): void => {
      if (ctx.cancelled) throw new Cancelled()
      ctx.stage = s
      deps.progress?.({ attemptId: ctx.attemptId, stage: s })
    }
    /** 每個 port 呼叫都經過這裡：逾時取消後不再碰 LINE。 */
    const P = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (ctx.cancelled) throw new Cancelled()
      const v = await fn()
      if (ctx.cancelled) throw new Cancelled()
      return v
    }
    /** 守門指令（會等安靜期）：回來之後，若曾送出 waitingForQuiet:true，補送 false。 */
    const G = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await P(fn)
      } finally {
        if (ctx.quietShown) {
          ctx.quietShown = false
          if (!ctx.cancelled) deps.progress?.({ attemptId: ctx.attemptId, stage: ctx.stage, waitingForQuiet: false })
        }
      }
    }
    const snap = async (): Promise<OrderSnapshot> => {
      const t = now()
      const r = await P(() => deps.order.snapshot())
      ctx.dbMs.push(now() - t)
      if (!r.ok) throw new Stop(r.code)
      return r.value
    }

    // ── S0 preflight（不碰 LINE）──
    if (req?.mode === 'fillAndSend') throw new Stop('send_not_available')
    const text = norm(String(req?.text ?? ''))
    if (!text.trim()) throw new Stop('invalid_request')
    if (text.length > POST_RULES.maxTextLen) throw new Stop('text_too_long')
    const todo = deps.getTodo(ctx.todoId)
    if (!todo) throw new Stop('todo_not_found')
    ctx.chatId = todo.chatId
    const dbName = deps.getChatName(todo.chatId)
    if (!dbName || !dbName.trim()) throw new Stop('chat_name_missing')
    setName(dbName)
    if (cpLen(normalizeName(dbName)) < IDENTIFY_RULES.minTargetLen) throw new Stop('chat_name_unverifiable')
    const allow = deps.testAllowlist()
    if (allow) {
      if (!allow.includes(todo.chatId)) {
        if (!allow.includes(SELF_CHAT_NAME)) throw new Stop('test_allowlist_blocked')
        // 「Keep筆記」代表 _profile._mid（design-v3 S0）：只讀 DB，不碰 LINE 畫面。
        const s0 = await snap()
        if (!s0.selfMid || s0.selfMid !== todo.chatId) throw new Stop('test_allowlist_blocked')
      }
    }

    // ── S1 host_start ──
    stage('host_start')
    let hello: HostHello
    try {
      hello = await P(() => deps.ui.hello())
    } catch (e) {
      if (e instanceof Cancelled) throw e
      throw new Stop('host_unavailable')
    }
    if (hello.languageMode !== 'FullLanguage') throw new Stop('powershell_restricted')
    if (!Array.isArray(hello.ocrLanguages) || !hello.ocrLanguages.includes('zh-Hant-TW')) throw new Stop('ocr_unavailable')
    ctx.sessionStarted = true
    await P(() => deps.ui.beginSession())

    // ── S2 locate_line ──
    stage('locate_line')
    const loc = await P(() => deps.ui.locateLine())
    if (loc.status === 'not_running') throw new Stop('line_not_running')
    if (loc.status === 'no_window') throw new Stop('line_no_window')
    if (loc.status === 'multiple_windows') throw new Stop('line_multiple_windows')
    ctx.lineVer = loc.exeVersion
    if (loc.otherTopLevel.length > 0) throw new Stop('line_multiple_windows')
    // ② 搜尋框必須是空的：在任何切前景之前檢查（最小化時 UIA 仍讀得到搜尋框，Batch 3 實測）。
    const search = await P(() => deps.ui.readSearch())
    if (search !== '') throw new Stop('line_search_active')
    if (loc.iconic) {
      // ③ S6 之前唯一會切前景的情況：最小化時先還原（PrintWindow 擷取不到最小化視窗）。
      const act = await G(() => deps.ui.activateLine({ restore: true, quiet: QUIET.activate }))
      if (!act.ok) throw new Stop(act.refusal === 'user_busy' ? 'user_busy' : 'line_activate_failed')
      ctx.fx.activated = true
      if (!act.value.foreground) throw new Stop('line_activate_failed')
    }
    // UI 結構錨點在還原之後才檢查：LINE 最小化時 UIA 樹收合，probeAnchors 會缺 5 個節點（Batch 3 實測），
    // 先檢查會讓最小化的 LINE 永遠停在 line_ui_unrecognized，走不到 design-v3 S2 ③ 的還原。
    const anchorsOk = await P(() => deps.ui.probeAnchors())
    if (!anchorsOk.ok) throw new Stop('line_ui_unrecognized')

    // ── S3–S5（list_changing 最多重試 1 次）──
    let B!: OrderSnapshot
    let rsB!: OrderRow[]
    let fullRows!: ListRowV3[]
    let selBefore: number | null = null
    let preClickTitleHash = ''
    let located!: Extract<ReturnType<typeof locateTarget>, { ok: true }>
    for (let attempt = 0; ; attempt++) {
      ctx.retry = attempt
      // S3 read_order（DB-A）
      stage('read_order')
      const A = await snap()
      const rsA = orderRStar(A.rows)
      const idxA = indexOrder(rsA)
      const kA = idxA.rankById.get(todo.chatId)
      if (kA === undefined) throw new Stop('target_not_in_line')
      const lineName = idxA.norms[kA]
      if (!lineName || cpLen(lineName) < IDENTIFY_RULES.minTargetLen) throw new Stop('chat_name_unverifiable')

      // S4 read_list
      stage('read_list')
      const list = await P(() => deps.ui.readList({ configs: ROW_CONFIGS }))
      if (!list.ok) throw new Stop('line_capture_failed')
      fullRows = list.value.rows.filter((r) => r.rect.h > 0 && r.visibleH >= LOCATE_RULES.fullyVisible * r.rect.h)
      if (fullRows.length === 0) throw new Stop('list_unrecognized')
      if (fullRows.some((r) => r.selected === null)) throw new Stop('line_ui_unrecognized')
      const sel = list.value.rows.find((r) => r.selected === true)
      selBefore = sel ? sel.index : null
      const pre = await P(() => deps.ui.readTitle({ configs: ['T1'] }))
      if (!pre.ok) throw new Stop('line_capture_failed')
      preClickTitleHash = pre.value.stripHash

      // S5 locate_row（DB-B、L1–L8）
      stage('locate_row')
      B = await snap()
      rsB = orderRStar(B.rows)
      const idxB = indexOrder(rsB)
      const kB = idxB.rankById.get(todo.chatId)
      if (kB === undefined) throw new Stop('target_not_in_line')
      const locRows: LocateRow[] = fullRows.map((r) => ({ index: r.index, readings: rowReadings(r.ocr, ROW_CONFIGS) }))
      const res = locateTarget(locRows, rsB, todo.chatId, idxB)
      ctx.rank = kB
      ctx.pinned = rsB[kB].pinned
      ctx.offset = res.ok ? res.offset : res.offset
      ctx.anchors = res.ok ? res.anchors.length : res.anchors
      if (ctx.offset !== undefined) ctx.win = `${fullRows[0].index + ctx.offset}..${fullRows[fullRows.length - 1].index + ctx.offset}`
      const st = orderStable(rsA, rsB, stableRanges(res, locRows, kB), { newestUpdate: B.newestUpdate, now: now(), captureStable: list.value.stable })
      if (!st.ok) {
        if (attempt < LOCATE_RULES.retryOnChanging) {
          await sleep(LOCATE_RULES.retryDelayMs)
          continue
        }
        throw new Stop('list_changing')
      }
      if (!res.ok) {
        const other = res.otherChatId ? rsB.find((r) => r.chatId === res.otherChatId)?.name ?? undefined : undefined
        if (res.code === 'target_not_in_line' || res.code === 'chat_name_unverifiable') throw new Stop(res.code)
        throw new Stop(res.code, { visibility: res.visibility, otherChatName: other })
      }
      located = res
      break
    }
    ctx.path = located.path
    ctx.row = located.row
    const target = fullRows.find((r) => r.index === located.row) as ListRowV3
    const windowRows = fullRows.map((r) => ({ index: r.index, rect: r.rect, hash: r.hash }))

    // ── S6 activate_line（定位成功後才切前景）──
    stage('activate_line')
    const act = await G(() => deps.ui.activateLine({ restore: false, quiet: QUIET.activate }))
    if (!act.ok) throw new Stop(act.refusal === 'user_busy' ? 'user_busy' : 'line_activate_failed')
    ctx.fx.activated = true
    if (!act.value.foreground) throw new Stop('line_activate_failed')
    const geo = await P(() => deps.ui.readListGeometry())
    if (!geo.ok) throw new Stop('line_capture_failed')
    for (const w of windowRows) {
      const g = geo.value.rows.find((r) => r.index === w.index)
      if (!g || g.hash !== w.hash || g.rect.x !== w.rect.x || g.rect.y !== w.rect.y || g.rect.w !== w.rect.w || g.rect.h !== w.rect.h) {
        throw new Stop('row_changed')
      }
    }

    // ── S7 open_chat ──
    stage('open_chat')
    // review F3：從送出點擊到拿到結果之間停止（整體逾時、port 逾時、helper 例外或結束），點擊可能已經發生
    // （helper 是單執行緒，dispose 的 shutdown 會等它做完）。這段期間的失敗一律回報「可能已開啟」。
    ctx.clickPending = true
    const click = await G(() =>
      deps.ui.guardedClick({ row: { index: target.index, rect: target.rect, hash: target.hash }, windowRows, quiet: QUIET.click })
    )
    ctx.clickPending = false
    if (!click.ok) {
      const r = click.refusal
      throw new Stop(r === 'row_changed' ? 'row_changed' : r === 'occluded' ? 'occluded' : r === 'user_busy' ? 'user_busy' : 'line_ui_unrecognized')
    }
    if (!click.value.clicked) throw new Stop('internal')
    ctx.fx.chatOpened = true
    const selAfter = click.value.selectedIndexAfter
    const stable = await P(() => deps.ui.waitTitleStable())
    if (!stable.ok) throw new Stop('timeout')

    // ── S8 verify_open（C1、C2、C3）──
    stage('verify_open')
    const idxB = indexOrder(rsB)
    const readTitle = async (): Promise<PortResult<TitleReadings>> => P(() => deps.ui.readTitle({ configs: TITLE_CONFIGS }))
    let t = await readTitle()
    if (!t.ok) throw new Stop('title_unreadable')
    const judge = (tv: TitleReadings) =>
      judgeOpen({
        targetRow: located.row,
        offset: located.offset,
        targetChatId: todo.chatId,
        selectedBefore: selBefore,
        selectedAfter: selAfter,
        titleHashBefore: preClickTitleHash,
        titleHashAfter: tv.stripHash,
        title: titleReadings(tv.byConfig, tv.stripRect, TITLE_CONFIGS),
        order: rsB,
        idx: idxB
      })
    let j = judge(t.value)
    if (!j.ok && j.code === 'title_unreadable') {
      await sleep(POST_RULES.titleRereadMs)
      t = await readTitle()
      if (!t.ok) throw new Stop('title_unreadable')
      j = judge(t.value)
    }
    ctx.selOk = !(!j.ok && j.code === 'click_missed')
    if (!j.ok) {
      const other = j.otherChatId ? rsB.find((r) => r.chatId === j.otherChatId)?.name ?? undefined : undefined
      throw new Stop(j.code, { otherChatName: other, seenTitle: j.seenTitle })
    }
    ctx.titleSim = j.evidence.titleSim
    ctx.titleGap = j.evidence.titleGap
    ctx.titlePass = j.evidence.titlePass
    const approvedTitleHash = t.value.stripHash
    let ack: OpenEvidence['dbAck'] = 'skipped'
    if (settings.verifyReadByDb) {
      const t0 = now()
      const c = await P(() => deps.order.snapshot())
      ctx.dbMs.push(now() - t0)
      if (!c.ok) {
        ack = 'na'
      } else {
        const a = dbAck(B, c.value, todo.chatId)
        if (a.verdict === 'other_cleared') {
          ctx.dbAck = 'other_cleared'
          const other = rsB.find((r) => r.chatId === a.otherChatId)?.name ?? undefined
          throw new Stop('opened_other_suspected', { otherChatName: other })
        }
        ack = a.verdict
      }
    }
    ctx.dbAck = ack

    // ── S10 check_input_empty ──
    stage('check_input_empty')
    const ed = await P(() => deps.ui.readEdit())
    if (!ed.ok) throw new Stop('line_ui_unrecognized')
    if (ed.value.value !== '') throw new Stop('draft_present')

    // ── S11 fill（唯一寫入；I1）──
    stage('fill')
    const fill = await G(() => deps.ui.setEdit(text, approvedTitleHash, QUIET.fill))
    if (!fill.ok) {
      const r = fill.refusal
      throw new Stop(r === 'edit_not_empty' ? 'draft_present' : r === 'user_busy' ? 'user_busy' : 'title_changed')
    }
    if (norm(fill.value.readback) !== text) {
      const clr = await P(() => deps.ui.clearEditIfEquals(fill.value.readback, approvedTitleHash))
      ctx.left = clr.ok ? 'none' : 'filled_in_identified'
      throw new Stop('fill_readback_mismatch')
    }
    ctx.left = 'filled_in_identified'
    followUp = { attemptId: ctx.attemptId, text, approvedTitleHash, chatName: dbName, at: now() }

    // ── S12 hand_back ──
    stage('hand_back')
    let handedBack = false
    const hwnd = deps.lineTodoHwnd()
    if (hwnd) {
      try {
        const hb = await P(() => deps.ui.handBackFocus(hwnd))
        handedBack = hb.ok && hb.value.handedBack
      } catch (e) {
        if (e instanceof Cancelled) throw e
        handedBack = false
      }
    }
    if (!handedBack) deps.onHandBackFailed?.(dbName)

    // ── S13 cleanup ──
    stage('cleanup')
    await endSession(ctx)
    const locate: LocateEvidence = {
      rank: located.rank,
      pinned: rsB[located.rank].pinned,
      offset: located.offset,
      anchors: located.anchors.length,
      path: located.path,
      row: located.row
    }
    const open: OpenEvidence = { ...j.evidence, dbAck: ack }
    return {
      ok: true,
      outcome: 'filled',
      attemptId: ctx.attemptId,
      chatName: dbName,
      locate,
      open,
      handedBack,
      elapsedMs: now() - ctx.startedAt,
      details: detailsText(locate, open),
      handBackNote: handedBack ? null : HAND_BACK_FAILED_NOTE,
      followUpTtlMs: POST_RULES.followUpTtlMs,
      expiredNote: FOLLOW_UP_EXPIRED_NOTE
    }
  }

  /** 只接受最近一次成功填入、5 分鐘內的 attemptId。 */
  function takeFollowUp(attemptId: string): FollowUpRecord | null {
    if (!followUp || followUp.attemptId !== attemptId || now() - followUp.at > POST_RULES.followUpTtlMs) return null
    return followUp
  }

  type FollowUpFailCode = Extract<DriverFollowUpResult, { ok: false }>['code']

  /**
   * 成功填入後的後續動作（design-v2 §9.2）。只由使用者在對話框觸發（driver.ipc.ts）。
   *   focusLine   → focusEdit(approvedTitleHash, Q_focus)：先守門（安靜期 500 ms、沒有按鍵按著，不通過回 user_busy、
   *                 不切換），再切到 LINE；標題 hash 不符時只切前景並回 title_changed。不注入按鍵。
   *   clearFilled → clearEditIfEquals(text, approvedTitleHash)：只清除仍等於我們填入的文字；成功後這筆後續資料作廢。
   */
  async function followUpAction(action: DriverFollowUpAction, attemptId: unknown): Promise<DriverFollowUpResult> {
    let rec: FollowUpRecord | null = null
    const fail = (code: FollowUpFailCode, activated = false): DriverFollowUpResult => ({
      ok: false,
      action,
      code,
      message: followUpMessage(action, { code }, rec?.chatName),
      activated
    })
    if (typeof attemptId !== 'string' || !attemptId) return fail('invalid_request')
    if (!deps.getSettings().enabled) return fail('disabled')
    if (busy) return fail('busy')
    rec = takeFollowUp(attemptId)
    if (!rec) return fail('attempt_expired')
    busy = true
    let result: DriverFollowUpResult
    try {
      if (action === 'focusLine') {
        // review F1：helper 在切前景之前守門（安靜期、沒有按鍵按著），不通過回 user_busy。
        const r = await deps.ui.focusEdit(rec.approvedTitleHash, QUIET.focus)
        if (r.ok) result = { ok: true, action, outcome: 'focused', message: followUpMessage(action, { outcome: 'focused' }, rec.chatName) }
        // detail 'late'：已切到前景、但放游標前又有輸入；其餘 user_busy 沒有切換。
        else if (r.refusal === 'user_busy') result = fail('user_busy', r.detail === 'late')
        // helper 的 focusEdit 先切前景、再比對標題 hash（design-v2 §9.2）：title_changed 時 LINE 已在前景。
        else if (r.refusal === 'title_changed' || r.refusal === 'title_not_approved') result = fail('title_changed', true)
        else if (r.refusal === 'line_not_running') result = fail('line_not_running')
        else result = fail('internal')
      } else {
        const r = await deps.ui.clearEditIfEquals(rec.text, rec.approvedTitleHash)
        if (r.ok) {
          result = { ok: true, action, outcome: 'cleared', message: followUpMessage(action, { outcome: 'cleared' }, rec.chatName) }
          followUp = null
        } else if (r.refusal === 'edit_mismatch') result = fail('edit_changed')
        else if (r.refusal === 'title_changed' || r.refusal === 'title_not_approved') result = fail('title_changed')
        else if (r.refusal === 'line_not_running') result = fail('line_not_running')
        else result = fail('internal')
      }
    } catch (e) {
      result = e instanceof PortCommandError && e.message.startsWith('line_not_running') ? fail('line_not_running') : fail('internal')
    } finally {
      busy = false
    }
    // 稽核：一行，不含名稱與草稿。
    deps.log?.(`[driver] followUp attempt=${attemptId} action=${action} result=${result.ok ? result.outcome : result.code}`)
    return result
  }

  /** 不碰 LINE 的前置檢查（S0 的子集）：讓對話框在按下之前就能說明為什麼不能用。 */
  function targetProblem(todoId: string): DriverStatus['targetProblem'] {
    const pre = (code: DriverPostErrorCode, chatName?: string): DriverStatus['targetProblem'] => ({
      code,
      message: messageFor(code, { chatName, stage: 'preflight' })
    })
    const todo = deps.getTodo(todoId)
    if (!todo) return pre('todo_not_found')
    const name = deps.getChatName(todo.chatId)
    if (!name || !name.trim()) return pre('chat_name_missing')
    if (cpLen(normalizeName(name)) < IDENTIFY_RULES.minTargetLen) return pre('chat_name_unverifiable', name)
    return null
  }

  return {
    postDraft: async (req: DriverPostRequest): Promise<DriverPostResult> => postDraft(req),
    isBusy: () => busy,
    takeFollowUp,
    focusLine: (attemptId: unknown): Promise<DriverFollowUpResult> => followUpAction('focusLine', attemptId),
    clearFilled: (attemptId: unknown): Promise<DriverFollowUpResult> => followUpAction('clearFilled', attemptId),
    targetProblem
  }
}

export type PostDraftService = ReturnType<typeof createPostDraft>
