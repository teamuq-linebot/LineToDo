import { MessageStream } from './components/MessageStream'
import { OverviewPage } from './components/OverviewPage'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { GroupTopicsPanel } from './features/groupTopics/GroupTopicsPanel'
import { PresentationToggle } from './components/PresentationToggle'
import { HeaderStatusProvider, HeaderStatusSlot } from './components/HeaderStatusSlot'
import { useHostCapabilities, useLineTodoApi } from './platform/LineTodoApi'
import { OriginalsProvider } from './features/originalDownload/OriginalAction'
import { APP_VERSION } from './lib/appVersion'
import { useTheme } from './lib/theme'
import { parseOneOf, usePersistentState } from './lib/uiState'
import { useLayoutEffect, useRef, useState } from 'react'
import { PurchasePage, type PurchasePackageId } from './components/PurchasePage'

/**
 * App（M3：待辦看板）。
 * 頂部分頁切換：總覽 / 聊天 / 群組議題 / 設定。
 *   - 總覽：篩選列 + 四欄（待辦 / 等回覆 / 行程 / 已完成）。
 *   - 聊天：LINE 聊天室、訊息與對話內群組議題。
 *   - 群組議題：所有群組的既有議題總覽與逐群操作。
 *   - 設定：整理（回顧、補媒體金鑰、不是我的回查、立即整理）、輪詢頻率、AI 判斷引擎（API 金鑰 + AI 端點）。
 *
 * 主題：外掛版跟隨 TeamUQ 宿主外觀（Electron nativeTheme → prefers-color-scheme）；standalone 保留本機切換與深色預設。
 * 目前分頁（G-04）：外掛版存進 UI 狀態（lib/uiState.ts），view 重新建立後回到同一個分頁；standalone 不保存（與原本相同）。
 */

type Tab = 'board' | 'stream' | 'topics' | 'settings' | 'purchase'
const parseTab = parseOneOf<Tab>(['board', 'stream', 'topics', 'settings', 'purchase'])
/**
 * Pro 版不顯示購買導引（「購買」分頁、圖片／發送的「進階｜查看方案」）：只在這裡關掉，不接 onPurchase。
 * 免費版（main）的購買頁與導引元件原樣保留在 PurchasePage／MediaView／MessageStream，日後合併 main 時衝突最小。
 */
const PURCHASE_ENABLED = false

function AppShell(): JSX.Element {
  const caps = useHostCapabilities()
  const [savedTab, setTab] = usePersistentState<Tab>('app.tab', 'board', parseTab)
  const [purchasePackage, setPurchasePackage] = useState<PurchasePackageId>('line')
  const purchaseSourceRef = useRef<HTMLElement | null>(null)
  const chatTabRef = useRef<HTMLButtonElement>(null)
  // 存起來的「設定」分頁在沒有設定分頁的宿主退回看板；Pro 存到的「購買」分頁（不應出現）同樣退回看板。
  const tab: Tab = (savedTab === 'settings' && !caps.settingsTab) || (savedTab === 'purchase' && !PURCHASE_ENABLED) ? 'board' : savedTab
  const { theme, toggle: toggleTheme, followsSystem } = useTheme(caps.host === 'plugin' ? 'system' : 'dark')
  const themeTitle = `${theme === 'dark' ? '切換為淺色主題' : '切換為深色主題'}${followsSystem ? '（目前跟隨系統外觀）' : ''}`

  useLayoutEffect(() => {
    if (tab !== 'stream') return
    const source = purchaseSourceRef.current
    if (source?.isConnected) source.focus()
    else chatTabRef.current?.focus()
    purchaseSourceRef.current = null
  }, [tab])

  const openPurchase = (packageId: PurchasePackageId, source: HTMLElement): void => {
    purchaseSourceRef.current = source
    setPurchasePackage(packageId)
    setTab('purchase')
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>line-todo</h1>
        {APP_VERSION && <span className="app-version" title={`外掛版本 ${APP_VERSION}`}>v{APP_VERSION}</span>}
        {tab === 'stream' && <HeaderStatusSlot />}
        <nav className="app-tabs">
          <button
            className={`tab ${tab === 'board' ? 'active' : ''}`}
            onClick={() => setTab('board')}
          >
            總覽
          </button>
          <button
            ref={chatTabRef}
            className={`tab ${tab === 'stream' ? 'active' : ''}`}
            onClick={() => setTab('stream')}
          >
            聊天
          </button>
          {PURCHASE_ENABLED && (
            <button className={`tab ${tab === 'purchase' ? 'active' : ''}`} onClick={() => setTab('purchase')}>
              購買
            </button>
          )}
          <button
            className={`tab ${tab === 'topics' ? 'active' : ''}`}
            onClick={() => setTab('topics')}
          >
            群組議題
          </button>
          {caps.settingsTab && (
            <button
              className={`tab ${tab === 'settings' ? 'active' : ''}`}
              onClick={() => setTab('settings')}
            >
              設定
            </button>
          )}
        </nav>
        <PresentationToggle />
        {caps.host !== 'plugin' && <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label="切換深色 / 淺色主題"
          title={themeTitle}
        >
          {theme === 'dark' ? '🌙' : '☀️'}
        </button>}
      </header>

      <main className={`app-main ${tab === 'stream' ? 'stream-main' : ''}`}>
        {tab === 'board' && <OverviewPage />}
        {(tab === 'stream' || tab === 'purchase') && (
          <div className="app-chat-retained" hidden={tab !== 'stream'} aria-hidden={tab !== 'stream'}>
            <MessageStream onPurchase={PURCHASE_ENABLED ? openPurchase : undefined} />
          </div>
        )}
        {PURCHASE_ENABLED && tab === 'purchase' && <PurchasePage selectedPackage={purchasePackage} onBack={() => setTab('stream')} />}
        {tab === 'topics' && <GroupTopicsPanel />}
        {tab === 'settings' && caps.settingsTab && <SettingsPanel operations />}
      </main>
    </div>
  )
}

/**
 * Pro「下載原檔」（X7）：只有 `api.linejsMedia?.original` 存在時才掛 provider（格子插槽與聊天室批次列）。
 * 免費版、standalone、沒有下載服務的 api 都沒有它 → M4 插槽維持 null，畫面不出現任何下載原檔的按鈕。總開關見 useOriginals.ts。
 */
function OriginalsGate({ children }: { children: JSX.Element }): JSX.Element {
  const api = useLineTodoApi()
  const original = api.linejsMedia?.original
  return original ? <OriginalsProvider control={original} login={api.linejsMedia}>{children}</OriginalsProvider> : children
}

function App(): JSX.Element {
  return (
    <HeaderStatusProvider>
      <OriginalsGate>
        <AppShell />
      </OriginalsGate>
    </HeaderStatusProvider>
  )
}

export default App
