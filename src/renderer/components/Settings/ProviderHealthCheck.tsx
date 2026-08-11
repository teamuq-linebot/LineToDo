import { useEffect, useState } from 'react'
import type { ProviderHealth, SettingsView } from '../../types/api'
import {
  cliSettingsOf,
  healthHeadline,
  healthLevel,
  healthLines,
  isBatchPath,
  providerMeta
} from '../../lib/aiProvider'

/**
 * ProviderHealthCheck — 設定頁「測試連線 / 檢查 CLI 狀態」。
 *
 * 一律走 settings:testAiProvider（provider-aware，main 端永不 reject），
 * 結果以三行呈現：CLI＝路徑／版本／登入，HTTP＝端點／模型。
 * 按鈕文案依 provider 變（HTTP：測試連線；CLI：檢查 CLI 狀態）。
 *
 * 檢查的是**已存檔**的設定，所以 provider / 執行檔路徑一改就把舊結果清掉，
 * 免得使用者拿著上一個 provider 的綠燈當這一個的。
 */

interface Props {
  view: SettingsView
  /** 「到路徑欄位手動指定」用；把焦點送回上方的 CLI 執行檔路徑輸入框。 */
  onFocusExecPath: () => void
}

export function ProviderHealthCheck({ view, onFocusExecPath }: Props): JSX.Element {
  const meta = providerMeta(view.aiProvider)
  const cli = cliSettingsOf(view, view.aiProvider)
  const execPath = cli?.execPath ?? ''

  const [testing, setTesting] = useState(false)
  const [health, setHealth] = useState<ProviderHealth | null>(null)

  // provider / 路徑一變，先前的檢查結果就不再代表現況。
  useEffect(() => {
    setHealth(null)
  }, [view.aiProvider, execPath])

  async function run(): Promise<void> {
    setTesting(true)
    setHealth(null)
    try {
      setHealth(await window.api.pipeline.testAiProvider())
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="set-field">
      <div className="set-keyrow">
        <button className="ghost" onClick={() => void run()} disabled={testing}>
          {testing ? '檢查中…' : meta.testLabel}
        </button>
        <span className="muted">{meta.testHint}</span>
      </div>

      {testing && (
        <div className="health-box testing">
          <div className="health-sum">
            正在檢查，請稍候…{meta.kind === 'cli' ? '（CLI 檢查通常需要 3–8 秒）' : ''}
          </div>
        </div>
      )}

      {!testing && health && <HealthBox health={health} view={view} onFocusExecPath={onFocusExecPath} />}
    </div>
  )
}

function HealthBox({
  health,
  view,
  onFocusExecPath
}: {
  health: ProviderHealth
  view: SettingsView
  onFocusExecPath: () => void
}): JSX.Element {
  const meta = providerMeta(view.aiProvider)
  const execPath = cliSettingsOf(view, view.aiProvider)?.execPath ?? ''
  const level = healthLevel(health)
  const headline = healthHeadline(health)
  const lines = healthLines(health, view.aiProvider, { baseUrl: view.aiBaseUrl, execPath })
  const cls = level === 'ok' ? 'txt-ok' : level === 'warn' ? 'txt-warn' : 'txt-err'
  const batch = isBatchPath(health.details.path)
  const notInstalled = meta.kind === 'cli' && health.details.installed === false

  return (
    <div className="health-box" role="status" aria-live="polite">
      <div className={`health-sum ${cls}`}>{headline ?? health.summary}</div>

      {lines.length > 0 && (
        <div className="health-lines">
          {lines.map((l) => (
            <div className="health-line" key={l.k}>
              <span className={`dot${l.s ? ` ${l.s}` : ''}`} aria-hidden="true" />
              <span className="health-k">{l.k}</span>
              <span className="health-v">{l.v}</span>
            </div>
          ))}
        </div>
      )}

      {headline && <div className="muted set-hint">引擎回報：{health.summary}</div>}

      {batch && (
        <>
          <div className="health-acts">
            <button className="ghost" onClick={onFocusExecPath}>
              到上方「CLI 執行檔路徑」填寫
            </button>
          </div>
          <div className="muted set-hint">
            這台電腦上的原生執行檔通常在：<code>{meta.nativeExeHint}</code>
            。填好後請再按一次「{meta.testLabel}」確認。
          </div>
        </>
      )}

      {notInstalled && !batch && (
        <>
          <div className="health-acts">
            <button className="ghost" onClick={onFocusExecPath}>
              到上方「CLI 執行檔路徑」填寫
            </button>
          </div>
          <div className="muted set-hint">
            請先在這台電腦安裝 {meta.name}，或在上方「CLI 執行檔路徑」填入完整路徑後再檢查一次。
          </div>
        </>
      )}

      {level === 'ok' && meta.kind === 'cli' && (
        <div className="muted set-hint">提醒：每個聊天室的一次抽取約需 20 秒。</div>
      )}
    </div>
  )
}
