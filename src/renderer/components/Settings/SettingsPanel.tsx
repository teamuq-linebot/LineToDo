import { useCallback, useEffect, useState } from 'react'
import type { SettingsView, ChatDTO } from '../../types/api'
import { ApiKeyField } from './ApiKeyField'
import { BlocklistEditor } from './BlocklistEditor'

/**
 * SettingsPanel — 設定頁（IMPLEMENTATION_PLAN.md M3）。
 *
 * 區塊：
 *   - 輪詢頻率 / 並發 / 上下文則數（數值設定，存 settings.json）
 *   - qwen 金鑰（safeStorage，ApiKeyField）
 *   - 降噪黑名單（關鍵字 + 逐 chat toggle，BlocklistEditor）
 *   - 資料夾 / 維運
 *
 * 所有變更立即透過 window.api.settings.update 落檔；輪詢頻率改動會讓 main 重排排程器。
 */

export function SettingsPanel(): JSX.Element {
  const [view, setView] = useState<SettingsView | null>(null)
  const [chats, setChats] = useState<ChatDTO[]>([])
  const [saved, setSaved] = useState(false)

  const loadView = useCallback(async (): Promise<void> => {
    const v = await window.api.settings.get()
    setView(v)
  }, [])

  const loadChats = useCallback(async (): Promise<void> => {
    const list = await window.api.db.chats.list(true) // 含黑名單
    setChats(list)
  }, [])

  useEffect(() => {
    void loadView()
    void loadChats()
  }, [loadView, loadChats])

  function flashSaved(): void {
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  async function patch(
    p: Parameters<typeof window.api.settings.update>[0]
  ): Promise<void> {
    const v = await window.api.settings.update(p)
    setView(v)
    flashSaved()
  }

  async function toggleChat(chatId: string, blocked: boolean): Promise<void> {
    await window.api.db.chats.setBlocked(chatId, blocked, blocked ? 'manual' : undefined)
    await loadChats()
  }

  async function removeKeyword(chatId: string, kw: string): Promise<void> {
    await window.api.db.chats.removeIgnoreKeyword(chatId, kw)
    await loadView()
  }

  const chatNameOf = (id: string): string =>
    chats.find((c) => c.chatId === id)?.name ?? id

  if (!view) {
    return <div className="settings-wrap muted">載入設定中…</div>
  }

  return (
    <div className="settings-wrap">
      <div className="settings-head">
        <h2>設定</h2>
        {saved && <span className="txt-ok">已儲存 ✓</span>}
      </div>

      {/* 抓取行為 */}
      <div className="set-section">
        <div className="set-section-title">抓取行為</div>

        <div className="set-field">
          <label className="set-label">輪詢頻率（秒）</label>
          <div className="set-inline">
            <input
              type="number"
              className="set-num"
              min={5}
              max={3600}
              value={view.pollIntervalSec}
              onChange={(e) =>
                setView({ ...view, pollIntervalSec: Number(e.target.value) })
              }
              onBlur={() => void patch({ pollIntervalSec: view.pollIntervalSec })}
            />
            <span className="muted">每隔幾秒檢查一次新訊息並抽取（5–3600）。</span>
          </div>
        </div>

        <div className="set-field">
          <label className="set-label">抽取並發數</label>
          <div className="set-inline">
            <input
              type="number"
              className="set-num"
              min={1}
              max={4}
              value={view.concurrency}
              onChange={(e) =>
                setView({ ...view, concurrency: Number(e.target.value) })
              }
              onBlur={() => void patch({ concurrency: view.concurrency })}
            />
            <span className="muted">同時送幾個聊天室給 qwen（保守 1–2，最多 4）。</span>
          </div>
        </div>
      </div>

      {/* 開機與自我對帳 */}
      <div className="set-section">
        <div className="set-section-title">開機與自我對帳</div>

        {/* 開機時自動啟動 */}
        <div className="set-row">
          <div className="set-row-main">
            <span className="set-label">開機時自動啟動</span>
            <span className="set-hint muted">
              Windows 登入後自動在背景開啟 line-todo，隨時補齊代辦。可關閉。
            </span>
          </div>
          <div className="set-row-ctl">
            <label className="switch">
              <input
                type="checkbox"
                checked={view.openAtLogin}
                onChange={(e) => void patch({ openAtLogin: e.target.checked })}
              />
              <span className="slider"></span>
            </label>
          </div>
        </div>

        {/* 自動補齊歷史訊息（自我對帳） */}
        <div className="set-row">
          <div className="set-row-main">
            <span className="set-label">自動補齊歷史訊息（自我對帳）</span>
            <span className="set-hint muted">
              開機時比對 LINE 與本機資料庫各月訊息筆數，於背景補齊缺漏的月份，不打擾操作。
            </span>
          </div>
          <div className="set-row-ctl">
            <label className="switch">
              <input
                type="checkbox"
                checked={view.reconcile.enabled}
                onChange={(e) =>
                  void patch({ reconcile: { enabled: e.target.checked } })
                }
              />
              <span className="slider"></span>
            </label>
          </div>
        </div>

        {/* 對帳範圍（依賴自我對帳開關；關閉時淡化+停用） */}
        <div className={`set-row${view.reconcile.enabled ? '' : ' disabled'}`}>
          <div className="set-row-main">
            <span className="set-label">對帳範圍</span>
            <span className="set-hint muted">
              「全部歷史」較完整但首次較久；「近 N 個月」較快，只補最近的月份。
            </span>
          </div>
          <div className="set-row-ctl">
            <select
              className="set-select"
              disabled={!view.reconcile.enabled}
              value={view.reconcile.scopeMonths}
              onChange={(e) =>
                void patch({ reconcile: { scopeMonths: Number(e.target.value) } })
              }
            >
              <option value={0}>全部歷史</option>
              <option value={3}>近 3 個月</option>
              <option value={6}>近 6 個月</option>
              <option value={12}>近 12 個月</option>
            </select>
          </div>
        </div>
      </div>

      {/* qwen 金鑰 */}
      <div className="set-section">
        <div className="set-section-title">qwen 抽取引擎</div>
        <ApiKeyField view={view} onChanged={() => void loadView()} />
      </div>

      {/* 黑名單 */}
      <div className="set-section">
        <div className="set-section-title">降噪</div>
        <BlocklistEditor
          nameKeywords={view.blocklist.nameKeywords}
          chats={chats}
          onKeywordsChange={(next) =>
            void patch({ blocklist: { nameKeywords: next } })
          }
          onToggleChat={(chatId, blocked) => void toggleChat(chatId, blocked)}
        />
      </div>

      {/* 逐對話關鍵字忽略（卡片「更多 ▾ → 依關鍵字忽略」加入的，這裡可解除） */}
      <div className="set-section">
        <div className="set-section-title">逐對話關鍵字忽略</div>
        {Object.keys(view.chatIgnoreKeywords).length === 0 ? (
          <span className="muted">
            目前沒有。可在看板卡片「更多 ▾ → 依關鍵字忽略」加入；之後該對話新抽到、標題或備註含此詞的代辦會自動忽略。
          </span>
        ) : (
          Object.entries(view.chatIgnoreKeywords).map(([chatId, kws]) => (
            <div className="set-field" key={chatId}>
              <label className="set-label">{chatNameOf(chatId)}</label>
              <div className="kw-list">
                {kws.map((kw) => (
                  <span className="kw-chip" key={kw}>
                    {kw}
                    <button
                      className="kw-x"
                      title="解除此關鍵字"
                      onClick={() => void removeKeyword(chatId, kw)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 維運 */}
      <div className="set-section">
        <div className="set-section-title">維運</div>
        <button className="ghost" onClick={() => void window.api.app.openDataFolder()}>
          開啟資料夾
        </button>
      </div>
    </div>
  )
}
