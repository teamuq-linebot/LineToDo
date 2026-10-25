/**
 * residency.ts — 「背景執行」（TeamUQ 的 `background:resident`）的狀態與給使用者看的文字。backend 與兩個 view 共用（純資料＋純函式，不依賴 DOM／Node）。
 *
 * 來源是 TeamUQ Core 的 `context.residency`（Core 設計 D:150-174）：`current()` 回 `{ requested, level, reason }`、`onChange(listener)` 在變動時通知。
 * 本外掛的規則：
 *   - 舊 Core 沒有 `context.residency`：`supported:false`，畫面完全不提背景執行，行為與 0.2.0 之前相同。
 *   - `reason` 是開放集合（Core 之後可以加新代碼）：已知代碼有專屬文字，不認得的代碼一律用通用文字，並把代碼印出來方便回報；絕不因為不認得而當成「正常」或丟錯。
 *   - 狀態只靠 `onChange` 更新（撤銷或降級不會送 `ext-permission-revoked`，Core 設計 D:162,502）；本外掛不輪詢、不為了「保持常駐」去呼叫宿主。
 *   - 畫面端沒有 residency API 也沒有深連結（D:177-178），所以畫面只顯示白話原因，並指出要去 TeamUQ 抽屜的哪個開關。
 */
import { PLUGIN_PAGE_PLACE, RESIDENT_ALLOW_STEPS, RESIDENT_RETRY_STEPS, RESIDENT_STOP_STEPS, RESIDENT_TOGGLE_TITLE } from './teamuqPlaces'

/** 啟動時沒拿到 Core 的值（舊 Core）與拿到的值，畫面用同一個形狀。 */
export interface ResidencySnapshot {
  /** false＝這個 Core 沒有提供 `context.residency`（或回傳的值讀不懂）。畫面不顯示任何背景執行文字。 */
  supported: boolean
  /** 外掛有宣告 `background:resident`。 */
  requested: boolean
  /** `resident`＝目前常駐；其餘（含不認得的值）一律當成 `on-demand`。 */
  level: 'on-demand' | 'resident'
  /** 沒有常駐的原因代碼（開放集合）；`null`＝沒有原因。 */
  reason: string | null
}

export const RESIDENCY_UNSUPPORTED: Readonly<ResidencySnapshot> = Object.freeze({ supported: false, requested: false, level: 'on-demand', reason: null })

/** Core 目前定義的原因代碼（Core 設計 D:151）。這份清單只用來挑專屬文字；不在清單內的代碼走通用文字。 */
export const KNOWN_RESIDENCY_REASONS = Object.freeze([
  'resident_not_granted', 'resident_inactive', 'resident_budget_exceeded', 'resident_crash_budget_exhausted',
  'resident_boot_failed', 'resident_artifact_revoked', 'resident_revalidation_failed', 'resident_policy_error'
] as const)

const REASON_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

/** Core 的 `{requested, level, reason}`（或任何長得像的東西）→ 快照；讀不懂回 null（呼叫端保留上一個值）。 */
export function normalizeResidency(raw: unknown): ResidencySnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.requested !== 'boolean') return null
  const reason = typeof value.reason === 'string' && REASON_PATTERN.test(value.reason) ? value.reason : null
  return { supported: true, requested: value.requested, level: value.level === 'resident' ? 'resident' : 'on-demand', reason }
}

export function sameResidency(a: ResidencySnapshot, b: ResidencySnapshot): boolean {
  return a.supported === b.supported && a.requested === b.requested && a.level === b.level && a.reason === b.reason
}

/** view 從 backend 收到的值：形狀不對（舊 backend、壞資料）一律當成不支援。 */
export function parseResidencyView(raw: unknown): ResidencySnapshot {
  if (raw === null || typeof raw !== 'object') return RESIDENCY_UNSUPPORTED
  const value = raw as Record<string, unknown>
  if (value.supported !== true) return RESIDENCY_UNSUPPORTED
  return normalizeResidency(value) ?? RESIDENCY_UNSUPPORTED
}

export type ResidencyTone = 'ok' | 'info' | 'warn'

export interface ResidencyText {
  tone: ResidencyTone
  /** 看板狀態列的一句話。 */
  bar: string
  /** 設定頁的完整說明（含該去哪個開關）。 */
  detail: string
}

const RESIDENT_NOW = '背景執行中：關閉看板後，LINE 待辦仍會在背景整理新訊息（只要 TeamUQ 還開著）'

/** 已知原因的白話文字（不含「該去哪個開關」的後半句，由 `describeResidency` 補）。 */
const REASON_TEXT: Readonly<Record<(typeof KNOWN_RESIDENCY_REASONS)[number], { tone: ResidencyTone; bar: string; steps: string }>> = {
  resident_not_granted: { tone: 'info', bar: '背景執行尚未開啟：關閉看板一段時間後，TeamUQ 會停止背景程式，下次開啟看板時才會補整理新訊息', steps: RESIDENT_ALLOW_STEPS },
  resident_inactive: { tone: 'warn', bar: '沒有在背景執行：這個外掛目前沒有啟用', steps: `請到 ${PLUGIN_PAGE_PLACE}把這個外掛啟用` },
  resident_budget_exceeded: { tone: 'warn', bar: '沒有在背景執行：TeamUQ 同時能在背景執行的外掛已達上限，名額先到先得', steps: `可以到 ${PLUGIN_PAGE_PLACE}關閉其他外掛的「${RESIDENT_TOGGLE_TITLE}」，空出名額後 TeamUQ 會再試` },
  resident_crash_budget_exhausted: { tone: 'warn', bar: '背景執行已停止：背景程式連續當掉', steps: RESIDENT_RETRY_STEPS },
  resident_boot_failed: { tone: 'warn', bar: '背景執行已停止：背景程式連續啟動失敗', steps: RESIDENT_RETRY_STEPS },
  resident_artifact_revoked: { tone: 'warn', bar: '背景執行已停止：這個版本的外掛已被外掛商店撤銷', steps: `請到 ${PLUGIN_PAGE_PLACE}更新這個外掛` },
  resident_revalidation_failed: { tone: 'warn', bar: '背景執行已停止：TeamUQ 重新檢查外掛檔案沒有通過', steps: `請到 ${PLUGIN_PAGE_PLACE}更新或重新安裝這個外掛` },
  resident_policy_error: { tone: 'warn', bar: '沒有在背景執行：TeamUQ 暫時無法決定背景執行，稍後會再試', steps: '不需要做任何事；如果一直沒有恢復，請重新啟動 TeamUQ' }
}

const isKnownReason = (reason: string): reason is (typeof KNOWN_RESIDENCY_REASONS)[number] => Object.prototype.hasOwnProperty.call(REASON_TEXT, reason)

/**
 * 給使用者看的文字。`null`＝什麼都不顯示（舊 Core）。
 * 沒有要求常駐（沒宣告 `background:resident`）時狀態列不顯示（`bar` 空字串），設定頁只說明「目前沒有要求在背景持續執行」。
 */
export function describeResidency(snapshot: ResidencySnapshot): ResidencyText | null {
  if (!snapshot.supported) return null
  if (!snapshot.requested) {
    return {
      tone: 'info',
      bar: '',
      detail: '背景執行：這個版本沒有要求在背景持續執行。TeamUQ 會在外掛閒置一段時間後停止背景程式，之後開啟看板會補整理新訊息'
    }
  }
  if (snapshot.level === 'resident') return { tone: 'ok', bar: RESIDENT_NOW, detail: `${RESIDENT_NOW}。${RESIDENT_STOP_STEPS}` }
  const reason = snapshot.reason
  if (reason !== null && isKnownReason(reason)) {
    const known = REASON_TEXT[reason]
    return { tone: known.tone, bar: known.bar, detail: `${known.bar}。${known.steps}` }
  }
  // 不認得的原因代碼（Core 之後新增）或沒有原因：通用文字，印出代碼方便回報，並指出開關所在。
  const shown = reason === null ? '' : `（TeamUQ 回報的原因代碼：${reason}）`
  const bar = `沒有在背景執行${shown}`
  return { tone: 'warn', bar, detail: `${bar}。請到 ${PLUGIN_PAGE_PLACE}打開這個外掛，查看「${RESIDENT_TOGGLE_TITLE}」的狀態` }
}
