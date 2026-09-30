/**
 * driver/index.ts — driver_post 的 public entry（design-v1 §2.2、design-v3 §8.1）。
 *
 * 其他模組只能從這裡 import。這裡組裝 psHost（LineUiPortV3）、lineOrder（LineOrderPort）、foreground，
 * 再注入 postDraft 狀態機。IPC 註冊在 src/main/ipc/driver.ipc.ts；本檔建立時不觸發任何呼叫（不 spawn helper、不讀 DB）。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { allowSetForeground, hwndFromNativeHandle } from './foreground'
import { createLineOrder } from './lineOrder'
import { createPostDraft, type PostDraftDeps } from './postDraft'
import { createPsHost } from './psHost'
import type { LineOrderPort, LineUiPortV3 } from './port'
import type { DriverFollowUpResult, DriverPostMode, DriverPostProgress, DriverPostRequest, DriverPostResult, DriverStatus } from './types'

export type * from './types'
export { messageFor, successMessage, detailsText, handBackNotice } from './messages'
export { hwndFromNativeHandle }

export interface DriverDeps {
  getSettings(): { enabled: boolean; mode: DriverPostMode; verifyReadByDb: boolean }
  getTodo(todoId: string): { chatId: string } | null
  getChatName(chatId: string): string | null
  lineTodoHwnd(): bigint | null
  onHandBackFailed?(chatName: string): void
  pushProgress?(p: DriverPostProgress): void
  log?(line: string): void
  /** 覆寫 helper 腳本路徑（測試用）；省略時依打包與否解析。 */
  scriptPath?: string
  /** 覆寫 LINE 金鑰快取檔（測試用）；省略時用 linekey 預設（<userData>/.linekey）。 */
  keyCacheFile?: string
  /** 測試用：注入假的 port（probe-driver-ipc）。production 省略，改用 psHost／lineOrder。 */
  ui?: LineUiPortV3
  order?: LineOrderPort
  /** 測試用：時鐘與等待（後續動作的 5 分鐘有效期）。 */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** helper 腳本位置：打包後在 resources/line-driver（extraResources），開發時在 repo 的 resources/line-driver。 */
export function resolveHelperScript(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'line-driver', 'line-uia-host.ps1')
    : join(app.getAppPath(), 'resources', 'line-driver', 'line-uia-host.ps1')
}

/** LINE_TODO_DRIVER_TEST_ALLOW（逗號分隔）。只能縮小範圍，不能放寬任何檢查。 */
export function readTestAllowlist(): string[] | null {
  const raw = process.env.LINE_TODO_DRIVER_TEST_ALLOW
  if (!raw || !raw.trim()) return null
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length ? list : null
}

export function createDriver(deps: DriverDeps) {
  const log = deps.log ?? ((line: string) => console.log(line))
  // psHost 只在第一次指令時才 spawn helper；建立本身不做任何事。
  const ui = deps.ui ?? createPsHost({ scriptPath: deps.scriptPath ?? resolveHelperScript(), allowSetForeground, log })
  const order = deps.order ?? createLineOrder({ cacheFile: deps.keyCacheFile })
  const pdDeps: PostDraftDeps = {
    now: deps.now,
    sleep: deps.sleep,
    ui,
    order,
    getSettings: deps.getSettings,
    getTodo: deps.getTodo,
    getChatName: deps.getChatName,
    testAllowlist: readTestAllowlist,
    lineTodoHwnd: deps.lineTodoHwnd,
    onHandBackFailed: deps.onHandBackFailed,
    progress: deps.pushProgress,
    log
  }
  const service = createPostDraft(pdDeps)
  let lastHostProblem: DriverStatus['lastHostProblem'] = null

  return {
    async postDraft(req: DriverPostRequest): Promise<DriverPostResult> {
      const r = await service.postDraft(req)
      if (!r.ok && (r.code === 'host_unavailable' || r.code === 'powershell_restricted' || r.code === 'ocr_unavailable')) {
        lastHostProblem = { code: r.code, message: r.message }
      } else if (r.ok) {
        lastHostProblem = null
      }
      return r
    },
    /** 輕量：只讀設定、記憶體狀態與 line-todo DB（todoId 時），不 spawn helper、不碰 LINE。 */
    getStatus(todoId?: string): DriverStatus {
      const enabled = deps.getSettings().enabled
      return {
        enabled,
        mode: 'fillOnly',
        sendAvailable: false,
        busy: service.isBusy(),
        lastHostProblem,
        targetProblem: enabled && todoId ? service.targetProblem(todoId) : null
      }
    },
    /** 最近一次成功填入的後續資料（只給 probe-driver-live 的 M23 守門測試用；IPC 不使用）。 */
    takeFollowUp: service.takeFollowUp,
    focusLine: (attemptId: unknown): Promise<DriverFollowUpResult> => service.focusLine(attemptId),
    clearFilled: (attemptId: unknown): Promise<DriverFollowUpResult> => service.clearFilled(attemptId),
    async dispose(): Promise<void> {
      await ui.dispose()
    }
  }
}

export type Driver = ReturnType<typeof createDriver>
