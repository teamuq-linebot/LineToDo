/**
 * zoom.ts — 外掛畫面的放大縮小。
 *
 * TeamUQ 主畫面的縮放（webFrame.setZoomFactor）不會作用在外掛 view（獨立的 WebContentsView），SDK 也沒有縮放 API，所以外掛自己做：
 * Ctrl + `=`／`+`、Ctrl + `-`、Ctrl + `0`（重設）與 Ctrl + 滾輪，調整 `<html>` 的 CSS `zoom`。
 * 檔位沿用 TeamUQ 主畫面的 [0.8, 0.9, 1.0, 1.1, 1.25]，預設 1.0；值存在這個外掛自己的 localStorage（`lt-zoom`），重開仍維持，
 * 看板與設定 view 共用同一個值（`storage` 事件讓另一個 view 即時跟上）。
 *
 * - 快捷鍵在輸入框／文字區內一樣有效（與瀏覽器縮放相同；這些組合在文字編輯裡沒有別的意思）。
 * - 滾輪：只有按著 Ctrl 才縮放；觸控板的捏合（Ctrl + 很小的 deltaY）累積到一格滾輪的量才換一檔。
 * - 不顯示任何提示。
 *
 * 位置換算（CSS zoom 之後）：getBoundingClientRect() 與 window.innerWidth／innerHeight 是畫面實際像素（已乘上縮放），
 * 但 position:fixed 的 left／top／bottom 是縮放前的 CSS 長度（會再乘上縮放）。`layoutScale()` 量出這個比例，`placeFixedMenu()` 用它換算。
 */

export const ZOOM_STEPS: readonly number[] = Object.freeze([0.8, 0.9, 1.0, 1.1, 1.25])
export const DEFAULT_ZOOM = 1.0
export const ZOOM_KEY = 'lt-zoom'
/** 一格滑鼠滾輪的 deltaY；觸控板捏合的小 delta 累積到這個量才換一檔。 */
export const WHEEL_STEP_DELTA = 100

export type ZoomAction = 'in' | 'out' | 'reset'

/** 任何值 → 合法檔位；不是檔位的數字取最近的一檔，壞值回預設。 */
export function normalizeZoom(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return DEFAULT_ZOOM
  let best = ZOOM_STEPS[0] as number
  for (const step of ZOOM_STEPS) if (Math.abs(step - n) < Math.abs(best - n)) best = step
  return best
}

/** 往放大／縮小一檔；已在上限或下限就停在原檔。重設回預設。 */
export function stepZoom(current: number, action: ZoomAction): number {
  if (action === 'reset') return DEFAULT_ZOOM
  const index = ZOOM_STEPS.indexOf(normalizeZoom(current))
  const next = action === 'in' ? Math.min(ZOOM_STEPS.length - 1, index + 1) : Math.max(0, index - 1)
  return ZOOM_STEPS[next] as number
}

export interface ZoomKeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey?: boolean
  altKey?: boolean
}

/** Ctrl（或 Cmd）+ =／+／-／0 → 動作；其他任何按鍵（沒按 Ctrl、同時按 Alt…）→ null。 */
export function zoomActionForKey(event: ZoomKeyLike): ZoomAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null
  if (event.key === '=' || event.key === '+' || event.code === 'NumpadAdd') return 'in'
  if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') return 'out'
  if (event.key === '0' || event.code === 'Numpad0') return 'reset'
  return null
}

export interface ZoomState {
  get(): number
  /** 設定檔位（先正規化）、套用到畫面並保存。 */
  set(value: number): number
  apply(action: ZoomAction): number
  dispose(): void
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (event: any) => void
interface ZoomTarget {
  addEventListener(type: string, listener: AnyListener, options?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, listener: AnyListener, options?: boolean | EventListenerOptions): void
}
interface ZoomRoot { style: { zoom: string } }

export interface InstallZoomOptions {
  target?: ZoomTarget | null
  root?: ZoomRoot | null
  storage?: StorageLike | null
}

function readStored(storage: StorageLike | null | undefined): number {
  try { return normalizeZoom(storage?.getItem(ZOOM_KEY)) } catch { return DEFAULT_ZOOM }
}

/**
 * 讀回保存的檔位、套用，並開始聽快捷鍵與 Ctrl+滾輪。每個 view 的入口在第一次 render 之前呼叫一次（套用得早，畫面不會先閃一下 1.0）。
 * 沒有 window（server render、測試）時不做事。
 */
export function installZoom(options: InstallZoomOptions = {}): ZoomState {
  const target = options.target !== undefined ? options.target : (typeof window !== 'undefined' ? window : null)
  const root = options.root !== undefined ? options.root : (typeof document !== 'undefined' ? document.documentElement : null)
  let storage: StorageLike | null | undefined = options.storage
  if (storage === undefined) {
    try { storage = typeof window !== 'undefined' ? window.localStorage : null } catch { storage = null }
  }

  let current = readStored(storage)
  const paint = (): void => { if (root) root.style.zoom = current === DEFAULT_ZOOM ? '' : String(current) }
  paint()

  const set = (value: number): number => {
    current = normalizeZoom(value)
    paint()
    try { storage?.setItem(ZOOM_KEY, String(current)) } catch { /* localStorage 不可用：這次仍然生效，只是不保存 */ }
    return current
  }
  const apply = (action: ZoomAction): number => set(stepZoom(current, action))

  let wheelAcc = 0
  const onKeyDown = (event: KeyboardEvent): void => {
    const action = zoomActionForKey(event)
    if (!action) return
    event.preventDefault()
    if (event.repeat && action === 'reset') return
    apply(action)
  }
  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey) { wheelAcc = 0; return }
    event.preventDefault() // 不讓 Chromium 對整個 view 再做自己的縮放
    if (!event.deltaY) return
    if (wheelAcc !== 0 && Math.sign(wheelAcc) !== Math.sign(event.deltaY)) wheelAcc = 0
    wheelAcc += event.deltaY
    if (Math.abs(wheelAcc) < WHEEL_STEP_DELTA) return
    // 往上滾（deltaY < 0）＝放大；一次事件只換一檔（超大的 delta 不會連跳）
    apply(wheelAcc < 0 ? 'in' : 'out')
    wheelAcc = 0
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== ZOOM_KEY) return
    const next = readStored(storage)
    if (next === current) return
    current = next
    paint()
  }

  target?.addEventListener('keydown', onKeyDown, true)
  target?.addEventListener('wheel', onWheel, { capture: true, passive: false })
  target?.addEventListener('storage', onStorage)

  return {
    get: () => current,
    set,
    apply,
    dispose() {
      target?.removeEventListener('keydown', onKeyDown, true)
      target?.removeEventListener('wheel', onWheel, true)
      target?.removeEventListener('storage', onStorage)
    }
  }
}

/**
 * 量出「getBoundingClientRect 的值」與「position:fixed 的 left／top 長度」之間的比例：
 * 在有 CSS zoom 的 `<html>` 底下放一個 100px 寬的探針，量到的實際寬度 ÷ 100。沒有縮放（或量不到）＝1。
 */
export function layoutScale(doc: Pick<Document, 'createElement' | 'body'> | null | undefined = typeof document !== 'undefined' ? document : null): number {
  try {
    if (!doc?.body) return 1
    const probe = doc.createElement('div')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:1px;visibility:hidden;pointer-events:none'
    doc.body.appendChild(probe)
    const width = probe.getBoundingClientRect().width
    probe.remove()
    return Number.isFinite(width) && width > 0 ? width / 100 : 1
  } catch {
    return 1
  }
}

export interface MenuPlacement { top?: number; bottom?: number; left: number }

/**
 * 卡片「更多」選單的 fixed 位置。輸入是畫面實際像素（rect、viewport），輸出是要寫進 style 的 CSS 長度（已除以 scale）。
 * scale＝1 時與縮放功能之前的算法相同，只有「下方至少要有多少空間才往下開」從 260 改成 320：選單實際高約 305，
 * 原本的 260 在放大後（可用的 CSS 高度變少）會讓選單的下緣超出視窗（實測 1.25 倍）。
 */
export function placeFixedMenu(
  rect: { top: number; bottom: number; right: number },
  viewport: { width: number; height: number },
  scale: number,
  menuWidth = 168,
  gap = 4,
  needBelow = 320
): MenuPlacement {
  const s = scale > 0 ? scale : 1
  const left = Math.max(8, Math.min(rect.right / s - menuWidth, viewport.width / s - menuWidth - 8))
  const spaceBelow = (viewport.height - rect.bottom) / s
  return spaceBelow < needBelow
    ? { bottom: (viewport.height - rect.top) / s + gap, left }
    : { top: rect.bottom / s + gap, left }
}
