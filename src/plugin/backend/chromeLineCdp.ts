/**
 * chromeLineCdp.ts — `LinePage` 的實作：經 Chrome DevTools Protocol 操作「LINE 背景 Chrome」（127.0.0.1:19223；scripts/line-bg/line-bg.mjs 啟動的 headless Chrome）裡的 LINE Chrome 外掛分頁。
 *
 * - 連線只到 127.0.0.1:19223（manifest `network.loopbackServices` 宣告的 http／ws），用 Node 內建的 fetch／WebSocket（不 import node:http／net）。
 * - LINE 外掛的 CSS class 帶雜湊後綴，一律用 `[class*="前綴"]` 比對。
 * - 開聊天室只改 `location.hash`（`#/chats/<mid>`）；不點分頁、資料夾或導覽按鈕（點了會自動開啟列表第一個聊天室並標成已讀）。
 * - 輸入框是 `<textarea-ex>`，真正的 textarea 在它的 open shadow root 裡。
 * - 觀察 sendMessage 請求時只取 HTTP 狀態與本文裡的 `to`（不讀、不回傳訊息內容）。
 */
import { ChromeLineError } from './chromeLine'
import type { ChatHit, LinePage, LinePageOpener, SendObservation } from './chromeLine'

export const LINE_EXTENSION_ID = 'ophjlpahpchlmihnnnihgmmeilfjmjjc'
const LINE_INDEX_URL = `chrome-extension://${LINE_EXTENSION_ID}/index.html`
const HTTP_TIMEOUT_MS = 3_000
const CALL_TIMEOUT_MS = 10_000

const SEL = {
  nav: '[class*="gnb-module__nav_list"]',
  searchInput: 'div[class*="chatlist-module__search_box"] input',
  searchReset: 'div[class*="chatlist-module__search_box"] button[class*="button_reset"]',
  listItem: '[class*="chatlistItem-module__chatlist_item"]',
  listTitle: '[class*="chatlistItem-module__title_box"] [class*="chatlistItem-module__text"]',
  room: '[class*="chatroom-module__chatroom"]',
  roomHeader: '[class*="chatroomHeader-module__name"]'
} as const

interface CdpTarget {
  id: string
  type: string
  url: string
}

const isLineTab = (t: CdpTarget): boolean => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(LINE_INDEX_URL)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function listTargets(): Promise<CdpTarget[]> {
  let res: Response
  try {
    res = await fetch('http://127.0.0.1:19223/json/list', { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  } catch {
    throw new ChromeLineError('browser_unreachable', '連不上 LINE 背景 Chrome（127.0.0.1:19223）。請先執行 line-todo 的 scripts/line-bg/line-bg.mjs start。')
  }
  if (!res.ok) throw new ChromeLineError('browser_unreachable', `LINE 背景 Chrome 回應 ${res.status}，無法列出分頁。`)
  const body: unknown = await res.json()
  return Array.isArray(body) ? (body as CdpTarget[]) : []
}

async function openLineTab(): Promise<CdpTarget> {
  try {
    const res = await fetch('http://127.0.0.1:19223/json/new?' + encodeURIComponent(LINE_INDEX_URL), { method: 'PUT', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    if (res.ok) {
      const target = (await res.json()) as CdpTarget
      if (target && typeof target.id === 'string') return target
    }
  } catch {
    // 落到下面的錯誤
  }
  throw new ChromeLineError('line_tab_unavailable', 'LINE 背景 Chrome 裡沒有 LINE 外掛分頁，也無法自動開啟。請重新執行 scripts/line-bg/line-bg.mjs start。')
}

type Listener = (msg: { method: string; params: Record<string, unknown> }) => void

class CdpSession {
  private next = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Set<Listener>()
  private readonly ws: WebSocket

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
        else p.resolve(msg.result)
      } else if (typeof msg.method === 'string') {
        for (const l of this.listeners) l({ method: msg.method, params: msg.params ?? {} })
      }
    })
    ws.addEventListener('close', () => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('CDP connection closed'))
        this.pending.delete(id)
      }
    })
  }

  static async connect(targetId: string): Promise<CdpSession> {
    const ws = new WebSocket(`ws://127.0.0.1:19223/devtools/page/${encodeURIComponent(targetId)}`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ChromeLineError('browser_unreachable', '連上 LINE 外掛分頁逾時。')), HTTP_TIMEOUT_MS)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new ChromeLineError('browser_unreachable', '無法連上 LINE 外掛分頁。')) }, { once: true })
    })
    return new CdpSession(ws)
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    try { this.ws.close() } catch { /* 已關閉 */ }
  }
}

/** 把一段頁面內的運算式（可 await）送進分頁執行，回傳 JSON 值。 */
async function evaluate<T>(s: CdpSession, expression: string): Promise<T> {
  const r = await s.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }
  )
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate failed')
  return r.result?.value as T
}

const js = (value: unknown): string => JSON.stringify(value)

/** 分頁正在載入或導覽（剛開的 LINE 分頁會從 index.html 轉到路由）時，evaluate 會丟這類錯誤；重試即可。 */
const isNavigationError = (error: unknown): boolean =>
  error instanceof Error && /context was destroyed|Cannot find context|Inspected target navigated|Cannot find default execution context/i.test(error.message)

/** 頁面內共用的小工具（每段運算式前面接上）。 */
const PRELUDE = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const editor = () => {
    const room = document.querySelector(${js(SEL.room)});
    if (!room) return null;
    const ex = room.querySelector('textarea-ex');
    return ex?.shadowRoot?.querySelector('textarea') ?? room.querySelector('textarea');
  };
`

/** sendMessage 請求本文 `[seq, message]` 裡的收件對象。 */
export function routingTo(postData: string | null | undefined): string | null {
  if (!postData) return null
  try {
    const body: unknown = JSON.parse(postData)
    const items = Array.isArray(body) ? body : [body]
    for (const item of items) {
      if (item && typeof item === 'object' && typeof (item as { to?: unknown }).to === 'string') return (item as { to: string }).to
    }
  } catch {
    // 不是 JSON
  }
  return null
}

class CdpLinePage implements LinePage {
  private readonly s: CdpSession

  constructor(s: CdpSession) {
    this.s = s
  }

  async ready(): Promise<boolean> {
    const until = Date.now() + 15_000
    while (Date.now() < until) {
      try {
        if (await evaluate<boolean>(this.s, `!!document.querySelector(${js(SEL.nav)})`)) return true
      } catch (error) {
        if (!isNavigationError(error)) throw error
      }
      await sleep(300)
    }
    return false
  }

  async searchChats(name: string): Promise<ChatHit[]> {
    const focused = await evaluate<boolean>(this.s, `(async () => { ${PRELUDE}
      if (!location.hash.startsWith('#/chats')) location.hash = '#/chats';
      for (let i = 0; i < 20 && !document.querySelector(${js(SEL.searchInput)}); i++) await sleep(250);
      // 剛開的分頁要等聊天列表同步出來，否則搜尋結果是空的（會誤判成找不到聊天室）。
      for (let i = 0; i < 60 && document.querySelectorAll(${js(SEL.listItem)}).length === 0; i++) await sleep(250);
      const input = document.querySelector(${js(SEL.searchInput)});
      if (!input) return false;
      input.focus();
      input.select();
      return document.activeElement === input;
    })()`)
    if (!focused) throw new ChromeLineError('line_not_ready', 'LINE 外掛的聊天搜尋框沒有出現。')
    await this.s.send('Input.insertText', { text: name })
    return evaluate<ChatHit[]>(this.s, `(async () => { ${PRELUDE}
      const want = ${js(name)}.normalize('NFC').trim();
      const read = () => [...document.querySelectorAll(${js(SEL.listItem)})].map((it) => ({
        mid: it.getAttribute('data-mid') || '',
        title: (it.querySelector(${js(SEL.listTitle)})?.textContent || '').trim()
      })).filter((h) => h.mid);
      const started = Date.now();
      let hits = read();
      while (Date.now() - started < 4000) {
        await sleep(250);
        hits = read();
        const value = document.querySelector(${js(SEL.searchInput)})?.value ?? '';
        if (value === ${js(name)} && Date.now() - started > 800 && hits.some((h) => h.title.normalize('NFC').trim() === want)) break;
      }
      return hits;
    })()`)
  }

  async clearSearch(): Promise<void> {
    await evaluate(this.s, `(() => {
      const input = document.querySelector(${js(SEL.searchInput)});
      if (!input || input.value === '') return;
      document.querySelector(${js(SEL.searchReset)})?.click();
    })()`)
  }

  async openChat(mid: string): Promise<{ roomMid: string | null; header: string | null }> {
    return evaluate(this.s, `(async () => { ${PRELUDE}
      const mid = ${js(mid)};
      location.hash = '#/chats/' + encodeURIComponent(mid);
      let room = null;
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        room = document.querySelector(${js(SEL.room)});
        if (room && room.getAttribute('data-mid') === mid && editor()) break;
      }
      return {
        roomMid: room ? room.getAttribute('data-mid') : null,
        header: room ? (room.querySelector(${js(SEL.roomHeader)})?.textContent ?? '').trim() || null : null
      };
    })()`)
  }

  readDraft(): Promise<string | null> {
    return evaluate<string | null>(this.s, `(() => { ${PRELUDE} const el = editor(); return el ? el.value : null; })()`)
  }

  async fillDraft(text: string): Promise<string | null> {
    const focused = await evaluate<boolean>(this.s, `(() => { ${PRELUDE}
      const el = editor();
      if (!el) return false;
      el.focus();
      const root = el.getRootNode();
      return (root instanceof ShadowRoot ? root.activeElement : document.activeElement) === el;
    })()`)
    if (!focused) return null
    await this.s.send('Input.insertText', { text })
    return this.readDraft()
  }

  async clearDraft(): Promise<void> {
    await evaluate(this.s, `(() => { ${PRELUDE}
      const el = editor();
      if (!el) return;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    })()`)
  }

  async pressEnterAndWatch(timeoutMs: number): Promise<SendObservation[]> {
    const seen = new Map<string, { status: number | null; postData: string | null; hasPostData: boolean }>()
    const off = this.s.on(({ method, params }) => {
      if (method === 'Network.requestWillBeSent') {
        const request = params.request as { url?: string; postData?: string; hasPostData?: boolean } | undefined
        if (request?.url && /\/TalkService\/sendMessage(?:$|\?)/.test(request.url)) {
          seen.set(String(params.requestId), { status: null, postData: request.postData ?? null, hasPostData: request.hasPostData === true })
        }
      } else if (method === 'Network.responseReceived') {
        const entry = seen.get(String(params.requestId))
        if (entry) entry.status = (params.response as { status?: number } | undefined)?.status ?? null
      } else if (method === 'Network.loadingFailed') {
        const entry = seen.get(String(params.requestId))
        if (entry && entry.status === null) entry.status = 0
      }
    })
    try {
      await this.s.send('Network.enable', { maxPostDataSize: 65_536 })
      for (const type of ['keyDown', 'keyUp'] as const) {
        await this.s.send('Input.dispatchKeyEvent', {
          type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {})
        })
      }
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        if (seen.size > 0 && [...seen.values()].every((e) => e.status !== null)) break
        await sleep(150)
      }
      const out: SendObservation[] = []
      for (const [requestId, entry] of seen) {
        let postData = entry.postData
        if (!postData && entry.hasPostData) {
          postData = await this.s.send<{ postData?: string }>('Network.getRequestPostData', { requestId }).then((r) => r.postData ?? null, () => null)
        }
        out.push({ status: entry.status, to: routingTo(postData) })
      }
      return out
    } finally {
      off()
      await this.s.send('Network.disable').catch(() => undefined)
    }
  }

  close(): void {
    this.s.close()
  }
}

/** 正式環境的 opener：找 LINE 背景 Chrome 裡的 LINE 外掛分頁（沒有就開一個）並連上。 */
export function createCdpLinePageOpener(): LinePageOpener {
  return {
    async open(): Promise<LinePage> {
      const targets = await listTargets()
      const tab = targets.find(isLineTab) ?? (await openLineTab())
      const session = await CdpSession.connect(tab.id)
      // headless／背景分頁也要讓 focus()／輸入有效（從不把分頁切到前景）。
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
      return new CdpLinePage(session)
    }
  }
}
