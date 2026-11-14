/**
 * LineJsMediaPanel.tsx — 設定頁的「LINE 附件下載」區塊（Pro）。
 *
 * X5（implementation-plan-v2.md §2 X5）的文案：
 * - 「接收」以 LINE 電腦版收到的訊息為準（X2b）：電腦版沒開時不會自動保存；之後打開電腦版，開啟接收後收到的訊息會陸續補上
 *   （X2b-fix 的 sinceTs＝開啟時間減 5 分鐘、以訊息時間比對；review-x5 F-4）；自己傳出的也保存（X3）。
 * - review-x5 F-2、F-6：開頭只說「不使用電腦版的登入資料（只確認同一個帳號）、不改電腦版的檔案」；每小時上限是請求數，重試也算。
 * - 「舊訊息下載」：聊天室格子上的「下載原檔」與「補抓本頁原檔」（X6、X7）。
 * - 每小時上限（ORIGINALS_LIMITS.requestsPerHour）與遇到 LINE 限流自動暫停。
 * - 舊版（v1）的下載紀錄已凍結（X2b：v1 下載路徑停用，`linejsMedia.retry` 一律回 disabled）：只唯讀列出，不給重試；
 *   照片不再給「另存附件」（已顯示在聊天室；宿主也會取消這種下載），舊版的檔案仍可另存（唯讀匯出）。
 */
import { useCallback, useEffect, useState } from 'react'
import { ORIGINALS_LIMITS } from '../../shared/linejsOriginals'

type PluginCalls = { invoke(path: string, args?: readonly unknown[]): Promise<unknown> }
type DownloadRow = { key: string; kind: string; name: string; status: string; bytes: number; errorCode?: string }
export type MediaStatus = {
  available: boolean
  /** `pin`：掃描後 LINE 要求在手機輸入的 PIN（只在畫面上顯示）；`restoring`：後端正在恢復已儲存的登入。 */
  login: { status: string; qr?: string; pin?: string; error?: { code: string; message: string } }
  receiver: string
  downloads: { pending: number; active: number; completed: number; failed: number; recent: DownloadRow[] }
}

/** `initialStatus`：測試用的初始狀態（伺服器渲染時 effect 不會執行；正式畫面不傳，掛上後自己讀）。 */
export function LineJsMediaPanel({ plugin, initialStatus }: { plugin: PluginCalls; initialStatus?: MediaStatus }): JSX.Element {
  const [status, setStatus] = useState<MediaStatus | null>(initialStatus ?? null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const value = await plugin.invoke('linejsMedia.status') as MediaStatus
      setStatus(value)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '讀取下載狀態失敗')
    }
  }, [plugin])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 2000)
    return () => clearInterval(timer)
  }, [refresh])

  const act = async (path: string, args: unknown[] = []) => {
    setBusy(true)
    try { await plugin.invoke(path, args); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失敗') }
    finally { setBusy(false) }
  }

  const exportFile = async (item: DownloadRow) => {
    setExporting(item.key)
    setError(null)
    try {
      const chunkSize = 32 * 1024
      const parts: BlobPart[] = []
      for (let offset = 0; offset < item.bytes; offset += chunkSize) {
        const length = Math.min(chunkSize, item.bytes - offset)
        const result = await plugin.invoke('linejsMedia.exportChunk', [item.key, offset, length]) as { name?: unknown; size?: unknown; offset?: unknown; data?: unknown }
        if (result.name !== item.name || result.size !== item.bytes || result.offset !== offset || typeof result.data !== 'string') throw new Error('附件資料驗證失敗')
        const binary = atob(result.data)
        if (binary.length !== length) throw new Error('附件資料長度不符')
        const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(length))
        for (let index = 0; index < length; index++) bytes[index] = binary.charCodeAt(index)
        parts.push(bytes)
      }
      const blob = new Blob(parts)
      if (blob.size !== item.bytes) throw new Error('附件資料長度不符')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = item.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '匯出附件失敗')
    } finally { setExporting(null) }
  }

  // 舊版紀錄已凍結：沒完成的不會再繼續（不是「下載中」）
  const statusLabel = (value: string) => ({ pending: '未完成', running: '未完成', completed: '已完成', failed: '失敗', paused: '未完成' }[value] || '狀態未知')

  const enabled = status?.receiver !== 'disabled'
  const loggedIn = status?.login.status === 'authenticated'
  const recent = status?.downloads.recent ?? []
  const counts = status?.downloads
  const hasLegacy = recent.length > 0 || Boolean(counts && (counts.pending || counts.active || counts.completed || counts.failed))

  return (
    <section className="set-section" data-testid="linejs-media-panel" aria-labelledby="linejs-media-title">
      <div className="set-section-title" id="linejs-media-title">LINE 附件下載</div>
      <p className="set-msg muted" data-testid="linejs-media-intro">用另一個 LINE 連線保存照片、影片與檔案，並顯示在聊天室。首次使用需掃描 QR code；不會使用電腦版 LINE 的登入資料（只確認兩邊是同一個帳號），也不會更改電腦版 LINE 的檔案。檔案都存在本外掛的資料夾，移除外掛時一併刪除。</p>
      {error && <div className="set-notice err" role="alert">{error}</div>}
      {!status && !error && <div className="set-msg muted" role="status">正在讀取下載狀態…</div>}
      {status && !status.available && <div className="set-notice err" role="alert">{status.login.error?.message || '下載服務目前無法使用。'}</div>}
      {status?.available && (
        <>
          {!loggedIn && !status.login.qr && !status.login.pin && status.login.status !== 'restoring' && <button type="button" disabled={busy || status.login.status === 'pending'} onClick={() => void act('linejsMedia.startLogin')}>登入 LINE</button>}
          {status.login.status === 'restoring' && <div className="set-msg muted" role="status" data-testid="linejs-login-restoring">正在恢復已儲存的 LINE 登入…</div>}
          {status.login.status === 'pending' && !status.login.qr && !status.login.pin && <div className="set-msg muted" role="status" data-testid="linejs-login-waiting">正在向 LINE 取得 QR code…（LINE 伺服器或外掛背景工作較慢時可能需要數十秒）</div>}
          {status.login.status === 'pending' && <button type="button" disabled={busy} onClick={() => void act('linejsMedia.cancelLogin')}>取消登入</button>}
          {status.login.pin && <div className="set-notice chat-login-pin" role="status" data-testid="linejs-login-pin">請在手機 LINE 輸入 PIN：<strong>{status.login.pin}</strong></div>}
          {status.login.qr && <div className="set-inline" data-testid="linejs-login-qr"><img src={status.login.qr} alt="LINE 登入 QR code" width={180} height={180} /><button type="button" disabled={busy} onClick={() => void act('linejsMedia.cancelLogin')}>取消登入</button></div>}
          {status.login.error && <div className="set-notice err" role="alert">{status.login.error.message}</div>}
          {loggedIn && <div className="set-msg" role="status">LINE 已登入</div>}
          <label className="set-row">
            <input type="checkbox" checked={enabled} disabled={!loggedIn || busy} onChange={(event) => void act('linejsMedia.setReceiveEnabled', [event.target.checked])} />
            <span>接收新照片、影片與檔案（含自己傳出的）</span>
          </label>
          <div className="set-msg muted" data-testid="linejs-receive-help">以 LINE 電腦版收到的訊息為準，自動保存並顯示在聊天室。電腦版沒開時不會自動保存；之後打開電腦版，開啟接收後收到的訊息會陸續補上（LINE 已不提供的除外）。看板關閉後也要繼續保存，請在「它可以做的事」打開「關閉畫面後繼續在背景執行」。</div>
          {(loggedIn || status.login.status === 'failed') && <button type="button" disabled={busy} onClick={() => void act('linejsMedia.logout')}>{loggedIn ? '登出 LINE' : '清除登入資料'}</button>}
          <div className="set-msg muted" role="status">接收：{status.receiver === 'active' ? '運作中' : status.receiver === 'disabled' ? '已關閉' : status.receiver === 'waiting_for_login' ? '等待登入' : status.receiver}</div>
          <div className="set-msg muted" data-testid="linejs-history-help"><strong>舊訊息下載</strong>：開啟接收之前的舊訊息不會自動保存。在聊天室裡「尚未下載」的照片、影片、檔案上按「下載原檔」，或按聊天室上方的「補抓本頁原檔」（一次最多 {ORIGINALS_LIMITS.batchMax} 個）。LINE 已不提供的會顯示「已過期」。</div>
          <div className="set-msg muted" data-testid="linejs-limit-help">自動保存與舊訊息下載合計每小時最多向 LINE 下載 {ORIGINALS_LIMITS.requestsPerHour} 次（重試也算）；超過或遇到 LINE 限流時會自動暫停，稍後自動繼續。</div>
          {hasLegacy && <div className="linejs-media-legacy" data-testid="linejs-legacy">
            <div className="set-msg muted" data-testid="linejs-legacy-note">舊版下載紀錄（唯讀）：舊版的下載方式已停用，這裡只列出以前的紀錄，不能重試。沒下載成功的，請到聊天室按「下載原檔」。</div>
            {counts && <div className="set-msg muted">完成 {counts.completed} ・失敗 {counts.failed}{counts.pending + counts.active > 0 ? ` ・未完成 ${counts.pending + counts.active}` : ''}</div>}
            {recent.length > 0 && <ul className="linejs-media-list" aria-label="舊版下載紀錄">
              {recent.slice(-12).reverse().map((item) => <li key={item.key} className="linejs-media-item">
                <div className="linejs-media-item-info">
                  <span className="linejs-media-name">{item.kind === 'IMAGE' ? '圖片' : item.kind === 'FILE' ? '檔案' : '附件'} · {item.name}</span>
                  <span className="linejs-media-status" role="status">{statusLabel(item.status)}{Number.isFinite(item.bytes) ? ` · ${item.bytes.toLocaleString()} 位元組` : ''}</span>
                  {item.errorCode && <details className="linejs-media-diagnostic"><summary>技術資訊</summary><code>{item.errorCode}</code></details>}
                </div>
                <div className="linejs-media-actions">
                  {item.status === 'completed' && item.kind === 'FILE' && <button type="button" disabled={busy || exporting !== null} onClick={() => void exportFile(item)}>{exporting === item.key ? '匯出中…' : '另存附件'}</button>}
                </div>
              </li>)}
            </ul>}
          </div>}
        </>
      )}
    </section>
  )
}
