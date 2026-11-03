/**
 * extractQueue.ts — 外掛版 AI 抽取的「供料／收料」（設計 v2 §4.3）。
 *
 * 0.2.0 起抽取的「大腦」在 backend：`extractWorker.ts` 領走項目、經 AI port（`host.ai.complete`）取得模型輸出再交回本佇列
 * （0.1.x 這個角色是看板 view 裡的 aiOrchestrator，經 `extract.pull`／`extract.commit` 的 RPC 來回；那條通道已移除）。
 * 本佇列自己**完全不打 LLM、不 spawn 任何東西**，只做兩件事：
 *
 *   供料（outbox）：runOnce 的步驟 1-4（落庫、黑名單、噪音過濾、取未處理訊息按 chat 分組）照跑，
 *     但在呼叫 extractFn 之前停下，把每個 chat 的 `ChatExtractInput` 交給本佇列（`offer`）。
 *     本佇列依 `ai:chat` 的單輪輸入上限把 payload 切成 ≤ maxUserChars 的「片段」，worker 以 `pull` 領走（附租約）。
 *   收料（inbox）：worker 把 AI 回來、已 parse 的 JSON 以 `commit` 送回；本佇列**重新用 zod 驗證**
 *     （格式錯誤 → 拒絕、該 chat 退避重排，訊息維持未處理），通過後走與 standalone 同一份落庫邏輯
 *     `applyChatExtract()`（近似去重、完成偵測、重新分類、標 processed）。
 *
 * 失敗語意對齊現行 runOnce：失敗的 chat 訊息**不**標 processed，下一輪重抽；per-chat 指數退避（對齊 ChatBackoff）。
 * 另提供 `request()`：呼叫端要「同步拿到結果」的情境（reviewLastDays 回顧）— 同一個 pull/commit 通道，
 * 結果不落庫、直接 resolve 給呼叫端（由呼叫端自己的流程落庫）。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { PipelineDefaults } from '../../main/config/defaults'
import type { MessageDTO } from '../../main/db/dto'
import { finishRun, startRun } from '../../main/db/pipeline.repo'
import { getOpenTodosByChat } from '../../main/db/todos.repo'
import { EXTRACT_SYSTEM_PROMPT, buildUserPayload } from '../../main/llm/extractPrompt'
import { EXTRACT_JSON_SCHEMA, validateExtractResult } from '../../main/llm/schema'
import type { ExtractResult } from '../../main/llm/schema'
import { applyChatExtract } from '../../main/pipeline/runOnce'
import { applyCombinedExtract } from '../../main/pipeline/combinedApply'
import { COMBINED_BUNDLE_ENABLED, COMBINED_PROMPT_HASH, COMBINED_PROMPT_VERSION, COMBINED_SCHEMA_HASH, COMBINED_SCHEMA_VERSION, GROUP_TOPICS_BUNDLE_ENABLED } from '../../main/features/groupTopics/prompts/bundle'
import { splitCombined, topicCandidatesOnly } from '../../main/features/groupTopics/combined'
import type { CombinedTopicPayload } from '../../main/features/groupTopics/combined'
import { TopicAnalysisValidationError } from '../../main/features/groupTopics/domain'
import type { TopicAnalysis, TopicMessageInput } from '../../main/features/groupTopics/domain'
import { GROUP_TOPICS_VALIDATOR_VERSION, loadTopicCandidates, recordFailure as recordTopicFailure, selectTopicTargets } from '../../main/features/groupTopics/repository'
import type { ApplyTally, ChatExtractInput, ExtractSink, RunOnceResult } from '../../main/pipeline/runOnce'
import { advanceIdentityIndex, beginIdentitySourceAttempt, captureIdentitySnapshot, recallTodoIdentityCandidates, recordIdentitySourceAttempt, releaseIdentitySourceAttempt, renewIdentitySourceLease, tableExists } from '../../main/db/identity.repo'
import { getMessagesByChatAndIds, getRecentByChat } from '../../main/db/messages.repo'
import { IDENTITY_QUERY_VERSION } from '../../shared/identityDecision'
import { sharedSourceRows } from '../../main/db/sourceCache'
import { isTodoExtractEnabled } from '../../main/db/chatTodoPrefs.repo'
import type { ChatSourceLease } from '../../main/db/sourceCache'

export const EXTRACT_SYSTEM_SHA256 = createHash('sha256').update(EXTRACT_SYSTEM_PROMPT).digest('hex')

/** `AI_CHAT_LIMITS.inputChars` 是 8000；留餘裕給 UI 加的包裝。 */
export const DEFAULT_MAX_USER_CHARS = 7500
/** recentContext 最多佔單輪預算的比例（其餘留給新訊息與 openTodos）。 */
export const CONTEXT_BUDGET_RATIO = 0.2
const DEFAULT_LEASE_MS = 120_000
/** 單次領取租約的上限（ExtractWorker 的租約要涵蓋一個項目在 AI port 裡最壞的處理時間，約 14 分鐘）。 */
const MAX_LEASE_MS = 20 * 60_000
const DEFAULT_RETRY_BASE_MS = 30_000
const DEFAULT_RETRY_MAX_MS = 30 * 60_000
/**
 * 同步呼叫端（回顧）的「停滯」上限：整個佇列已經這麼久沒有任何結果被交回（commit），這個呼叫自己也沒有進展，才算停滯。
 * 不是「從發出請求起算的總等待時間」——UI 在跑、只是受 ai:chat 18 輪/分限制而慢，不會被它判失敗（修正前是總時間上限 15 分鐘）。
 */
const DEFAULT_AWAIT_TIMEOUT_MS = 15 * 60_000
/** 單次 pull 回傳的 JSON 預算（host 上限 64 KiB，留餘裕給 envelope）。 */
const DEFAULT_PULL_BUDGET_BYTES = 40 * 1024
const DEFAULT_MAX_ITEMS_PER_PULL = 4
/** 合併整理：一個 part 最多要分析的議題目標數（等於 GROUP_TOPICS_BATCH_SIZE；測試釘住兩者相等）。 */
export const COMBINED_TARGETS_PER_PART = 20
/** topic.existingLocalTopics 最多佔單輪預算的比例（超過先砍它）。 */
export const COMBINED_LOCAL_TOPICS_RATIO = 0.15
/** 同一聊天室的議題邊連續失敗這麼多次，就在接下來 COMBINED_DEGRADE_MS 內只送純待辦。 */
export const COMBINED_DEGRADE_FAILS = 2
export const COMBINED_DEGRADE_MS = 30 * 60_000

/** 合併整理的診斷計數（replyChars＝已解析的回覆 JSON 序列化後的字元數；decisions＝議題身分決策總數）。 */
export interface CombinedCounters {
  partsWithTopic: number; topicApplied: number; topicFailed: number; topicAbsent: number; topicDiscarded: number; todoFailedTopicApplied: number
  decisions: number; replyChars: number; replyCharsMax: number; fallbackSystemTooLarge: number; fallbackDegraded: number
}

// ───────────────────────── 切片：把一個 chat 的輸入切成 ≤ maxChars 的 payload ─────────────────────────

export interface ExtractPart {
  /** 此片段的輸入（newMessages 只含這一片的訊息；recentContext／openTodos 可能被縮減）。 */
  input: ChatExtractInput
  /** 此片段涵蓋（要標 processed）的訊息 id。所有片段的 msgIds 合起來恰好等於原輸入的 newMessages。 */
  msgIds: string[]
  /** 已序列化的 user payload（≤ maxChars，除非單一訊息怎麼縮都放不下）。 */
  user: string
  /** 被截短文字的訊息數（單一訊息本身就超過預算時才會發生）。 */
  truncated: number
}

function takeLast<T>(items: T[], n: number): T[] {
  return n <= 0 ? [] : items.slice(-n)
}

function buildPayload(input: ChatExtractInput, newMessages: MessageDTO[], recentContext: MessageDTO[], openTodos: ChatExtractInput['openTodos'], topic?: CombinedTopicPayload): string {
  return buildUserPayload({
    now: input.now,
    chat: input.chat,
    newMessages,
    recentContext,
    openTodos,
    classificationCorrections: input.classificationCorrections,
    identityCandidates:input.identityCandidates,
    identityCandidatesTruncated:input.identityCandidatesTruncated,
    ...(topic ? { topic } : {})
    // 刻意不傳 onCorrectionsPayloadBuilt：那個稽核 hook 只在 payload 真的被領走（pull）時才呼叫。
  })
}

/** 既有議題清單依序取到序列化長度不超過 budget 為止（超過就從尾端捨棄）。 */
function fitLocalTopics(list: CombinedTopicPayload['existingLocalTopics'], budget: number): CombinedTopicPayload['existingLocalTopics'] {
  const picked: CombinedTopicPayload['existingLocalTopics'] = []
  for (const topic of list) {
    if (JSON.stringify([...picked, topic]).length > budget) break
    picked.push(topic)
  }
  return picked
}

/**
 * 依字元預算切片。順序：先放滿新訊息；一則都放不下時先縮 recentContext（丟最舊的）、再截短該則文字。
 * 後一片的 recentContext 接在前一片的新訊息之後（最多 contextLimit 則）。openTodos 若單獨就吃掉一半預算，截成前綴。
 *
 * **recentContext 有自己的預算上限**（`contextBudgetChars`，預設單輪的 20%）：只拿最近的幾則、放得下為止，絕不讓上下文
 * 把單輪預算吃光（修正前：contextLimit 較大或訊息較長時，上下文佔滿預算，每輪只剩一則新訊息，長聊天室退化成「一則一輪」，
 * 吃光 ai:chat 的 18 輪/分）。每輪的新訊息因此至少有 `maxChars × (1 − 20%) − openTodos` 可用。
 */
export function partitionExtractInput(input: ChatExtractInput, opts: { maxChars: number; contextLimit: number; contextBudgetChars?: number }): ExtractPart[] {
  const { maxChars } = opts
  const contextLimit = Math.max(0, opts.contextLimit)
  const contextBudget = Math.max(0, Math.floor(opts.contextBudgetChars ?? maxChars * CONTEXT_BUDGET_RATIO))
  let openTodos = input.openTodos
  while (openTodos.length > 0 && buildPayload(input, [], [], openTodos).length > maxChars / 2) {
    openTodos = openTodos.slice(0, Math.floor(openTodos.length / 2))
  }
  let identityCandidates=input.identityCandidates??[]
  let identityCandidatesTruncated=input.identityCandidatesTruncated===true
  while(identityCandidates.length>0&&buildPayload({...input,identityCandidates,identityCandidatesTruncated},[],[],openTodos).length>maxChars/2){
    identityCandidates=identityCandidates.slice(0,Math.floor(identityCandidates.length/2))
    identityCandidatesTruncated=true
  }
  if(input.identityCandidates){
    input.identityCandidates=identityCandidates
    input.identityCandidatesTruncated=identityCandidatesTruncated
    input.identitySnapshot.candidatesTruncated=identityCandidatesTruncated
  }

  // 合併整理：input.topic 存在時，每個 part 只帶自己訊息中的議題目標（≤ COMBINED_TARGETS_PER_PART）。
  // 放不下時依序退讓：先拿掉 existingLocalTopics，再整個 part 改成純待辦——議題永遠不能讓待辦的 part 過大。
  const topicTargets = input.topic ? new Set(input.topic.targetMsgIds) : null
  const localTopics = input.topic ? fitLocalTopics(input.topic.existingLocalTopics, Math.floor(maxChars * COMBINED_LOCAL_TOPICS_RATIO)) : []
  type TopicMode = 'full' | 'noLocals' | 'none'
  const topicFor = (slice: MessageDTO[], mode: TopicMode): CombinedTopicPayload | undefined => {
    if (!topicTargets || mode === 'none') return undefined
    const ids = slice.filter((m) => topicTargets.has(m.msgId)).map((m) => m.msgId)
    if (ids.length === 0) return undefined
    return { targetMsgIds: ids, existingLocalTopics: mode === 'full' ? localTopics : [] }
  }

  /** 上下文佔用的字元數（序列化後，扣掉沒有上下文時的基底）。 */
  const emptyContextChars = buildPayload(input, [], [], []).length
  const contextCost = (list: MessageDTO[]): number => buildPayload(input, [], list, []).length - emptyContextChars
  /** 從候選（舊到新）取最近的幾則，總成本 ≤ contextBudget；最新一則本身就超過預算時截短它的文字（不整則丟掉）。 */
  const fitContext = (candidates: MessageDTO[]): MessageDTO[] => {
    let picked = takeLast(candidates, contextLimit)
    while (picked.length > 1 && contextCost(picked) > contextBudget) picked = picked.slice(1)
    if (picked.length === 1 && contextCost(picked) > contextBudget) {
      const only = picked[0]
      let room = contextBudget - contextCost([{ ...only, text: '' }])
      let cut: MessageDTO = { ...only, text: (only.text ?? '').slice(0, Math.max(0, room)) }
      while (room > 0 && contextCost([cut]) > contextBudget) {
        room = Math.floor(room * 0.8)
        cut = { ...only, text: (only.text ?? '').slice(0, room) }
      }
      picked = room >= 20 ? [cut] : []
    }
    return picked
  }

  const messages = input.newMessages
  const parts: ExtractPart[] = []
  let history: MessageDTO[] = takeLast(input.recentContext, contextLimit)
  let context = fitContext(history)
  let index = 0
  while (index < messages.length) {
    let count = 0
    let user = ''
    let used = context
    let chunk: MessageDTO[] = []
    let truncated = 0
    let topicMode: TopicMode = 'full'
    for (;;) {
      const next = count + 1
      if (index + next > messages.length) break
      const slice = messages.slice(index, index + next)
      const sliceTopic = topicFor(slice, 'full')
      if (sliceTopic && sliceTopic.targetMsgIds.length > COMBINED_TARGETS_PER_PART) break
      const candidate = buildPayload(input, slice, used, openTodos, sliceTopic)
      if (candidate.length > maxChars) break
      count = next
      user = candidate
    }
    if (count > 0) {
      chunk = messages.slice(index, index + count)
    } else {
      if (topicFor([messages[index]], 'full')) {
        // 帶議題一則都放不下：先拿掉 existingLocalTopics，仍放不下就整個 part 改成純待辦。
        const lean = buildPayload(input, [messages[index]], used, openTodos, topicFor([messages[index]], 'noLocals'))
        if (lean.length <= maxChars) { count = 1; user = lean; chunk = [messages[index]]; topicMode = 'noLocals' }
        else topicMode = 'none'
      }
    }
    if (count === 0) {
      // 一則都放不下：先縮 context。
      let shrunk = context
      while (shrunk.length > 0 && count === 0) {
        shrunk = shrunk.slice(1)
        const candidate = buildPayload(input, [messages[index]], shrunk, openTodos)
        if (candidate.length <= maxChars) { count = 1; user = candidate; used = shrunk; chunk = [messages[index]] }
      }
      if (count === 0) {
        // 沒有 context 了仍放不下：截短這則訊息的文字（逐步縮到放得下為止）。
        const original = messages[index]
        let room = Math.max(50, maxChars - buildPayload(input, [{ ...original, text: '' }], [], openTodos).length)
        let cut: MessageDTO = { ...original, text: (original.text ?? '').slice(0, room) }
        user = buildPayload(input, [cut], [], openTodos)
        while (user.length > maxChars && room > 50) {
          room = Math.max(50, Math.floor(room * 0.8))
          cut = { ...original, text: (original.text ?? '').slice(0, room) }
          user = buildPayload(input, [cut], [], openTodos)
        }
        count = 1; used = []; chunk = [cut]; truncated = (original.text ?? '').length > room ? 1 : 0
      }
    }
    const taken = messages.slice(index, index + count)
    const partInput: ChatExtractInput = { ...input, newMessages: chunk, recentContext: used, openTodos }
    const partTopic = truncated === 0 ? topicFor(chunk, topicMode) : undefined
    if (partTopic) partInput.topic = partTopic
    else delete partInput.topic
    parts.push({
      input: partInput,
      msgIds: taken.map((m) => m.msgId),
      user,
      truncated
    })
    history = takeLast([...history, ...taken], contextLimit)
    context = fitContext(history)
    index += count
  }
  return parts
}

// ───────────────────────── 佇列 ─────────────────────────

export interface ExtractQueueOptions {
  db: Database
  getConfig(): PipelineDefaults
  /** system 的雜湊；帶 chatId＝該對話的生效值（逐對話 prompt／名字），不帶＝預設值。`topics`＝合併整理的 part（system 另接議題段落）。 */
  getSystemSha256?(chatId?: string, opts?: { topics?: boolean }): string
  /**
   * 合併整理（待辦＋議題一次 AI 呼叫）。省略＝永遠純待辦（standalone 與既有測試不受影響）。
   * `enabled`：執行期旗標（pluginCombinedExtract）。`systemFits`：該聊天室帶議題的 system 沒有超過 host 的 systemChars；
   * 超過就走純待辦（`system_too_large` 不是暫時性錯誤，只會退避，不能靠重試）。
   */
  combined?: { enabled(): boolean; systemFits(chatId: string): boolean }
  /** 診斷 log（不得含訊息內容）。 */
  log?(event: string, detail?: Record<string, unknown>): void
  getSessionContext?(): string
  /** commit 落庫後回報一輪結果（外掛接到 `scheduler.recordExternalRun`，沿用 pipeline-run / todos-changed 事件）。 */
  onRun?(result: RunOnceResult): void
  /** 可領取的項目集合有變動（外掛接到事件通道，UI 不必空轉輪詢）。 */
  onPending?(info: { pending: number }): void
  now?(): number
  maxUserChars?: number
  leaseMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  /** 同步呼叫端的停滯上限（見 DEFAULT_AWAIT_TIMEOUT_MS）。 */
  awaitTimeoutMs?: number
  /**
   * 有人在領取或即將領取嗎（外掛接到 ExtractWorker 是否已跑，或啟動 timer 正在倒數）。給了就以它為準：確定沒有 consumer 時
   * `request()` 立刻以 `extract_ui_offline` 失敗，不必等「很久沒有人碰佇列」。省略＝照舊用最近一次 pull／commit／release／touch 的時間判斷。
   */
  consumerOnline?(): boolean
  /** 測試用：取代 setTimeout（回傳取消函式）。預設用 unref 的 setTimeout。 */
  schedule?(fn: () => void, ms: number): () => void
  pullBudgetBytes?: number
  maxItemsPerPull?: number
}

export interface PullItem {
  /** 本次租約的 id；commit 必須帶回（租約過期或被重新領走後舊 id 失效）。 */
  itemId: string
  chatId: string
  chatName: string | null
  /** 要送給 `ai:chat` 的 user 訊息（JSON 字串，已 ≤ maxUserChars）。system prompt 用 `extract.system` 取。 */
  user: string
  userChars: number
  messageCount: number
  /** 這個 chat 已失敗的次數（供 UI 顯示／節流）。 */
  attempts: number
  part: number
  parts: number
  truncatedMessages: number
  /** 合併整理的 part：payload 含 topic 鍵，system 要用 `{ topics: true }` 取、回覆要驗 { todo, topic }。純待辦的 part 沒有這個鍵。 */
  topics?: boolean
  /** Cache epoch is backend-private metadata used only to choose fresh versus valid same-epoch Host resume. */
  sessionEpoch?: number
  /** Records each additional serialized model request before Host submission; never crosses IPC. */
  onAdditionalUserPayload?: (serializedUserPayload: string) => boolean
}

export interface PullResult {
  ok: true
  items: PullItem[]
  pending: number
  leased: number
  systemSha256: string
  maxUserChars: number
  /** 沒有可領項目但有項目在退避時：最短還要等多久。 */
  retryAfterMs: number | null
}

export interface CommitRequestItem {
  itemId: string
  ok: boolean
  /** `ok:true` 時：UI 已 JSON.parse 的模型輸出（backend 會重新驗證）。 */
  result?: unknown
  /** `ok:false` 時：UI 端的失敗代碼（`rate_limited`、`provider_error`、`invalid_json`…）。 */
  failCode?: string
  /** 失敗時建議的退避毫秒（例如 `ai:chat` 的 retryAfterMs）。 */
  retryAfterMs?: number
}

export type CommitItemStatus = 'applied' | 'accepted' | 'rejected' | 'failed_recorded' | 'unknown_item' | 'bad_request' | 'apply_failed'

export interface CommitItemResult {
  itemId: string
  status: CommitItemStatus
  chatId?: string
  code?: string
  issues?: string[]
  createdIds?: string[]
  resolvedIds?: string[]
  updatedIds?: string[]
  /** 退避到何時（ms，相對現在）；只有失敗時有。 */
  retryInMs?: number
}

export interface CommitResult {
  ok: true
  results: CommitItemResult[]
  /** 這次 commit 產生的 pipeline run（有任何項目落庫時）。 */
  run: { runId: string; todosCreated: number; todosMerged: number; resolved: number; updated: number; chatsFailed: number } | null
  pending: number
}

interface AwaitGroup {
  resolve(value: ExtractResult): void
  reject(error: Error): void
  results: Array<ExtractResult | undefined>
  remaining: number
  /** 取消停滯計時器。 */
  cancel: (() => void) | null
  /** 這個呼叫最近一次有進展（建立、或有片段被領走／回來）的時間。 */
  progressAt: number
  settled: boolean
  identitySnapshotRef?: ChatExtractInput['identitySnapshot']
  identityInputRef?: ChatExtractInput
  sourceLease?: ChatSourceLease
}

interface Entry {
  id: string
  chatId: string
  chatName: string | null
  msgIds: string[]
  input: ChatExtractInput
  user: string
  truncated: number
  partIndex: number
  partCount: number
  mode: 'apply' | 'await'
  gen: number
  attempts: number
  notBefore: number
  state: 'pending' | 'leased'
  itemId: string | null
  leaseUntil: number
  group: AwaitGroup | null
  sourceLease: ChatSourceLease | null
}

function mergeResults(parts: ExtractResult[]): ExtractResult {
  const importance = parts.some((p) => p.importance === 'action') ? 'action' : parts.some((p) => p.importance === 'fyi') ? 'fyi' : 'noise'
  const seenResolved = new Set<string>()
  const seenUpdated = new Set<string>()
  return {
    importance,
    newTodos: parts.flatMap((p) => p.newTodos),
    identityDecisions:parts.flatMap((p)=>p.identityDecisions??[]),
    resolved: parts.flatMap((p) => p.resolved).filter((r) => (seenResolved.has(r.todoId) ? false : (seenResolved.add(r.todoId), true))),
    updates: parts.flatMap((p) => p.updates).filter((u) => (seenUpdated.has(u.todoId) ? false : (seenUpdated.add(u.todoId), true)))
  }
}

function issuesOf(error: unknown): string[] {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> } | null)?.issues
  if (Array.isArray(issues)) return issues.slice(0, 5).map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`)
  return [error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)]
}

export class ExtractQueue implements ExtractSink {
  private readonly opts: ExtractQueueOptions
  private readonly entries = new Map<string, Entry>()
  /** chat 級的失敗記憶（對齊 ChatBackoff）：跨 cycle 保留 attempts／notBefore，成功即清掉。 */
  private readonly chatFail = new Map<string, { attempts: number; notBefore: number }>()
  private gen = 0
  private disposed = false
  private lastPendingKey = ''
  /** 領取端最近一次碰這個佇列（pull／commit／release／touch）的時間；從沒碰過＝佇列建立時間。ExtractWorker 每輪迴圈都會 touch。 */
  private uiSeenAt: number
  /** UI 最近一次交回結果（commit，不論成功失敗）的時間——「有在做事」的證據。只有領了又還回去（Codex 沒登入、被限流）不算。 */
  private commitAt: number
  /** 合併整理的議題邊自動降級（設計 §4.3）：連續失敗 COMBINED_DEGRADE_FAILS 次後 COMBINED_DEGRADE_MS 內只送純待辦；議題成功一次就清零；重啟後清空。 */
  private readonly topicDegrade = new Map<string, { fails: number; until: number }>()
  private readonly fallbackLogged = new Set<string>()
  private readonly combinedCounters: CombinedCounters = { partsWithTopic: 0, topicApplied: 0, topicFailed: 0, topicAbsent: 0, topicDiscarded: 0, todoFailedTopicApplied: 0, decisions: 0, replyChars: 0, replyCharsMax: 0, fallbackSystemTooLarge: 0, fallbackDegraded: 0 }

  constructor(opts: ExtractQueueOptions) {
    this.opts = opts
    this.uiSeenAt = this.stallNow()
    this.commitAt = this.uiSeenAt
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }
  /**
   * 停滯判斷用的時鐘，必須和停滯計時器同一個時間基準：有注入 `schedule`（假時鐘）就用注入的 `now`，否則用真時間
   * （`now` 單獨注入時只是拿來控制租約／退避，計時器仍是真的 setTimeout）。
   */
  private stallNow(): number { return this.opts.schedule && this.opts.now ? this.opts.now() : Date.now() }
  private get awaitTimeoutMs(): number { return this.opts.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS }
  private get maxChars(): number { return this.opts.maxUserChars ?? DEFAULT_MAX_USER_CHARS }

  // ── ExtractSink（供料）──

  beginCycle(): void {
    this.gen += 1
  }

  offer(input: ChatExtractInput, msgIds: string[]): void {
    if (this.disposed) return
    this.reap()
    const chatId = input.chat.chatId
    if (!isTodoExtractEnabled(this.opts.db, chatId)) {
      for (const [id, e] of this.entries) if (e.chatId === chatId && e.mode === 'apply' && e.state === 'pending') this.entries.delete(id)
      return
    }
    const wanted = new Set(msgIds)
    // 已被領走（租約中）的訊息不重複供料；其餘訊息照常排隊。
    const inflight = new Set<string>()
    // 回顧（await）正在處理的訊息（排隊或租約中）也算：回顧要幾十分鐘，期間定時輪詢會再把同一批尚未標記 processed 的訊息供料，同一則訊息就會送 AI 兩次。
    for (const e of this.entries.values()) if (e.chatId === chatId && (e.mode === 'await' || e.state === 'leased')) for (const id of e.msgIds) inflight.add(id)
    for (const [id, e] of this.entries) if (e.chatId === chatId && e.mode === 'apply' && e.state === 'pending') this.entries.delete(id)
    const fresh = input.newMessages.filter((m) => wanted.has(m.msgId) && !inflight.has(m.msgId))
    if (fresh.length === 0) return
    const partitionInput: ChatExtractInput = { ...input, newMessages: fresh }
    delete partitionInput.topic
    const topic = this.combinedTopic(chatId, fresh.map((m) => m.msgId))
    if (topic) partitionInput.topic = topic
    const parts = partitionExtractInput(partitionInput, { maxChars: this.maxChars, contextLimit: this.opts.getConfig().recentContextLimit })
    const fail = this.chatFail.get(chatId)
    parts.forEach((part, partIndex) => {
      const id = randomUUID()
      this.entries.set(id, {
        id, chatId, chatName: input.chat.name, msgIds: part.msgIds, input: part.input, user: part.user, truncated: part.truncated,
        partIndex, partCount: parts.length, mode: 'apply', gen: this.gen, attempts: fail?.attempts ?? 0, notBefore: fail?.notBefore ?? 0,
        state: 'pending', itemId: null, leaseUntil: 0, group: null, sourceLease: null
      })
    })
  }

  endCycle(): void {
    for (const [id, e] of this.entries) if (e.mode === 'apply' && e.state === 'pending' && e.gen !== this.gen) this.entries.delete(id)
    this.announce()
  }

  /**
   * 呼叫端要同步拿結果（reviewLastDays）：切片 → 同一個 pull/commit 通道 → 全部片段回來後合併 resolve。
   *
   * 等待上限是「停滯」而不是「總時間」：只要佇列還在交回結果（任何 chat 的 commit）或這個呼叫自己有片段回來，就一直等
   * （長聊天室、300 個聊天室的回顧，在 ai:chat 18 輪/分下本來就要跑很久）。已在等的請求，整個佇列超過上限都沒有結果被交回
   * （看板被隱藏／關掉、Codex 掉線），以 `extract_await_timeout` 失敗；UI 已經超過上限完全沒碰過佇列（pull／commit／release 都沒有）
   * 時，新的請求**立刻**以 `extract_ui_offline` 失敗——不再讓成百上千個請求各自傻等 15 分鐘。
   */
  request(input: ChatExtractInput): Promise<ExtractResult> {
    if (this.disposed) return Promise.reject(new Error('extract queue disposed'))
    const offline = this.opts.consumerOnline ? !this.opts.consumerOnline() : this.stallNow() - this.uiSeenAt >= this.awaitTimeoutMs
    if (offline) return Promise.reject(new Error('extract_ui_offline'))
    const chatId = input.chat.chatId
    const parts = partitionExtractInput(input, { maxChars: this.maxChars, contextLimit: this.opts.getConfig().recentContextLimit })
    if (parts.length === 0) return Promise.resolve({ importance: 'noise', newTodos: [], identityDecisions: [], resolved: [], updates: [] })
    return new Promise<ExtractResult>((resolve, reject) => {
      const group: AwaitGroup = { resolve, reject, results: new Array(parts.length).fill(undefined), remaining: parts.length, cancel: null, progressAt: this.stallNow(), settled: false, identitySnapshotRef: input.identitySnapshot, identityInputRef: input }
      const ids: string[] = []
      parts.forEach((part, partIndex) => {
        const id = randomUUID()
        ids.push(id)
        this.entries.set(id, {
          id, chatId, chatName: input.chat.name, msgIds: part.msgIds, input: part.input, user: part.user, truncated: part.truncated,
          partIndex, partCount: parts.length, mode: 'await', gen: -1, attempts: 0, notBefore: 0, state: 'pending', itemId: null, leaseUntil: 0, group, sourceLease: null
        })
      })
      this.armStall(group, this.awaitTimeoutMs)
      this.announce()
    })
  }

  /** 有沒有待領取的項目（含退避中的；先收回租約過期的）。領取端用它決定要不要去準備 AI（空佇列不必問 host）。 */
  hasPending(): boolean {
    this.reap()
    return this.countState('pending') > 0
  }

  /** 現在就能領的項目數（待領取、而且不在聊天室退避中）。狀態列用它判斷「是不是真的在等配額」。 */
  runnable(): number {
    this.reap()
    const now = this.now()
    let n = 0
    for (const e of this.entries.values()) if (e.state === 'pending' && e.notBefore <= now) n += 1
    return n
  }

  /** 領取端還活著（ExtractWorker 每輪迴圈呼叫；不改變任何項目）。 */
  touch(): void {
    this.uiSeenAt = this.stallNow()
  }

  /** Keep a supported in-flight Host turn alive without treating a new lease as progress loss. */
  progress(itemId: string): void {
    const entry=[...this.entries.values()].find((value)=>value.itemId===itemId&&value.state==='leased')
    if(!entry)return
    const now=this.now()
    this.uiSeenAt=this.stallNow()
    entry.leaseUntil=Math.max(entry.leaseUntil,now+(this.opts.leaseMs??DEFAULT_LEASE_MS))
    if(entry.group&&!entry.group.settled)entry.group.progressAt=this.stallNow()
    if(entry.sourceLease){
      const renewed=renewIdentitySourceLease(this.opts.db,entry.sourceLease,new Date())
      if(renewed){
        entry.sourceLease=renewed
        if(entry.input.identitySnapshot)entry.input.identitySnapshot.sourceLease=renewed
        if(entry.group){entry.group.sourceLease=renewed;if(entry.group.identitySnapshotRef)entry.group.identitySnapshotRef.sourceLease=renewed}
      }
    }
  }

  // ── outbox：pull ──

  pull(params: { max?: number; leaseMs?: number } = {}): PullResult {
    this.reap()
    const now = this.now()
    this.uiSeenAt = this.stallNow()
    const maxItems = Math.min(Math.max(1, Math.floor(params.max ?? this.opts.maxItemsPerPull ?? DEFAULT_MAX_ITEMS_PER_PULL)), 16)
    const leaseMs = Math.min(Math.max(1000, params.leaseMs ?? this.opts.leaseMs ?? DEFAULT_LEASE_MS), MAX_LEASE_MS)
    const budget = this.opts.pullBudgetBytes ?? DEFAULT_PULL_BUDGET_BYTES
    const busyChats = new Set<string>()
    for (const e of this.entries.values()) if (e.state === 'leased') busyChats.add(e.chatId)
    const items: PullItem[] = []
    let bytes = 0
    let soonest: number | null = null
    for (const e of [...this.entries.values()]) {
      if (e.state !== 'pending') continue
      if (e.mode === 'apply' && !isTodoExtractEnabled(this.opts.db, e.chatId)) { this.entries.delete(e.id); continue }
      if (e.notBefore > now) { soonest = soonest === null ? e.notBefore : Math.min(soonest, e.notBefore); continue }
      if (busyChats.has(e.chatId)) continue // 同一個 chat 一次只領一片，後面的片段等前一片回來
      if(e.input.identitySnapshot){
        const sourceRows=getMessagesByChatAndIds(e.chatId,e.msgIds,this.opts.db)
        if(sourceRows.length!==e.msgIds.length){
          if(e.group)this.failGroup(e.group,new Error('identity_source_missing'));else this.entries.delete(e.id)
          continue
        }
        const surviving=e.mode==='apply'?sourceRows.filter((row)=>!row.processed):sourceRows
        if(surviving.length===0){if(e.group)this.failGroup(e.group,new Error('identity_source_no_longer_pending'));else this.entries.delete(e.id);continue}
        e.msgIds=surviving.map((row)=>row.msgId)
        e.input.newMessages=surviving
        const selected=new Set([...this.entries.values()].filter((entry)=>entry.chatId===e.chatId&&entry.state==='pending'&&entry.mode===e.mode&&(e.mode==='apply'?entry.gen===e.gen:entry.group===e.group)).flatMap((entry)=>entry.msgIds))
        for(const id of e.msgIds)selected.add(id)
        const contextLimit=this.opts.getConfig().recentContextLimit
        const recentWindow=getRecentByChat(e.chatId,Math.min(1000,Math.max(contextLimit,contextLimit+selected.size)),this.opts.db)
        const priorRows=recentWindow.filter((row)=>!selected.has(row.msgId))
        e.input.recentContext=contextLimit>0?priorRows.slice(-contextLimit):[]
        e.input.now=new Date(this.now()).toISOString()
        const todoReady=advanceIdentityIndex(this.opts.db,e.chatId,'todo')
        const topicReady=!tableExists(this.opts.db,'discussion_topics')||advanceIdentityIndex(this.opts.db,e.chatId,'topic')
        if(!todoReady||!topicReady){if(e.group)this.failGroup(e.group,new Error('identity_indexing'));else this.entries.delete(e.id);continue}
        const groupSourceIds=e.group?.identitySnapshotRef?.selectedFingerprints.map((row)=>row.msgId)
        const identitySourceRows=e.group&&groupSourceIds?.length?getMessagesByChatAndIds(e.chatId,groupSourceIds,this.opts.db):surviving
        if(identitySourceRows.length!==(e.group&&groupSourceIds?.length?groupSourceIds.length:surviving.length)){
          if(e.group)this.failGroup(e.group,new Error('identity_source_missing'));else this.entries.delete(e.id)
          continue
        }
        const identitySourceIds=identitySourceRows.map((row)=>row.msgId)
        const recalled=recallTodoIdentityCandidates(this.opts.db,e.chatId,identitySourceRows.map((row)=>row.text??''),identitySourceIds)
        if(!recalled.ready){if(e.group)this.failGroup(e.group,new Error('identity_indexing'));else this.entries.delete(e.id);continue}
        const snapshot=captureIdentitySnapshot(this.opts.db,e.chatId,surviving,recalled.truncated,recalled.candidateRevisions)
        if(!snapshot){if(e.group)this.failGroup(e.group,new Error('identity_source_stale'));else this.entries.delete(e.id);continue}
        e.input.identityCandidates=recalled.candidates
        e.input.identityCandidatesTruncated=recalled.truncated
        e.input.identitySnapshot=snapshot
        if(e.group?.identitySnapshotRef){
          const groupSnapshot=captureIdentitySnapshot(this.opts.db,e.chatId,identitySourceRows,recalled.truncated,recalled.candidateRevisions)
          if(!groupSnapshot){this.failGroup(e.group,new Error('identity_source_stale'));continue}
          Object.assign(e.group.identitySnapshotRef,groupSnapshot)
          if(e.group.identityInputRef){
            e.group.identityInputRef.identitySnapshot=e.group.identitySnapshotRef
            e.group.identityInputRef.identityCandidates=recalled.candidates
            e.group.identityInputRef.identityCandidatesTruncated=recalled.truncated
            e.group.identityInputRef.newMessages=identitySourceRows
            e.group.identityInputRef.now=new Date(this.now()).toISOString()
          }
        }
      }
      if (e.mode === 'apply') {
        // 議題目標與既有議題每次領取都重算（旗標被關、聊天室被降級、訊息已被分析過，這一片就退回純待辦）。
        const freshTopic = this.combinedTopic(e.chatId, e.msgIds)
        if (freshTopic) e.input.topic = freshTopic
        else delete e.input.topic
      }
      if (e.mode === 'apply' || e.input.identitySnapshot) {
        const latestOpenTodos = getOpenTodosByChat(e.chatId, this.opts.db)
        if(e.group?.identityInputRef)e.group.identityInputRef.openTodos=latestOpenTodos
        const refreshedParts = partitionExtractInput({ ...e.input, openTodos: latestOpenTodos }, { maxChars: this.maxChars, contextLimit: this.opts.getConfig().recentContextLimit })
        if (refreshedParts.length === 0) { if(e.group)this.failGroup(e.group,new Error('identity_empty_payload'));else this.entries.delete(e.id);continue }
        if (refreshedParts.length > 1) {
          const additionalParts = refreshedParts.length - 1
          const nextPartCount = e.partCount + additionalParts
          const entries = [...this.entries.entries()]
          const entryIndex = entries.findIndex(([id]) => id === e.id)
          if(e.group)e.group.results.splice(e.partIndex+1,0,...new Array(additionalParts).fill(undefined))
          if(e.group)e.group.remaining+=additionalParts
          for (const sibling of this.entries.values()) {
            if (sibling.id === e.id || sibling.chatId !== e.chatId || sibling.mode !== e.mode || sibling.state !== 'pending' || sibling.group!==e.group || (e.mode==='apply'&&sibling.gen!==e.gen)) continue
            if (sibling.partIndex > e.partIndex) sibling.partIndex += additionalParts
            sibling.partCount = nextPartCount
          }
          const replacements = refreshedParts.map((part, index): [string, Entry] => {
            const id = index === 0 ? e.id : randomUUID()
            return [id, {
              ...e, id, msgIds: part.msgIds, input: part.input, user: part.user, truncated: part.truncated,
              partIndex: e.partIndex + index, partCount: nextPartCount, itemId: null, leaseUntil: 0
            }]
          })
          this.entries.clear()
          const before = entryIndex < 0 ? entries : entries.slice(0, entryIndex)
          const after = entryIndex < 0 ? [] : entries.slice(entryIndex + 1)
          for (const [id, entry] of [...before, ...replacements, ...after]) this.entries.set(id, entry)
          busyChats.add(e.chatId)
          soonest = soonest === null ? now : Math.min(soonest, now)
          continue
        }
        e.msgIds = refreshedParts[0].msgIds
        e.input = refreshedParts[0].input
        e.user = refreshedParts[0].user
        e.truncated = refreshedParts[0].truncated
      }
      const item: PullItem = {
        itemId: randomUUID(), chatId: e.chatId, chatName: e.chatName, user: e.user, userChars: e.user.length, messageCount: e.msgIds.length,
        attempts: e.attempts, part: e.partIndex + 1, parts: e.partCount, truncatedMessages: e.truncated
      }
      const withTopics = e.mode === 'apply' && e.input.topic !== undefined
      if (withTopics) item.topics = true
      const size = Buffer.byteLength(JSON.stringify(item))
      if (items.length > 0 && bytes + size > budget) break
      if (e.input.identitySnapshot) {
        const reusableLease=e.sourceLease??(e.mode==='await'?(e.group?.sourceLease??e.input.identitySnapshot.sourceLease):undefined)
        let lease:ChatSourceLease|null=reusableLease??null
        if(lease){
          const attempt=recordIdentitySourceAttempt(this.opts.db,lease,e.user)
          if(!attempt.ok){releaseIdentitySourceAttempt(this.opts.db,lease,true);if(e.group)this.failGroup(e.group,new Error('identity_context_stale'));else this.recordFailure(e,'identity_context_stale');continue}
          lease=attempt.lease
        } else {
          const systemSha=(withTopics?this.opts.getSystemSha256?.(e.chatId,{topics:true}):this.opts.getSystemSha256?.(e.chatId))??EXTRACT_SYSTEM_SHA256
          const sessionFingerprint=createHash('sha256').update(JSON.stringify({systemSha256:systemSha,schema:EXTRACT_JSON_SCHEMA.schema,identityQuery:IDENTITY_QUERY_VERSION,sessionContext:this.opts.getSessionContext?.()??'',...(withTopics?{combined:{prompt:COMBINED_PROMPT_HASH,schema:COMBINED_SCHEMA_HASH}}:{})})).digest('hex')
          const begun=beginIdentitySourceAttempt(this.opts.db,e.chatId,e.input.identitySnapshot,e.user,sessionFingerprint)
          if(!begun.lease) {
            if(begun.reason==='lease_busy') {e.notBefore=now+1000;soonest=soonest===null?e.notBefore:Math.min(soonest,e.notBefore);continue}
            if(e.group) this.failGroup(e.group,new Error('identity_context_stale'))
            else this.entries.delete(e.id)
            continue
          }
          lease=begun.lease
        }
        e.sourceLease=lease
        e.input.identitySnapshot.sourceLease=lease
        if(e.group){e.group.sourceLease=lease;if(e.group.identitySnapshotRef)e.group.identitySnapshotRef.sourceLease=lease}
        item.sessionEpoch=lease.sessionEpoch
        const leaseId=lease.leaseId
        item.onAdditionalUserPayload=(serializedUserPayload)=>{
          const current=e.sourceLease
          if(!current||current.leaseId!==leaseId)return false
          const attempt=recordIdentitySourceAttempt(this.opts.db,current,serializedUserPayload,new Date(),false)
          if(!attempt.ok)return false
          e.sourceLease=attempt.lease
          if(e.input.identitySnapshot)e.input.identitySnapshot.sourceLease=attempt.lease
          if(e.group){e.group.sourceLease=attempt.lease;if(e.group.identitySnapshotRef)e.group.identitySnapshotRef.sourceLease=attempt.lease}
          return true
        }
      }
      e.state = 'leased'
      e.itemId = item.itemId
      e.leaseUntil = now + leaseMs
      busyChats.add(e.chatId)
      bytes += size
      items.push(item)
      try { e.input.onCorrectionsPayloadBuilt?.() } catch { /* 稽核 hook 失敗不影響供料 */ }
      if (items.length >= maxItems) break
    }
    return {
      // 只代表預設值（不帶 chatId）；各對話實際的 system 指紋看 chat_context_cache.session_fingerprint（上面 getSystemSha256(e.chatId)）。
      ok: true, items, pending: this.countState('pending'), leased: this.countState('leased'), systemSha256: this.opts.getSystemSha256?.() ?? EXTRACT_SYSTEM_SHA256,
      maxUserChars: this.maxChars, retryAfterMs: items.length === 0 && soonest !== null ? Math.max(0, soonest - now) : null
    }
  }

  // ── inbox：commit ──

  commit(params: { results: CommitRequestItem[] }): CommitResult {
    this.reap()
    this.uiSeenAt = this.commitAt = this.stallNow()
    const out: CommitItemResult[] = []
    const tally: ApplyTally & { chatsProcessed: number; chatsFailed: number } = {
      todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [], chatsProcessed: 0, chatsFailed: 0
    }
    const topicChatIds = new Set<string>()
    let runId: string | null = null
    const leased = new Map<string, Entry>()
    for (const e of this.entries.values()) if (e.state === 'leased' && e.itemId) leased.set(e.itemId, e)

    for (const item of params.results) {
      const itemId = typeof item?.itemId === 'string' ? item.itemId : ''
      if (!itemId || typeof item.ok !== 'boolean') { out.push({ itemId, status: 'bad_request', code: 'invalid_commit_item' }); continue }
      const entry = leased.get(itemId)
      if (!entry) { out.push({ itemId, status: 'unknown_item', code: 'lease_expired_or_unknown' }); continue }
      leased.delete(itemId)

      if (!item.ok) {
        const code = typeof item.failCode === 'string' && /^[a-z0-9_]{1,48}$/.test(item.failCode) ? item.failCode : 'ai_failed'
        if(entry.sourceLease) releaseIdentitySourceAttempt(this.opts.db,entry.sourceLease,true)
        const failedWithTopic = entry.mode === 'apply' && entry.input.topic !== undefined
        const retryInMs = this.recordFailure(entry, code, item.retryAfterMs)
        if (failedWithTopic) this.noteTopicFailure(entry.chatId, code === 'system_too_large')
        tally.chatsFailed += 1
        out.push({ itemId, status: 'failed_recorded', chatId: entry.chatId, code, retryInMs })
        continue
      }

      const topicSent = entry.mode === 'apply' && !!entry.input.identitySnapshot && entry.input.topic !== undefined
      let extract = null as ExtractResult | null
      let combinedTopic = null as TopicAnalysis | null
      let topicTargets: TopicMessageInput[] = []
      let topicFailure: { reason: string; path: string | null; stage: 'domain_validate' } | null = null
      let todoError: unknown = null
      try {
        if (topicSent) {
          topicTargets = this.topicTargetsOf(entry)
          const split = splitCombined(item.result, {
            todo: {
              candidates: entry.input.identityCandidates, candidatesTruncated: entry.input.identityCandidatesTruncated,
              selectedMessageIds: entry.msgIds, targetType: 'todo', allowedTodoIds: entry.input.openTodos.map((todo) => todo.id)
            },
            topic: { targets: topicTargets, candidates: entry.input.identityCandidates, candidatesTruncated: entry.input.identityCandidatesTruncated }
          })
          this.noteReply(item.result)
          if (split.topic.state === 'ok') combinedTopic = split.topic.value
          else if (split.topic.state === 'fail') {
            const err = split.topic.error
            topicFailure = err instanceof TopicAnalysisValidationError
              ? { stage: 'domain_validate', reason: err.reason, path: err.path }
              : { stage: 'domain_validate', reason: 'invalid_shape', path: '$' }
          } else topicFailure = { stage: 'domain_validate', reason: 'invalid_shape', path: '$' }
          if (split.todo.ok) extract = split.todo.value
          else { extract = null; todoError = split.todo.error }
          if (extract === null && combinedTopic === null) throw todoError
        } else {
          extract = entry.input.identitySnapshot ? validateExtractResult(item.result,{
            candidates:entry.input.identityCandidates,candidatesTruncated:entry.input.identityCandidatesTruncated,
            selectedMessageIds:entry.msgIds,targetType:'todo',allowedTodoIds:entry.input.openTodos.map((todo)=>todo.id)
          }) : validateExtractResult(item.result)
        }
      } catch (error) {
        if(entry.sourceLease) releaseIdentitySourceAttempt(this.opts.db,entry.sourceLease,true)
        const retryInMs = this.recordFailure(entry, 'invalid_result')
        if (topicSent) this.noteTopicFailure(entry.chatId, false)
        tally.chatsFailed += 1
        out.push({ itemId, status: 'rejected', chatId: entry.chatId, code: 'invalid_result', issues: issuesOf(error), retryInMs })
        continue
      }

      if (entry.mode === 'await') {
        const group = entry.group!
        this.entries.delete(entry.id)
        if (!group.settled) {
          if(group.identitySnapshotRef) group.identitySnapshotRef.sourceLease=entry.sourceLease??undefined
          group.progressAt = this.stallNow()
          group.results[entry.partIndex] = extract!
          group.remaining -= 1
          if (group.remaining === 0) this.settleGroup(group, mergeResults(group.results as ExtractResult[]))
        }
        out.push({ itemId, status: 'accepted', chatId: entry.chatId })
        continue
      }

      try {
        runId ??= startRun(this.opts.db)
        const local: ApplyTally = { todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [] }
        if(entry.input.identitySnapshot&&!entry.sourceLease) throw new Error('identity_source_lease_missing')
        const identity=entry.input.identitySnapshot&&entry.sourceLease?{
          snapshot:entry.input.identitySnapshot,sourceLease:entry.sourceLease,candidates:entry.input.identityCandidates,
          candidatesTruncated:entry.input.identityCandidatesTruncated,selectedMessageIds:entry.msgIds,targetType:'todo' as const,
          allowedTodoIds:entry.input.openTodos.map((todo)=>todo.id)
        }:undefined
        let topicApplied = false
        if (topicSent) {
          const applied = applyCombinedExtract({
            db: this.opts.db, cfg: this.opts.getConfig(), now: new Date(this.now()).toISOString(), chatId: entry.chatId, msgIds: entry.msgIds,
            identity: identity!, todo: extract,
            topic: combinedTopic ? {
              input: topicTargets, result: combinedTopic, candidates: topicCandidatesOnly(entry.input.identityCandidates),
              versions: { promptVersion: COMBINED_PROMPT_VERSION, promptHash: COMBINED_PROMPT_HASH, schemaVersion: COMBINED_SCHEMA_VERSION, schemaHash: COMBINED_SCHEMA_HASH, validatorVersion: GROUP_TOPICS_VALIDATOR_VERSION }
            } : null,
            identityVersions: { promptVersion: COMBINED_PROMPT_VERSION, schemaVersion: COMBINED_SCHEMA_VERSION },
            tally: local
          })
          topicApplied = applied.topic === 'applied'
          this.afterTopicOutcome(entry, applied.topic, applied.topicError, combinedTopic, topicFailure, topicTargets)
          // 診斷（累計計數，不含訊息內容）：回覆長度＝replyChars／partsWithTopic。
          try { this.opts.log?.('combined_commit', { chatId: entry.chatId, topic: applied.topic, todo: extract !== null, targets: topicTargets.length, ...this.combinedCounters }) } catch { /* 診斷失敗不影響流程 */ }
          if (topicApplied) topicChatIds.add(entry.chatId)
        } else applyChatExtract({ db: this.opts.db, cfg: this.opts.getConfig(), now: new Date(this.now()).toISOString(), ...(identity?{identity}:{}) }, entry.chatId, entry.msgIds, extract!, local)
        tally.todosCreated += local.todosCreated
        tally.todosMerged += local.todosMerged
        tally.todosResolvedDone += local.todosResolvedDone
        tally.todosSuggestedDone += local.todosSuggestedDone
        tally.createdIds.push(...local.createdIds)
        tally.resolvedIds.push(...local.resolvedIds)
        tally.updatedIds.push(...local.updatedIds)
        if (extract === null) {
          // 待辦邊失敗、議題邊已寫入：待辦走現有失敗路徑（退避、訊息維持未處理）；下一次領取時議題目標已被決策過，只送純待辦。
          this.combinedCounters.todoFailedTopicApplied += 1
          if (!isTodoExtractEnabled(this.opts.db, entry.chatId)) {
            if(entry.sourceLease) releaseIdentitySourceAttempt(this.opts.db,entry.sourceLease,true)
            this.entries.delete(entry.id)
            this.chatFail.delete(entry.chatId)
            out.push({ itemId, status: 'rejected', chatId: entry.chatId, code: 'todo_disabled' })
            continue
          }
          const retryInMs = this.recordFailure(entry, 'invalid_result')
          tally.chatsFailed += 1
          out.push({ itemId, status: 'rejected', chatId: entry.chatId, code: 'invalid_result', issues: issuesOf(todoError), retryInMs })
          continue
        }
        tally.chatsProcessed += 1
        this.entries.delete(entry.id)
        // 這個 chat 已經有一片成功 → 清掉失敗記憶（後面的片段不再被退避）。
        this.chatFail.delete(entry.chatId)
        out.push({ itemId, status: 'applied', chatId: entry.chatId, createdIds: local.createdIds, resolvedIds: local.resolvedIds, updatedIds: local.updatedIds })
      } catch (error) {
        if (!isTodoExtractEnabled(this.opts.db, entry.chatId)) {
          if(entry.sourceLease) releaseIdentitySourceAttempt(this.opts.db,entry.sourceLease,true)
          this.entries.delete(entry.id)
          out.push({ itemId, status: 'rejected', chatId: entry.chatId, code: 'todo_disabled' })
          continue
        }
        if(entry.sourceLease) releaseIdentitySourceAttempt(this.opts.db,entry.sourceLease,true)
        const retryInMs = this.recordFailure(entry, 'apply_failed')
        tally.chatsFailed += 1
        out.push({ itemId, status: 'apply_failed', chatId: entry.chatId, code: 'apply_failed', issues: [error instanceof Error ? error.message.slice(0, 200) : 'unknown'], retryInMs })
      }
    }

    let run: CommitResult['run'] = null
    if (runId) {
      const llmStatus: RunOnceResult['llmStatus'] = tally.chatsFailed > 0 && tally.chatsProcessed > 0 ? 'partial' : tally.chatsFailed > 0 ? 'error' : 'ok'
      const result: RunOnceResult = {
        runId, lineBridge: 'ok', llmStatus, newMsgs: 0, chatsSeen: tally.chatsProcessed + tally.chatsFailed, chatsProcessed: tally.chatsProcessed,
        chatsSkippedNoise: 0, chatsSkipped: 0, chatsFailed: tally.chatsFailed, todosCreated: tally.todosCreated, todosMerged: tally.todosMerged,
        todosResolvedDone: tally.todosResolvedDone, todosSuggestedDone: tally.todosSuggestedDone, createdIds: tally.createdIds,
        resolvedIds: tally.resolvedIds, updatedIds: tally.updatedIds, note: null,
        ...(topicChatIds.size ? { topicChatIds: [...topicChatIds] } : {})
      }
      try {
        finishRun(runId, { newMsgs: 0, chatsSeen: result.chatsSeen, todosCreated: result.todosCreated, todosResolved: result.resolvedIds.length, lineBridge: 'ok', llmStatus, note: null }, this.opts.db)
      } catch { /* 收尾記錄失敗不影響已落庫的結果 */ }
      try { this.opts.onRun?.(result) } catch { /* 事件推送失敗不影響落庫 */ }
      run = { runId, todosCreated: result.todosCreated, todosMerged: result.todosMerged, resolved: result.resolvedIds.length, updated: result.updatedIds.length, chatsFailed: result.chatsFailed }
    }
    this.announce()
    return { ok: true, results: out, run, pending: this.countState('pending') }
  }

  /**
   * UI 暫時做不了（看板被隱藏、被 ai:chat 限流、額度用完、provider 還沒就緒…）時把租約還回去：
   * 不算失敗——不增加 attempts、不啟動 per-chat 退避、不改訊息狀態，項目立刻回到可領取。
   */
  release(params: { itemIds: string[] }): { ok: true; released: number; unknown: string[] } {
    this.reap()
    this.uiSeenAt = this.stallNow()
    const wanted = new Set(params.itemIds.filter((id) => typeof id === 'string'))
    let released = 0
    for (const e of this.entries.values()) {
      if (e.state === 'leased' && e.itemId && wanted.delete(e.itemId)) {
        if(e.sourceLease) releaseIdentitySourceAttempt(this.opts.db,e.sourceLease,true)
        if(e.input.identitySnapshot?.sourceLease===e.sourceLease) e.input.identitySnapshot.sourceLease=undefined
        if(e.group?.sourceLease===e.sourceLease){e.group.sourceLease=undefined;if(e.group.identitySnapshotRef)e.group.identitySnapshotRef.sourceLease=undefined}
        e.sourceLease=null
        e.state = 'pending'
        e.itemId = null
        e.leaseUntil = 0
        released += 1
      }
    }
    if (released > 0) this.announce()
    return { ok: true, released, unknown: [...wanted] }
  }

  /**
   * AI port 回報這個聊天室原有的 Host Session 被重建，模型沒有先前的增量上下文：讓下一次供料進位 SourceCache epoch、送完整視窗。
   * Host Session 本身不因此更換；沒有租約在跑的聊天室才標記（多段項目的中途不動，避免後續段落的 commit 因 tainted 失敗）。
   */
  markContextLost(chatId: string): void {
    sharedSourceRows(this.opts.db).taintChat(chatId)
  }

  // ── 觀測 ──

  stats(): { pending: number; leased: number; awaiting: number; chatsBackingOff: number; gen: number } {
    const now = this.now()
    let awaiting = 0
    for (const e of this.entries.values()) if (e.mode === 'await') awaiting += 1
    let backing = 0
    for (const f of this.chatFail.values()) if (f.notBefore > now) backing += 1
    return { pending: this.countState('pending'), leased: this.countState('leased'), awaiting, chatsBackingOff: backing, gen: this.gen }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const e of this.entries.values()) {
      if(e.sourceLease) releaseIdentitySourceAttempt(this.opts.db,e.sourceLease,true)
      if (e.group && !e.group.settled) this.failGroup(e.group, new Error('extract queue disposed'))
    }
    this.entries.clear()
    this.chatFail.clear()
    this.topicDegrade.clear()
    this.fallbackLogged.clear()
  }

  /** 合併整理的診斷計數（測試與診斷用；不含任何訊息內容）。 */
  combinedStats(): Readonly<CombinedCounters> & { degradedChats: number } {
    const now = this.now()
    let degradedChats = 0
    for (const d of this.topicDegrade.values()) if (d.until > now) degradedChats += 1
    return { ...this.combinedCounters, degradedChats }
  }

  // ── 內部 ──

  /** 這個聊天室現在要不要走合併整理：旗標、bundle、聊天室已啟用議題、沒被降級、system 放得下。 */
  private combinedActiveFor(chatId: string): boolean {
    const combined = this.opts.combined
    if (!combined || !combined.enabled()) return false
    if (!COMBINED_BUNDLE_ENABLED || !GROUP_TOPICS_BUNDLE_ENABLED) return false
    try {
      if (!tableExists(this.opts.db, 'discussion_topics') || !tableExists(this.opts.db, 'group_topic_preferences')) return false
      const row = this.opts.db.prepare(
        'SELECT c.blocked AS blocked, p.enabled AS enabled FROM chats c LEFT JOIN group_topic_preferences p ON p.chat_id=c.chat_id WHERE c.chat_id=?'
      ).get(chatId) as { blocked: number; enabled: number | null } | undefined
      if (!row || row.blocked === 1 || row.enabled !== 1) return false
    } catch { return false }
    const degraded = this.topicDegrade.get(chatId)
    if (degraded && degraded.until > this.now()) { this.noteFallback(chatId, 'degraded'); return false }
    let fits = true
    try { fits = combined.systemFits(chatId) } catch { fits = false }
    if (!fits) { this.noteFallback(chatId, 'system_too_large'); return false }
    this.fallbackLogged.delete(`${chatId}:degraded`)
    this.fallbackLogged.delete(`${chatId}:system_too_large`)
    return true
  }

  private noteFallback(chatId: string, reason: 'degraded' | 'system_too_large'): void {
    if (reason === 'degraded') this.combinedCounters.fallbackDegraded += 1
    else this.combinedCounters.fallbackSystemTooLarge += 1
    const key = `${chatId}:${reason}`
    if (this.fallbackLogged.has(key)) return
    this.fallbackLogged.add(key)
    try { this.opts.log?.('combined_fallback_todo_only', { chatId, reason }) } catch { /* 診斷失敗不影響流程 */ }
  }

  /** 這批訊息中要送議題分析的目標與聊天室既有議題；不適用（旗標關、未啟用、沒有目標…）時回 undefined＝純待辦。 */
  private combinedTopic(chatId: string, msgIds: string[]): CombinedTopicPayload | undefined {
    if (!this.combinedActiveFor(chatId)) return undefined
    try {
      const targetMsgIds = selectTopicTargets(this.opts.db, chatId, msgIds)
      if (targetMsgIds.length === 0) return undefined
      return { targetMsgIds, existingLocalTopics: loadTopicCandidates(this.opts.db, chatId) }
    } catch { return undefined }
  }

  private topicTargetsOf(entry: Entry): TopicMessageInput[] {
    const wanted = new Set(entry.input.topic?.targetMsgIds ?? [])
    return entry.input.newMessages.filter((m) => wanted.has(m.msgId))
      .map((m) => ({ msgId: m.msgId, ts: m.ts, direction: m.direction, text: (m.text ?? '').slice(0, 3000) }))
  }

  private noteReply(result: unknown): void {
    let chars = 0
    try { chars = JSON.stringify(result)?.length ?? 0 } catch { chars = 0 }
    this.combinedCounters.partsWithTopic += 1
    this.combinedCounters.replyChars += chars
    this.combinedCounters.replyCharsMax = Math.max(this.combinedCounters.replyCharsMax, chars)
  }

  private noteTopicFailure(chatId: string, immediate: boolean): void {
    this.combinedCounters.topicFailed += 1
    const now = this.now()
    const prev = this.topicDegrade.get(chatId) ?? { fails: 0, until: 0 }
    const fails = immediate ? Math.max(prev.fails + 1, COMBINED_DEGRADE_FAILS) : prev.fails + 1
    const until = fails >= COMBINED_DEGRADE_FAILS ? now + COMBINED_DEGRADE_MS : prev.until
    this.topicDegrade.set(chatId, { fails, until })
    if (fails >= COMBINED_DEGRADE_FAILS && prev.until <= now) {
      try { this.opts.log?.('combined_topic_degraded', { chatId, fails, minutes: COMBINED_DEGRADE_MS / 60_000 }) } catch { /* 診斷失敗不影響流程 */ }
    }
  }

  /** 合併提交成功後的議題邊記帳：成功清零降級計數；缺席、驗證失敗、寫入被捨棄各記一筆失敗（議題的訊息進入集合 B）。 */
  private afterTopicOutcome(entry: Entry, outcome: string, topicError: unknown, topicOk: TopicAnalysis | null, failure: { reason: string; path: string | null; stage: 'domain_validate' } | null, targets: TopicMessageInput[]): void {
    const versions = { promptVersion: COMBINED_PROMPT_VERSION, promptHash: COMBINED_PROMPT_HASH, schemaVersion: COMBINED_SCHEMA_VERSION, schemaHash: COMBINED_SCHEMA_HASH, validatorVersion: GROUP_TOPICS_VALIDATOR_VERSION }
    const record = (stage: 'domain_validate' | 'persist', code: string, reason: string, path: string | null): void => {
      try { recordTopicFailure(this.opts.db, entry.chatId, targets, versions, { stage, code, path, reason, providerKind: 'unknown' }) } catch { /* 記錄失敗不影響已落庫的待辦 */ }
    }
    if (outcome === 'applied') {
      this.combinedCounters.topicApplied += 1
      this.topicDegrade.delete(entry.chatId)
      this.combinedCounters.decisions += topicOk?.identityDecisions?.length ?? 0
      return
    }
    if (outcome === 'discarded') {
      this.combinedCounters.topicDiscarded += 1
      this.noteTopicFailure(entry.chatId, false)
      record('persist', 'persistence_failed', 'persistence_failed', null)
      try { this.opts.log?.('combined_topic_discarded', { chatId: entry.chatId, error: topicError instanceof Error ? topicError.message.slice(0, 120) : 'unknown' }) } catch { /* 診斷失敗不影響流程 */ }
      return
    }
    if (topicOk === null) {
      if (failure && failure.path === '$' && failure.reason === 'invalid_shape') this.combinedCounters.topicAbsent += 1
      this.noteTopicFailure(entry.chatId, false)
      record('domain_validate', 'invalid_output', failure?.reason ?? 'invalid_shape', failure?.path ?? '$')
    }
  }

  private countState(state: Entry['state']): number {
    let n = 0
    for (const e of this.entries.values()) if (e.state === state) n += 1
    return n
  }

  /** 租約逾時的項目回到可領取（UI 掛了或看板被隱藏）。 */
  private reap(): void {
    const now = this.now()
    for (const e of this.entries.values()) {
      if (e.state === 'leased' && e.leaseUntil <= now) {
        if(e.sourceLease) releaseIdentitySourceAttempt(this.opts.db,e.sourceLease,true)
        if(e.input.identitySnapshot?.sourceLease===e.sourceLease) e.input.identitySnapshot.sourceLease=undefined
        if(e.group?.sourceLease===e.sourceLease){e.group.sourceLease=undefined;if(e.group.identitySnapshotRef)e.group.identitySnapshotRef.sourceLease=undefined}
        e.sourceLease=null
        e.state = 'pending'
        e.itemId = null
        e.leaseUntil = 0
        e.attempts += 1
      }
    }
  }

  private recordFailure(entry: Entry, code: string, retryAfterMs?: number): number {
    const now = this.now()
    if(entry.sourceLease) releaseIdentitySourceAttempt(this.opts.db,entry.sourceLease,true)
    if(entry.input.identitySnapshot?.sourceLease===entry.sourceLease) entry.input.identitySnapshot.sourceLease=undefined
    if(entry.group?.sourceLease===entry.sourceLease) entry.group.sourceLease=undefined
    if(entry.group&&entry.group.identitySnapshotRef?.sourceLease===entry.sourceLease) entry.group.identitySnapshotRef.sourceLease=undefined
    entry.sourceLease=null
    if (entry.mode === 'apply' && !isTodoExtractEnabled(this.opts.db, entry.chatId)) {
      this.entries.delete(entry.id)
      this.chatFail.delete(entry.chatId)
      return 0
    }
    if (entry.mode === 'await') {
      // 同步呼叫端（回顧）沿用 extractFn throw 語意：整個 chat 失敗，不在佇列內重試。
      this.entries.delete(entry.id)
      if (entry.group) this.failGroup(entry.group, new Error(code))
      return 0
    }
    const prev = this.chatFail.get(entry.chatId)
    const attempts = (prev?.attempts ?? entry.attempts) + 1
    const base = this.opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
    const max = this.opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS
    const hinted = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, max) : 0
    const delay = Math.max(hinted, Math.min(base * 2 ** (attempts - 1), max))
    const notBefore = now + delay
    this.chatFail.set(entry.chatId, { attempts, notBefore })
    // 同一 chat 的所有待領片段都跟著退避。
    for (const e of this.entries.values()) if (e.chatId === entry.chatId && e.mode === 'apply') { e.attempts = attempts; e.notBefore = notBefore }
    entry.state = 'pending'
    entry.itemId = null
    entry.leaseUntil = 0
    return delay
  }

  /** 停滯計時器：到點時若 UI 與這個呼叫都還有動靜就續等剩餘時間，否則判停滯。 */
  private armStall(group: AwaitGroup, delayMs: number): void {
    const fire = (): void => {
      if (group.settled || this.disposed) return
      const idle = this.stallNow() - Math.max(group.progressAt, this.commitAt)
      if (idle >= this.awaitTimeoutMs) { this.failGroup(group, new Error('extract_await_timeout')); return }
      this.armStall(group, Math.max(1, this.awaitTimeoutMs - idle))
    }
    group.cancel?.()
    if (this.opts.schedule) { group.cancel = this.opts.schedule(fire, delayMs); return }
    const timer = setTimeout(fire, delayMs)
    timer.unref?.()
    group.cancel = () => clearTimeout(timer)
  }

  private settleGroup(group: AwaitGroup, value: ExtractResult): void {
    if (group.settled) return
    group.settled = true
    group.cancel?.()
    group.resolve(value)
  }

  private failGroup(group: AwaitGroup, error: Error): void {
    if (group.settled) return
    group.settled = true
    group.cancel?.()
    const released=new Set<string>()
    for (const [id, e] of this.entries) if (e.group === group) {
      if(e.sourceLease&&!released.has(e.sourceLease.leaseId)){
        releaseIdentitySourceAttempt(this.opts.db,e.sourceLease,true)
        released.add(e.sourceLease.leaseId)
      }
      if(e.input.identitySnapshot?.sourceLease===e.sourceLease)e.input.identitySnapshot.sourceLease=undefined
      e.sourceLease=null
      this.entries.delete(id)
    }
    if(group.sourceLease&&!released.has(group.sourceLease.leaseId)) releaseIdentitySourceAttempt(this.opts.db,group.sourceLease,true)
    if(group.identitySnapshotRef&&group.identitySnapshotRef.sourceLease===group.sourceLease)group.identitySnapshotRef.sourceLease=undefined
    group.sourceLease=undefined
    group.reject(error)
    this.announce()
  }

  /** 可領項目集合變了才通知（每個 cycle 重新供料同樣的內容不會洗版）。 */
  private announce(): void {
    if (this.disposed) return
    const now = this.now()
    const ids: string[] = []
    for (const e of this.entries.values()) if (e.state === 'pending' && e.notBefore <= now) ids.push(`${e.chatId}:${e.msgIds[0]}:${e.msgIds.length}:${e.mode}`)
    const key = ids.sort().join('|')
    if (key === this.lastPendingKey) return
    this.lastPendingKey = key
    if (ids.length > 0) { try { this.opts.onPending?.({ pending: ids.length }) } catch { /* 通知失敗不影響佇列 */ } }
  }
}
