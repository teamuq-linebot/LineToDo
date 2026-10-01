import { useCallback, useEffect, useRef, useState } from 'react'
import { useLineTodoApi } from '../../platform/LineTodoApi'
import type {
  AiProviderId,
  CliProviderSettings,
  SettingsView,
  ChatDTO
} from '../../types/api'
import { ApiKeyField } from './ApiKeyField'
import { BlocklistEditor } from './BlocklistEditor'
import { ProviderHealthCheck } from './ProviderHealthCheck'
import { DriverPostSettings } from './DriverPostSettings'
import {
  PROVIDERS,
  cliSettingsOf,
  effectiveConcurrency,
  providerMeta
} from '../../lib/aiProvider'

/**
 * SettingsPanel — 設定頁（IMPLEMENTATION_PLAN.md M3）。
 *
 * 區塊：
 *   - 輪詢頻率 / 並發 / 上下文則數（數值設定，存 settings.json）
 *   - AI 判斷引擎（provider 卡片選擇 + 各自的欄位 + 健檢；Batch 6）
 *   - 降噪黑名單（關鍵字 + 逐 chat toggle，BlocklistEditor）
 *   - 資料夾 / 維運
 *
 * 所有變更立即透過 api.settings.update 落檔；輪詢頻率改動會讓 main 重排排程器。
 */

export function SettingsPanel(): JSX.Element {
  const api = useLineTodoApi()
  const [view, setView] = useState<SettingsView | null>(null)
  const [chats, setChats] = useState<ChatDTO[]>([])
  const [saved, setSaved] = useState(false)
  /** 模型下拉是否切到「自訂模型名稱…」。 */
  const [customModel, setCustomModel] = useState(false)
  const execPathRef = useRef<HTMLInputElement>(null)
  /**
   * 「引擎已就緒」用 pipeline:status 的 hasApiKey——它是 provider-aware 的
   * （main/llm/provider/index.ts isProviderConfigured）。settings:get 的同名欄位
   * 目前只看 HTTP 金鑰，CLI 下會恆假，拿它當提示會誤導使用者。
   */
  const [engineReady, setEngineReady] = useState<boolean | null>(null)

  const loadView = useCallback(async (): Promise<void> => {
    const v = await api.settings.get()
    setView(v)
  }, [])

  const loadChats = useCallback(async (): Promise<void> => {
    const list = await api.db.chats.list(true) // 含黑名單
    setChats(list)
  }, [])

  const loadReady = useCallback(async (): Promise<void> => {
    const st = await api.pipeline.status()
    setEngineReady(st.hasApiKey)
  }, [])

  useEffect(() => {
    void loadView()
    void loadChats()
    void loadReady()
    // 設定改動會讓 main 重排排程器並推 status；順手跟著更新就緒狀態。
    return api.pipeline.onStatus((st) => setEngineReady(st.hasApiKey))
  }, [loadView, loadChats, loadReady])

  function flashSaved(): void {
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  async function patch(
    p: Parameters<typeof api.settings.update>[0]
  ): Promise<void> {
    const next = await api.settings.update(p)
    setView(next)
    flashSaved()
    void loadReady()
  }

  async function toggleChat(chatId: string, blocked: boolean): Promise<void> {
    await api.db.chats.setBlocked(chatId, blocked, blocked ? 'manual' : undefined)
    await loadChats()
  }

  async function removeKeyword(chatId: string, kw: string): Promise<void> {
    await api.db.chats.removeIgnoreKeyword(chatId, kw)
    await loadView()
  }

  const chatNameOf = (id: string): string =>
    chats.find((c) => c.chatId === id)?.name ?? id

  if (!view) {
    return <div className="settings-wrap muted">載入設定中…</div>
  }

  const v = view // TS narrowing：以下的 closure 都用這個非空引用
  const meta = providerMeta(v.aiProvider)
  const cli = cliSettingsOf(v, v.aiProvider)
  const isCli = meta.kind === 'cli'
  const modelIsPreset = !!cli && meta.models.some((m) => m.value === cli.model)
  const modelSelectValue = customModel || (!!cli?.model && !modelIsPreset) ? '__custom' : (cli?.model ?? '')
  const modelMissing = !!cli && cli.model.trim() === ''

  /** 只改當前 CLI provider 的欄位（另一個 provider 的設定原封不動）。 */
  function patchCli(p: Partial<CliProviderSettings>): void {
    if (v.aiProvider === 'claudeCli') void patch({ claudeCli: p })
    else if (v.aiProvider === 'codexCli') void patch({ codexCli: p })
  }

  /** 輸入中的本地更新（onBlur 才落檔），避免每個字都寫檔。 */
  function setCliLocal(p: Partial<CliProviderSettings>): void {
    if (v.aiProvider === 'claudeCli') setView({ ...v, claudeCli: { ...v.claudeCli, ...p } })
    else if (v.aiProvider === 'codexCli') setView({ ...v, codexCli: { ...v.codexCli, ...p } })
  }

  function selectProvider(id: AiProviderId): void {
    if (id === v.aiProvider) return
    setCustomModel(false)
    void patch({ aiProvider: id })
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
              disabled={isCli}
              value={effectiveConcurrency(v.aiProvider, view.concurrency)}
              onChange={(e) =>
                setView({ ...view, concurrency: Number(e.target.value) })
              }
              onBlur={() => void patch({ concurrency: view.concurrency })}
            />
            <span className="muted">
              {isCli
                ? 'CLI 引擎固定為 1：同時跑多個 CLI 會把這台電腦吃掉。'
                : '同時送幾個聊天室給 AI 判斷引擎（保守 1–2，最多 4）。'}
            </span>
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

      {/* AI 判斷引擎 */}
      <div className="set-section">
        <div className="set-section-title">AI 判斷引擎</div>

        {/* provider 卡片選擇器：三個選項全部攤開，速度標籤在選之前就看得到 */}
        <fieldset className="prov-cards">
          <legend>使用哪一個引擎</legend>
          {PROVIDERS.map((p) => (
            <label className={`prov-card${p.id === v.aiProvider ? ' sel' : ''}`} key={p.id}>
              <input
                type="radio"
                name="ai-provider"
                value={p.id}
                checked={p.id === v.aiProvider}
                onChange={() => selectProvider(p.id)}
              />
              <span className="prov-card-body">
                <span className="prov-name">{p.name}</span>
                <span className="prov-sub">{p.sub}</span>
              </span>
              <span className={`prov-speed ${p.speedClass}`}>{p.speed}</span>
            </label>
          ))}
        </fieldset>


        {/* HTTP 專屬欄位 */}
        {!isCli && (
          <>
            <div className="set-field">
              <label className="set-label">AI 端點（Base URL）</label>
              <div className="set-inline">
                <input
                  type="text"
                  className="set-input"
                  value={view.aiBaseUrl}
                  placeholder="https://qwen.tuq.tw/v1"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setView({ ...view, aiBaseUrl: e.target.value })}
                  onBlur={() => void patch({ aiBaseUrl: view.aiBaseUrl })}
                />
                <button
                  className="ghost"
                  onClick={() => {
                    setView({ ...view, aiBaseUrl: '' })
                    void patch({ aiBaseUrl: '' })
                  }}
                >
                  還原為預設
                </button>
              </div>

            </div>

            <ApiKeyField view={view} onChanged={() => void loadView()} />
          </>
        )}

        {/* CLI 專屬欄位：執行檔路徑 + 模型（必填）+ 逾時 */}
        {isCli && cli && (
          <>
            <div className="set-field">
              <label className="set-label" htmlFor="set-execpath">
                CLI 執行檔路徑
              </label>
              <div className="set-inline">
                <input
                  id="set-execpath"
                  ref={execPathRef}
                  type="text"
                  className="set-input"
                  value={cli.execPath}
                  placeholder="留空＝自動偵測"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setCliLocal({ execPath: e.target.value })}
                  onBlur={() => patchCli({ execPath: cli.execPath.trim() })}
                />
                {cli.execPath !== '' && (
                  <button className="ghost" onClick={() => patchCli({ execPath: '' })}>
                    清除，改回自動偵測
                  </button>
                )}
              </div>
            </div>

            <div className="set-field">
              <label className="set-label" htmlFor="set-cli-model">
                模型{modelMissing && <span className="txt-err">（必填）</span>}
              </label>
              <select
                id="set-cli-model"
                className={`set-select wide${modelMissing ? ' is-err' : ''}`}
                value={modelSelectValue}
                aria-invalid={modelMissing || undefined}
                aria-describedby="set-cli-modelhint"
                onChange={(e) => {
                  const next = e.target.value
                  if (next === '__custom') {
                    setCustomModel(true)
                    if (modelIsPreset) patchCli({ model: '' })
                  } else {
                    setCustomModel(false)
                    patchCli({ model: next })
                  }
                }}
              >
                <option value="">— 請選擇模型（必填）—</option>
                {meta.models.map((m) => (
                  <option value={m.value} key={m.value}>
                    {m.label}
                  </option>
                ))}
                <option value="__custom">自訂模型名稱…</option>
              </select>
              {modelSelectValue === '__custom' && (
                <input
                  type="text"
                  className={`set-input${modelMissing ? ' is-err' : ''}`}
                  value={cli.model}
                  placeholder="輸入模型名稱，例如 sonnet"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="自訂模型名稱"
                  onChange={(e) => setCliLocal({ model: e.target.value })}
                  onBlur={() => patchCli({ model: cli.model.trim() })}
                />
              )}

            </div>

            <div className="set-field">
              <label className="set-label" htmlFor="set-cli-timeout">
                單次逾時（秒）
              </label>
              <div className="set-inline">
                <input
                  id="set-cli-timeout"
                  type="number"
                  className="set-num"
                  min={15}
                  max={600}
                  value={Math.round(cli.timeoutMs / 1000)}
                  onChange={(e) =>
                    setCliLocal({ timeoutMs: (Number(e.target.value) || 0) * 1000 })
                  }
                  onBlur={() => patchCli({ timeoutMs: cli.timeoutMs })}
                />
                <span className="muted">
                  超過就放棄這一個聊天室，換下一個（15–600）。實測約 21 秒，預設 120 秒留有餘裕。
                </span>
              </div>
            </div>
          </>
        )}

        {/* 測試連線 / 檢查 CLI 狀態（三行結果） */}
        <ProviderHealthCheck
          view={view}
          onFocusExecPath={() => {
            execPathRef.current?.focus()
            execPathRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }}
        />

        {engineReady === false && (
          <div className="set-msg txt-warn">
            {isCli
              ? `目前找不到可用的 ${meta.name}（執行檔不存在或路徑指錯），抽取不會執行。請按上方「${meta.testLabel}」看是哪一環。`
              : '目前沒有可用的 API 金鑰，抽取不會執行。請填入金鑰後再按「測試連線」。'}
          </div>
        )}
      </div>
      <DriverPostSettings view={view} onPatch={(p) => void patch({ driverPost: p })} />

      {/* 黑名單 */}
      <div className="set-section">
        <div className="set-section-title">黑名單</div>
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
        <button className="ghost" onClick={() => void api.app.openDataFolder()}>
          開啟資料夾
        </button>
      </div>
    </div>
  )
}
