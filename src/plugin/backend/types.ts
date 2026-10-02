/**
 * types.ts — TeamUQ 1.6.8 外掛 backend 契約的本地型別（只描述我們用到的部分）。
 *
 * 來源：teamuq-electron @ b8b96cb3
 *   - activate(context) / call / openSession / dispose：`apps/plugin-host/src/external/index.ts`
 *   - invoke 上限：`packages/plugin-sdk/src/backendInvokeContracts.ts`（params／回傳各 ≤ 64 KiB，單次 ≤ 30 s）
 *   - session 上限：`packages/plugin-sdk/src/capabilityContracts.ts`（單則 message ≤ 16 KiB）
 * 外掛不能 import TeamUQ 的 SDK，所以型別在這裡自備；數值常數集中在 `BACKEND_LIMITS`，測試用 drift guard 對照。
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * host 在 `activate(context)` 傳入的 context（frozen）中，本外掛會讀的部分。
 * host 另外會帶 `settings`，但本外掛沒有 `settingsSchema` 也沒有 `settings:plugin`，那些值一律是空的（G-06），
 * 所以這裡刻意不宣告它：backend 讀 `context.settings` 會在型別檢查失敗。
 */
export interface PluginBackendContext {
  readonly pluginId: string
  readonly dataDir: string
  readonly assetPacks: Readonly<Record<string, string>>
  readonly allowAddons: boolean
}

export interface SessionInfo {
  readonly sessionId: string
  readonly capability: string
  readonly callerPluginId: string
  readonly options: Readonly<Record<string, unknown>>
}

export interface SessionChannel {
  send(message: Record<string, unknown>, data?: Uint8Array): void
  close(reason?: string): void
}

export interface SessionHandler {
  message(message: Record<string, unknown>, data: Uint8Array | undefined): unknown
  close?(reason: string): unknown
}

/** `activate()` 回傳的物件；host 只認 call / openSession / dispose，`diagnostics` 是我們給測試與除錯用的額外欄位。 */
export interface PluginBackendHandler {
  call(method: string, params: unknown): Promise<unknown>
  openSession(info: SessionInfo, channel: SessionChannel): Promise<SessionHandler>
  dispose(): Promise<void>
  diagnostics(): BackendDiagnostics
}

export interface BackendDiagnostics {
  /** app DB 連線是否仍開著（dispose 之後必須是 false）。 */
  appDbOpen: boolean
  /** LINE DB 引擎的連線數／VFS 開檔數（dispose 之後必須是 0）。 */
  lineEngine: { openConnections: number; vfsOpenFiles: number; vfsShmNodes: number } | null
  /** 事件 session 數（長輪詢 + capability）。 */
  eventSessions: number
  /** ExtractQueue 狀態。 */
  extract: { pending: number; leased: number; awaiting: number }
  /** 仍被追蹤的 job／分段結果數。 */
  jobs: number
  results: number
  disposed: boolean
}

/** host 規定的上限（見檔頭來源）。 */
export const BACKEND_LIMITS = Object.freeze({
  /** `PLUGIN_BACKEND_INVOKE_LIMITS.payloadBytes`：params 與回傳各自的上限。 */
  invokeBytes: 64 * 1024,
  /** `PLUGIN_BACKEND_INVOKE_LIMITS.timeoutMs`：單次 call 超過這個時間 host 會整個重啟 backend。 */
  invokeTimeoutMs: 30_000,
  /** `CAPABILITY_LIMITS.messageBytes`：session 單則 message。 */
  sessionMessageBytes: 16 * 1024,
  /** `PLUGIN_BACKEND_INVOKE_LIMITS.inFlight`：同時進行中的 invoke。 */
  inFlight: 8,
})

/** dispatcher 回給 view 的 envelope。一律用 in-band 結果，不用 throw（view 只看得到 host 的固定錯誤碼）。 */
export type Envelope =
  | { ok: true; value: JsonValue }
  | { ok: true; pending: true; jobId: string; ageMs: number }
  | { ok: true; chunked: true; resultId: string; chunks: number; bytes: number }
  | { ok: false; code: string; message?: string; route?: string }
