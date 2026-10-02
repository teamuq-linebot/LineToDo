import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { TodoDTO } from '../../types/api'
import type { CompleteTodoRegistry, CompleteTodoResult } from '../../store/completeTodo'
import { SourceMessagesModal } from './SourceMessagesModal'
import {
  isSuggestedDone,
  priorityLabel,
  fmtDue,
  isOverdue
} from './buckets'
import type { CardDnd } from './KanbanBoard'
import { useHostCapabilities } from '../../platform/LineTodoApi'
import { undoInSettingsHint } from '../../../shared/teamuqPlaces'
// 未儲存的編輯／關鍵字草稿保留多久（G-04：重新開啟畫面後還原；太舊的就丟掉）：7 天，定義在 uiState.ts 的 UI_DRAFT_RETENTION，
// 看板啟動時與開著的期間每小時也會主動清掉過期的（review N1）。
import { CARD_DRAFT_MAX_AGE_MS, useUiState } from '../../lib/uiState'

interface EditDraft { title: string; detail: string; bucket: TodoDTO['bucket']; priority: number; due: string }

function parseEditDraft(raw: unknown): EditDraft | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const d = raw as Record<string, unknown>
  if (typeof d.title !== 'string' || typeof d.detail !== 'string' || typeof d.due !== 'string' || typeof d.priority !== 'number') return undefined
  if (d.bucket !== 'todo' && d.bucket !== 'waiting' && d.bucket !== 'schedule') return undefined
  if (d.title.length > 2000 || d.detail.length > 20000 || d.due.length > 40) return undefined
  return { title: d.title, detail: d.detail, bucket: d.bucket, priority: d.priority, due: d.due }
}

const parseKwDraft = (raw: unknown): string | undefined => (typeof raw === 'string' && raw.length <= 200 ? raw : undefined)

/**
 * TodoCard — 單張代辦卡（IMPLEMENTATION_PLAN.md M3）。
 *
 * 顯示：標題、對象（聊天室）、到期、來源訊息片段（可展開）、信心/優先級徽章。
 * 動作：一個主要按鈕 + 「更多 ▾」收納選單（次要動作全部結合在內）。
 *   - 進行中：主要「完成」；更多＝開原聊天 / 草擬回覆 / 延後 / 編輯 / 忽略。
 *   - status='suggested_done'（建議完成）：主要「確認完成 / 還沒」；更多＝編輯 / 忽略。
 *   - status='done'（已完成）：唯讀 + 完成證據 + 「復原 / 編輯」。
 */

export interface TodoCardActions {
  onComplete: (id: string, onWriteConfirmed?: () => void) => Promise<CompleteTodoResult>
  onConfirmDone: (id: string, onWriteConfirmed?: () => void) => Promise<CompleteTodoResult>
  completion: CompleteTodoRegistry
  onRefresh: () => Promise<boolean>
  onRejectSuggested: (todo: TodoDTO) => Promise<void>
  onIgnore: (id: string) => Promise<void>
  onMarkNotMine: (todo: TodoDTO) => Promise<unknown>
  /** 依關鍵字忽略（此對話）：加關鍵字並立即忽略命中的未完成代辦。 */
  onIgnoreByKeyword: (chatId: string, keyword: string) => Promise<number>
  /** 封鎖這個對話：不再抽代辦 + 清掉現有未完成代辦。 */
  onBlockChat: (chatId: string) => Promise<number>
  onSnooze: (todo: TodoDTO, hours: number) => Promise<void>
  onReopen: (todo: TodoDTO) => Promise<void>
  onOpenChat: (chatId: string) => Promise<{ ok: boolean; error?: string }>
  onDraftReply: (todo: TodoDTO) => void
  /** 手動編輯：把使用者改好的欄位寫回（呼叫端負責 update + 刷新看板）。 */
  onEdit: (id: string, patch: TodoEditPatch, onWriteConfirmed?: () => void) => Promise<CompleteTodoResult>
  /** 本機 session 的檢視標記，不代表 LINE 已讀狀態。 */
  onSetViewedLocal: (id: string, viewed: boolean) => void
}

/** 卡片可手動編輯的欄位。 */
export interface TodoEditPatch {
  title: string
  detail: string | null
  bucket: TodoDTO['bucket']
  priority: number
  dueAt: string | null
}

const BUCKET_OPTIONS: { value: TodoDTO['bucket']; label: string }[] = [
  { value: 'todo', label: '待辦' },
  { value: 'waiting', label: '等回覆' },
  { value: 'schedule', label: '行程' }
]

const PRIORITY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '高' },
  { value: 2, label: '中' },
  { value: 3, label: '低' }
]

/**
 * ISO（後端本地秒精度、無 tz）↔ <input type="datetime-local"> 值（YYYY-MM-DDTHH:mm）互轉。
 * 直接切字串，避免 new Date 的時區搬移。
 */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return ''
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`
  const dOnly = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (dOnly) return `${dOnly[1]}-${dOnly[2]}-${dOnly[3]}T00:00`
  return ''
}

/** datetime-local 值 → 後端風格 ISO（補秒，無 tz）。空字串 → null（清空到期）。 */
function localInputToIso(val: string): string | null {
  if (!val.trim()) return null
  const m = val.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`
}

interface Props {
  todo: TodoDTO
  chatName: string | null
  isGroup: boolean
  viewedLocally: boolean
  /** 是否顯示「未檢視 locally」相關視覺（pill 鈕與卡片左側藍條）。僅「已完成」欄為 true。 */
  showLocalViewed?: boolean
  actions: TodoCardActions
  dnd: CardDnd
}

/**
 * OverflowMenu — 卡片次要動作的「更多 ▾」收納選單。
 *
 * - fixed 定位（依觸發鈕 getBoundingClientRect 計算），不會被欄位 overflow 裁掉；
 *   下方空間不足時自動往上開。
 * - 關閉：點選任一項（事件冒泡到 .menu-pop）或點半透明 backdrop。
 */
function OverflowMenu({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  function toggle(): void {
    if (open) {
      setOpen(false)
      return
    }
    const el = triggerRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      const MENU_W = 168
      const gap = 4
      const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8))
      const spaceBelow = window.innerHeight - r.bottom
      setPos(
        spaceBelow < 260
          ? { bottom: window.innerHeight - r.top + gap, left } // 下方不夠 → 往上開
          : { top: r.bottom + gap, left }
      )
    }
    setOpen(true)
  }

  return (
    <div className="card-menu">
      <button
        ref={triggerRef}
        className="ghost menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title="更多動作"
        onClick={toggle}
      >
        更多 ▾
      </button>
      {open && pos && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          {/* 點選單內任一按鈕後關閉（onClick 冒泡到此） */}
          <div
            className="menu-pop"
            role="menu"
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left }}
            onClick={() => setOpen(false)}
          >
            {children}
          </div>
        </>
      )}
    </div>
  )
}

export function TodoCard({
  todo,
  chatName,
  isGroup,
  viewedLocally,
  showLocalViewed = false,
  actions,
  dnd
}: Props): JSX.Element {
  const [showSources, setShowSources] = useState(false)
  const caps = useHostCapabilities()
  const subscribeCompletion = useCallback(
    (listener: () => void) => actions.completion.subscribe(todo.id, listener),
    [actions.completion, todo.id]
  )
  const getCompletionSnapshot = useCallback(
    () => actions.completion.getSnapshot(todo.id),
    [actions.completion, todo.id]
  )
  const completeUi = useSyncExternalStore(subscribeCompletion, getCompletionSnapshot, getCompletionSnapshot)
  const [cardActionUi, setCardActionUi] = useState<
    | null
    | { phase: 'pending'; label: string }
    | { phase: 'error'; label: string; message: string }
  >(null)
  // G-04：未儲存的編輯表單與「依關鍵字忽略」輸入存成草稿（外掛版；standalone 的 store 不保存），卡片重新出現時還原。
  const ui = useUiState()
  const editDraftKey = `card.edit.${todo.id}`
  const kwDraftKey = `card.kw.${todo.id}`
  const [restored] = useState(() => ({
    edit: ui.read(editDraftKey, parseEditDraft, { maxAgeMs: CARD_DRAFT_MAX_AGE_MS }),
    kw: ui.read(kwDraftKey, parseKwDraft, { maxAgeMs: CARD_DRAFT_MAX_AGE_MS })
  }))

  // 「依關鍵字忽略」inline 表單狀態。
  const [kwMode, setKwMode] = useState(restored.kw !== undefined)
  const [kwText, setKwText] = useState(restored.kw ?? '')

  // 編輯模式狀態（草稿欄位 + 驗證錯誤）。
  const [editing, setEditing] = useState(restored.edit !== undefined)
  const [eTitle, setETitle] = useState(restored.edit?.title ?? todo.title)
  const [eDetail, setEDetail] = useState(restored.edit?.detail ?? todo.detail ?? '')
  const [eBucket, setEBucket] = useState<TodoDTO['bucket']>(restored.edit?.bucket ?? todo.bucket)
  const [ePriority, setEPriority] = useState<number>(restored.edit?.priority ?? todo.priority)
  const [eDue, setEDue] = useState<string>(restored.edit?.due ?? isoToLocalInput(todo.dueAt))

  // 輸入一改變就保存；表單關閉（儲存成功或取消）就刪掉草稿。
  useEffect(() => {
    if (editing) ui.write(editDraftKey, { title: eTitle, detail: eDetail, bucket: eBucket, priority: ePriority, due: eDue })
    else ui.remove(editDraftKey)
  }, [ui, editDraftKey, editing, eTitle, eDetail, eBucket, ePriority, eDue])
  useEffect(() => {
    if (kwMode) ui.write(kwDraftKey, kwText)
    else ui.remove(kwDraftKey)
  }, [ui, kwDraftKey, kwMode, kwText])
  const [editErr, setEditErr] = useState<string | null>(null)
  const [editPhase, setEditPhase] = useState<'idle' | 'writing' | 'refreshing' | 'refresh-error'>('idle')
  const editInFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const editBusy = editPhase === 'writing' || editPhase === 'refreshing'
  const editLocked = editBusy || editPhase === 'refresh-error'

  function startEdit(): void {
    // Reopening a cancelled form must not forget a write still awaiting reply.
    if (editInFlight.current || editErr !== null || editPhase === 'refresh-error') {
      setEditing(true)
      return
    }
    setETitle(todo.title)
    setEDetail(todo.detail ?? '')
    setEBucket(todo.bucket)
    setEPriority(todo.priority)
    setEDue(isoToLocalInput(todo.dueAt))
    setEditErr(null)
    setEditing(true)
  }

  async function saveEdit(): Promise<void> {
    if (editInFlight.current || editPhase === 'refresh-error') return
    const title = eTitle.trim()
    // 前端驗證：title 非空、bucket/priority 在列舉內、dueAt 合法 ISO 或 null。
    if (!title) {
      setEditErr('標題不可為空')
      return
    }
    if (!BUCKET_OPTIONS.some((o) => o.value === eBucket)) {
      setEditErr('分類不合法')
      return
    }
    if (!PRIORITY_OPTIONS.some((o) => o.value === ePriority)) {
      setEditErr('優先級不合法')
      return
    }
    let dueAt: string | null = null
    if (eDue.trim()) {
      dueAt = localInputToIso(eDue)
      if (dueAt === null || Number.isNaN(Date.parse(dueAt))) {
        setEditErr('到期時間格式不正確')
        return
      }
    }
    editInFlight.current = true
    setEditErr(null)
    setEditPhase('writing')
    try {
      const result = await actions.onEdit(todo.id, {
        title,
        detail: eDetail.trim() ? eDetail : null,
        bucket: eBucket,
        priority: ePriority,
        dueAt
      }, () => {
        if (mounted.current) setEditPhase('refreshing')
      })
      if (!mounted.current) return
      if (result.write === 'failed') {
        setEditPhase('idle')
        setEditErr(`儲存失敗：${result.error}`)
      } else if (result.refresh === 'failed') {
        setEditPhase('refresh-error')
        setEditErr(`編輯已儲存；看板更新失敗：${result.error}`)
      } else {
        setEditPhase('idle')
        setEditing(false)
      }
    } catch (error) {
      if (mounted.current) {
        setEditPhase('idle')
        setEditErr(`儲存失敗：${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      editInFlight.current = false
    }
  }

  async function retryEditRefresh(): Promise<void> {
    if (editInFlight.current || editPhase !== 'refresh-error') return
    editInFlight.current = true
    setEditPhase('refreshing')
    try {
      const refreshed = await actions.onRefresh()
      if (!mounted.current) return
      if (refreshed) {
        setEditPhase('idle')
        setEditErr(null)
        setEditing(false)
      } else {
        setEditPhase('refresh-error')
        setEditErr('編輯已儲存；看板更新失敗，請重試同步')
      }
    } catch (error) {
      if (mounted.current) {
        setEditPhase('refresh-error')
        setEditErr(`編輯已儲存；看板更新失敗：${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      editInFlight.current = false
    }
  }

  function startKwIgnore(): void {
    setKwText('')
    setKwMode(true)
  }

  async function confirmKw(): Promise<void> {
    const kw = kwText.trim()
    if (!kw) return
    if (await runCardAction('依關鍵字忽略', () => actions.onIgnoreByKeyword(todo.chatId, kw))) setKwMode(false)
  }

  function blockChatConfirm(): void {
    const label = chatName ?? todo.chatId
    if (
      window.confirm(
        `封鎖「${label}」？\n之後不再從這個對話抽代辦，並會清掉它目前的未完成代辦${undoInSettingsHint(caps.settingsTab)}。`
      )
    ) {
      void runCardAction('封鎖這個對話', () => actions.onBlockChat(todo.chatId))
    }
  }

  const suggested = isSuggestedDone(todo)
  const done = todo.status === 'done'
  const prio = priorityLabel(todo.priority)
  const due = fmtDue(todo.dueAt)
  const overdue = !done && isOverdue(todo.dueAt)

  async function completeTodo(confirmSuggested: boolean): Promise<void> {
    await (confirmSuggested ? actions.onConfirmDone(todo.id) : actions.onComplete(todo.id))
  }

  async function retryBoardRefresh(): Promise<void> {
    await actions.onComplete(todo.id)
  }

  async function runCardAction(label: string, action: () => Promise<unknown>): Promise<boolean> {
    if (cardActionUi?.phase === 'pending') return false
    setCardActionUi({ phase: 'pending', label })
    try {
      const result = await action()
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        throw new Error('error' in result && typeof result.error === 'string' ? result.error : '操作失敗')
      }
      setCardActionUi(null)
      return true
    } catch (err) {
      setCardActionUi({ phase: 'error', label, message: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  const cls = ['todo-card']
  if (suggested) cls.push('suggested')
  if (done) cls.push('done')
  if (overdue) cls.push('overdue')
  if (showLocalViewed && !viewedLocally) cls.push('local-unviewed')
  if (dnd.dragging) cls.push('dragging')

  if (editing) {
    return (
      <div className={cls.join(' ') + ' editing'}>
        <div className="edit-form">
          <label className="edit-field">
            <span className="edit-label">標題</span>
            <input
              className="edit-input"
              disabled={editLocked}
              value={eTitle}
              onChange={(e) => setETitle(e.target.value)}
              placeholder="代辦標題"
            />
          </label>

          <label className="edit-field">
            <span className="edit-label">備註</span>
            <textarea
              className="edit-input edit-textarea"
              disabled={editLocked}
              value={eDetail}
              onChange={(e) => setEDetail(e.target.value)}
              placeholder="補充說明（可留空）"
            />
          </label>

          <div className="edit-row">
            <label className="edit-field">
              <span className="edit-label">分類</span>
              <select
                className="edit-input"
                disabled={editLocked}
                value={eBucket}
                onChange={(e) => setEBucket(e.target.value as TodoDTO['bucket'])}
              >
                {BUCKET_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="edit-field">
              <span className="edit-label">優先級</span>
              <select
                className="edit-input"
                disabled={editLocked}
                value={ePriority}
                onChange={(e) => setEPriority(Number(e.target.value))}
              >
                {PRIORITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="edit-field">
            <span className="edit-label">到期</span>
            <div className="edit-due-row">
              <input
                type="datetime-local"
                className="edit-input"
                disabled={editLocked}
                value={eDue}
                onChange={(e) => setEDue(e.target.value)}
              />
              {eDue && (
                <button className="link-btn" type="button" disabled={editLocked} onClick={() => setEDue('')}>
                  清除
                </button>
              )}
            </div>
          </label>

          {editErr && <div className="edit-err txt-err">{editErr}</div>}
          {editBusy && <div role="status">{editPhase === 'writing' ? '儲存中…' : '編輯已儲存，正在更新看板…'}</div>}

          <div className="edit-actions">
            {editPhase === 'refresh-error' ? (
              <button className="ok-btn" type="button" onClick={() => void retryEditRefresh()}>重試同步</button>
            ) : (
              <button className="ok-btn" type="button" disabled={editBusy} onClick={() => void saveEdit()}>
                {editPhase === 'writing' ? '儲存中…' : editPhase === 'refreshing' ? '更新中…' : '儲存'}
              </button>
            )}
            <button className="ghost" type="button" onClick={() => { if (!editLocked) setEditErr(null); setEditing(false) }}>
              {editLocked ? '收起' : '取消'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cls.join(' ')}
      draggable={!showSources}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', todo.id)
        e.dataTransfer.effectAllowed = 'move'
        dnd.onDragStart(todo.id)
      }}
      onDragEnd={() => dnd.onDragEnd()}
    >
      <div className="card-top">
        <span className={`prio-badge ${prio.cls}`} title="優先級">
          {prio.text}
        </span>
        <span className="card-title">{todo.title}</span>
      </div>

      <div className="card-meta">
        <span className="card-chat" title={todo.chatId}>
          {isGroup ? '👥 ' : '💬 '}
          {chatName ?? todo.chatId}
        </span>
        {due && (
          <span className={`card-due ${overdue ? 'overdue' : ''}`} title={todo.dueAt ?? ''}>
            🕑 {due}
            {overdue ? ' (已過)' : ''}
          </span>
        )}
        <span className="card-conf" title="抽取信心">
          {Math.round(todo.confidence * 100)}%
        </span>
        {showLocalViewed && (
          <button
            className={`local-view-btn ${viewedLocally ? 'viewed' : 'unviewed'}`}
            type="button"
            title="本機 session 標記，不代表 LINE 已讀"
            onClick={() => actions.onSetViewedLocal(todo.id, !viewedLocally)}
          >
            {viewedLocally ? '已讀' : '未讀'}
          </button>
        )}
      </div>

      {todo.detail && <div className="card-detail">{todo.detail}</div>}

      {suggested && todo.completionEvidence && (
        <div className="card-evidence" title="完成偵測依據">
          建議完成依據：{todo.completionEvidence}
        </div>
      )}
      {done && todo.completionEvidence && (
        <div className="card-evidence" title="完成證據">
          完成證據：{todo.completionEvidence}
        </div>
      )}

      <div className="card-source">
        <button className="link-btn" onClick={() => setShowSources(true)}>
          來源訊息 ({todo.sourceMsgIds.length})
        </button>
        {showSources && (
          <SourceMessagesModal
            key={`${todo.id}:${todo.chatId}`}
            chatId={todo.chatId}
            chatName={chatName}
            sourceMsgIds={todo.sourceMsgIds}
            onClose={() => setShowSources(false)}
          />
        )}
      </div>

      {completeUi?.phase === 'writing' && <div className="review-note" role="status">正在儲存完成狀態…</div>}
      {completeUi?.phase === 'refreshing' && <div className="review-note" role="status">完成狀態已寫入，正在更新看板…</div>}
      {completeUi?.phase === 'write-error' && <div className="txt-err" role="alert">完成失敗：{completeUi.message}</div>}
      {completeUi?.phase === 'refresh-error' && (
        <div className="txt-warn" role="status">
          已寫入完成；看板更新失敗：{completeUi.message}{' '}
          <button type="button" className="link-btn" onClick={() => void retryBoardRefresh()}>重試同步</button>
        </div>
      )}
      {cardActionUi?.phase === 'pending' && <div className="review-note" role="status">{cardActionUi.label}處理中…</div>}
      {cardActionUi?.phase === 'error' && <div className="txt-err" role="alert">{cardActionUi.label}失敗：{cardActionUi.message}</div>}
      {editBusy && <div className="review-note" role="status">{editPhase === 'writing' ? '編輯儲存中…' : '編輯已儲存，正在更新看板…'}</div>}
      {editErr && <div className="txt-err" role="alert">{editErr}</div>}
      {editPhase === 'refresh-error' && <button type="button" className="link-btn" onClick={() => void retryEditRefresh()}>重試同步</button>}

      {/* 動作列：主要動作 + 「更多 ▾」收納次要動作；kwMode 時改顯示關鍵字忽略表單 */}
      {kwMode ? (
        <div className="kw-ignore-form">
          <span className="edit-label">
            在「{chatName ?? todo.chatId}」中，忽略含此關鍵字的代辦：
          </span>
          <div className="edit-due-row">
            <input
              className="edit-input"
              value={kwText}
              onChange={(e) => setKwText(e.target.value)}
              placeholder="輸入要忽略的關鍵字"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmKw()
                if (e.key === 'Escape') setKwMode(false)
              }}
            />
            <button className="ok-btn" type="button" onClick={() => void confirmKw()} disabled={!kwText.trim()}>
              忽略
            </button>
            <button className="ghost" type="button" onClick={() => setKwMode(false)}>
              取消
            </button>
          </div>
          <span className="muted kw-ignore-hint">
            之後這個對話新抽到、標題或備註含此詞的代辦會自動忽略{undoInSettingsHint(caps.settingsTab)}。
          </span>
        </div>
      ) : (
        <div className="card-actions">
          {done ? (
            <>
              <button className="ghost" onClick={() => void runCardAction('復原', () => actions.onReopen(todo))}>
                ↩ 復原
              </button>
              <button className="ghost" onClick={startEdit}>
                ✏️ 編輯
              </button>
            </>
          ) : suggested ? (
            <>
              <button className="ok-btn" disabled={completeUi?.phase === 'writing' || completeUi?.phase === 'refreshing'} onClick={() => void completeTodo(true)}>
                {completeUi?.phase === 'writing' ? '儲存中…' : '✓ 確認完成'}
              </button>
              <button className="ghost" onClick={() => void runCardAction('退回待確認', () => actions.onRejectSuggested(todo))}>
                還沒
              </button>
              <OverflowMenu>
                <button className="menu-item" onClick={startEdit}>
                  ✏️ 編輯
                </button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => void runCardAction('忽略這一筆', () => actions.onIgnore(todo.id))}>
                  🚫 忽略這一筆
                </button>
                <button className="menu-item" onClick={() => void runCardAction('標記不是我的', () => actions.onMarkNotMine(todo))}>不是我的（保留來源）</button>
                <button className="menu-item" onClick={startKwIgnore}>
                  🔑 依關鍵字忽略…
                </button>
                <button className="menu-item danger" onClick={blockChatConfirm}>
                  ⛔ 封鎖這個對話
                </button>
              </OverflowMenu>
            </>
          ) : (
            <>
              <button className="ok-btn" disabled={completeUi?.phase === 'writing' || completeUi?.phase === 'refreshing'} onClick={() => void completeTodo(false)}>
                {completeUi?.phase === 'writing' ? '儲存中…' : '✓ 完成'}
              </button>
              <OverflowMenu>
                {caps.openOriginalChat && (
                  <button className="menu-item" onClick={() => void runCardAction('開原聊天', () => actions.onOpenChat(todo.chatId))}>
                    💬 開原聊天
                  </button>
                )}
                <button className="menu-item" onClick={() => actions.onDraftReply(todo)}>
                  ✍️ 草擬回覆
                </button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => void runCardAction('延後 1 小時', () => actions.onSnooze(todo, 1))}>
                  ⏰ 延後 1 小時
                </button>
                <button className="menu-item" onClick={() => void runCardAction('延後 3 小時', () => actions.onSnooze(todo, 3))}>
                  ⏰ 延後 3 小時
                </button>
                <button className="menu-item" onClick={() => void runCardAction('延後到明天', () => actions.onSnooze(todo, 24))}>
                  ⏰ 延後到明天
                </button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={startEdit}>
                  ✏️ 編輯
                </button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => void runCardAction('忽略這一筆', () => actions.onIgnore(todo.id))}>
                  🚫 忽略這一筆
                </button>
                <button className="menu-item" onClick={() => void runCardAction('標記不是我的', () => actions.onMarkNotMine(todo))}>不是我的（保留來源）</button>
                <button className="menu-item" onClick={startKwIgnore}>
                  🔑 依關鍵字忽略…
                </button>
                <button className="menu-item danger" onClick={blockChatConfirm}>
                  ⛔ 封鎖這個對話
                </button>
              </OverflowMenu>
            </>
          )}
        </div>
      )}
    </div>
  )
}
