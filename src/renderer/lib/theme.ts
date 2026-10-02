/**
 * theme.ts — 淺色／深色主題（G-01；外掛開發者指南 §3：「用 `prefers-color-scheme` 設定預設配色，並隨作業系統外觀變更更新」）。
 *
 * - 外掛（`defaultSource:'system'`）：沒有手動選擇時跟著作業系統外觀（`prefers-color-scheme`），而且系統外觀改變時立即更新。
 *   手動切換（看板右上角）會記在這個外掛自己的 localStorage（`lt-theme`）；切回「與系統相同」的那一個時清掉手動選擇，恢復跟隨系統。
 *   TeamUQ 自己的手動主題不會經公開 API 同步給外掛（指南），這裡也不去讀它。
 * - standalone（`defaultSource:'dark'`）：維持原本行為：沒有手動選擇時是深色，切換一律記住。
 * - 兩者都同時設定 `data-theme` 與 `color-scheme`，原生下拉選單、捲軸也會跟著主題。
 * - 另一個 view（看板／設定）切換主題時，`storage` 事件讓這個 view 跟著更新。
 */
import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'
export type ThemeDefault = 'system' | 'dark'
export const THEME_KEY = 'lt-theme'
export const LIGHT_QUERY = '(prefers-color-scheme: light)'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type MatchMediaLike = (query: string) => { matches: boolean; addEventListener?(type: 'change', listener: () => void): void; removeEventListener?(type: 'change', listener: () => void): void }

export function readStoredTheme(storage: StorageLike | null | undefined): Theme | null {
  try {
    const value = storage?.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

/** 作業系統目前的外觀；查不到（沒有 matchMedia）時當成深色。 */
export function systemTheme(matchMedia: MatchMediaLike | null | undefined): Theme {
  try {
    return matchMedia?.(LIGHT_QUERY).matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** 實際要用的主題：手動選擇優先；沒有時外掛跟系統、standalone 用深色。 */
export function resolveTheme(stored: Theme | null, system: Theme, defaultSource: ThemeDefault): Theme {
  if (stored) return stored
  return defaultSource === 'system' ? system : 'dark'
}

/**
 * 按一下切換之後要記住什麼：回傳要存的手動選擇，或 null＝清掉手動選擇。
 * 外掛：切到與系統相同的主題＝不再需要手動選擇（恢復跟隨系統）；standalone：一律記住（原本的行為）。
 */
export function toggleChoice(current: Theme, system: Theme, defaultSource: ThemeDefault): { theme: Theme; store: Theme | null } {
  const next: Theme = current === 'dark' ? 'light' : 'dark'
  if (defaultSource === 'system' && next === system) return { theme: next, store: null }
  return { theme: next, store: next }
}

export function applyTheme(root: { dataset: DOMStringMap; style: { colorScheme: string } } | null | undefined, theme: Theme): void {
  if (!root) return
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

function browserStorage(): StorageLike | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}
function browserMatchMedia(): MatchMediaLike | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null
}

export interface UseTheme {
  theme: Theme
  /** 目前沒有手動選擇、跟著系統外觀（只有外掛會是 true）。 */
  followsSystem: boolean
  toggle(): void
}

export function useTheme(defaultSource: ThemeDefault): UseTheme {
  const [system, setSystem] = useState<Theme>(() => systemTheme(browserMatchMedia()))
  const [stored, setStored] = useState<Theme | null>(() => readStoredTheme(browserStorage()))
  const theme = resolveTheme(stored, system, defaultSource)

  // 系統外觀改變 → 更新（外掛沒有手動選擇時畫面就跟著變）。
  useEffect(() => {
    const mm = browserMatchMedia()
    if (!mm) return undefined
    const query = mm(LIGHT_QUERY)
    const onChange = (): void => setSystem(systemTheme(mm))
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])

  // 另一個 view 改了手動選擇 → 跟著更新。
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === THEME_KEY) setStored(readStoredTheme(browserStorage()))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    applyTheme(typeof document !== 'undefined' ? document.documentElement : null, theme)
  }, [theme])

  const toggle = useCallback((): void => {
    const choice = toggleChoice(theme, system, defaultSource)
    const storage = browserStorage()
    try {
      if (choice.store === null) storage?.removeItem(THEME_KEY)
      else storage?.setItem(THEME_KEY, choice.store)
    } catch {
      /* localStorage 不可用：主題仍會即時切換，只是不保存 */
    }
    setStored(choice.store)
  }, [theme, system, defaultSource])

  return { theme, followsSystem: defaultSource === 'system' && stored === null, toggle }
}
