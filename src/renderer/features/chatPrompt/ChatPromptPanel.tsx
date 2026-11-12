import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatPromptControl, ChatPromptState } from '../../../shared/promptSettings'
import { defaultsInSettingsHint } from '../../../shared/teamuqPlaces'
import { useHostCapabilities } from '../../platform/LineTodoApi'
import { useLineTodoApi } from '../../platform/LineTodoApi'
import type { ChatProfileConfig, ChatProfileOverride, ChatProfileSnapshot } from '../../../shared/chatProfiles'
import type { ChatProfileRuleKind, ChatProfileRuleSuggestion } from '../../../shared/chatProfiles'
import { cleanChatRuleMarkers } from '../../../shared/chatTemplateImport'

const CHAT_NATURE_OPTIONS = [
  { id: 'work_project', label: '工作／專案協作' },
  { id: 'time_schedule', label: '時間／行程協調' },
  { id: 'announcement_event', label: '公告／活動資訊' },
  { id: 'social_life', label: '社交／生活互動' },
  { id: 'mixed_unclassified', label: '混合／未分類' }
] as const

interface Props {
  chatId: string
  chatName: string
  control: ChatPromptControl
  /** 儲存或恢復成功後通知看板（用來更新「AI 設定」分頁的標記）。 */
  onChanged?: (state: ChatPromptState) => void
}

export function chatPromptErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (text.includes('prompt_conflict')) return '這個對話的設定已在另一個畫面變更，請按「重新載入」。'
  if (text.includes('prompt_empty')) return 'Prompt 不可留空。'
  if (text.includes('prompt_too_long')) return 'Prompt 超過可用長度，請縮短後再儲存。'
  if (text.includes('my_name_too_long')) return '名字太長，請縮短後再儲存。'
  if (text.includes('my_name_invalid')) return '名字不可包含換行或控制字元。'
  if (text.includes('chat_unknown')) return '找不到這個對話，可能已被移除。'
  if (text.includes('chat_prompt_unavailable')) return '資料庫尚未就緒，請稍後重試。'
  return '操作未完成，請確認外掛可用後重試。'
}

const collapseName = (value: string): string => value.trim().replace(/\s+/g, ' ')
const pendingProfileDrafts = new Map<string, { revision: string; profileRevision: string; nature: string; todo: string; topic: string }>()
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if (!pendingProfileDrafts.size) return
  event.preventDefault()
  event.returnValue = ''
})

/** 看板聊天室窗格的「AI 設定」分頁：這個對話自己的「我的名字」與抽取 Prompt。沒有自訂時只顯示摘要，Prompt 編輯器按需展開。 */
export function ChatPromptPanel({ chatId, chatName, control, onChanged }: Props): JSX.Element {
  const caps = useHostCapabilities()
  const api = useLineTodoApi()
  const [state, setState] = useState<ChatPromptState | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [promptDraft, setPromptDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<'loading' | 'saving' | null>('loading')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [profile, setProfile] = useState<ChatProfileSnapshot | null>(null)
  const [profileChat, setProfileChat] = useState<ChatProfileOverride | null>(null)
  const [profileConfig, setProfileConfig] = useState<ChatProfileConfig | null>(null)
  const [natureDraft, setNatureDraft] = useState('mixed_unclassified')
  const [todoDraft, setTodoDraft] = useState('')
  const [topicDraft, setTopicDraft] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [editorKind, setEditorKind] = useState<ChatProfileRuleKind>('topic')
  const [natureChoice, setNatureChoice] = useState<{ previous: string; next: string } | null>(null)
  const [assistGoal, setAssistGoal] = useState('')
  const [assistBusy, setAssistBusy] = useState(false)
  const [assistSuggestion, setAssistSuggestion] = useState<ChatProfileRuleSuggestion | null>(null)
  const [editorWarning, setEditorWarning] = useState<string | null>(null)
  const [confirmProfileReload, setConfirmProfileReload] = useState(false)
  const [staleProfileDraft, setStaleProfileDraft] = useState(false)
  const [restoredProfileDraft, setRestoredProfileDraft] = useState(false)
  const [discardingProfileDraft, setDiscardingProfileDraft] = useState(false)
  const [cachedOtherDrafts, setCachedOtherDrafts] = useState(0)
  const assistGeneration = useRef(0)
  const generation = useRef(0)

  const adopt = useCallback((next: ChatPromptState): void => {
    setState(next)
    setNameDraft(next.overrideName ?? '')
    setPromptDraft(next.effectivePrompt)
    setEditing(next.promptSource === 'chat')
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const request = ++generation.current
    setBusy('loading'); setError(null); setMessage(null)
    try {
      const next = await control.get(chatId)
      if (request === generation.current) adopt(next)
    } catch (failure) { if (request === generation.current) setError(chatPromptErrorText(failure)) }
    finally { if (request === generation.current) setBusy(null) }
  }, [adopt, chatId, control])

  useEffect(() => { void load(); return () => { generation.current += 1 } }, [load])

  const profiles = api.hostAi?.profiles
  const profileGeneration = useRef(0)
  const profileDirty = Boolean(profile && (
    natureDraft !== (profileChat?.natureId ?? profile?.natureId) ||
    todoDraft !== (profileChat?.todoOverride ?? profile?.todo.instruction) ||
    topicDraft !== (profileChat?.topicOverride ?? profile?.topic.instruction)
  ))
  const loadProfile = useCallback(async (): Promise<boolean> => {
    const request = ++profileGeneration.current
    if (!profiles) return false
    setProfileError(null); setProfileBusy(true)
    try {
      const [snapshot, chat, config] = await Promise.all([profiles.resolve(chatId), profiles.getChat(chatId), profiles.getConfig()])
      if (request !== profileGeneration.current) return false
      const pending = pendingProfileDrafts.get(chatId)
      const currentRevision = chat?.revision ?? 'new'
      setCachedOtherDrafts([...pendingProfileDrafts.keys()].filter(id => id !== chatId).length)
      setProfile(snapshot); setProfileChat(chat); setProfileConfig(config)
      setNatureDraft(pending?.nature ?? chat?.natureId ?? snapshot.natureId)
      const rawTodo = pending?.todo ?? chat?.todoOverride ?? snapshot.todo.instruction
      const rawTopic = pending?.topic ?? chat?.topicOverride ?? snapshot.topic.instruction
      const cleanTodo = cleanChatRuleMarkers(rawTodo, 'todo')
      const cleanTopic = cleanChatRuleMarkers(rawTopic, 'topic')
      setTodoDraft(cleanTodo.ok ? cleanTodo.text : rawTodo)
      setTopicDraft(cleanTopic.ok ? cleanTopic.text : rawTopic)
      setEditorWarning(!cleanTodo.ok || !cleanTopic.ok ? '舊標記無法安全隱藏；原文已保留，請在進階檢視後再儲存。' : null)
      const pendingIsStale = Boolean(pending && (pending.revision !== currentRevision || pending.profileRevision !== snapshot.revision))
      setStaleProfileDraft(pendingIsStale)
      setRestoredProfileDraft(Boolean(pending && !pendingIsStale))
      if (!pending) setStaleProfileDraft(false)
      setConfirmProfileReload(false)
      return true
    } catch { if (request === profileGeneration.current) setProfileError('聊天室規則載入失敗，請重新載入。'); return false }
    finally { if (request === profileGeneration.current) setProfileBusy(false) }
  }, [profiles, chatId])
  useEffect(() => { void loadProfile(); return () => { profileGeneration.current += 1 } }, [loadProfile])
  useEffect(() => { assistGeneration.current += 1; setAssistSuggestion(null); setAssistBusy(false); setConfirmProfileReload(false) }, [chatId])

  useEffect(() => {
    if (!profile) return
    if (discardingProfileDraft) { pendingProfileDrafts.delete(chatId); return }
    if (!profileDirty) { pendingProfileDrafts.delete(chatId); return }
    const previous = pendingProfileDrafts.get(chatId)
    pendingProfileDrafts.set(chatId, { revision: staleProfileDraft && previous ? previous.revision : profileChat?.revision ?? 'new', profileRevision: staleProfileDraft && previous ? previous.profileRevision : profile.revision, nature: natureDraft, todo: todoDraft, topic: topicDraft })
  }, [chatId, profile, profileChat, natureDraft, todoDraft, topicDraft, profileDirty, staleProfileDraft, discardingProfileDraft])

  const discardProfileDraftAndReload = (): void => {
    pendingProfileDrafts.delete(chatId)
    setDiscardingProfileDraft(true)
    setRestoredProfileDraft(false)
    void loadProfile().then(loaded => { if (loaded) setDiscardingProfileDraft(false) })
  }

  const cancelTemplateImport = (): void => undefined

  const suggestRule = async (): Promise<void> => {
    if (!profiles?.suggestRule || !profile || !assistGoal.trim()) return
    const request = ++assistGeneration.current
    const baseRevision = profile.revision
    setAssistBusy(true); setAssistSuggestion(null); setProfileError(null)
    try {
      const kind = editorKind
      const draftRule = kind === 'todo' ? todoDraft : topicDraft
      const suggestion = await profiles.suggestRule(chatId, kind, assistGoal, baseRevision, { draftRule, natureId: natureDraft })
      if (request !== assistGeneration.current) return
      const latest = await profiles.resolve(chatId)
      if (request !== assistGeneration.current || latest.revision !== baseRevision) return
      setAssistSuggestion(suggestion)
    } catch (failure) {
      if (request === assistGeneration.current) setProfileError(failure instanceof Error && failure.message.includes('revision_conflict') ? '規則已變更，請重新載入後再產生建議。' : 'AI 建議未完成，請調整需求後重試。')
    } finally { if (request === assistGeneration.current) setAssistBusy(false) }
  }
  const cancelSuggestion = (): void => { assistGeneration.current += 1; setAssistBusy(false); setAssistSuggestion(null) }

  const saveProfile = async (reset = false): Promise<void> => {
    if (!profiles || !profile || staleProfileDraft || discardingProfileDraft) return
    cancelSuggestion()
    cancelTemplateImport()
    const request = ++profileGeneration.current
    setProfileBusy(true); setProfileError(null); setMessage(null)
    try {
      const selectedCell = profileConfig?.matrix[profile.chatKind]?.[natureDraft]
      const todoIsFallback = Boolean(selectedCell && todoDraft === selectedCell.todoInstruction && profileChat?.todoOverride == null && (profile.todo.source !== 'legacy' || natureDraft !== profile.natureId))
      const topicIsFallback = Boolean(selectedCell && topicDraft === selectedCell.topicInstruction && profileChat?.topicOverride == null)
      await profiles.saveChat(chatId, { natureId: natureDraft, todoOverride: reset || !todoDraft.trim() || todoIsFallback ? null : todoDraft, topicOverride: reset || !topicDraft.trim() || topicIsFallback ? null : topicDraft, ...(reset ? { resetLegacyTodo: true } : {}) }, profileChat?.revision ?? 'new')
      if (request !== profileGeneration.current) return
      pendingProfileDrafts.delete(chatId)
      setCachedOtherDrafts([...pendingProfileDrafts.keys()].filter(id => id !== chatId).length)
      setRestoredProfileDraft(false)
      setMessage(reset ? '已重設聊天室待辦覆寫並恢復繼承。' : '聊天室規則已儲存。')
      await loadProfile()
    } catch (failure) {
      if (request !== profileGeneration.current) return
      const code = failure instanceof Error ? failure.message : ''
      setProfileError(code.includes('revision_conflict') ? '設定已在其他畫面更新。請重新載入後再儲存。' : '聊天室規則儲存失敗，請稍後重試。')
    } finally { if (request === profileGeneration.current) setProfileBusy(false) }
  }

  const persist = async (run: (current: ChatPromptState) => Promise<ChatPromptState>, done: string): Promise<void> => {
    if (!state) return
    cancelTemplateImport()
    const request = ++generation.current
    setBusy('saving'); setError(null); setMessage(null)
    try {
      const next = await run(state)
      if (request !== generation.current) return
      adopt(next)
      setMessage(done)
      onChanged?.(next)
    } catch (failure) { if (request === generation.current) setError(chatPromptErrorText(failure)) }
    finally { if (request === generation.current) setBusy(null) }
  }

  const locked = busy !== null
  const payloadName = collapseName(nameDraft) === '' ? null : collapseName(nameDraft)
  const payloadPrompt = !state || !editing || (state.promptSource === 'default' && promptDraft === state.effectivePrompt) ? null : promptDraft
  const dirty = state !== null && (payloadPrompt !== state.overridePrompt || payloadName !== state.overrideName)
  const hasOverride = state !== null && (state.overridePrompt !== null || state.overrideName !== null)

  return (
    <section className="chat-todos-content" aria-label={`${chatName}的 AI 設定`} data-testid="chat-prompt-panel">
      <header className="chat-todos-heading">
        <h3>此聊天室的 AI 設定</h3>
        <span>{chatName}</span>
      </header>
      {error && <div className="set-msg err" role="alert" data-testid="chat-prompt-error">{error}</div>}
      {message && <div className="set-msg muted" role="status" data-testid="chat-prompt-message">{message}</div>}
      {profiles && <section className="chat-profile-section" aria-label="聊天室 AI 設定" data-testid="chat-profile-panel">
        {profileError && <div className="set-msg err" role="alert">{profileError}</div>}
        {profileBusy && <div role="status">正在載入聊天室規則…</div>}
        {profile && <>
          {profile.warning === 'profile_invalid' && <div className="set-msg warn" role="alert" data-testid="chat-profile-invalid">聊天室規則資料格式異常，原資料已保留且不會用於 AI 規則；按下方儲存可用目前表單值修復。</div>}
          <label className="set-field"><span className="set-label">性質</span><select className="set-select" aria-label="性質" value={natureDraft} disabled={profileBusy} onChange={e => {
            const next = e.target.value
            const hasLegacyTodo = profile.todo.source === 'legacy' && !profileChat?.todoOverride && Boolean(todoDraft.trim())
            const hasCustom = Boolean(profileChat?.todoOverride || profileChat?.topicOverride || hasLegacyTodo || todoDraft !== profile.todo.instruction || topicDraft !== profile.topic.instruction)
            if (hasCustom) setNatureChoice({ previous: natureDraft, next })
            else { setNatureDraft(next); const cell = profileConfig?.matrix[profile.chatKind]?.[next]; if (cell) { setTodoDraft(cell.todoInstruction); setTopicDraft(cell.topicInstruction) } }
            cancelSuggestion()
          }}>{[...CHAT_NATURE_OPTIONS, ...(profileConfig?.customNatures ?? []).map(n => ({ id:n.id, label:n.label + (n.archived ? '（已封存）' : '') }))].map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select></label>
          {natureChoice && <div className="set-msg warn" role="alert" data-testid="chat-nature-confirm">此聊天室有專用或手動修改的內容。<button className="btn" type="button" onClick={() => { const cell = profileConfig?.matrix[profile.chatKind]?.[natureChoice.next]; if (cell) { if (!profileChat?.todoOverride && profile.todo.source !== 'legacy' && todoDraft === profile.todo.instruction) setTodoDraft(cell.todoInstruction); if (!profileChat?.topicOverride && topicDraft === profile.topic.instruction) setTopicDraft(cell.topicInstruction) } setNatureDraft(natureChoice.next); setNatureChoice(null) }}>保留目前內容</button><button className="btn" type="button" onClick={() => { const cell = profileConfig?.matrix[profile.chatKind]?.[natureChoice.next]; if (cell) { setTodoDraft(cell.todoInstruction); setTopicDraft(cell.topicInstruction) } setNatureDraft(natureChoice.next); setNatureChoice(null) }}>換成新模板</button><button className="btn" type="button" onClick={() => setNatureChoice(null)}>取消</button></div>}
          <div className="set-inline chat-profile-tabs" role="tablist" aria-label="規則種類"><button className="btn" role="tab" aria-selected={editorKind === 'topic'} type="button" onClick={() => { setEditorKind('topic'); cancelSuggestion() }}>議題</button><button className="btn" role="tab" aria-selected={editorKind === 'todo'} type="button" onClick={() => { setEditorKind('todo'); cancelSuggestion() }}>待辦</button></div>
          {editorWarning && <p className="set-msg warn" role="status">{editorWarning}</p>}
          <textarea aria-label="Prompt 編輯器" className="set-input chat-prompt-editor" rows={10} value={assistSuggestion ? assistSuggestion.draftRule : editorKind === 'todo' ? todoDraft : topicDraft} readOnly={Boolean(assistSuggestion)} disabled={profileBusy || staleProfileDraft || discardingProfileDraft} onChange={e => { if (editorKind === 'todo') setTodoDraft(e.target.value); else setTopicDraft(e.target.value); cancelSuggestion() }} />
          {assistSuggestion && <div className="chat-profile-suggestion" data-testid="chat-profile-suggestion"><ul>{assistSuggestion.changes.map((change, i) => <li key={i}>{change}</li>)}</ul><button className="btn" type="button" onClick={() => { if (editorKind === 'todo') setTodoDraft(assistSuggestion.draftRule); else setTopicDraft(assistSuggestion.draftRule); setAssistSuggestion(null) }}>套用建議</button><button className="btn" type="button" onClick={cancelSuggestion}>取消</button></div>}
          {restoredProfileDraft && !staleProfileDraft && <p className="set-msg warn" role="status" data-testid="chat-profile-restored-draft">已保留此聊天室先前未儲存的草稿，可繼續編輯或明確保存。</p>}
          {cachedOtherDrafts > 0 && <p className="set-msg warn" role="status" data-testid="chat-profile-other-cached-drafts">另有 {cachedOtherDrafts} 個聊天室保留未儲存草稿；離開頁面或重新載入時，系統會提示尚有草稿。</p>}
          {staleProfileDraft && <div className="set-msg warn" role="alert" data-testid="chat-profile-stale-draft">此聊天室已有較新的設定版本；舊草稿已保留，請選擇如何處理後再保存。<div className="set-inline"><button className="btn" type="button" disabled={profileBusy} onClick={() => { setDiscardingProfileDraft(false); setStaleProfileDraft(false); setRestoredProfileDraft(false) }}>以目前版本保留草稿並允許保存</button><button className="btn" type="button" disabled={profileBusy} onClick={discardProfileDraftAndReload}>丟棄舊草稿並採用目前設定</button></div></div>}
          {profileDirty && <div className="set-msg warn" role="status" data-testid="chat-profile-unsaved">聊天室規則尚未儲存；按「儲存聊天室規則」後才會生效。</div>}
          <div className="chat-profile-assist"><label className="set-field"><span className="set-label">AI 幫改需求</span><input className="set-input" aria-label="改善需求" value={assistGoal} maxLength={2000} disabled={assistBusy} onChange={e => setAssistGoal(e.target.value)} /></label><button className="btn" type="button" disabled={profileBusy || assistBusy || !assistGoal.trim()} onClick={() => void suggestRule()}>{assistBusy ? '處理中…' : 'AI 幫改'}</button>{assistBusy && <button className="btn" type="button" onClick={cancelSuggestion}>取消</button>}</div>
          <div className="set-inline"><button className="btn" type="button" disabled={profileBusy || staleProfileDraft || discardingProfileDraft || !profileDirty || Boolean(editorWarning)} onClick={() => void saveProfile()}>儲存</button></div>
          <details open={advanced} onToggle={e => setAdvanced(e.currentTarget.open)}><summary>進階／舊設定相容</summary>
            <p>聊天室類型：{profile.chatKind === 'group' ? '群組' : profile.chatKind === 'non_group' ? '非群組' : '未知'}；待辦來源：{profile.todo.source}；議題來源：{profile.topic.source}</p>
            <label className="set-field"><span className="set-label">舊待辦全文</span><textarea className="set-input" aria-label="進階待辦規則" rows={4} value={todoDraft} onChange={e => setTodoDraft(e.target.value)} /></label><label className="set-field"><span className="set-label">舊議題全文</span><textarea className="set-input" aria-label="進階議題規則" rows={4} value={topicDraft} onChange={e => setTopicDraft(e.target.value)} /></label><button className="btn" type="button" onClick={() => { if (profileDirty) setConfirmProfileReload(true); else discardProfileDraftAndReload() }}>重新載入</button>
            {confirmProfileReload && <div className="set-msg warn" role="alert" data-testid="chat-profile-reload-confirm">重新載入會丟棄尚未儲存的聊天室規則草稿。<div className="set-inline"><button className="btn" type="button" disabled={profileBusy} onClick={() => { setDiscardingProfileDraft(false); setConfirmProfileReload(false) }}>保留未儲存草稿</button><button className="btn" type="button" disabled={profileBusy} onClick={discardProfileDraftAndReload}>丟棄草稿並重新載入</button></div></div>}
            {state && <div className="chat-legacy-settings"><div className="set-section">
              {state.corrupt && <div className="set-msg warn" role="alert" data-testid="chat-prompt-corrupt">這個對話的個別設定已損毀，目前改用預設值。<button className="btn" type="button" disabled={locked} data-testid="chat-prompt-restore-corrupt" onClick={() => void persist(current => control.reset(chatId, current.revision), '已恢復沿用預設。')}>恢復沿用預設</button></div>}
              <label className="set-field"><span className="set-label">我在這個對話的名字</span><input data-testid="chat-prompt-name" className="set-input" type="text" maxLength={state.maxNameChars} placeholder={state.defaultName ?? '未設定'} value={nameDraft} disabled={locked} onChange={event => setNameDraft(event.target.value)} /><span className="muted" data-testid="chat-prompt-name-source">{state.overrideName !== null ? '此對話自訂' : state.defaultName !== null ? `沿用預設：${state.defaultName}` : '沿用預設：未設定'}</span></label>
              <div className="set-field"><span className="set-label">抽取 Prompt</span>{!editing ? <div className="set-inline"><span data-testid="chat-prompt-source">沿用預設</span><button className="btn" type="button" disabled={locked} data-testid="customize-chat-prompt" onClick={() => setEditing(true)}>自訂此對話的 Prompt</button></div> : <><div className="set-msg muted">此對話使用專屬 Prompt，不受預設變更影響。</div><textarea aria-label="此對話的抽取 Prompt" data-testid="chat-prompt-text" className="set-input" rows={14} maxLength={state.maxChars} value={promptDraft} disabled={locked} onChange={event => setPromptDraft(event.target.value)} style={{ width: '100%', resize: 'vertical' }} /><span className="muted">{promptDraft.length} / {state.maxChars} 字元</span><div className="set-inline"><button className="btn" type="button" disabled={locked} data-testid="restore-default-chat-prompt" onClick={() => { setEditing(false); setPromptDraft(state.effectivePrompt); setMessage('已改回沿用預設 Prompt，按「儲存」後生效。') }}>恢復沿用預設 Prompt</button></div></>}</div>
              <div className="set-inline"><button className="btn" type="button" disabled={locked || !dirty} data-testid="save-chat-prompt" onClick={() => void persist(current => control.save(chatId, { prompt: payloadPrompt, myName: payloadName }, current.revision), '已儲存，這個對話的下一項抽取工作會使用新設定。')}>儲存</button><button className="btn" type="button" disabled={locked || !hasOverride} data-testid="reset-chat-prompt" onClick={() => void persist(current => control.reset(chatId, current.revision), '已恢復全部沿用預設。')}>恢復全部沿用預設</button><button className="btn" type="button" disabled={busy === 'saving'} data-testid="reload-chat-prompt" onClick={() => void load()}>重新載入</button></div>
              <div className="muted set-hint" data-testid="chat-prompt-defaults-hint">{defaultsInSettingsHint(caps.settingsTab)}</div>
            </div></div>}
          </details>
        </>}
      </section>}
      {busy === 'loading' && <div className="muted" role="status">正在載入…</div>}
      {!state && busy === null && <button className="btn" type="button" data-testid="reload-chat-prompt" onClick={() => void load()}>重新載入</button>}
    </section>
  )
}
