import { useCallback, useEffect, useRef, useState } from 'react'
import { HOST_AI_EFFORTS, normalizeHostAiSelection, type HostAiControl, type HostAiOptions, type HostAiSelection } from '../../../shared/hostAi'
import { AI_CHAT_ALLOW_STEPS } from '../../../shared/teamuqPlaces'

const STATE_TEXT: Record<string, string> = {
  ready: '可用', not_installed: '尚未安裝', not_logged_in: '尚未登入', unsupported_version: '需要更新', unavailable: '暫時無法使用', not_supported_yet: '尚未支援'
}
const EFFORT_TEXT: Record<string, string> = { minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '最高' }

function optionsError(error: unknown): string {
  const code = error instanceof Error ? error.message.replace(/^Error:\s*/, '').trim() : ''
  if (['not_granted', 'access_revoked', 'plugin_not_active'].includes(code)) return `目前無法使用 TeamUQ 的 AI；${AI_CHAT_ALLOW_STEPS}後，重新開啟看板。`
  return '暫時無法載入 AI 模型，請在 TeamUQ 確認 AI 已安裝並登入，再按「更新可用模型」。'
}

export function HostAiSettings({ control, selection, onSaved }: {
  control: HostAiControl
  selection?: HostAiSelection
  onSaved(selection: HostAiSelection): void
}): JSX.Element {
  const [options, setOptions] = useState<HostAiOptions | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const generation = useRef(0)
  const selected = normalizeHostAiSelection(selection)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const next = await control.getOptions()
      if (request === generation.current) setOptions(next)
    } catch (failure) {
      if (request === generation.current) { setOptions(null); setError(optionsError(failure)) }
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [control])
  useEffect(() => {
    void refresh()
    return () => { generation.current += 1 }
  }, [refresh])

  const save = async (next: HostAiSelection): Promise<void> => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try { onSaved(await control.setSelection(next)); setSaved(true) }
    catch { setError('AI 模型設定沒有儲存，請確認外掛已啟用且允許背景程式溝通，再重試。') }
    finally { setSaving(false) }
  }
  const provider = selected.providerId
    ? options?.providers.find((item) => item.id === selected.providerId)
    : options?.providers.find((item) => item.id === options.defaultProviderId && item.state === 'ready') ?? options?.providers.find((item) => item.state === 'ready')
  const model = selected.modelId
    ? provider?.models.find((item) => item.id === selected.modelId)
    : provider?.models.find((item) => item.isDefault) ?? provider?.models[0]
  const unavailable = !!options && (!provider || provider.state !== 'ready' || !model || (selected.effort !== null && !model.efforts.includes(selected.effort)))

  return (
    <div className="set-section" data-testid="host-ai-settings">
      <div className="set-section-title">AI 判斷引擎</div>
      <div className="set-msg muted" data-testid="ai-by-host">
        使用 TeamUQ 已登入的 AI。新訊息抽取、草擬回覆與群組議題分析都使用下面的模型設定。
        AI 在 LINE 待辦看板顯示於前景時運作；背景期間的訊息會在回到看板後補整理。
      </div>
      {error && <div className="set-msg err" role="alert">{error}</div>}
      {loading && <div className="set-msg muted" role="status">正在載入可用模型…</div>}
      {options && <>
        <div className="set-field">
          <label htmlFor="host-ai-provider">TeamUQ AI 供應者</label>
          <select id="host-ai-provider" className="set-select wide" data-testid="host-ai-provider" value={selected.providerId ?? ''} disabled={saving || loading}
            onChange={(event) => void save({ providerId: event.target.value || null, modelId: null, effort: null })}>
            <option value="">使用 TeamUQ 預設</option>
            {selected.providerId && !options.providers.some((item) => item.id === selected.providerId) && <option value={selected.providerId}>{selected.providerId}（目前不可用）</option>}
            {options.providers.map((item) => <option key={item.id} value={item.id} disabled={item.state !== 'ready'}>{item.label}（{STATE_TEXT[item.state] ?? '目前不可用'}）</option>)}
          </select>
        </div>
        <div className="set-field">
          <label htmlFor="host-ai-model">AI 模型</label>
          <select id="host-ai-model" className="set-select wide" data-testid="host-ai-model" value={selected.modelId ?? ''} disabled={saving || loading || provider?.state !== 'ready'}
            onChange={(event) => void save({ ...selected, modelId: event.target.value || null, effort: null })}>
            <option value="">使用供應者預設{!selected.modelId && model ? `（${model.label}）` : ''}</option>
            {selected.modelId && !provider?.models.some((item) => item.id === selected.modelId) && <option value={selected.modelId}>{selected.modelId}（目前不可用）</option>}
            {provider?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
        <div className="set-field">
          <label htmlFor="host-ai-effort">推理強度</label>
          <select id="host-ai-effort" className="set-select wide" data-testid="host-ai-effort" value={selected.effort ?? ''} disabled={saving || loading || !model}
            onChange={(event) => void save(normalizeHostAiSelection({ ...selected, effort: event.target.value || null }))}>
            <option value="">使用模型預設</option>
            {selected.effort && !model?.efforts.includes(selected.effort) && <option value={selected.effort}>{EFFORT_TEXT[selected.effort]}（目前不支援）</option>}
            {model?.efforts.filter((effort) => HOST_AI_EFFORTS.some((allowed) => allowed === effort)).map((effort) => <option key={effort} value={effort}>{EFFORT_TEXT[effort] ?? effort}</option>)}
          </select>
        </div>
        {unavailable && <div className="set-msg warn" role="status">所選供應者、模型或推理強度目前無法使用。請重新選擇，或回到 TeamUQ 登入／更新 AI；待辦抽取會暫停。</div>}
        {options.quota.state === 'exhausted' && <div className="set-msg warn" role="status">目前 AI 額度已用完，額度恢復後會繼續整理。</div>}
      </>}
      <button type="button" className="btn" disabled={loading || saving} onClick={() => void refresh()}>更新可用模型</button>
      {saving && <span className="muted" role="status"> 儲存中…</span>}
      {saved && <span className="muted" role="status"> 已儲存，下一項 AI 工作會使用新設定。</span>}
    </div>
  )
}
