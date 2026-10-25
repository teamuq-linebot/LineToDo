import { useCallback, useEffect, useRef, useState } from 'react'
import { PROMPT_GOAL_MAX_CHARS } from '../../../shared/promptSettings'
import type { PromptControl, PromptState, PromptSuggestion } from '../../../shared/promptSettings'
import { PROMPT_EDITOR_DRAFT_MAX_AGE_MS, useUiState } from '../../lib/uiState'
import { DEFAULT_PROMPT_GOAL, PROMPT_DRAFT_KEY, notifyPromptSuggestionSaved, onPromptSuggestionSaved, parsePromptDraft } from './promptDraft'

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (text.includes('prompt_conflict')) return '這份 prompt 已在另一個畫面變更。請按「重新載入」取得最新內容，再儲存。'
  if (text.includes('prompt_empty')) return 'Prompt 不可留空。'
  if (text.includes('prompt_too_long') || text.includes('prompt_goal_too_long')) return '內容超過可用長度，請縮短 prompt 或改善目標後重試。'
  if (text.includes('prompt_suggestion_invalid') || text.includes('invalid_json')) return 'AI 建議的格式不正確，尚未套用任何變更；請重新產生建議。'
  if (text.includes('session_limit') || text.includes('busy') || text.includes('turn_in_progress')) return 'AI 正在處理其他工作，請稍後再試。'
  if (text.includes('quota_exhausted')) return 'AI 額度已用完，請在額度恢復後再產生建議。'
  if (text.includes('rate_limited')) return '已達 AI 呼叫上限，請稍後再試。'
  if (text.includes('not_granted') || text.includes('access_revoked')) return '請在 TeamUQ 允許此外掛使用 AI，再產生建議。'
  if (text.includes('turn_timeout')) return 'AI 回覆逾時，尚未套用任何變更；請重試。'
  if (text.includes('model_unavailable') || text.includes('provider_not_ready') || text.includes('provider_unavailable')) return '所選 AI 目前無法使用，請先確認上方的模型與登入狀態。'
  if (text.includes('prompt_cancelled')) return '已取消產生建議。'
  return '操作未完成，請確認外掛與 AI 可用後重試。'
}

export function PromptSettings({ control }: { control: PromptControl }): JSX.Element {
  const drafts = useUiState()
  const [state, setState] = useState<PromptState | null>(null)
  const [draft, setDraft] = useState('')
  const [goal, setGoal] = useState(DEFAULT_PROMPT_GOAL)
  const [busy, setBusy] = useState<'loading' | 'saving' | 'refining' | null>('loading')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<PromptSuggestion | null>(null)
  const [suggestionBase, setSuggestionBase] = useState('')
  const generation = useRef(0)
  const mounted = useRef(false)
  const refining = useRef(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const load = useCallback(async (discardDraft = false) => {
    const request = ++generation.current
    setBusy('loading')
    setError(null)
    try {
      const next = await control.get()
      if (request === generation.current) {
        if (discardDraft) drafts.remove(PROMPT_DRAFT_KEY)
        const restored = discardDraft ? undefined : drafts.read(PROMPT_DRAFT_KEY, parsePromptDraft, { maxAgeMs: PROMPT_EDITOR_DRAFT_MAX_AGE_MS })
        setState(restored ? { ...next, revision: restored.revision } : next)
        setDraft(restored?.draft ?? next.activePrompt)
        setGoal(restored?.goal ?? DEFAULT_PROMPT_GOAL)
        setSuggestion(restored?.suggestion ?? null)
        setSuggestionBase(restored?.suggestionBase ?? '')
        setMessage(restored ? '已還原尚未儲存的 prompt 草稿與 AI 建議。' : null)
        if (restored && restored.revision !== next.revision) setError(errorText(new Error('prompt_conflict')))
      }
    } catch (failure) { if (request === generation.current) setError(errorText(failure)) }
    finally { if (request === generation.current) setBusy(null) }
  }, [control, drafts])
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; generation.current += 1 } }, [load])
  useEffect(() => onPromptSuggestionSaved(() => { if (drafts.persistent && !refining.current) void load() }), [drafts, load])
  useEffect(() => {
    if (!state || busy === 'loading') return
    if (draft === state.activePrompt && !suggestion && goal === DEFAULT_PROMPT_GOAL) drafts.remove(PROMPT_DRAFT_KEY)
    else drafts.write(PROMPT_DRAFT_KEY, { revision: state.revision, draft, goal, suggestion, suggestionBase: suggestion ? suggestionBase : '' })
  }, [state, draft, goal, suggestion, suggestionBase, busy, drafts])

  const persist = async (run: () => Promise<PromptState>): Promise<void> => {
    setBusy('saving'); setError(null); setMessage(null)
    try {
      const next = await run()
      setState(next); setDraft(next.activePrompt); setSuggestion(null)
      setMessage('已儲存，下一項抽取工作會使用這份 prompt。')
    } catch (failure) { setError(errorText(failure)) }
    finally { setBusy(null) }
  }
  const refine = async (): Promise<void> => {
    const base = draft
    const revision = state!.revision
    refining.current = true
    setBusy('refining'); setError(null); setMessage(null); setSuggestion(null)
    try {
      const proposed = await control.refine({ prompt: base, goal })
      const existing = drafts.read(PROMPT_DRAFT_KEY, parsePromptDraft, { maxAgeMs: PROMPT_EDITOR_DRAFT_MAX_AGE_MS })
      if (!existing || existing.revision === revision) {
        drafts.write(PROMPT_DRAFT_KEY, { revision, draft: mounted.current ? draftRef.current : existing?.draft ?? base, goal: existing?.goal ?? goal, suggestion: proposed, suggestionBase: base })
        notifyPromptSuggestionSaved()
      }
      if (mounted.current) {
        setSuggestion(proposed); setSuggestionBase(base)
        setMessage('AI 已提出修正建議，按「採用建議並儲存」後才會套用。')
      }
    } catch (failure) { if (mounted.current) setError(errorText(failure)) }
    finally { refining.current = false; if (mounted.current) setBusy(null) }
  }
  const locked = busy !== null
  const stale = suggestion !== null && draft !== suggestionBase
  return (
    <div className="set-section" data-testid="prompt-settings">
      <div className="set-section-title">待辦抽取 Prompt</div>
      <div className="set-msg muted">這是 AI 開始判斷 LINE 訊息時使用的提示詞。可調整分類、判斷與去重方式；待辦輸出欄位仍由系統固定。</div>
      {error && <div className="set-msg err" role="alert" data-testid="prompt-error">{error}</div>}
      {message && <div className="set-msg muted" role="status">{message}</div>}
      {busy === 'loading' && <div className="muted" role="status">正在載入 prompt…</div>}
      {state && <>
        <details data-testid="initial-prompt">
          <summary>查看初始 Prompt</summary>
          <textarea aria-label="內建初始 Prompt" className="set-input" rows={12} readOnly value={state.initialPrompt} style={{ width: '100%', resize: 'vertical' }} />
        </details>
        <div className="set-field">
          <label className="set-label" htmlFor="active-extract-prompt">目前使用的 Prompt{state.customized ? '（已自訂）' : '（初始內容）'}</label>
          <textarea id="active-extract-prompt" data-testid="active-extract-prompt" className="set-input" rows={16} maxLength={state.maxChars} value={draft}
            onChange={(event) => { draftRef.current = event.target.value; setDraft(event.target.value) }} disabled={busy === 'loading' || busy === 'saving'} style={{ width: '100%', resize: 'vertical' }} />
          <span className="muted">{draft.length} / {state.maxChars} 字元</span>
        </div>
        <div className="set-inline">
          <button className="btn" type="button" disabled={locked || !draft.trim() || draft === state.activePrompt} data-testid="save-prompt" onClick={() => void persist(() => control.save(draft, state.revision))}>儲存並套用</button>
          <button className="btn" type="button" disabled={locked || (!state.customized && draft === state.initialPrompt)} data-testid="reset-prompt" onClick={() => void persist(() => control.reset(state.revision))}>恢復初始 Prompt</button>
        </div>
        <div className="set-field">
          <label className="set-label" htmlFor="prompt-improvement-goal">希望 AI 怎麼修正？</label>
          <textarea id="prompt-improvement-goal" data-testid="prompt-goal" className="set-input" rows={3} maxLength={PROMPT_GOAL_MAX_CHARS} value={goal} disabled={locked}
            onChange={(event) => setGoal(event.target.value)} placeholder="例如：不要把一般寒暄當成待辦；有截止日期的任務仍歸在待辦。" style={{ width: '100%', resize: 'vertical' }} />
          <span className="muted">AI 會使用上方選定的模型，讀取目前編輯中的 prompt 與這個改善目標。</span>
        </div>
        <button className="btn" type="button" data-testid="refine-prompt" disabled={locked || !draft.trim() || !goal.trim()} onClick={() => void refine()}>{busy === 'refining' ? 'AI 正在提出修正…' : '用 AI 提出修正'}</button>
        {suggestion && <div data-testid="prompt-suggestion">
          <h4>AI 修正建議{suggestion.modelId ? ` · ${suggestion.modelId}` : ''}</h4>
          <ul>{suggestion.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>
          <textarea aria-label="AI 建議的 Prompt" className="set-input" rows={16} readOnly value={suggestion.prompt} style={{ width: '100%', resize: 'vertical' }} />
          {stale && <div className="set-msg warn">目前的 prompt 已變更，這份建議以舊內容產生。請重新產生建議。</div>}
          <button className="btn" type="button" data-testid="apply-prompt-suggestion" disabled={locked || stale} onClick={() => void persist(() => control.save(suggestion.prompt, state.revision))}>採用建議並儲存</button>
          <button className="btn" type="button" disabled={locked} onClick={() => { setSuggestion(null); setMessage(null) }}>捨棄建議</button>
        </div>}
      </>}
      <button className="btn" type="button" disabled={locked} onClick={() => void load(true)}>重新載入</button>
    </div>
  )
}
