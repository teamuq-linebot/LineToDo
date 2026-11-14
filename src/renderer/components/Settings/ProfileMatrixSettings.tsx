import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatProfilesControl } from '../../../shared/hostAi'
import type { ChatProfileConfig, ChatProfileNature } from '../../../shared/chatProfiles'

const KINDS: Array<{ id: 'group' | 'non_group'; label: string }> = [
  { id: 'group', label: '群組' },
  { id: 'non_group', label: '非群組' }
]
const BUILTINS: Array<{ id: string; label: string }> = [
  { id: 'work_project', label: '工作／專案協作' },
  { id: 'time_schedule', label: '時間／行程協調' },
  { id: 'announcement_event', label: '公告／活動資訊' },
  { id: 'social_life', label: '社交／生活互動' },
  { id: 'mixed_unclassified', label: '混合／未分類' }
]
const PROMPT_KINDS = [
  { id: 'todo', label: '待辦規則' },
  { id: 'topic', label: '議題規則' }
] as const
type PromptKind = typeof PROMPT_KINDS[number]['id']

function safeError(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code.includes('revision_conflict')) return '設定已在其他畫面更新。請重新載入後再儲存。'
  if (code.includes('invalid_input') || code.includes('corrupt_config')) return '設定格式無法儲存，請檢查性質名稱與規則內容。'
  if (code.includes('storage_unavailable')) return '設定儲存目前無法使用，請稍後重試。'
  return '設定讀取或儲存未完成，請稍後重試。'
}

function stableNatureId(label: string, existing: Set<string>): string {
  const base = label.trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 44) || 'custom_nature'
  let id = `custom_${base}`.slice(0, 63)
  let suffix = 2
  while (existing.has(id)) {
    const tail = `_${suffix++}`
    id = `${`custom_${base}`.slice(0, 63 - tail.length)}${tail}`
  }
  return id
}

function natures(config: ChatProfileConfig): ChatProfileNature[] {
  return [...BUILTINS.map(({ id, label }) => ({ id, label })), ...config.customNatures]
}

function blankCell() { return { todoInstruction: '', topicInstruction: '' } }

export function ProfileMatrixSettings({ control }: { control: ChatProfilesControl }): JSX.Element {
  const [config, setConfig] = useState<ChatProfileConfig | null>(null)
  const [kind, setKind] = useState<'group' | 'non_group'>('group')
  const [natureId, setNatureId] = useState('work_project')
  const [promptKind, setPromptKind] = useState<PromptKind>('todo')
  const [draft, setDraft] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState<'loading' | 'saving' | null>('loading')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const requested = useRef(false)

  const load = useCallback(async () => {
    setBusy('loading'); setError(null); setMessage(null)
    try {
      const next = await control.getConfig()
      setConfig(next)
      const first = natures(next)[0]?.id ?? 'work_project'
      setNatureId((current) => natures(next).some((item) => item.id === current) ? current : first)
    } catch (failure) { setError(safeError(failure)) }
    finally { setBusy(null) }
  }, [control])
  const currentCell = config?.matrix[kind]?.[natureId]
  useEffect(() => {
    setDraft(promptKind === 'todo' ? currentCell?.todoInstruction ?? '' : currentCell?.topicInstruction ?? '')
  }, [config, kind, natureId, promptKind])

  const save = async (nextConfig: ChatProfileConfig, success: string): Promise<void> => {
    if (!config) return
    setBusy('saving'); setError(null); setMessage(null)
    try {
      const saved = await control.saveConfig(nextConfig, config.revision)
      setConfig(saved); setMessage(success)
    } catch (failure) { setError(safeError(failure)) }
    finally { setBusy(null) }
  }

  const saveCell = (): void => {
    if (!config || !currentCell) return
    const matrix = {
      ...config.matrix,
      [kind]: {
        ...config.matrix[kind],
        [natureId]: { ...currentCell, [promptKind === 'todo' ? 'todoInstruction' : 'topicInstruction']: draft, edited: true }
      }
    }
    void save({ ...config, matrix }, '已儲存這個類型與性質的規則。')
  }

  const addNature = (): void => {
    if (!config) return
    const label = newLabel.trim()
    if (!label || [...label].length > 40) { setError('自訂性質名稱需為 1 到 40 個字。'); return }
    const existing = natures(config)
    const id = stableNatureId(label, new Set(existing.map((item) => item.id)))
    const customNatures = [...config.customNatures, { id, label }]
    const matrix = { ...config.matrix } as ChatProfileConfig['matrix']
    for (const profileKind of ['group', 'non_group', 'unknown'] as const) {
      matrix[profileKind] = { ...matrix[profileKind], [id]: blankCell() }
    }
    setNewLabel(''); setNatureId(id); setPromptKind('todo')
    void save({ ...config, customNatures, matrix }, '已新增自訂性質；待辦與議題規則都可分別編輯。')
  }

  const renameNature = (): void => {
    if (!config) return
    const label = newLabel.trim()
    if (!label || [...label].length > 40) { setError('自訂性質名稱需為 1 到 40 個字。'); return }
    const customNatures = config.customNatures.map((item) => item.id === natureId ? { ...item, label } : item)
    if (customNatures.every((item, index) => item.label === config.customNatures[index]?.label)) return
    void save({ ...config, customNatures }, '已更新自訂性質名稱；既有矩陣規則仍綁定相同識別碼。')
  }

  const selectedNature = config ? natures(config).find((item) => item.id === natureId) : undefined
  const isCustom = config?.customNatures.some((item) => item.id === natureId) ?? false
  const locked = busy !== null
  return (
    <details className="profile-matrix-settings" data-testid="profile-matrix-settings" onToggle={(event) => {
      if ((event.currentTarget as HTMLDetailsElement).open && !requested.current) { requested.current = true; void load() }
    }}>
      <summary>管理類型 × 性質規則與自訂性質</summary>
      <p className="muted">只編輯待辦或議題補充規則；固定輸出格式與共用安全規則仍由系統維持。</p>
      {busy === 'loading' && <div className="muted" role="status">正在載入全域性質與規則…</div>}
      {error && <div className="set-msg err" role="alert" data-testid="profile-matrix-error">{error}</div>}
      {message && <div className="set-msg muted" role="status">{message}</div>}
      {!config && busy !== 'loading' && <button className="btn" type="button" onClick={() => void load()}>重新載入</button>}
      {config && <>
        <div className="profile-matrix-selectors">
          <div className="set-field">
            <label className="set-label" htmlFor="profile-matrix-kind">聊天室類型</label>
            <select id="profile-matrix-kind" className="set-select wide" value={kind} disabled={locked} onChange={(event) => setKind(event.target.value as 'group' | 'non_group')}>
              {KINDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
          <div className="set-field">
            <label className="set-label" htmlFor="profile-matrix-nature">性質</label>
            <select id="profile-matrix-nature" className="set-select wide" value={natureId} disabled={locked} onChange={(event) => setNatureId(event.target.value)}>
              {natures(config).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
        </div>
        <div className="profile-matrix-tabs" role="group" aria-label="規則類型">
          {PROMPT_KINDS.map((item) => <button key={item.id} className="btn" type="button" aria-pressed={promptKind === item.id} disabled={locked} onClick={() => setPromptKind(item.id)}>{item.label}</button>)}
        </div>
        <div className="set-field">
          <label className="set-label" htmlFor="profile-matrix-instruction">{kind === 'group' ? '群組' : '非群組'} · {selectedNature?.label ?? ''} · {promptKind === 'todo' ? '待辦規則' : '議題規則'}</label>
          <textarea id="profile-matrix-instruction" className="set-input" data-testid="profile-matrix-instruction" rows={6} maxLength={12000} value={draft} disabled={locked || !currentCell} onChange={(event) => setDraft(event.target.value)} />
          <span className="muted">{draft.length} / 12000 字</span>
        </div>
        <div className="set-inline">
          <button className="btn" type="button" data-testid="save-profile-matrix-cell" disabled={locked || !currentCell || draft === (promptKind === 'todo' ? currentCell.todoInstruction : currentCell.topicInstruction)} onClick={saveCell}>儲存此規則</button>
          <button className="btn" type="button" disabled={locked} onClick={() => void load()}>重新載入設定</button>
        </div>
        <div className="profile-nature-editor">
          <label className="set-label" htmlFor="profile-custom-nature-name">{isCustom ? '自訂性質名稱' : '新增自訂性質'}</label>
          <input id="profile-custom-nature-name" className="set-input" type="text" maxLength={40} value={newLabel} disabled={locked} placeholder={isCustom ? selectedNature?.label : '輸入名稱（最多 40 字）'} onChange={(event) => setNewLabel(event.target.value)} />
          {isCustom
            ? <button className="btn" type="button" disabled={locked || !newLabel.trim() || newLabel.trim() === selectedNature?.label} onClick={renameNature}>改名並儲存</button>
            : <button className="btn" type="button" disabled={locked || !newLabel.trim()} onClick={addNature}>新增性質</button>}
        </div>
      </>}
    </details>
  )
}
