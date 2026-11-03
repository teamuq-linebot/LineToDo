import { createHash } from 'node:crypto'
import { AiPortError } from '../../core/aiPort'
import type { AiPort } from '../../core/aiPort'
import type { SettingsStore } from '../../main/config/settings'
import { EXTRACT_SYSTEM_PROMPT } from '../../main/llm/extractPrompt'
import { COMBINED_OUTPUT_CONTRACT, EXTRACT_OUTPUT_CONTRACT } from './aiOutputContract'
import { COMBINED_BUNDLE_ENABLED, COMBINED_TOPIC_SECTION } from '../../main/features/groupTopics/prompts/bundle'
import { EMPTY_CHAT_PROMPT_OVERRIDE } from './chatPromptStore'
import type { ChatPromptStore } from './chatPromptStore'
import { MY_NAME_MAX_CHARS, PROMPT_MAX_CHARS, PromptError, TOPIC_APPENDIX_TEXT, promptRefinementInput, validateMyName, validatePrompt, validatePromptSuggestion } from '../../shared/promptSettings'
import type { ChatPromptState, ChatPromptSummary, PromptRefinementRequest, PromptState, PromptSuggestion } from '../../shared/promptSettings'

/** `topics`：已啟用議題的群組，system 另接固定的議題段落與合併輸出格式。省略＝與舊版逐字相同。 */
export interface ExtractSystemOptions { topics?: boolean }

export interface PromptService {
  state(): PromptState
  save(prompt: unknown, expectedRevision: unknown): PromptState
  reset(expectedRevision: unknown): PromptState
  /** 儲存預設的「我的名字」；null／空字串＝清除。`expectedNameRevision` 與目前名字的 nameRevision 不符丟 `prompt_conflict`。 */
  saveName(myName: unknown, expectedNameRevision: unknown): PromptState
  refine(request: PromptRefinementRequest): Promise<PromptSuggestion>
  revision(): string
  /** 抽取實際送給 AI 的 system：生效的 prompt＋（有名字時）身分段＋固定輸出格式（ExtractWorker 每次領到項目時讀）。省略 chatId＝只用預設值。 */
  extractSystem(chatId?: string, opts?: ExtractSystemOptions): string
  /** 該對話 system（不含固定輸出格式）的 sha256；沒有名字時等於預設 prompt 的 `revision()`，所以升級不會重置既有 session。 */
  systemSha256(chatId?: string, opts?: ExtractSystemOptions): string
  chatState(chatId: unknown): ChatPromptState
  chatSave(chatId: unknown, input: { prompt: unknown; myName: unknown }, expectedRevision: unknown): ChatPromptState
  chatReset(chatId: unknown, expectedRevision: unknown): ChatPromptState
  chatList(): ChatPromptSummary[]
}

export interface PromptServiceOptions {
  chatStore?: ChatPromptStore
  log?: (event: string, detail?: Record<string, unknown>) => void
  /** 測試用：覆寫合併 bundle 是否可用（預設為建置時的 COMBINED_BUNDLE_ENABLED）。 */
  combinedEnabled?: boolean
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** 程式附加在使用者 prompt 之後、固定輸出格式之前的身分段（只在生效名字非 null 時附加）。 */
export function identitySection(name: string): string {
  const quoted = JSON.stringify(name)
  return [
    '【使用者在這個對話的身分（由程式加入）】',
    `- 在這個聊天室裡，「我」(me) 被稱為 ${quoted}。訊息中對 ${quoted}（含 @${quoted.slice(1, -1)}、暱稱或相近寫法）的請託、指派與點名，視為對我說的。`,
    '- 這只用來判斷事項是否指派給我；不改變 direction 的定義、輸出欄位或 JSON Schema。'
  ].join('\n')
}

export function createPromptService(settings: SettingsStore, ai: AiPort, options: PromptServiceOptions = {}): PromptService {
  const chatStore = options.chatStore
  const combinedEnabled = options.combinedEnabled ?? COMBINED_BUNDLE_ENABLED
  const log = (event: string, detail?: Record<string, unknown>): void => { try { options.log?.(event, detail) } catch { /* 診斷失敗不影響流程 */ } }
  const active = (): string => settings.get().pluginPrompt ?? EXTRACT_SYSTEM_PROMPT
  const defaultName = (): string | null => settings.get().pluginMyName ?? null
  const revision = (): string => sha256(active())
  const nameRevision = (): string => sha256(JSON.stringify({ myName: defaultName() }))
  const state = (): PromptState => ({
    initialPrompt: EXTRACT_SYSTEM_PROMPT, activePrompt: active(), customized: active() !== EXTRACT_SYSTEM_PROMPT,
    revision: revision(), maxChars: PROMPT_MAX_CHARS, outputFormat: EXTRACT_OUTPUT_CONTRACT, topicAppendix: TOPIC_APPENDIX_TEXT,
    myName: defaultName(), nameRevision: nameRevision(), maxNameChars: MY_NAME_MAX_CHARS
  })
  const assertRevision = (expected: unknown): void => { if (expected !== revision()) throw new PromptError('prompt_conflict') }
  const assertNameRevision = (expected: unknown): void => { if (expected !== nameRevision()) throw new PromptError('prompt_conflict') }

  const requireStore = (): ChatPromptStore => {
    if (!chatStore) throw new PromptError('chat_prompt_unavailable')
    return chatStore
  }
  const validChatId = (chatId: unknown): string => {
    if (typeof chatId !== 'string' || chatId.length === 0 || chatId.length > 512) throw new PromptError('chat_unknown')
    return chatId
  }
  const knownChatId = (chatId: unknown): string => {
    const id = validChatId(chatId)
    if (!requireStore().chatExists(id)) throw new PromptError('chat_unknown')
    return id
  }
  const chatRevision = (prompt: string | null, myName: string | null): string => sha256(JSON.stringify({ v: 1, prompt, myName }))
  const reportedCorrupt = new Set<string>()
  const readOverride = (chatId: string): { prompt: string | null; myName: string | null; corrupt: boolean } => {
    const read = requireStore().get(chatId)
    if (read.corrupt) {
      if (!reportedCorrupt.has(chatId)) { reportedCorrupt.add(chatId); log('chat_override_corrupt') }
    } else reportedCorrupt.delete(chatId)
    return { prompt: read.override.prompt, myName: read.override.myName, corrupt: read.corrupt }
  }

  /** 生效值的唯一解析點：對話覆寫優先，否則沿用預設。 */
  const effective = (chatId: string | undefined): { prompt: string; name: string | null } => {
    const base = { prompt: active(), name: defaultName() }
    if (chatId === undefined || !chatStore) return base
    const override = readOverride(chatId)
    return { prompt: override.prompt ?? base.prompt, name: override.myName ?? base.name }
  }
  const systemText = (chatId: string | undefined): string => {
    const value = effective(chatId)
    return value.name === null ? value.prompt : `${value.prompt}\n\n${identitySection(value.name)}`
  }

  /** 合併 bundle 建置失敗（失敗閉鎖）時，topics 選項退回純待辦的 system，不會送出空的議題段落。 */
  const withTopics = (opts: ExtractSystemOptions | undefined): boolean => opts?.topics === true && combinedEnabled

  const chatState = (chatId: string): ChatPromptState => {
    const override = readOverride(chatId)
    const name = override.myName ?? defaultName()
    return {
      chatId,
      revision: chatRevision(override.prompt, override.myName),
      overridePrompt: override.prompt,
      overrideName: override.myName,
      effectivePrompt: override.prompt ?? active(),
      effectiveName: name,
      promptSource: override.prompt === null ? 'default' : 'chat',
      nameSource: override.myName !== null ? 'chat' : name !== null ? 'default' : 'none',
      defaultName: defaultName(),
      maxChars: PROMPT_MAX_CHARS,
      maxNameChars: MY_NAME_MAX_CHARS,
      corrupt: override.corrupt
    }
  }

  return {
    state, revision,
    extractSystem: (chatId, opts) => withTopics(opts)
      ? `${systemText(chatId)}\n\n${COMBINED_TOPIC_SECTION}\n\n${COMBINED_OUTPUT_CONTRACT}`
      : `${systemText(chatId)}\n\n${EXTRACT_OUTPUT_CONTRACT}`,
    systemSha256: (chatId, opts) => sha256(withTopics(opts) ? `${systemText(chatId)}\n\n${COMBINED_TOPIC_SECTION}` : systemText(chatId)),
    save(prompt, expectedRevision) {
      assertRevision(expectedRevision)
      const text = validatePrompt(prompt)
      settings.update({ pluginPrompt: text === EXTRACT_SYSTEM_PROMPT ? null : text })
      return state()
    },
    reset(expectedRevision) {
      assertRevision(expectedRevision)
      settings.update({ pluginPrompt: null })
      return state()
    },
    saveName(myName, expectedNameRevision) {
      assertNameRevision(expectedNameRevision)
      if (myName === undefined) throw new PromptError('invalid_args')
      settings.update({ pluginMyName: validateMyName(myName) })
      return state()
    },
    chatState(chatId) {
      return chatState(knownChatId(chatId))
    },
    chatSave(chatId, input, expectedRevision) {
      const id = knownChatId(chatId)
      const current = readOverride(id)
      if (expectedRevision !== chatRevision(current.prompt, current.myName)) throw new PromptError('prompt_conflict')
      if (input === null || typeof input !== 'object') throw new PromptError('prompt_empty')
      if (input.prompt === undefined || input.myName === undefined) throw new PromptError('invalid_args')
      const nextPrompt = input.prompt === null ? null : validatePrompt(input.prompt)
      const nextName = validateMyName(input.myName)
      requireStore().put(id, {
        prompt: nextPrompt === null || nextPrompt === active() ? null : nextPrompt,
        myName: nextName === null || nextName === defaultName() ? null : nextName
      })
      reportedCorrupt.delete(id)
      return chatState(id)
    },
    chatReset(chatId, expectedRevision) {
      const id = validChatId(chatId)
      const current = readOverride(id)
      if (expectedRevision !== chatRevision(current.prompt, current.myName)) throw new PromptError('prompt_conflict')
      requireStore().put(id, EMPTY_CHAT_PROMPT_OVERRIDE)
      reportedCorrupt.delete(id)
      return chatState(id)
    },
    chatList() {
      return requireStore().list().map(({ chatId, override }) => ({
        chatId, hasPrompt: override.prompt !== null, myName: override.myName, revision: chatRevision(override.prompt, override.myName)
      }))
    },
    async refine(request) {
      const input = promptRefinementInput(request, EXTRACT_OUTPUT_CONTRACT)
      let result: Awaited<ReturnType<AiPort['complete']>>
      try {
        result = await ai.complete({
          ...input,
          expectJson: true,
          priority: 'user',
          // 形狀不對（多餘欄位、changes 不合規）也算「回覆不合格」，由 port 重問一次。
          validate: (value) => {
            try { validatePromptSuggestion(value, null); return { ok: true, value } } catch { return { ok: false, reason: '只能有 prompt（字串）與 changes（1 至 8 項字串）兩個欄位' } }
          }
        })
      } catch (error) {
        if (error instanceof AiPortError && (error.code === 'invalid_json' || error.code === 'invalid_result')) throw new PromptError('prompt_suggestion_invalid')
        throw error
      }
      return validatePromptSuggestion(result.value, result.model)
    }
  }
}
