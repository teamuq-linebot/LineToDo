/**
 * combinedApply.ts — 合併整理（待辦＋議題）的單一提交：兩邊本體串在同一個 sourceLease 的 commitLease 交易裡。
 *
 * 為什麼快照斷言要前置：assertIdentitySnapshotCurrent 會比對快照內「所有」候選的版本（不分 todo 或 topic）。
 * 待辦的 update_existing 會遞增 todos.entity_revision、議題的會遞增 discussion_topics.revision；各自在本體開頭斷言的話，
 * 後跑的一邊會被誤判為 stale。所以在任何本體執行之前，一次斷言兩類，兩個本體都以 skipSnapshotAssert 呼叫。
 *
 * 半成功語意（設計 §4.3）：
 *   - 待辦本體拋錯 → 整包回滾（markProcessed 由待辦負責）。
 *   - 議題本體包在 SQLite savepoint（巢狀 db.transaction）：失敗就捨棄議題、保留待辦。
 *   - 只有一邊可用時只套用那一邊（todo=null 時 processed 維持 0）。
 */
import type { Database } from 'better-sqlite3'
import type { PipelineDefaults } from '../config/defaults'
import { assertIdentitySnapshotCurrent } from '../db/identity.repo'
import { getRecentByChat } from '../db/messages.repo'
import { runImmediateTransaction, sharedSourceRows } from '../db/sourceCache'
import type { ExtractResult } from '../llm/schema'
import { buildTopicSave, type AnalysisVersions } from '../features/groupTopics/repository'
import type { TopicAnalysis, TopicMessageInput } from '../features/groupTopics/domain'
import { buildTodoApply, type ApplyTally, type ChatIdentityApplyContext } from './runOnce'

export type CombinedTopicOutcome = 'applied' | 'none' | 'skipped_inactive' | 'skipped_complete' | 'discarded'

export interface CombinedApplyInput {
  db: Database
  cfg: PipelineDefaults
  now: string
  chatId: string
  msgIds: string[]
  /** 必須帶 sourceLease。 */
  identity: ChatIdentityApplyContext
  /** null＝待辦邊沒有可用結果：不套用待辦、不標 processed。 */
  todo: ExtractResult | null
  /** null＝議題邊缺席或失敗：不寫議題。 */
  topic: { input: TopicMessageInput[]; result: TopicAnalysis; versions: AnalysisVersions; candidates: ChatIdentityApplyContext['candidates'] } | null
  identityVersions: { promptVersion: string; schemaVersion: string }
  tally: ApplyTally
}

export interface CombinedApplyResult {
  todoApplied: boolean
  topic: CombinedTopicOutcome
  /** topic==='discarded' 時，被捨棄的議題本體所拋出的錯誤（供診斷）。 */
  topicError?: unknown
}

export function applyCombinedExtract(input: CombinedApplyInput): CombinedApplyResult {
  const { db, chatId, msgIds, identity } = input
  if (!identity.sourceLease) throw new Error('combined_identity_source_lease_required')
  const lease = identity.sourceLease
  const snapshot = identity.snapshot
  const selectedRows = snapshot.selectedFingerprints.filter((row) => msgIds.includes(row.msgId))
  const todoBody = input.todo
    ? buildTodoApply({ db, cfg: input.cfg, now: input.now, identity, identityVersions: input.identityVersions }, chatId, msgIds, input.todo, input.tally, { skipSnapshotAssert: true })
    : null
  const outcome: CombinedApplyResult = { todoApplied: false, topic: 'none' }
  const committed = sharedSourceRows(db).commitLease({
    lease, selectedRows,
    fallbackRecent: () => getRecentByChat(chatId, 10, db),
    apply: () => {
      const tx = db.transaction(() => {
        outcome.todoApplied = false
        outcome.topic = 'none'
        delete outcome.topicError
        assertIdentitySnapshotCurrent(db, chatId, snapshot, 'todo')
        assertIdentitySnapshotCurrent(db, chatId, snapshot, 'topic')
        if (input.topic) {
          try {
            const built = buildTopicSave(db, chatId, input.topic.input, input.topic.result, input.topic.versions,
              { snapshot, sourceLease: lease, candidates: input.topic.candidates, candidatesTruncated: identity.candidatesTruncated }, { skipSnapshotAssert: true })
            const saved = built.tx()
            outcome.topic = saved === true ? 'applied' : saved === 'inactive' ? 'skipped_inactive' : 'skipped_complete'
          } catch (error) {
            outcome.topic = 'discarded'
            outcome.topicError = error
          }
        }
        if (todoBody) { todoBody(); outcome.todoApplied = true }
      })
      runImmediateTransaction(tx)
    }
  })
  if (!committed.ok) throw new Error(`combined_identity_commit_${committed.reason}`)
  return outcome
}
