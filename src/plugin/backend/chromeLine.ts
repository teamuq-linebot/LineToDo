/**
 * chromeLine.ts — 「用 Chrome 發送」：經共用瀏覽器（TeamUQ shared browser，CDP 127.0.0.1:19222）的 LINE Chrome 外掛送出一則訊息。
 *
 * 為什麼靠名稱找聊天室：LINE 桌面版 DB 的聊天室 ID 和 Chrome 外掛的 mid（`U/C/R`＋43 字 base64url）格式不同、無法互推，
 * 所以先用 todo 的聊天室名稱在 Chrome 外掛的聊天搜尋裡找「名稱完全相同且唯一」的聊天室，開啟後再核對 data-mid 與標頭名稱才送出。
 *
 * 這個檔案只有流程（純邏輯、可用假頁面測試）；實際的 CDP 操作在 `chromeLineCdp.ts`。
 * 已知副作用（無法避免）：開啟聊天室會把那個聊天室的未讀標成已讀。流程從不點分頁或資料夾按鈕（那會自動開啟列表第一個聊天室）。
 */
import type { ChromeLineErrorCode, ChromeLineSendResult, ChromeLineStage, ChromeLineStatus } from '../../shared/api'

/** 聊天搜尋結果的一列。 */
export interface ChatHit {
  mid: string
  title: string
}

/** sendMessage 請求的觀察結果（只有路由欄位，不含訊息內容）。 */
export interface SendObservation {
  status: number | null
  to: string | null
}

/** 一個已連上的 LINE 外掛分頁（`chromeLineCdp.ts` 實作；測試用假頁面）。 */
export interface LinePage {
  /** 外掛已登入、聊天列表可用。 */
  ready(): Promise<boolean>
  /** 在聊天搜尋框輸入名稱，回傳目前列出的聊天室。 */
  searchChats(name: string): Promise<ChatHit[]>
  /** 清掉聊天搜尋（還原畫面）。 */
  clearSearch(): Promise<void>
  /** 以路由開啟聊天室（不點任何按鈕），回傳開啟後聊天室的 data-mid 與標頭名稱。 */
  openChat(mid: string): Promise<{ roomMid: string | null; header: string | null }>
  /** 目前聊天室輸入框的內容；找不到輸入框回 null。 */
  readDraft(): Promise<string | null>
  /** 把文字填入輸入框（不送出），回傳填入後的內容。 */
  fillDraft(text: string): Promise<string | null>
  /** 清空輸入框。 */
  clearDraft(): Promise<void>
  /** 按 Enter，觀察 sendMessage 請求直到有回應或逾時。 */
  pressEnterAndWatch(timeoutMs: number): Promise<SendObservation[]>
  close(): void
}

export class ChromeLineError extends Error {
  readonly code: ChromeLineErrorCode

  constructor(code: ChromeLineErrorCode, message: string) {
    super(message)
    this.name = 'ChromeLineError'
    this.code = code
  }
}

/** 連上共用瀏覽器並取得 LINE 外掛分頁；連不上 throw `ChromeLineError`（browser_unreachable／line_tab_unavailable）。 */
export interface LinePageOpener {
  open(): Promise<LinePage>
}

export interface ChromeLineSenderOptions {
  opener: LinePageOpener
  /** todoId → 聊天室名稱；todo 不存在回 undefined，聊天室沒有名稱回 null。 */
  resolveChatName(todoId: string): Promise<string | null | undefined>
  /** 按 Enter 後等 sendMessage 回應的時間。 */
  sendTimeoutMs?: number
}

export const MAX_TEXT_CHARS = 5000

/** 名稱比對：去頭尾空白＋Unicode NFC。 */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim()
}

/** textarea 會把 CRLF 存成 LF；比對與填入都用 LF。 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 名稱完全相同的聊天室（同一個 mid 只算一次）。 */
export function exactMatches(hits: readonly ChatHit[], name: string): ChatHit[] {
  const want = normalizeName(name)
  const seen = new Set<string>()
  const out: ChatHit[] = []
  for (const hit of hits) {
    if (normalizeName(hit.title) !== want || seen.has(hit.mid)) continue
    seen.add(hit.mid)
    out.push(hit)
  }
  return out
}

type Failure = Extract<ChromeLineSendResult, { ok: false }>

const failure = (code: ChromeLineErrorCode, message: string, stage: ChromeLineStage, chatName: string | null, sent: Failure['sent'] = 'no'): Failure => ({
  ok: false, code, message, stage, chatName, sent
})

/**
 * 已連上分頁之後的流程：找聊天室 → 開啟並核對 → 填入並核對 → Enter 並確認 sendMessage。
 * `track.stage` 隨流程更新，呼叫端在例外時用它判斷是否可能已送出。
 */
export async function sendOnPage(page: LinePage, chatName: string, rawText: string, sendTimeoutMs: number, track: { stage: ChromeLineStage } = { stage: 'connect' }): Promise<ChromeLineSendResult> {
  const text = normalizeText(rawText)

  track.stage = 'connect'
  if (!(await page.ready())) return failure('line_not_ready', '共用瀏覽器的 LINE 外掛沒有登入，或聊天列表還沒出現。請在共用瀏覽器登入 LINE 後再試。', 'connect', chatName)

  track.stage = 'locate'
  let hits: ChatHit[]
  try {
    hits = exactMatches(await page.searchChats(chatName), chatName)
  } finally {
    await page.clearSearch().catch(() => undefined)
  }
  if (hits.length === 0) return failure('chat_not_found', `在 Chrome 的 LINE 外掛裡找不到名稱是「${chatName}」的聊天室。`, 'locate', chatName)
  if (hits.length > 1) return failure('chat_ambiguous', `Chrome 的 LINE 外掛裡有 ${hits.length} 個名稱都是「${chatName}」的聊天室，無法判斷要送到哪一個。`, 'locate', chatName)
  const mid = hits[0].mid

  track.stage = 'open'
  const room = await page.openChat(mid)
  if (room.roomMid !== mid) return failure('open_failed', `開啟「${chatName}」失敗：畫面上的聊天室不是搜尋到的那一個。`, 'open', chatName)
  if (room.header === null || normalizeName(room.header) !== normalizeName(chatName)) {
    return failure('open_failed', `開啟的聊天室名稱是「${room.header ?? '（讀不到）'}」，和「${chatName}」不同，已停止。`, 'open', chatName)
  }

  track.stage = 'fill'
  const before = await page.readDraft()
  if (before === null) return failure('fill_failed', `「${chatName}」的聊天室找不到輸入框。`, 'fill', chatName)
  if (before !== '') return failure('draft_present', `Chrome 的 LINE 裡「${chatName}」的輸入框已經有文字，為了不蓋掉它已停止。請先清掉再試。`, 'fill', chatName)
  const filled = await page.fillDraft(text)
  if (filled !== text) {
    await page.clearDraft().catch(() => undefined)
    return failure('fill_failed', `把訊息填入「${chatName}」的輸入框後內容不一致，已清除、沒有送出。`, 'fill', chatName)
  }

  track.stage = 'send'
  const observed = await page.pressEnterAndWatch(sendTimeoutMs)
  if (observed.some((o) => o.status === 200 && o.to === mid)) return { ok: true, chatName, chatMid: mid }
  if (observed.length === 0) {
    const after = await page.readDraft().catch(() => null)
    if (after === text) {
      await page.clearDraft().catch(() => undefined)
      return failure('send_unconfirmed', `按下 Enter 後 LINE 沒有送出「${chatName}」的訊息，已清除輸入框。`, 'send', chatName, 'no')
    }
    return failure('send_unconfirmed', `沒有看到 LINE 送出「${chatName}」的訊息回應，請到 LINE 確認是否已送出。`, 'send', chatName, 'unknown')
  }
  const bad = observed.find((o) => o.status !== 200) ?? observed[0]
  const why = bad.status !== 200 ? `LINE 回應 ${bad.status ?? '（無回應）'}` : '收件對象和聊天室對不上'
  return failure('send_failed', `送出「${chatName}」時${why}，請到 LINE 確認是否已送出。`, 'send', chatName, 'unknown')
}

export interface ChromeLineSender {
  status(): Promise<ChromeLineStatus>
  send(req: unknown): Promise<ChromeLineSendResult>
}

export function createChromeLineSender(options: ChromeLineSenderOptions): ChromeLineSender {
  const sendTimeoutMs = options.sendTimeoutMs ?? 10_000
  let busy = false

  const fromError = (error: unknown, stage: ChromeLineStage, chatName: string | null): Failure =>
    error instanceof ChromeLineError
      ? failure(error.code, error.message, stage, chatName)
      : failure('internal', `用 Chrome 發送時發生錯誤：${error instanceof Error ? error.message : String(error)}`, stage, chatName, stage === 'send' ? 'unknown' : 'no')

  return {
    async status(): Promise<ChromeLineStatus> {
      let page: LinePage | null = null
      try {
        page = await options.opener.open()
        if (!(await page.ready())) return { ready: false, code: 'line_not_ready', message: '共用瀏覽器的 LINE 外掛沒有登入，或聊天列表還沒出現。' }
        return { ready: true, code: null, message: null }
      } catch (error) {
        const f = fromError(error, 'connect', null)
        return { ready: false, code: f.code, message: f.message }
      } finally {
        page?.close()
      }
    },

    async send(req: unknown): Promise<ChromeLineSendResult> {
      const body = req !== null && typeof req === 'object' ? (req as Record<string, unknown>) : {}
      const todoId = typeof body.todoId === 'string' ? body.todoId : ''
      const text = typeof body.text === 'string' ? body.text : ''
      if (!todoId) return failure('invalid_request', '缺少 todoId。', 'preflight', null)
      if (!text.trim()) return failure('invalid_request', '訊息是空的，沒有送出。', 'preflight', null)
      if (text.length > MAX_TEXT_CHARS) return failure('invalid_request', `訊息超過 ${MAX_TEXT_CHARS} 字，沒有送出。`, 'preflight', null)
      if (busy) return failure('busy', '上一則還在發送中，請稍候。', 'preflight', null)
      busy = true
      let chatName: string | null = null
      const track: { stage: ChromeLineStage } = { stage: 'preflight' }
      let page: LinePage | null = null
      try {
        const resolved = await options.resolveChatName(todoId)
        if (resolved === undefined) return failure('todo_not_found', '找不到這張待辦。', 'preflight', null)
        if (resolved === null || !normalizeName(resolved)) return failure('chat_name_missing', '這個聊天室在 LINE 桌面版沒有名稱，無法在 Chrome 的 LINE 外掛裡找到它。', 'preflight', null)
        chatName = normalizeName(resolved)
        track.stage = 'connect'
        page = await options.opener.open()
        return await sendOnPage(page, chatName, text, sendTimeoutMs, track)
      } catch (error) {
        return fromError(error, track.stage, chatName)
      } finally {
        page?.close()
        busy = false
      }
    }
  }
}
