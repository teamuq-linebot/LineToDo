import { useRef, useState, type ReactNode } from 'react'
import type { TodoDTO } from '../../types/api'
import { SourceMessagesModal } from './SourceMessagesModal'
import {
  isSuggestedDone,
  priorityLabel,
  fmtDue,
  isOverdue
} from './buckets'
import type { CardDnd } from './KanbanBoard'

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
  onComplete: (id: string) => void
  onConfirmDone: (id: string) => void
  onRejectSuggested: (todo: TodoDTO) => void
  onIgnore: (id: string) => void
  /** 依關鍵字忽略（此對話）：加關鍵字並立即忽略命中的未完成代辦。 */
  onIgnoreByKeyword: (chatId: string, keyword: string) => void
  /** 封鎖這個對話：不再抽代辦 + 清掉現有未完成代辦。 */
  onBlockChat: (chatId: string) => void
  onSnooze: (todo: TodoDTO, hours: number) => void
  onReopen: (todo: TodoDTO) => void
  onOpenChat: (chatId: string) => void
  onDraftReply: (todo: TodoDTO) => void
  /** 手動編輯：把使用者改好的欄位寫回（呼叫端負責 update + 刷新看板）。 */
  onEdit: (id: string, patch: TodoEditPatch) => void
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
  // 「依關鍵字忽略」inline 表單狀態。
  const [kwMode, setKwMode] = useState(false)
  const [kwText, setKwText] = useState('')

  // 編輯模式狀態（草稿欄位 + 驗證錯誤）。
  const [editing, setEditing] = useState(false)
  const [eTitle, setETitle] = useState(todo.title)
  const [eDetail, setEDetail] = useState(todo.detail ?? '')
  const [eBucket, setEBucket] = useState<TodoDTO['bucket']>(todo.bucket)
  const [ePriority, setEPriority] = useState<number>(todo.priority)
  const [eDue, setEDue] = useState<string>(isoToLocalInput(todo.dueAt))
  const [editErr, setEditErr] = useState<string | null>(null)

  function startEdit(): void {
    setETitle(todo.title)
    setEDetail(todo.detail ?? '')
    setEBucket(todo.bucket)
    setEPriority(todo.priority)
    setEDue(isoToLocalInput(todo.dueAt))
    setEditErr(null)
    setEditing(true)
  }

  function saveEdit(): void {
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
    actions.onEdit(todo.id, {
      title,
      detail: eDetail.trim() ? eDetail : null,
      bucket: eBucket,
      priority: ePriority,
      dueAt
    })
    setEditing(false)
  }

  function startKwIgnore(): void {
    setKwText('')
    setKwMode(true)
  }

  function confirmKw(): void {
    const kw = kwText.trim()
    if (!kw) return
    actions.onIgnoreByKeyword(todo.chatId, kw)
    setKwMode(false)
  }

  function blockChatConfirm(): void {
    const label = chatName ?? todo.chatId
    if (
      window.confirm(
        `封鎖「${label}」？\n之後不再從這個對話抽代辦，並會清掉它目前的未完成代辦（可到設定頁解除）。`
      )
    ) {
      actions.onBlockChat(todo.chatId)
    }
  }

  const suggested = isSuggestedDone(todo)
  const done = todo.status === 'done'
  const prio = priorityLabel(todo.priority)
  const due = fmtDue(todo.dueAt)
  const overdue = !done && isOverdue(todo.dueAt)

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
              value={eTitle}
              onChange={(e) => setETitle(e.target.value)}
              placeholder="代辦標題"
            />
          </label>

          <label className="edit-field">
            <span className="edit-label">備註</span>
            <textarea
              className="edit-input edit-textarea"
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
                value={eDue}
                onChange={(e) => setEDue(e.target.value)}
              />
              {eDue && (
                <button className="link-btn" type="button" onClick={() => setEDue('')}>
                  清除
                </button>
              )}
            </div>
          </label>

          {editErr && <div className="edit-err txt-err">{editErr}</div>}

          <div className="edit-actions">
            <button className="ok-btn" type="button" onClick={saveEdit}>
              儲存
            </button>
            <button className="ghost" type="button" onClick={() => setEditing(false)}>
              取消
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
            chatId={todo.chatId}
            chatName={chatName}
            sourceMsgIds={todo.sourceMsgIds}
            onClose={() => setShowSources(false)}
          />
        )}
      </div>

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
                if (e.key === 'Enter') confirmKw()
                if (e.key === 'Escape') setKwMode(false)
              }}
            />
            <button className="ok-btn" type="button" onClick={confirmKw} disabled={!kwText.trim()}>
              忽略
            </button>
            <button className="ghost" type="button" onClick={() => setKwMode(false)}>
              取消
            </button>
          </div>
          <span className="muted kw-ignore-hint">
            之後這個對話新抽到、標題或備註含此詞的代辦會自動忽略（可到設定頁解除）。
          </span>
        </div>
      ) : (
        <div className="card-actions">
          {done ? (
            <>
              <button className="ghost" onClick={() => actions.onReopen(todo)}>
                ↩ 復原
              </button>
              <button className="ghost" onClick={startEdit}>
                ✏️ 編輯
              </button>
            </>
          ) : suggested ? (
            <>
              <button className="ok-btn" onClick={() => actions.onConfirmDone(todo.id)}>
                ✓ 確認完成
              </button>
              <button className="ghost" onClick={() => actions.onRejectSuggested(todo)}>
                還沒
              </button>
              <OverflowMenu>
                <button className="menu-item" onClick={startEdit}>
                  ✏️ 編輯
                </button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => actions.onIgnore(todo.id)}>
                  🚫 忽略這一筆
                </button>
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
              <button className="ok-btn" onClick={() => actions.onComplete(todo.id)}>
                ✓ 完成
              </button>
              <OverflowMenu>
                <button className="menu-item" onClick={() => actions.onOpenChat(todo.chatId)}>
                  💬 開原聊天
                </button>
                <button className="menu-item" onClick={() => actions.onDraftReply(todo)}>
                  ✍️ 草擬回覆
                </button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => actions.onSnooze(todo, 1)}>
                  ⏰ 延後 1 小時
                </button>
                <button className="menu-item" onClick={() => actions.onSnooze(todo, 3)}>
                  ⏰ 延後 3 小時
                </button>
                <button className="menu-item" onClick={() => actions.onSnooze(todo, 24)}>
                  ⏰ 延後到明天
                </button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={startEdit}>
                  ✏️ 編輯
                </button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => actions.onIgnore(todo.id)}>
                  🚫 忽略這一筆
                </button>
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
