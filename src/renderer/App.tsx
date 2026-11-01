import { MessageStream } from './components/MessageStream'
import { KanbanBoard } from './components/Board/KanbanBoard'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { GroupTopicsPanel } from './features/groupTopics/GroupTopicsPanel'
import { IdentityInboxPanel } from './features/identity/IdentityInboxPanel'
import { useHostCapabilities } from './platform/LineTodoApi'
import { useTheme } from './lib/theme'
import { parseOneOf, usePersistentState } from './lib/uiState'

/**
 * App（M3：待辦看板）。
 * 頂部分頁切換：彙整 / 聊天 / 群組議題 / 設定。
 *   - 彙整：四欄（待辦 / 等回覆 / 行程 / 已完成）+ 今日摘要。
 *   - 聊天：LINE 聊天室、訊息與對話內群組議題。
 *   - 設定：輪詢頻率、降噪黑名單、AI 判斷引擎（API 金鑰 + AI 端點）。
 *
 * 主題：外掛版跟隨 TeamUQ 宿主外觀（Electron nativeTheme → prefers-color-scheme）；standalone 保留本機切換與深色預設。
 * 目前分頁（G-04）：外掛版存進 UI 狀態（lib/uiState.ts），view 重新建立後回到同一個分頁；standalone 不保存（與原本相同）。
 */

type Tab = 'board' | 'stream' | 'topics' | 'identity' | 'settings'
const parseTab = parseOneOf<Tab>(['board', 'stream', 'topics', 'identity', 'settings'])

function App(): JSX.Element {
  const caps = useHostCapabilities()
  const [savedTab, setTab] = usePersistentState<Tab>('app.tab', 'board', parseTab)
  // 存起來的「設定」分頁在沒有設定分頁的宿主退回看板。
  const tab: Tab = savedTab === 'settings' && !caps.settingsTab ? 'board' : savedTab
  const { theme, toggle: toggleTheme, followsSystem } = useTheme(caps.host === 'plugin' ? 'system' : 'dark')
  const themeTitle = `${theme === 'dark' ? '切換為淺色主題' : '切換為深色主題'}${followsSystem ? '（目前跟隨系統外觀）' : ''}`

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>line-todo</h1>
        <nav className="app-tabs">
          <button
            className={`tab ${tab === 'board' ? 'active' : ''}`}
            onClick={() => setTab('board')}
          >
            待辦
          </button>
          <button
            className={`tab ${tab === 'stream' ? 'active' : ''}`}
            onClick={() => setTab('stream')}
          >
            聊天
          </button>
          <button
            className={`tab ${tab === 'topics' ? 'active' : ''}`}
            onClick={() => setTab('topics')}
          >
            群組議題
          </button>
          <button
            className={`tab ${tab === 'identity' ? 'active' : ''}`}
            onClick={() => setTab('identity')}
          >
            待確認
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
        {tab === 'board' && <KanbanBoard />}
        {tab === 'stream' && <MessageStream />}
        {tab === 'topics' && <GroupTopicsPanel />}
        {tab === 'identity' && <IdentityInboxPanel />}
        {tab === 'settings' && caps.settingsTab && <SettingsPanel />}
      </main>
    </div>
  )
}

export default App
