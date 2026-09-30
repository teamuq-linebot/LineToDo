import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type {
  DriverFollowUpResult,
  DriverPostMode,
  DriverPostProgress,
  DriverPostRequest,
  DriverPostResult,
  DriverStatus
} from '../driver'

/**
 * driver.ipc.ts — 草稿填入 LINE（driver_post）的 IPC（design-v1 §5.3、design-v2 §9.2、design-v3 §10 Batch 5）。
 *
 *   driver:status       invoke({ todoId? }) → DriverStatus          輕量；不 spawn helper、不碰 LINE
 *   driver:postDraft    invoke(DriverPostRequest) → DriverPostResult 整個流程跑完才回
 *   driver:focusLine    invoke({ attemptId }) → DriverFollowUpResult
 *   driver:clearFilled  invoke({ attemptId }) → DriverFollowUpResult
 *   evt:driver-post-progress  push → DriverPostProgress（main 用 DRIVER_PROGRESS_CHANNEL 推送）
 *
 * 守門：
 *   - 只接受主視窗 webContents 的呼叫（isTrustedSender）；其他來源一律拒絕（invoke reject）。
 *   - 參數在這裡正規化（型別不對 → 空字串，由狀態機回 invalid_request／todo_not_found），不把任意物件傳進 driver。
 *   - 設定關閉（driverPost.enabled=false）時，postDraft 回 disabled、focusLine／clearFilled 回 disabled，都不碰 LINE；
 *     判斷在 driver 內（postDraft S0 ①、followUpAction），這裡不重複讀設定，避免兩個來源不一致。
 *   - postDraft／focusLine／clearFilled 的呼叫點只在本檔（M7）。
 */

export const DRIVER_PROGRESS_CHANNEL = 'evt:driver-post-progress'

/** driver/index.ts createDriver 的子集（probe 可以注入同介面的物件）。 */
export interface DriverIpcService {
  getStatus(todoId?: string): DriverStatus
  postDraft(req: DriverPostRequest): Promise<DriverPostResult>
  focusLine(attemptId: unknown): Promise<DriverFollowUpResult>
  clearFilled(attemptId: unknown): Promise<DriverFollowUpResult>
}

export interface DriverIpcDeps {
  driver: DriverIpcService
  /** 只接受主視窗；省略時不檢查（只給 probe 用）。 */
  isTrustedSender?(sender: WebContents): boolean
}

const MODES: DriverPostMode[] = ['fillOnly', 'fillAndSend']

function sanitizePostRequest(raw: unknown): DriverPostRequest {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const req: DriverPostRequest = {
    todoId: typeof a.todoId === 'string' ? a.todoId : '',
    text: typeof a.text === 'string' ? a.text : ''
  }
  // 舊 renderer 若帶 fillAndSend，交給狀態機回 send_not_available（design-v2 §9.2）。
  if (MODES.includes(a.mode as DriverPostMode)) req.mode = a.mode as DriverPostMode
  return req
}

function attemptIdOf(raw: unknown): unknown {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>).attemptId : undefined
}

export function registerDriverIpc(deps: DriverIpcDeps): () => void {
  const channels: string[] = []
  const guard = (e: IpcMainInvokeEvent): void => {
    if (deps.isTrustedSender && !deps.isTrustedSender(e.sender)) throw new Error('driver: untrusted sender')
  }
  const handle = <T>(channel: string, fn: (args: unknown) => T | Promise<T>): void => {
    ipcMain.handle(channel, (e, args: unknown) => {
      guard(e)
      return fn(args)
    })
    channels.push(channel)
  }

  handle('driver:status', (args) => {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    return deps.driver.getStatus(typeof a.todoId === 'string' && a.todoId ? a.todoId : undefined)
  })
  handle('driver:postDraft', (args) => deps.driver.postDraft(sanitizePostRequest(args)))
  handle('driver:focusLine', (args) => deps.driver.focusLine(attemptIdOf(args)))
  handle('driver:clearFilled', (args) => deps.driver.clearFilled(attemptIdOf(args)))

  return () => channels.forEach((c) => ipcMain.removeHandler(c))
}

/** main → renderer 的進度推送（只送主視窗）。 */
export function createProgressPusher(getTarget: () => WebContents | null): (p: DriverPostProgress) => void {
  return (p) => {
    const wc = getTarget()
    if (wc && !wc.isDestroyed()) wc.send(DRIVER_PROGRESS_CHANNEL, p)
  }
}
