/**
 * pluginWire.ts — 外掛 view 與 backend 之間「線上格式」的共用上限（view 與 backend 都 import；不依賴 DOM／Node）。
 *
 * TeamUQ 1.6.8 對 `backend.call` 的請求與回應各 ≤ 64 KiB（位元組，`backendInvokeContracts.ts` 的 `payloadBytes`）。
 * 上限一律用「UTF-8 位元組」表達，不用字元數：中文每字 3 位元組，字元上限會讓 view 端的位元組檢查先擋掉（review F8）。
 * （0.2.0 起 AI 回覆不再經過 backend.call 的請求：backend 直接呼叫 host.ai.complete，原本限制回覆文字大小的 ai.commit 通道已移除。）
 */

/** 單一請求的位元組上限：host 的 64 KiB 留一點餘裕給 envelope。 */
export const MAX_REQUEST_BYTES = 60 * 1024

/**
 * manifest `backendMethods`（TeamUQ 的方法 allowlist，最多 32 個）：依 API 路徑的命名空間分組，一組一個方法名稱。
 * view 呼叫 `backend.call(<組名>, { path, args })`；backend 只接受「組名＝`backendMethodFor(path)`」的呼叫（dispatcher.ts）。
 * 所以 Core 的 allowlist 真的能縮限：不在這份清單的命名空間（例如 `driver`），Core 會在進到 backend 之前就以 `backend_method_not_allowed` 擋掉。
 * 清單、manifest（scripts/plugin/lib/manifest.mjs）、view 傳輸（pluginTransport.ts）與 backend（dispatcher.ts）共用這一份。
 */
export const BACKEND_METHOD_GROUPS = Object.freeze([
  'ping',
  'messages',
  'line',
  'db.messages',
  'db.chats',
  'db.todos',
  'groupTopics',
  'pipeline',
  'settings',
  'app',
  'media',
  'linejsMedia',
  'linejsOutbound',
  'backend',
  'review',
  'tasks',
  'events',
  'extract',
  'ai',
  'result',
  'job'
] as const)

export type BackendMethodGroup = (typeof BACKEND_METHOD_GROUPS)[number]

const GROUPS_BY_LENGTH: readonly string[] = [...BACKEND_METHOD_GROUPS].sort((a, b) => b.length - a.length)

/** API 路徑所屬的方法組（最長前綴相符：`db.todos.list` → `db.todos`、`ping` → `ping`）；不屬於任何一組回 null。 */
export function backendMethodFor(path: string): BackendMethodGroup | null {
  for (const group of GROUPS_BY_LENGTH) {
    if (path === group || path.startsWith(`${group}.`)) return group as BackendMethodGroup
  }
  return null
}
