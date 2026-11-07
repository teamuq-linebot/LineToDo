/**
 * combined-queue-harness.mjs — test-combined-queue.mjs 與基準快照共用的測試夾具。
 *
 * 這個檔只用 0.2.10（cab5354）就已存在的 API：基準快照（fixtures/combined-off-baseline.json）就是把 captureOffBaseline()
 * 原封不動放到 cab5354 的樹上跑出來的；旗標 OFF 的測試在新樹上重跑同一個函式，要求結果逐字相同。
 * 所以這裡不能 import 任何合併整理的新符號。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import NativeDatabase from 'better-sqlite3-plugin'
import { createBetterSqlite3AppEngine } from '../../src/main/db/appDbEngine.ts'
import { openDatabase } from '../../src/main/db/database.ts'
import { createTodo } from '../../src/main/db/todos.repo.ts'
import { insertMessages } from '../../src/main/db/messages.repo.ts'
import { advanceIdentityIndex } from '../../src/main/db/identity.repo.ts'
import { runOnce } from '../../src/main/pipeline/runOnce.ts'
import { ExtractQueue } from '../../src/plugin/backend/extractQueue.ts'
import { getPipelineDefaults } from '../../src/main/config/defaults.ts'
import { ensureGroupTopicsSchema, setEnabled } from '../../src/main/features/groupTopics/repository.ts'
import { createSettingsStore } from '../../src/main/config/settings.ts'
import { createPromptService } from '../../src/plugin/backend/promptService.ts'

export const NOW_ISO = '2026-11-03T08:00:00.000Z'
export const NOW_MS = Date.parse(NOW_ISO)
export const stored = (id) => `i:${id}`

export function openFixture() {
  const engine = createBetterSqlite3AppEngine({ driver: NativeDatabase })
  return openDatabase({ dbPath: ':memory:', engine })
}

export function rawMessage(id, chatId, ts, text, direction = 'in') {
  return { msgId: id, chat: `Group ${chatId}`, chatId, isGroup: true, ts, time: new Date(ts).toISOString().slice(0, 19), direction, sender: 'Alice', text, contentType: 0 }
}

export function addMessages(db, chatId, items) {
  insertMessages(items.map(([id, ts, text, direction]) => rawMessage(id, chatId, ts, text, direction)), db)
  return items.map(([id]) => stored(id))
}

export function drainIndexes(db, chatId) {
  for (const type of ['todo', 'topic']) {
    let done = false
    for (let i = 0; i < 100 && !done; i += 1) done = advanceIdentityIndex(db, chatId, type, 50)
    if (!done) throw new Error(`${type}_index_did_not_finish`)
  }
}

const noSecrets = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } }

/** 只含舊 API 的 runOnce 供料：訊息已在 DB 裡（未處理），watchSource 回空。 */
export async function feedQueue(db, queue) {
  return runOnce({ db, now: () => NOW_ISO, watchSource: async () => ({ messages: [], bridge: 'ok' }), extractFn: async () => { throw new Error('sink mode never calls extractFn') }, extractSink: queue })
}

const noiseReply = () => ({ importance: 'noise', newTodos: [], identityDecisions: [], resolved: [], updates: [] })

/**
 * 旗標 OFF（或 0.2.10）的基準快照：已啟用議題的群組、數個 part，逐個記下 pull 出來的 user、item 欄位、system、system 雜湊與 session 指紋。
 * 回覆一律用合法的純待辦 noise，讓下一個 part 可以領。
 */
export async function captureOffBaseline(queueOptions = {}, prepare = undefined) {
  const opened = openFixture()
  const db = opened.db
  if (prepare) prepare(db)
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-baseline-'))
  const chatId = 'group-baseline'
  try {
    const items = []
    for (let i = 1; i <= 9; i += 1) items.push([`b${i}`, 1_000 + i * 10, `第 ${i} 則：專案 Orion 的進度討論，需要準備簡報與確認時程 ${'細節'.repeat(90)}`, i % 4 === 0 ? 'out' : 'in'])
    addMessages(db, chatId, items)
    ensureGroupTopicsSchema(db)
    setEnabled(db, chatId, true)
    const seededTodo = createTodo({ chatId, bucket: 'todo', status: 'pending', title: '先前的待辦 準備簡報', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [stored('b1')] }, db)
    const normalize = (text) => text.split(seededTodo.id).join('<todo-id>')
    drainIndexes(db, chatId)
    const queue = new ExtractQueue({ db, getConfig: getPipelineDefaults, now: () => NOW_MS, maxUserChars: 3200, ...queueOptions })
    await feedQueue(db, queue)
    const prompts = createPromptService(createSettingsStore({ userDataDir: dir, secrets: noSecrets }), { complete: async () => { throw new Error('unused') } })
    const parts = []
    for (let guard = 0; guard < 12; guard += 1) {
      const pulled = queue.pull({ max: 1 })
      const item = pulled.items[0]
      if (!item) break
      const { itemId, ...stable } = item
      const user = normalize(item.user)
      parts.push({ item: { ...stable, user }, itemKeys: Object.keys(item).sort(), userSha256: createHash('sha256').update(user).digest('hex') })
      const committed = queue.commit({ results: [{ itemId, ok: true, result: noiseReply() }] })
      if (committed.results[0].status !== 'applied') throw new Error(`baseline commit: ${committed.results[0].status}`)
    }
    const fingerprint = db.prepare('SELECT session_fingerprint AS fp FROM chat_context_cache WHERE chat_id=?').get(chatId)?.fp ?? null
    queue.dispose()
    return JSON.parse(JSON.stringify({
      parts,
      system: prompts.extractSystem(chatId),
      systemSha256: prompts.systemSha256(chatId),
      defaultSystem: prompts.extractSystem(),
      sessionFingerprint: fingerprint
    }))
  } finally {
    opened.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
