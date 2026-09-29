import { useCallback, useEffect, useRef, useState } from 'react'
import { useLineTodoApi } from '../../platform/LineTodoApi'
import type {
  AiProviderId,
  CliProviderSettings,
  PipelineLoadStats,
  SettingsView,
  ChatDTO
} from '../../types/api'
import { ApiKeyField } from './ApiKeyField'
import { BlocklistEditor } from './BlocklistEditor'
import { ProviderHealthCheck } from './ProviderHealthCheck'
import {
  POLL_SEC_MAX,
  PROVIDERS,
  cliSettingsOf,
  defaultChatsPerRound,
  effectiveConcurrency,
  estimateRound,
  fmtDuration,
  hasEnoughLoadHistory,
  modelRationaleText,
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
  /**
   * 延遲試算用的「每輪聊天室數」（純試算，不落檔）；
   * null＝沿用 loadStats 算出的預設（見 defaultChatsPerRound）。
   */
  const [estimateChats, setEstimateChats] = useState<number | null>(null)
  /** 歷史負載統計（pipeline:loadStats）；null＝還沒回來或查不到。 */
  const [loadStats, setLoadStats] = useState<PipelineLoadStats | null>(null)
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

  /** 只在掛載時拉一次：這是統計，不是狀態，不需要跟著每輪更新。 */
  const loadLoadStats = useCallback(async (): Promise<void> => {
    setLoadStats(await api.pipeline.loadStats())
  }, [])

  useEffect(() => {
    void loadView()
    void loadChats()
    void loadReady()
    void loadLoadStats()
    // 設定改動會讓 main 重排排程器並推 status；順手跟著更新就緒狀態。
    return api.pipeline.onStatus((st) => setEngineReady(st.hasApiKey))
  }, [loadView, loadChats, loadReady, loadLoadStats])

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
  /**
   * 試算的預設值＝歷史上每輪實際處理過的聊天室數（p90），**不是**聊天室總數。
   * 總數只出現在下方的說明文字裡（它是使用者關心的數字，但它不驅動試算）。
   */
  const activeChatTotal = chats.filter((c) => !c.blocked).length
  const chatCount = estimateChats ?? defaultChatsPerRound(loadStats)
  const est = estimateRound(v.aiProvider, chatCount, v.concurrency, v.pollIntervalSec)
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

        {/* 延遲試算（CLI 才出現）：常駐事實 → 可編輯試算 → 追不上時才升級成警示 */}
        {isCli && (
          <div className={`set-notice ${est.behind ? 'warn' : 'info'}`} role="status" aria-live="polite">
            <span className="set-notice-icon" aria-hidden="true">
              {est.behind ? '⚠' : 'ℹ'}
            </span>
            <div className="set-notice-body">
              <div className="set-notice-title">
                {est.behind
                  ? '以你目前的設定，背景輪詢會追不上'
                  : '以你目前的設定，背景輪詢追得上'}
              </div>
              <div className="est-line">
                <label>
                  每輪要處理的聊天室數（只算有新訊息的）{' '}
                  <input
                    type="number"
                    className="set-num"
                    min={1}
                    /* 無上限：使用者可以自己填大數字去看最壞情況（例如把總數填進來），
                       宣告一個死板上限只會讓 input 一載入就 :invalid（見 Batch 驗收缺陷 2）。 */
                    value={chatCount}
                    onChange={(e) =>
                      setEstimateChats(Math.max(1, Number(e.target.value) || 1))
                    }
                  />
                </label>{' '}
                × 每室約 <span className="est-num">{est.perCallSec} 秒</span> ÷ 併發{' '}
                <span className="est-num">{est.concurrency}</span> ＝ 跑完一輪約{' '}
                <span className="est-num">{fmtDuration(est.roundSec)}</span>，目前輪詢間隔{' '}
                <span className="est-num">{fmtDuration(v.pollIntervalSec)}</span>。
              </div>
              {/* 聊天室總數要有地方安放（使用者會找它），但它不驅動試算——只當說明文字。 */}
              <div className="muted set-hint">
                {activeChatTotal > 0 && loadStats
                  ? `你有 ${activeChatTotal} 個未封鎖聊天室，近 ${loadStats.recentDays} 天其中 ${loadStats.chatsWithRecentMessages} 個有過新訊息；`
                  : ''}
                每一輪只處理「上一輪之後剛有新訊息」的那幾間，不是每輪都掃全部聊天室。
                {loadStats && hasEnoughLoadHistory(loadStats)
                  ? `本機最近 ${loadStats.sampleRuns} 輪成功紀錄：每輪中位數 ${loadStats.chatsSeenP50} 間、p90 ${loadStats.chatsSeenP90} 間，所以上面預設填 ${defaultChatsPerRound(loadStats)}（最少以 1 間估算，因為「一輪 0 秒」沒有參考價值）。`
                  : '目前還沒有足夠的執行紀錄可以估算，上面先以每輪 1 間計；想看最壞情況可以自己把數字改大。'}
                {loadStats && loadStats.chatsSeenMax >= 10
                  ? `例外是久沒開機後的第一次自我對帳，會一次補比較多（本機歷來單輪最多 ${loadStats.chatsSeenMax} 間），那是一次性的，跑完就回到常態。`
                  : '例外是久沒開機後的第一次自我對帳，會一次補比較多；那是一次性的，跑完就回到常態。'}
              </div>
              {est.behind ? (
                est.hopeless ? (
                  <div className="est-line">
                    這個規模跑完一輪要 {fmtDuration(est.roundSec)}
                    ，已經超過輪詢間隔可以調到的上限（{fmtDuration(POLL_SEC_MAX)}
                    ）—— 不管把輪詢間隔調多長都追不上，這不是調參數能解的問題。
                    這個規模不適合背景自動輪詢；建議改用「今日摘要」面板的「立即抓取」手動觸發，
                    或設法把要輪詢的聊天室數量／併發降到追得上的範圍。
                  </div>
                ) : (
                  <>
                    <div className="est-line">
                      上一輪還沒跑完，下一輪就到了 ——
                      多數輪次會被略過，而且這台電腦會一直有 CLI
                      在跑。把輪詢間隔拉長就能解決，代價是新訊息晚一點被整理進看板。
                    </div>
                    <div className="set-notice-acts">
                      <button onClick={() => void patch({ pollIntervalSec: est.suggestPollSec })}>
                        把輪詢間隔改成 {fmtDuration(est.suggestPollSec)}
                      </button>
                    </div>
                  </>
                )
              ) : (
                <div className="est-line">
                  CLI 每次抽取約 20 秒（實測 p90：Claude 21 秒、Codex 23
                  秒），比 HTTP
                  端點的數秒慢一個量級；目前這組數字追得上，單輪要處理的聊天室變多時這裡會再提醒你。
                </div>
              )}
              <div className="muted set-hint">
                數字來源：每室秒數為本機實測（{meta.name}，20 則對話 × 5 次），會隨對話長度變動；
                每輪聊天室數取自本機 pipeline 執行紀錄（近 200 輪抽取成功的輪次）。
              </div>
            </div>
          </div>
        )}

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
              <div className="muted set-hint">
                留空＝使用預設端點；填入你自己的 OpenAI 相容端點（Base
                URL）即可換後端 LLM，讓別人也能用自己的模型安裝使用。
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
              <div className="muted set-hint">
                留空時會自動尋找 <code>{meta.cliName}</code>
                。只有在下方檢查結果告訴你「找不到」或「找到的是批次檔」時，才需要手動填。
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
              <div className="muted set-hint" id="set-cli-modelhint">
                {modelMissing ? (
                  <>
                    <span className="txt-err">必須指定模型。</span>
                    {modelRationaleText(v.aiProvider)}
                  </>
                ) : (
                  modelRationaleText(v.aiProvider)
                )}
              </div>
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
                  超過就放棄這一室，換下一室（15–600）。實測 p90 約 21 秒，預設 120 秒留有餘裕。
                </span>
              </div>
            </div>

            <div className="muted set-hint">
              會呼叫這台電腦上已安裝、且你已登入的 {meta.name}
              ；用量計入該訂閱帳號，不需要另外的 API 金鑰。它也會沿用你本機的 CLI
              設定，所以你改了自己的 CLI 設定時，抽取行為可能跟著變。
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
        <button className="ghost" onClick={() => void api.app.openDataFolder()}>
          開啟資料夾
        </button>
      </div>
    </div>
  )
}
