import { useLineTodoApi } from '../../platform/LineTodoApi'
import { useState } from 'react'
import type { SettingsView } from '../../types/api'

/**
 * ApiKeyField — QWEN_API_KEY 輸入（IMPLEMENTATION_PLAN.md §7.2）。
 *
 * 寫入走 settings:setApiKey → main 用 safeStorage 加密落檔；renderer 永不取回明文。
 * 只顯示「是否已設定」+ 來源（safeStorage / 環境變數 / 無）。可清除。
 * 連線測試已移到 SettingsPanel 的 ProviderHealthCheck（provider-aware，HTTP / CLI 共用一顆按鈕）。
 */

interface Props {
  view: SettingsView
  onChanged: () => void
}

function sourceLabel(s: SettingsView['apiKeySource']): string {
  switch (s) {
    case 'safeStorage':
      return '已加密儲存（safeStorage）'
    case 'env':
      return '環境變數 QWEN_API_KEY'
    default:
      return '尚未設定'
  }
}

export function ApiKeyField({ view, onChanged }: Props): JSX.Element {
  const api = useLineTodoApi()
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  async function save(): Promise<void> {
    if (!input.trim()) return
    setSaving(true)
    setMsg(null)
    try {
      const res = await api.settings.setApiKey(input.trim())
      if (res.ok) {
        setInput('')
        setMsg({ text: '金鑰已加密儲存', ok: true })
        onChanged()
      } else {
        setMsg({ text: res.error ?? '儲存失敗', ok: false })
      }
    } finally {
      setSaving(false)
    }
  }

  async function clear(): Promise<void> {
    await api.settings.clearApiKey()
    setMsg({ text: '已清除金鑰', ok: true })
    onChanged()
  }

  return (
    <div className="set-field">
      <label className="set-label">API 金鑰</label>
      <div className="set-keystate">
        目前狀態：
        <span className={view.hasApiKey ? 'txt-ok' : 'txt-warn'}>
          {sourceLabel(view.apiKeySource)}
        </span>
        {!view.safeStorageAvailable && (
          <span className="txt-warn">
            （此機 safeStorage 不可用，只能用環境變數）
          </span>
        )}
      </div>
      <div className="set-keyrow">
        <input
          type="password"
          className="set-input"
          placeholder="貼上金鑰後按「儲存」（不會顯示明文）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoComplete="off"
        />
        <button onClick={() => void save()} disabled={saving || !input.trim()}>
          {saving ? '儲存中…' : '儲存'}
        </button>
        {view.hasApiKey && view.apiKeySource === 'safeStorage' && (
          <button className="ghost danger" onClick={() => void clear()}>
            清除
          </button>
        )}
      </div>
      {msg && (
        <div className={msg.ok ? 'set-msg txt-ok' : 'set-msg txt-err'}>{msg.text}</div>
      )}
      <div className="muted set-hint">
        金鑰用 Electron safeStorage 加密後存於本機 userData，不寫入原始碼、不存明文、不回傳畫面。
      </div>
    </div>
  )
}
