import { useCallback, useEffect, useRef, useState } from 'react'
import { MY_NAME_MAX_CHARS, PROMPT_GOAL_MAX_CHARS } from '../../../shared/promptSettings'
import type { ChatPromptControl, ChatPromptSummary, PromptControl, PromptState, PromptSuggestion } from '../../../shared/promptSettings'
import type { ChatDTO } from '../../types/api'
import { displayChatName } from '../../lib/displayChatName'
import { PROMPT_EDITOR_DRAFT_MAX_AGE_MS, useUiState } from '../../lib/uiState'
import { DEFAULT_PROMPT_GOAL, PROMPT_DRAFT_KEY, notifyPromptSuggestionSaved, onPromptSuggestionSaved, parsePromptDraft } from './promptDraft'

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (text.includes('prompt_conflict')) return '這份 prompt 已在另一個畫面變更。請按「重新載入」取得最新內容，再儲存。'
  if (text.includes('prompt_empty')) return 'Prompt 不可留空。'
  if (text.includes('prompt_too_long') || text.includes('prompt_goal_too_long')) return '內容超過可用長度，請縮短 prompt 或改善目標後重試。'
  if (text.includes('my_name_too_long')) return '名字太長，請縮短後再儲存。'
  if (text.includes('my_name_invalid')) return '名字不可包含換行或控制字元。'
  if (text.includes('chat_prompt_unavailable')) return '資料庫尚未就緒，請稍後重試。'
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

const collapseName = (value: string): string => value.trim().replace(/\s+/g, ' ')

function nameErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (text.includes('prompt_conflict')) return '名字已在另一個畫面變更。請按「重新載入」取得最新內容，再儲存。'
  return errorText(error)
}

/** 「各對話的個別設定」：預設收合，第一次展開才讀清單；只列出有覆寫的對話，可逐筆恢復沿用預設。 */
function ChatOverrides({ control, chats }: { control: ChatPromptControl; chats: ChatDTO[] }): JSX.Element {
  const [items, setItems] = useState<ChatPromptSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resetting, setResetting] = useState<string | null>(null)
  const requested = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setError(null)
    try {
      const next = await control.list()
      if (mounted.current) setItems(next)
    } catch (failure) { if (mounted.current) setError(errorText(failure)) }
    finally { if (mounted.current) setLoading(false) }
  }, [control])
  const reset = async (item: ChatPromptSummary): Promise<void> => {
    setResetting(item.chatId); setError(null)
    try {
      await control.reset(item.chatId, item.revision)
      if (mounted.current) setItems((current) => current ? current.filter((entry) => entry.chatId !== item.chatId) : current)
    } catch (failure) {
      if (mounted.current) setError(errorText(failure))
      if (mounted.current && String(failure instanceof Error ? failure.message : failure).includes('prompt_conflict')) await load()
    } finally { if (mounted.current) setResetting(null) }
  }
  const names = new Map(chats.map((chat) => [chat.chatId, displayChatName(chat.name, chat.chatId, chat.isGroup)]))
  return (
    <details data-testid="chat-overrides" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open && !requested.current) { requested.current = true; void load() } }}>
      <summary>各對話的個別設定</summary>
      {loading && <div className="muted" role="status">正在載入…</div>}
      {error && <div className="set-msg err" role="alert" data-testid="chat-overrides-error">{error}</div>}
      {items && items.length === 0 && !error && <div className="muted" data-testid="chat-overrides-empty">目前沒有。到看板的聊天室 →「AI 設定」可以個別調整。</div>}
      {items && items.length > 0 && (
        <ul data-testid="chat-overrides-list">
          {items.map((item) => (
            <li key={item.chatId} className="set-inline" data-testid={`chat-override-${item.chatId}`}>
              <span>{names.get(item.chatId) ?? '（已不在清單）'}</span>
              {item.hasPrompt && <span className="muted">專屬 Prompt</span>}
              {item.myName !== null && <span className="muted">名字：{item.myName}</span>}
              <button className="btn" type="button" disabled={resetting !== null} data-testid={`reset-chat-override-${item.chatId}`} onClick={() => void reset(item)}>恢復沿用預設</button>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

export function PromptSettings({ control, chatControl, chats = [] }: { control: PromptControl; chatControl?: ChatPromptControl; chats?: ChatDTO[] }): JSX.Element {
  const drafts = useUiState()
  const [state, setState] = useState<PromptState | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [nameBusy, setNameBusy] = useState(false)
  const nameDirty = useRef(false)
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
        if (discardDraft || !nameDirty.current) { setNameDraft(next.myName ?? ''); nameDirty.current = false }
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
  const saveName = async (): Promise<void> => {
    if (!state || state.nameRevision === undefined) return
    setNameBusy(true); setError(null); setMessage(null)
    try {
      const next = await control.saveName(collapseName(nameDraft) || null, state.nameRevision)
      setState((current) => current ? { ...current, myName: next.myName, nameRevision: next.nameRevision } : current)
      setNameDraft(next.myName ?? ''); nameDirty.current = false
      setMessage('已儲存名字，下一項抽取工作會使用。')
    } catch (failure) { setError(nameErrorText(failure)) }
    finally { setNameBusy(false) }
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
      {state?.topicAppendix && <div className="set-msg muted" data-testid="topic-appendix">{state.topicAppendix}</div>}
      {error && <div className="set-msg err" role="alert" data-testid="prompt-error">{error}</div>}
      {message && <div className="set-msg muted" role="status">{message}</div>}
      {busy === 'loading' && <div className="muted" role="status">正在載入 prompt…</div>}
      {state && <>
        <div className="set-field">
          <label className="set-label" htmlFor="default-my-name">我的名字（預設）</label>
          <div className="set-inline">
            <input id="default-my-name" data-testid="default-my-name" className="set-input" type="text" maxLength={state.maxNameChars ?? MY_NAME_MAX_CHARS} value={nameDraft}
              disabled={busy === 'loading' || nameBusy || state.nameRevision === undefined} onChange={(event) => { nameDirty.current = true; setNameDraft(event.target.value) }} />
            <button className="btn" type="button" data-testid="save-my-name"
              disabled={busy === 'loading' || nameBusy || state.nameRevision === undefined || collapseName(nameDraft) === (state.myName ?? '')} onClick={() => void saveName()}>儲存名字</button>
          </div>
          <span className="muted">用來判斷哪些待辦是指派給你；各對話可以個別改</span>
        </div>
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
      {chatControl && <ChatOverrides control={chatControl} chats={chats} />}
      <button className="btn" type="button" disabled={locked} onClick={() => void load(true)}>重新載入</button>
    </div>
  )
}
