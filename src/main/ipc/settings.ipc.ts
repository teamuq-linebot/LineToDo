import { ipcMain, shell, app } from 'electron'
import {
  getSettings,
  updateSettings,
  setApiKey,
  clearApiKey,
  isSafeStorageAvailable,
  hasSafeStorageKey,
  type SettingsView,
  type SettingsPatch
} from '../config/settings'
import { getQwenConfig } from '../config/qwen'
import { makeQwen } from '../llm/qwenClient'
import { draftReply } from '../llm/draftReply'
import { getTodo } from '../db/todos.repo'
import { getChat } from '../db/chats.repo'
import { getRecentByChat } from '../db/messages.repo'
import { getPipelineDefaults } from '../config/defaults'

/**
 * settings:* / todos:draftReply / app:openDataFolder IPC handler（IMPLEMENTATION_PLAN.md §5）。
 *
 * - settings:get        → SettingsView（不含金鑰；只回 hasApiKey + 來源 + safeStorage 可用性）
 * - settings:update     → 套用 patch 並落檔，回最新 SettingsView
 * - settings:setApiKey  → safeStorage 加密落檔（不可用時回友善錯誤，不崩潰）
 * - settings:clearApiKey→ 清除金鑰檔
 * - todos:draftReply    → 用 qwen 草擬回覆（只回字串，不送出）
 * - app:openDataFolder  → 開 userData 資料夾（除錯）
 *
 * 註：settings:testQwen 已在 pipeline.ipc.ts 註冊（與 scheduler 同檔），此處不重複。
 */

function buildView(): SettingsView {
  const s = getSettings()
  const cfg = getQwenConfig()
  return {
    ...s,
    hasApiKey: cfg.apiKey !== null,
    apiKeySource: cfg.source,
    safeStorageAvailable: isSafeStorageAvailable()
  }
}

export interface SettingsIpcHooks {
  /** 設定更新後回呼（main 用來讓 scheduler 重排輪詢頻率，使 pollIntervalSec 變更即時生效）。 */
  onSettingsChanged?: () => void
}

export function registerSettingsIpc(hooks: SettingsIpcHooks = {}): void {
  ipcMain.handle('settings:get', (): SettingsView => buildView())

  ipcMain.handle(
    'settings:update',
    (_e, args: { patch: SettingsPatch }): SettingsView => {
      if (args?.patch && typeof args.patch === 'object') {
        updateSettings(args.patch)
        hooks.onSettingsChanged?.()
      }
      return buildView()
    }
  )

  ipcMain.handle(
    'settings:setApiKey',
    (_e, args: { apiKey: string }): { ok: boolean; error?: string } => {
      if (!args || typeof args.apiKey !== 'string') {
        return { ok: false, error: '金鑰格式不正確' }
      }
      try {
        setApiKey(args.apiKey)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('settings:clearApiKey', (): { ok: boolean } => {
    clearApiKey()
    return { ok: true }
  })

  ipcMain.handle('settings:hasSafeStorageKey', (): boolean => hasSafeStorageKey())

  // todos:draftReply —— 用 qwen 草擬回覆。只回字串，不送出（MVP）。
  ipcMain.handle(
    'todos:draftReply',
    async (_e, args: { id: string }): Promise<{ draft?: string; error?: string }> => {
      if (!args || typeof args.id !== 'string') {
        return { error: '缺少 todo id' }
      }
      const todo = getTodo(args.id)
      if (!todo) return { error: '找不到該代辦' }

      const cfg = getQwenConfig()
      if (!cfg.apiKey) {
        return { error: '尚未設定 API 金鑰（請在設定頁填入，或設環境變數 QWEN_API_KEY）' }
      }

      try {
        const chat = getChat(todo.chatId)
        const limit = getPipelineDefaults().recentContextLimit || 10
        const recent = getRecentByChat(todo.chatId, Math.max(limit, 10))
        const client = makeQwen({
          apiKey: cfg.apiKey,
          baseURL: cfg.baseURL,
          timeoutMs: cfg.timeoutMs
        })
        const draft = await draftReply(
          client,
          {
            todo: { bucket: todo.bucket, title: todo.title, detail: todo.detail },
            chatName: chat?.name ?? null,
            isGroup: chat?.isGroup ?? false,
            recentMessages: recent.map((m) => ({
              direction: m.direction,
              sender: m.sender,
              text: m.text,
              timeIso: m.timeIso
            }))
          },
          { model: cfg.model }
        )
        return { draft }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // chats:openOriginal —— 「開原聊天」。MVP：LINE Desktop 無穩定 deep-link，
  // 這裡盡力嘗試喚起 LINE 主視窗（line:// scheme）；失敗回 ok:false 由 UI 提示手動切換。
  ipcMain.handle(
    'chats:openOriginal',
    async (_e, args: { chatId: string }): Promise<{ ok: boolean; error?: string }> => {
      if (!args || typeof args.chatId !== 'string') {
        return { ok: false, error: '缺少 chatId' }
      }
      try {
        // line:// 只能喚起 App，無法精準跳到特定聊天室（LINE Desktop 限制）。
        await shell.openExternal('line://')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('app:openDataFolder', (): { ok: boolean } => {
    void shell.openPath(app.getPath('userData'))
    return { ok: true }
  })
}
