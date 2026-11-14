/**
 * ChatOriginalsBar.tsx — 聊天室標題列的「補抓本頁原檔」批次列（Pro；X7；history-download.md §7.2）。
 *
 * - 範圍：目前畫面已載入、正在顯示「尚未下載」的照片、影片、檔案格（Manager 裁決：批次也包含影片與檔案），已收回的不算。
 *   不查整個聊天室的歷史。一次最多 `ORIGINALS_LIMITS.batchMax`（50）格，取最新的 50 格。
 * - 進行中：「補抓中 12/30｜3 個已過期」＋［取消］。取消後排隊中的格子回到「尚未下載」。結束後顯示摘要，5 秒後收起。
 * - 只有本頁有可補抓的格子（或這個聊天室有批次）時才出現。單格手動下載的優先權由 backend 處理，這裡不另外排隊。
 * - 切換聊天室：這一列卸載（批次在 backend 繼續）；回到原本的聊天室時進度接著顯示。
 */
import { useEffect } from 'react'
import type { RawLineMessage } from '../../../shared/api'
import { ORIGINALS_LIMITS } from '../../../shared/linejsOriginals'
import { useOriginalsStore, useOriginalsVersion, type OriginalsBatchProgress } from './useOriginals'

const tally = (p: OriginalsBatchProgress): string =>
  `${p.expired > 0 ? `｜${p.expired} 個已過期` : ''}${p.failed > 0 ? `｜${p.failed} 個無法下載` : ''}`

export function ChatOriginalsBar({ chatId, messages }: { chatId: string; messages: readonly RawLineMessage[] }): JSX.Element | null {
  const store = useOriginalsStore()
  useOriginalsVersion(store)
  useEffect(() => { store?.noteMessages(messages) }, [store, messages])
  useEffect(() => store?.watchBatch(chatId), [store, chatId])
  if (!store) return null

  const batch = store.batchFor(chatId)
  const progress = store.batchProgress(chatId)
  if (batch && progress) {
    let text: string
    let action: JSX.Element | null = null
    // F-3：接納中（starting）也可以取消（store 記下來，batchStart 一回來就送 batchCancel）；F-5：按鈕名稱可分辨
    const cancelButton = <button type="button" className="chat-originals-cancel" aria-label="取消補抓" disabled={batch.cancelling === true} onClick={() => store.cancelBatch(chatId)}>取消</button>
    switch (batch.phase) {
      case 'starting':
        text = batch.cancelRequested ? '準備補抓…｜取消中' : '準備補抓…'
        action = cancelButton
        break
      case 'running':
        text = `補抓中 ${progress.finished}/${progress.total}${tally(progress)}`
        if (batch.cancelFailed) text += '｜取消沒有成功，請再試一次'
        action = cancelButton
        break
      case 'finished':
        text = `補抓完成：${progress.done} 個已下載${tally(progress)}`
        break
      case 'cancelled':
        text = `已取消補抓（已下載 ${progress.done} 個）`
        break
      default:
        // review-x5 F-1：暫時讀不到電腦版的帳號，一格都沒排進去
        text = batch.error === 'batch_active' ? '另一個聊天室正在補抓，完成後再試'
          : batch.error === 'account_unverified' ? '暫時讀不到電腦版 LINE 的帳號，補抓沒有開始；請確認電腦版已登入後再試'
            : '補抓沒有開始，請稍後再試'
    }
    return (
      <div className="chat-originals-bar" role="status" data-batch-phase={batch.phase}>
        <span className="chat-originals-text">{text}</span>
        {action}
      </div>
    )
  }

  const ids = store.eligible(messages)
  if (ids.length === 0) return null
  const take = ids.slice(-ORIGINALS_LIMITS.batchMax)
  return (
    <div className="chat-originals-bar" data-batch-phase="idle">
      <span className="chat-originals-text">
        本頁有 {ids.length} 個舊檔尚未下載{ids.length > take.length ? `，一次最多 ${ORIGINALS_LIMITS.batchMax} 個` : ''}
      </span>
      <button type="button" className="chat-originals-start" aria-label={ids.length > take.length ? `補抓最新 ${take.length} 個原檔` : '補抓本頁原檔'} onClick={() => store.startBatch(chatId, take)}>
        補抓{ids.length > take.length ? `最新 ${take.length} 個` : '本頁原檔'}
      </button>
    </div>
  )
}
