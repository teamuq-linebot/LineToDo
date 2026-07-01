import { useEffect, useState } from 'react'
import { MessageStream } from './components/MessageStream'
import { KanbanBoard } from './components/Board/KanbanBoard'
import { SettingsPanel } from './components/Settings/SettingsPanel'

/**
 * App（M3：代辦看板）。
 * 頂部分頁切換：看板 / 即時訊息流 / 設定。
 *   - 看板：四欄（待辦 / 等回覆 / 行程 / 已完成）+ 今日摘要。
 *   - 即時訊息流：M1 的 LINE 原始訊息流（保留作觀測 / 除錯）。
 *   - 設定：輪詢頻率、降噪黑名單、qwen 金鑰。
 */

type Tab = 'board' | 'stream' | 'settings'
type Theme = 'dark' | 'light'

function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('board')
  // 初始主題：優先讀 index.html 防閃爍 script 已設定的 data-theme；
  // 若該 script 被擋（例如 CSP），退回 localStorage；再退回深色預設。
  const [theme, setTheme] = useState<Theme>(() => {
    const fromDom = document.documentElement.dataset.theme
    if (fromDom === 'light' || fromDom === 'dark') return fromDom
    try {
      return localStorage.getItem('lt-theme') === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })

  // 讓 DOM 的 data-theme 與 state 一致（涵蓋 inline script 未執行的情況）
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const toggleTheme = (): void => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem('lt-theme', next)
      } catch {
        /* localStorage 不可用時忽略：主題仍會即時切換，只是不持久化 */
      }
      return next
    })
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>line-todo</h1>
        <nav className="app-tabs">
          <button
            className={`tab ${tab === 'board' ? 'active' : ''}`}
            onClick={() => setTab('board')}
          >
            看板
          </button>
          <button
            className={`tab ${tab === 'stream' ? 'active' : ''}`}
            onClick={() => setTab('stream')}
          >
            即時訊息流
          </button>
          <button
            className={`tab ${tab === 'settings' ? 'active' : ''}`}
            onClick={() => setTab('settings')}
          >
            設定
          </button>
        </nav>
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label="切換深色 / 淺色主題"
          title={theme === 'dark' ? '切換為淺色主題' : '切換為深色主題'}
        >
          {theme === 'dark' ? '🌙' : '☀️'}
        </button>
      </header>

      <main className={`app-main ${tab === 'stream' ? 'stream-main' : ''}`}>
        {tab === 'board' && <KanbanBoard />}
        {tab === 'stream' && <MessageStream />}
        {tab === 'settings' && <SettingsPanel />}
      </main>
    </div>
  )
}

export default App
