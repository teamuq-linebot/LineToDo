/**
 * nodeLineFsPort.ts — 外掛 backend bundle 專用的 `main/line/engine/nodeLineFsPort.ts` 替身（只在 esbuild 的 resolve plugin 生效）。
 * 真正的版本用 `child_process` 跑 `tasklist`；backend 不能 spawn 任何子行程（1.6.8 self-check 會實測），列舉行程改用 koffi
 * （`Win32LineFsPort`）。`enginePorts.ts` 只在「沒注入 fs port」時才惰性呼叫它——外掛組裝根一定先注入，所以到這裡就是 bug。
 */
import type { LineFsPort } from '../../../main/line/engine/fsPort'

export function createNodeLineFsPort(): LineFsPort {
  throw new Error('NodeLineFsPort is not available in the plugin backend (inject the koffi Win32LineFsPort)')
}
