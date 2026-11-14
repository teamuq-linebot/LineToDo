/**
 * OriginalAction.tsx — Pro「下載原檔」的格子動作（M4 插槽的內容）與 provider（X7；history-download.md §7.1、§7.3）。
 *
 * - `OriginalsProvider`：App 只在 `api.linejsMedia?.original` 存在時掛它（免費版、standalone 沒有 → 插槽一律 null，畫面不變）。
 *   它建立 `OriginalsStore`、提供 M4 的 `MissingMediaActionContext`，並在需要時渲染聊天室既有的 `LineLoginDialog`（不另做登入畫面）。
 * - `OriginalAction`：「尚未下載」的照片、影片、檔案卡旁的狀態文字與按鈕，依 HD §7.3 的狀態表；狀態查到之前、不支援、已收回 → 不渲染。
 */
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import type { LineJsMediaControl, LineJsOriginalsControl } from '../../../shared/api'
import { MissingMediaActionContext, type MissingMediaActionProvider, type MissingMediaKind } from '../../components/MediaView'
import { useLineTodoApi } from '../../platform/LineTodoApi'
import { LineLoginDialog } from '../chatComposer/LineLoginDialog'
import {
  ACCOUNT_UNVERIFIED, ACCOUNT_UNVERIFIED_TEXT, ORIGINALS_DOWNLOAD_ENABLED, OriginalsContext, OriginalsStore, pausedText, progressPercent, useOriginalsStore, useOriginalsVersion,
  type OriginalCell, type OriginalsStoreOptions
} from './useOriginals'

export interface OriginalsProviderProps {
  control: LineJsOriginalsControl
  /** 「登入 LINE」用（`api.linejsMedia`）；沒有＝需要登入的格子只顯示文字。 */
  login?: LineJsMediaControl
  /** 總開關（預設 `ORIGINALS_DOWNLOAD_ENABLED`，待 P0b 結果決定）。false＝不提供插槽與批次列，畫面與沒有 provider 相同。 */
  enabled?: boolean
  /** 測試用：計時器、間隔、時鐘。 */
  options?: Omit<OriginalsStoreOptions, 'control' | 'forget'>
  children: ReactNode
}

export function OriginalsProvider({ control, login, enabled = ORIGINALS_DOWNLOAD_ENABLED, options, children }: OriginalsProviderProps): JSX.Element {
  const api = useLineTodoApi()
  const [store] = useState(() => new OriginalsStore({ ...options, control, forget: (msgId) => api.media.forget?.(msgId) }))
  useEffect(() => {
    store.start()
    return () => store.dispose()
  }, [store])
  useOriginalsVersion(store)
  const slot = useMemo<MissingMediaActionProvider>(() => ({
    render: ({ kind, msgId, retry }) => <OriginalAction kind={kind} msgId={msgId} retry={retry} />
  }), [])
  if (!enabled) return <>{children}</>
  return (
    <OriginalsContext.Provider value={store}>
      <MissingMediaActionContext.Provider value={slot}>
        {children}
        {store.loginOpen && login && (
          <LineLoginDialog
            login={login}
            onAuthenticated={() => { store.closeLogin(); store.refreshAll() }}
            onClose={() => store.closeLogin()}
          />
        )}
      </MissingMediaActionContext.Provider>
    </OriginalsContext.Provider>
  )
}

/** 冷卻中的「重試」：到 retryAt 時重新渲染（計時器在卸載或狀態改變時清掉）。 */
function useCooldown(retryAt: number | undefined, now: () => number): number {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  const left = retryAt === undefined ? 0 : Math.max(0, retryAt - now())
  useEffect(() => {
    if (left <= 0) return
    const timer = setTimeout(tick, Math.min(left, 1000))
    return () => clearTimeout(timer)
  })
  return left
}

export function OriginalAction({ kind, msgId, retry }: { kind: MissingMediaKind; msgId: string; retry: () => void }): JSX.Element | null {
  const store = useOriginalsStore()
  useOriginalsVersion(store)
  const retryRef = useRef(retry)
  retryRef.current = retry
  useEffect(() => store?.register(msgId, kind, retryRef), [store, msgId, kind])
  const cell = store?.cell(msgId) ?? null
  const cooldown = useCooldown(cell && (cell.state === 'failed' || cell.state === 'failed_retry_exhausted') ? cell.retryAt : undefined, store?.now ?? Date.now)
  if (!store || !cell) return null
  return <CellView store={store} kind={kind} cell={cell} cooldown={cooldown} />
}

function CellView({ store, kind, cell, cooldown }: { store: OriginalsStore; kind: MissingMediaKind; cell: OriginalCell; cooldown: number }): JSX.Element | null {
  const { msgId, busy } = cell
  // F-5：每個按鈕有可分辨的名稱（含看得到的字；同一頁很多格時，螢幕閱讀器也分得出是哪一種動作）
  const button = (label: string, ariaLabel: string, onClick: () => void, disabled = busy) => (
    <button type="button" className="original-action-button" aria-label={ariaLabel} disabled={disabled} onClick={onClick}>{label}</button>
  )
  let text: string | null = null
  let action: JSX.Element | null = null
  switch (cell.state) {
    case 'unknown':
    case 'unavailable':
    case 'unsupported':
      return null
    case 'idle':
      // 照片、影片格本身已寫「尚未下載」；檔案卡的插槽在卡片下方，自己說明
      text = kind === 'file' ? '原檔尚未下載' : null
      action = button('下載原檔', '下載原檔', () => store.request(msgId))
      break
    case 'needs_login':
      text = '需先登入 LINE'
      action = button('登入 LINE', '登入 LINE 以下載原檔', () => store.openLogin(), false)
      break
    case 'account_mismatch':
      // review-x5 F-1：ACCOUNT_UNVERIFIED 是「暫時讀不到電腦版的帳號」（backend 的帳號暫停期間、或電腦版沒登入），不是帳號不同：
      // 說明原因並給「重試」（重新送出下載；讀到帳號就會排進去）。只有確定是別的帳號（ACCOUNT_MISMATCH）才是不能下載的終點。
      if (cell.code === ACCOUNT_UNVERIFIED) {
        text = ACCOUNT_UNVERIFIED_TEXT
        action = button('重試', '重試下載原檔', () => store.request(msgId))
      } else text = '登入的 LINE 帳號與電腦版不同，無法下載'
      break
    case 'queued':
      text = '排隊中…'
      action = button('取消', '取消下載', () => store.cancel(msgId))
      break
    case 'running': {
      const percent = kind === 'image' ? null : progressPercent(cell)
      text = percent === null ? '下載中…' : `下載中… ${percent}%`
      action = button('取消', '取消下載', () => store.cancel(msgId))
      break
    }
    case 'paused':
      text = pausedText(cell.code)
      break
    case 'failed':
    case 'failed_retry_exhausted':
      text = cooldown > 0 ? `下載失敗，${Math.ceil(cooldown / 1000)} 秒後可重試` : '下載失敗，可以重試'
      action = button('重試', '重試下載', () => store.request(msgId), busy || cooldown > 0)
      break
    case 'expired':
      text = '已過期，無法下載'
      break
    case 'forbidden':
      text = '沒有權限，無法下載'
      break
    case 'undecryptable':
      text = '無法解密，無法下載'
      break
    case 'done':
      // 已存好、格子正在重新查詢；查到之前不退回「下載原檔」
      if (cell.rechecks < store.recheckMax) text = '已下載，正在顯示…'
      else { text = '已下載'; action = button('重新顯示', '重新顯示原檔', () => store.reshow(msgId), false) }
      break
    default:
      return null
  }
  return (
    <span className="original-action" data-original-state={cell.state} data-original-kind={kind}>
      {text && <span className="original-action-text">{text}</span>}
      {action}
    </span>
  )
}
