/**
 * uiState.ts — UI 狀態的保存與還原（G-04；外掛開發者指南 §4：「輸入或結果改變時即保存需要保留的 UI 狀態，並在 UI 啟動時自行還原；
 * 若有未保存的草稿，也要在離開前保存」）。
 *
 * - `createLocalUiState(localStorage)`：外掛 view 用。值在「改變時」就寫入（不等 pagehide），view 被重建（外掛更新、停用再啟用、
 *   Core 重啟）後由元件在第一次 render 時讀回。外掛 view 的 partition 是 `persist:tuqplugin:<pluginId>`，localStorage 只有這個外掛自己看得到，
 *   不需要額外權限（`storage:plugin-data` 是 Core 的檔案儲存，這裡用不到）。
 * - `NO_UI_STATE`：預設值（standalone）：讀不到東西、寫入不做事，元件行為與加入保存前完全相同。
 *
 * 每筆值存成 `{ v, at }`；讀取時可給 `maxAgeMs`，過期的草稿直接丟掉並刪除。值超過 `maxValueBytes`（預設 256 KiB）就不寫，避免把 localStorage 撐爆。
 * 壞掉的 JSON、型別不符（`parse` 回 undefined）一律當成「沒有存過」。
 */
import { createContext, useCallback, useContext, useState } from 'react'

export interface UiStateReadOptions {
  /** 超過這個時間（毫秒）的值視為沒有存過。 */
  maxAgeMs?: number
}

export interface UiStateStore {
  readonly persistent: boolean
  read<T>(key: string, parse: (raw: unknown) => T | undefined, options?: UiStateReadOptions): T | undefined
  write(key: string, value: unknown): void
  remove(key: string): void
}

export const NO_UI_STATE: UiStateStore = Object.freeze({
  persistent: false,
  read: () => undefined,
  write: () => undefined,
  remove: () => undefined
})

export interface LocalUiStateOptions {
  prefix?: string
  maxValueBytes?: number
  now?(): number
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function createLocalUiState(storage: StorageLike | null | undefined, options: LocalUiStateOptions = {}): UiStateStore {
  if (!storage) return NO_UI_STATE
  const prefix = options.prefix ?? 'lt-ui:'
  const maxBytes = options.maxValueBytes ?? 256 * 1024
  const now = options.now ?? (() => Date.now())
  const full = (key: string): string => `${prefix}${key}`
  return {
    persistent: true,
    read<T>(key: string, parse: (raw: unknown) => T | undefined, readOptions: UiStateReadOptions = {}): T | undefined {
      let text: string | null
      try { text = storage.getItem(full(key)) } catch { return undefined }
      if (text === null) return undefined
      try {
        const entry = JSON.parse(text) as { v?: unknown; at?: unknown }
        if (entry === null || typeof entry !== 'object' || !('v' in entry)) return undefined
        if (readOptions.maxAgeMs !== undefined && (typeof entry.at !== 'number' || now() - entry.at > readOptions.maxAgeMs)) {
          try { storage.removeItem(full(key)) } catch { /* 忽略 */ }
          return undefined
        }
        return parse(entry.v)
      } catch {
        return undefined
      }
    },
    write(key: string, value: unknown): void {
      try {
        const text = JSON.stringify({ v: value, at: now() })
        if (text === undefined || text.length * 3 > maxBytes) return
        storage.setItem(full(key), text)
      } catch { /* 配額滿或不可用：狀態只是不保存 */ }
    },
    remove(key: string): void {
      try { storage.removeItem(full(key)) } catch { /* 忽略 */ }
    }
  }
}

/** 外掛 view 用：取 `window.localStorage`（被封鎖時退回不保存）。 */
export function browserUiState(): UiStateStore {
  try {
    return createLocalUiState(typeof window !== 'undefined' ? window.localStorage : null)
  } catch {
    return NO_UI_STATE
  }
}

const identity = (value: unknown): unknown => value

const UiStateContext = createContext<UiStateStore>(NO_UI_STATE)
export const UiStateProvider = UiStateContext.Provider

export function useUiState(): UiStateStore {
  return useContext(UiStateContext)
}

/**
 * 像 `useState`，但初值先從 store 讀回，之後每次改變就寫入。`serialize` 給不能直接 JSON 化的值（例如 Set）。
 * standalone（`NO_UI_STATE`）下與 `useState(initial)` 相同。
 */
export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
  parse: (raw: unknown) => T | undefined,
  serialize: (value: T) => unknown = identity
): [T, (next: T | ((prev: T) => T)) => void] {
  const store = useUiState()
  const [value, setValue] = useState<T>(() => {
    const restored = store.read(key, parse)
    if (restored !== undefined) return restored
    return typeof initial === 'function' ? (initial as () => T)() : initial
  })
  const set = useCallback((next: T | ((prev: T) => T)): void => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next
      store.write(key, serialize(resolved))
      return resolved
    })
  }, [store, key, serialize])
  return [value, set]
}

// ── 常用的 parse ──

export const parseOneOf = <T extends string>(values: readonly T[]) => (raw: unknown): T | undefined =>
  typeof raw === 'string' && (values as readonly string[]).includes(raw) ? (raw as T) : undefined

export const parseBoolean = (raw: unknown): boolean | undefined => (typeof raw === 'boolean' ? raw : undefined)

export const parseShortString = (max = 200) => (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw.length <= max ? raw : undefined

export const parseText = (max = 64 * 1024) => (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw.length <= max ? raw : undefined

/** 字串集合（存成陣列；最多 `max` 個，保留最後加入的）。 */
export const parseStringSet = (max = 5000) => (raw: unknown): Set<string> | undefined =>
  Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? new Set((raw as string[]).slice(-max)) : undefined

export const serializeStringSet = (max = 5000) => (value: Set<string>): string[] => [...value].slice(-max)
