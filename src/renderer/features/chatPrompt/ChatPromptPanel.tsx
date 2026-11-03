import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatPromptControl, ChatPromptState } from '../../../shared/promptSettings'
import { defaultsInSettingsHint } from '../../../shared/teamuqPlaces'
import { useHostCapabilities } from '../../platform/LineTodoApi'

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

/** 看板聊天室窗格的「AI 設定」分頁：這個對話自己的「我的名字」與抽取 Prompt。沒有自訂時只顯示摘要，Prompt 編輯器按需展開。 */
export function ChatPromptPanel({ chatId, chatName, control, onChanged }: Props): JSX.Element {
  const caps = useHostCapabilities()
  const [state, setState] = useState<ChatPromptState | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [promptDraft, setPromptDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<'loading' | 'saving' | null>('loading')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
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

  const persist = async (run: (current: ChatPromptState) => Promise<ChatPromptState>, done: string): Promise<void> => {
    if (!state) return
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
      {busy === 'loading' && <div className="muted" role="status">正在載入…</div>}
      {state && (
        <div className="set-section">
          {state.corrupt && (
            <div className="set-msg warn" role="alert" data-testid="chat-prompt-corrupt">
              這個對話的個別設定已損毀，目前改用預設值。
              <button className="btn" type="button" disabled={locked} data-testid="chat-prompt-restore-corrupt" onClick={() => void persist((current) => control.reset(chatId, current.revision), '已恢復沿用預設。')}>恢復沿用預設</button>
            </div>
          )}
          <div className="set-field">
            <label className="set-label" htmlFor="chat-prompt-name">我在這個對話的名字</label>
            <input id="chat-prompt-name" data-testid="chat-prompt-name" className="set-input" type="text" maxLength={state.maxNameChars}
              placeholder={state.defaultName ?? '未設定'} value={nameDraft} disabled={locked} onChange={(event) => setNameDraft(event.target.value)} />
            <span className="muted" data-testid="chat-prompt-name-source">{state.overrideName !== null ? '此對話自訂' : state.defaultName !== null ? `沿用預設：${state.defaultName}` : '沿用預設：未設定'}</span>
          </div>
          <div className="set-field">
            <span className="set-label">抽取 Prompt</span>
            {!editing ? (
              <div className="set-inline">
                <span data-testid="chat-prompt-source">沿用預設</span>
                <button className="btn" type="button" disabled={locked} data-testid="customize-chat-prompt" onClick={() => setEditing(true)}>自訂此對話的 Prompt</button>
              </div>
            ) : (
              <>
                <div className="set-msg muted">此對話使用專屬 Prompt，不受預設變更影響。</div>
                <textarea aria-label="此對話的抽取 Prompt" data-testid="chat-prompt-text" className="set-input" rows={14} maxLength={state.maxChars} value={promptDraft} disabled={locked}
                  onChange={(event) => setPromptDraft(event.target.value)} style={{ width: '100%', resize: 'vertical' }} />
                <span className="muted">{promptDraft.length} / {state.maxChars} 字元</span>
                <div className="set-inline">
                  <button className="btn" type="button" disabled={locked} data-testid="restore-default-chat-prompt" onClick={() => { setEditing(false); setPromptDraft(state.effectivePrompt); setMessage('已改回沿用預設 Prompt，按「儲存」後生效。') }}>恢復沿用預設 Prompt</button>
                </div>
              </>
            )}
          </div>
          <div className="set-inline">
            <button className="btn" type="button" disabled={locked || !dirty} data-testid="save-chat-prompt"
              onClick={() => void persist((current) => control.save(chatId, { prompt: payloadPrompt, myName: payloadName }, current.revision), '已儲存，這個對話的下一項抽取工作會使用新設定。')}>儲存</button>
            <button className="btn" type="button" disabled={locked || !hasOverride} data-testid="reset-chat-prompt"
              onClick={() => void persist((current) => control.reset(chatId, current.revision), '已恢復全部沿用預設。')}>恢復全部沿用預設</button>
            <button className="btn" type="button" disabled={busy === 'saving'} data-testid="reload-chat-prompt" onClick={() => void load()}>重新載入</button>
          </div>
          <div className="muted set-hint" data-testid="chat-prompt-defaults-hint">{defaultsInSettingsHint(caps.settingsTab)}</div>
        </div>
      )}
      {!state && busy === null && <button className="btn" type="button" data-testid="reload-chat-prompt" onClick={() => void load()}>重新載入</button>}
    </section>
  )
}
