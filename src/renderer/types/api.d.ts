import type { Api } from '../../preload'

/**
 * 讓 renderer 認得 preload 透過 contextBridge 暴露的 window.api。
 * 型別來源為 preload 的 Api，保持兩端同步、避免漂移。
 *
 * 另把即時訊息流會用到的資料型別在此重新匯出，讓 renderer 元件從 .d.ts
 * 取型別（避免直接 import preload/index.ts 越過 tsconfig.web 的 project 邊界）。
 */
export type {
  RawLineMessage,
  LineBridgeStatus,
  ChatDTO,
  MessageDTO,
  TodoDTO,
  TodoSortBy,
  TodoSortDirection,
  MessagesPersistedEvent,
  PipelineStatus,
  PipelineRunResult,
  TodosChangedEvent,
  BackfillProgress,
  ReconcileProgress,
  ReviewLastDaysResult,
  QwenTestResult,
  BlocklistRules,
  SettingsView,
  SettingsPatch,
  DraftReplyResult
} from '../../preload'

declare global {
  interface Window {
    api: Api
  }
}
