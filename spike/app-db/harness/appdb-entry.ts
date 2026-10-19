// Bundled by build.mjs (esbuild) together with the UNMODIFIED line-todo src/main/db/** code.
// `better-sqlite3` is redirected to harness/shim-better-sqlite3.mjs, so database.ts / migrate.ts /
// *.repo.ts run on whichever engine the permissioned child installed.
// Each exported phase is run in its own process (a restart between phases).
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { openDatabase, DbIntegrityError } from '../../../src/main/db/database'
import { createRepositories } from '../../../src/main/db/repositories'
import { SCHEMA_VERSION } from '../../../src/main/db/schema'
import { ensureLineImportSchema, isLineImportSchemaReady, commitLineImportBatch, lineImportBatchId } from '../../../src/main/db/lineImport.repo'

type Any = any
const BASE = Date.UTC(2026, 8, 28, 1, 0, 0) // 2026-09-28T01:00:00Z, fixed fixture epoch
const SEEN_AT = '2026-09-28T00:00:00.000Z'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g
const SEEN_ISO = /2026-09-28T00:00:00\.000Z/g
const replacer = (_k: string, v: Any) => (typeof v === 'bigint' ? `${v}n` : v)
const stable = (v: Any) => JSON.stringify(v, replacer)
// Cross-engine comparison: random UUIDs and wall-clock timestamps are masked (fixed fixture times kept)
const normStr = (s: string) => s.replace(SEEN_ISO, '<seen>').replace(UUID, '<uuid>').replace(ISO, '<now>')
const norm = (v: Any) => (v === undefined ? '<undefined>' : JSON.parse(normStr(stable(v))))
const normSet = (arr: Any[]) => arr.map((x) => normStr(stable(x))).sort()
const ms = (x: number) => Math.round(x * 100) / 100
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function withLogCapture<T>(fn: () => T): { value?: T; logs: string[]; error?: Any } {
  const logs: string[] = []
  const ol = console.log, oe = console.error, ow = console.warn
  console.log = (...a: Any[]) => logs.push('log ' + a.map(String).join(' '))
  console.error = (...a: Any[]) => logs.push('error ' + a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '))
  console.warn = (...a: Any[]) => logs.push('warn ' + a.map(String).join(' '))
  try { return { value: fn(), logs } } catch (error) { return { error, logs } } finally { console.log = ol; console.error = oe; console.warn = ow }
}
const errInfo = (e: Any) => ({ name: e?.name, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 300), isDbIntegrityError: e instanceof DbIntegrityError })

/** Content digest of every user table (ordered by rowid) + schema digest. */
export function dbDigest(db: Any) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r: Any) => r.name)
  const h = createHash('sha256'), hn = createHash('sha256')
  const rowCounts: Record<string, number> = {}
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all().map((r: Any) => ({ ...r }))
    const s = stable(rows)
    h.update(t + '\0' + s); hn.update(t + '\0' + normStr(s))
    rowCounts[t] = rows.length
  }
  const schema = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all().map((r: Any) => ({ ...r }))
  return { rowCounts, digest: h.digest('hex'), normalizedDigest: hn.digest('hex'), schemaDigest: sha(stable(schema)) }
}

function connState(db: Any) {
  return {
    journalMode: db.pragma('journal_mode', { simple: true }),
    lockingMode: db.pragma('locking_mode', { simple: true }),
    foreignKeys: db.pragma('foreign_keys', { simple: true }),
    busyTimeout: db.pragma('busy_timeout', { simple: true }),
    userVersion: db.pragma('user_version', { simple: true }),
    quickCheck: db.pragma('quick_check', { simple: true }),
  }
}

function makeMsgs(n: number, offset: number, idPrefix: string) {
  const chats = [
    { chatId: 'u-alice', chat: 'Alice 愛麗絲', isGroup: false },
    { chatId: 'c-team', chat: '專案群 🚀', isGroup: true },
    { chatId: 'c-noise', chat: 'Noise', isGroup: true },
  ]
  const out: Any[] = []
  for (let i = 0; i < n; i++) {
    const c = chats[i % 3]
    const k = offset + i
    const media = k % 50 === 0
    out.push({
      msgId: k % 97 === 0 ? null : `${idPrefix}${k}`, // a few rows without LINE _id -> 'd:' sha1 key path
      chat: c.chat, chatId: c.chatId, isGroup: c.isGroup,
      ts: BASE + k * 1000, time: new Date(BASE + k * 1000).toISOString().slice(0, 19),
      direction: k % 4 === 0 ? 'out' : 'in', sender: k % 4 === 0 ? 'me' : `成員${k % 7}`,
      text: media ? '[image]' : `訊息 ${k} 請幫忙確認報價 ✅ ${'x'.repeat(k % 13)}`,
      contentType: media ? 1 : 0,
    })
  }
  return out
}

const identityStub = (epoch: string | null) => ({
  epoch: () => epoch,
  resolve: (i: Any) => (i.senderMid ? { participantKey: sha(`${epoch}|${i.chatId}|${i.senderMid}`).slice(0, 32), scope: 'chat', keyVersion: 1, status: 'keyed' } : { participantKey: null, scope: 'unknown', keyVersion: null, status: 'unknown', reason: 'source_id_missing' }),
})

function importBatch(from: number, n: number, bad = false) {
  const items = makeMsgs(n, from, 'imp').map((message: Any, i: number) => ({ message, sourceRowId: from + i, senderMid: i % 5 === 0 ? null : `u-mid-${i % 4}`, accountMid: 'u-mid-0' }))
  if (bad) items.push({ message: { ...items[0].message, msgId: `imp-bad-${from}`, direction: 'sideways' }, sourceRowId: from + n, senderMid: null, accountMid: 'u-mid-0' })
  const cursorFrom = { createdTime: BASE + from * 1000, rowId: from }, cursorTo = { createdTime: BASE + (from + n) * 1000, rowId: from + n }
  return { batchId: lineImportBatchId('line-backfill', cursorFrom, cursorTo) + (bad ? '-bad' : ''), source: 'line-backfill', cursorFrom, cursorTo, hasMore: false, observedAt: SEEN_AT, items }
}

function summarizeInsert(r: Any) { return { attempted: r.attempted, inserted: r.inserted, mediaBackfilled: r.mediaBackfilled, unsentMarked: r.unsentMarked, chatIds: [...r.chatIds].sort(), insertedIdsSha: sha(stable(r.insertedMsgIds)) } }

/** Every repository entry point of createRepositories() + lineImport.repo, on a fixed fixture. */
function exercise(db: Any) {
  const repos = createRepositories(db)
  const L: Record<string, Any> = {}
  const T: Record<string, number> = {}
  const time = <X>(k: string, f: () => X): X => { const t0 = performance.now(); const v = f(); T[k] = ms(performance.now() - t0); return v }

  L.chatUpsert = normSet([
    repos.chats.upsert({ chatId: 'u-alice', name: 'Alice 愛麗絲', isGroup: false, seenAt: SEEN_AT }),
    repos.chats.upsert({ chatId: 'c-team', name: '專案群 🚀', isGroup: true, seenAt: SEEN_AT }),
    repos.chats.upsert({ chatId: 'c-noise', name: 'Noise', isGroup: true, seenAt: SEEN_AT }),
  ])
  L.chatBlock = norm(repos.chats.setBlocked('c-noise', true, 'spam'))
  L.chatBlockMissing = norm(repos.chats.setBlocked('nope', true))
  L.chatGet = norm(repos.chats.get('c-team'))
  L.chatListDefault = normSet(repos.chats.list())
  L.chatListAll = normSet(repos.chats.list({ includeBlocked: true }))

  const msgs = makeMsgs(2000, 0, 'm')
  L.insert1 = summarizeInsert(time('insertBatch2000', () => repos.messages.insertBatch(msgs)))
  // second pass: media rows gain keyMaterial (backfill path), some rows are unsent (markUnsent path)
  const pass2 = msgs.filter((m: Any, i: number) => i % 50 === 0 || i % 333 === 1).map((m: Any, i: number) => (m.contentType === 1 ? { ...m, keyMaterial: Buffer.alloc(32, i).toString('base64'), fileName: null, fileSize: 1000 + i } : { ...m, unsent: true }))
  L.insert2 = summarizeInsert(repos.messages.insertBatch(pass2))
  L.insertSingle = summarizeInsert(repos.messages.insert({ ...makeMsgs(1, 5000, 'single')[0] }))
  // transaction atomicity through the real repo: one CHECK-violating row must roll back the batch
  const before = repos.messages.count()
  try { repos.messages.insertBatch([...makeMsgs(3, 6000, 'rb'), { ...makeMsgs(1, 6003, 'rb')[0], direction: 'sideways' }]); L.batchRollback = { threw: false } } catch (e) { L.batchRollback = { threw: true, error: String((e as Any).message).slice(0, 80), countUnchanged: repos.messages.count() === before } }

  L.list = norm(time('listMessages50', () => repos.messages.list({ chatId: 'c-team', limit: 50 })))
  L.listBefore = norm(repos.messages.list({ beforeTs: BASE + 10_000, limit: 5 }))
  L.recent = norm(repos.messages.recentByChat('u-alice', 30))
  L.since = repos.messages.byChatSince('u-alice', BASE + 1_500_000).length
  L.count = repos.messages.count(); L.countChat = repos.messages.count('c-team')
  L.countRecent = repos.messages.countChatsWithRecent(7)
  const unproc = repos.messages.unprocessedForPipeline(100)
  L.unproc = { n: unproc.length, firstLast: norm([unproc[0], unproc.at(-1)]) }
  L.markProcessed = repos.messages.markProcessed(unproc.map((m: Any) => m.msgId))
  L.unprocAfter = repos.messages.unprocessedForPipeline(2000).length

  const src = repos.messages.list({ chatId: 'c-team', limit: 3 }).map((m: Any) => m.msgId)
  const mk = (title: string, extra: Any = {}) => repos.todos.create({ chatId: 'c-team', bucket: 'todo', title, sourceMsgIds: src, ...extra })
  const t1 = mk('準備報價單', { priority: 1, dueAt: '2026-10-05' })
  const t2 = mk('等對方回覆規格', { bucket: 'waiting', status: 'waiting_reply' })
  const t3 = mk('週會', { bucket: 'schedule', status: 'scheduled', dueAt: '2026-10-03' })
  const t4 = mk('寄樣品'), t5 = mk('確認匯款', { confidence: 0.9, detail: '金額 12,000' })
  const t6 = repos.todos.create({ chatId: 'u-alice', bucket: 'todo', title: '垃圾訊息待辦', sourceMsgIds: [] })
  const t7 = mk('群組公告：週五停機')
  L.todoCreate = normSet([t1, t2, t3, t4, t5, t6, t7])
  L.todoGet = norm(repos.todos.get(t1.id)); L.todoGetMissing = norm(repos.todos.get('missing'))
  L.todoList = normSet(time('listTodos', () => repos.todos.list({})))
  L.todoListFiltered = normSet(repos.todos.list({ statuses: ['pending'], buckets: ['todo'], chatId: 'c-team', sortBy: 'dueAt', sortDirection: 'asc' }))
  L.openByChat = normSet(repos.todos.openByChat('c-team'))
  L.updateStatus = norm(repos.todos.updateStatus(t2.id, 'pending'))
  L.update = norm(repos.todos.update(t1.id, { title: '準備報價單 v2', detail: '含運費', dueAt: '2026-10-06', priority: 3, sourceMsgIds: [...src, 'extra'] }))
  L.updateNoop = norm(repos.todos.update(t1.id, {}))
  L.reclassify = repos.todos.reclassify(t4.id, { bucket: 'schedule', dueAt: '2026-10-10' })
  L.reclassifySame = repos.todos.reclassify(t4.id, { bucket: 'schedule', dueAt: '2026-10-10' })
  L.moveColumn = norm(repos.todos.moveColumn(t3.id, 'done'))
  L.mergeSources = norm(repos.todos.mergeSources(t1.id, ['extra', 'new-1']))
  L.resolve = norm(repos.todos.resolve(t5.id, '對方已回覆', true))
  L.dismissKw = repos.todos.dismissOpenByChat('u-alice', '垃圾')
  L.todoCount = repos.todos.count()

  const marked = repos.notMine.mark(t7.id, 'general_announcement', '群組公告')
  L.nmMark = norm(marked)
  L.nmMarkAgain = norm(repos.notMine.mark(t7.id, 'other'))
  const fid = marked.feedbackId as string
  L.nmList = norm(repos.notMine.list())
  L.nmGet = norm(repos.notMine.get(fid))
  L.nmAnalyze = repos.notMine.analyze(fid, { analysisVersion: 'v1', inferredCauseCode: 'announcement', summary: '公告非指派', providerId: 'qwen' as Any, modelId: null, suggestedCondition: '公告', suggestedEffect: '忽略' })
  L.nmApply1 = norm(repos.notMine.apply(fid, '群組公告', '不建立待辦'))
  L.nmApply2 = norm(repos.notMine.apply(fid, '群組公告（含停機）', '不建立待辦'))
  const corrections = repos.notMine.listCorrections()
  L.nmCorrections = norm(corrections)
  const corr = corrections[0] as Any
  L.nmDisable = norm(repos.notMine.setEnabled(corr.id, false))
  L.nmActiveOff = norm(repos.notMine.corrections('c-team'))
  L.nmEnable = norm(repos.notMine.setEnabled(corr.id, true))
  L.nmActiveOn = norm(repos.notMine.corrections('c-team'))
  repos.notMine.effect({ id: corr.id, revision: corr.revision }, 'c-team', src, 'runOnce')
  L.nmReopen = norm(repos.notMine.reopen(fid))
  L.nmReopenAgain = norm(repos.notMine.reopen(fid))

  const runId = repos.pipeline.startRun()
  L.pipeFinish = norm(repos.pipeline.finishRun(runId, { newMsgs: 2000, chatsSeen: 3, todosCreated: 7, todosResolved: 1, lineBridge: 'ok', llmStatus: 'partial', note: 'spike' }))
  L.pipeGet = norm(repos.pipeline.getRun(runId)); L.pipeLast = norm(repos.pipeline.getLastRun())
  L.pipeStats = norm(repos.pipeline.getChatsSeenStats())

  ensureLineImportSchema(db); ensureLineImportSchema(db)
  L.liReady = isLineImportSchemaReady(db)
  const b1 = importBatch(10_000, 40)
  L.liCommit1 = norm(time('commitLineImportBatch40', () => commitLineImportBatch(db, b1 as Any, identityStub('epoch-A') as Any, { processedBeforeMs: BASE + 10_020_000 })))
  L.liCommitDup = norm(commitLineImportBatch(db, b1 as Any, identityStub('epoch-A') as Any))
  L.liCommitEpoch = norm(commitLineImportBatch(db, importBatch(10_040, 10) as Any, identityStub('epoch-B') as Any))
  L.liCommitNoEpoch = norm(commitLineImportBatch(db, importBatch(10_050, 5) as Any, identityStub(null) as Any))
  // nested transaction (commit tx -> insertMessages tx => SAVEPOINT) must roll back as a whole
  const beforeMsgs = repos.messages.count()
  const beforeBatches = db.prepare('SELECT count(*) n FROM line_import_batches').get().n
  try { commitLineImportBatch(db, importBatch(10_060, 5, true) as Any, identityStub('epoch-B') as Any); L.liNestedRollback = { threw: false } } catch (e) {
    L.liNestedRollback = { threw: true, error: String((e as Any).message).slice(0, 80), messagesUnchanged: repos.messages.count() === beforeMsgs, batchesUnchanged: db.prepare('SELECT count(*) n FROM line_import_batches').get().n === beforeBatches, inTransactionAfter: db.inTransaction }
  }
  L.participants = norm(db.prepare('SELECT identity_status, identity_reason, scope, count(*) n FROM message_participants GROUP BY 1,2,3 ORDER BY 1,2,3').all())
  return { L, T }
}

const MAIN = (dataDir: string) => join(dataDir, 'line-todo.db')

function openTimed(path: string) {
  const t0 = performance.now()
  const cap = withLogCapture(() => openDatabase({ dbPath: path }))
  return { opened: cap.value as Any, openMs: ms(performance.now() - t0), logs: cap.logs, error: cap.error ? errInfo(cap.error) : null }
}

export function phaseCreate(ctx: Any) {
  const o = openTimed(MAIN(ctx.dataDir))
  if (o.error) return { ok: false, open: o }
  const db = o.opened.db
  const state = connState(db)
  const { L, T } = exercise(db)
  const digest = dbDigest(db)
  o.opened.close()
  const reopenSame = openTimed(MAIN(ctx.dataDir))
  const again = reopenSame.error ? null : dbDigest(reopenSame.opened.db)
  if (!reopenSame.error) reopenSame.opened.close()
  return { ok: true, schemaVersionConst: SCHEMA_VERSION, openMs: o.openMs, openLogs: o.logs, state, timings: T, ops: L, digest, sameProcessReopenDigestEqual: again?.digest === digest.digest, opsSha: sha(stable(L)) }
}

const LEGACY_V1_DDL = `
CREATE TABLE chats (chat_id TEXT PRIMARY KEY, name TEXT, is_group INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, block_reason TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE messages (msg_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, ts INTEGER NOT NULL, time_iso TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('in','out')), sender TEXT, text TEXT, content_type INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0, ingested_at TEXT NOT NULL, FOREIGN KEY (chat_id) REFERENCES chats(chat_id));
CREATE INDEX idx_messages_chat_ts ON messages(chat_id, ts);
CREATE INDEX idx_messages_unproc ON messages(processed, chat_id);
CREATE TABLE todos (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, bucket TEXT NOT NULL CHECK(bucket IN ('todo','waiting','schedule')), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','waiting_reply','scheduled','done','suggested_done','dismissed')), title TEXT NOT NULL, detail TEXT, priority INTEGER NOT NULL DEFAULT 2, due_at TEXT, source_msg_ids TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, completion_evidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT, FOREIGN KEY (chat_id) REFERENCES chats(chat_id));
CREATE INDEX idx_todos_status ON todos(status);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, new_msgs INTEGER NOT NULL DEFAULT 0, chats_seen INTEGER NOT NULL DEFAULT 0, todos_created INTEGER NOT NULL DEFAULT 0, todos_resolved INTEGER NOT NULL DEFAULT 0, line_bridge TEXT NOT NULL DEFAULT 'ok', llm_status TEXT NOT NULL DEFAULT 'ok', note TEXT);
`

function seedLegacy(path: string, extraDdl = '') {
  const raw: Any = new (Database as Any)(path)
  raw.exec(LEGACY_V1_DDL + extraDdl)
  raw.prepare(`INSERT INTO chats VALUES ('c-old','舊群組',1,0,NULL,?,?)`).run(SEEN_AT, SEEN_AT)
  raw.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run('i:old-1', 'c-old', BASE, '2026-09-28T09:00:00', 'in', '老王', '舊訊息一', 0, 1, SEEN_AT)
  raw.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run('i:old-2', 'c-old', BASE + 1000, '2026-09-28T09:00:01', 'out', 'me', '舊訊息二', 0, 0, SEEN_AT)
  raw.prepare(`INSERT INTO todos(id,chat_id,bucket,status,title,source_msg_ids,created_at,updated_at) VALUES ('legacy-todo-1','c-old','todo','pending','舊待辦','["i:old-1"]',?,?)`).run(SEEN_AT, SEEN_AT)
  raw.pragma('user_version = 1')
  const uv = raw.pragma('user_version', { simple: true })
  raw.close()
  return uv
}
const cols = (db: Any, t: string) => db.prepare(`PRAGMA table_info(${t})`).all().map((r: Any) => r.name)

export function phaseLegacy(ctx: Any) {
  const R: Any = {}
  // (1) v1 -> v6 upgrade through migrate.ts (all five ALTER/CREATE steps)
  const p = join(ctx.dataDir, 'legacy-v1.db')
  R.seededUserVersion = seedLegacy(p)
  const o = openTimed(p)
  R.open = { openMs: o.openMs, logs: o.logs, error: o.error }
  if (!o.error) {
    const db = o.opened.db
    R.state = connState(db)
    R.messagesColumns = cols(db, 'messages')
    R.notMineEventsColumns = cols(db, 'todo_not_mine_events')
    R.legacyRows = norm(db.prepare(`SELECT msg_id,key_material,orig_filename,file_size,media_backed_up,unsent FROM messages ORDER BY msg_id`).all())
    const repos = createRepositories(db)
    R.legacyTodoMark = norm(repos.notMine.mark('legacy-todo-1', 'other', 'legacy'))
    R.legacyList = normSet(repos.messages.list({ chatId: 'c-old' }))
    R.digest = dbDigest(db)
    o.opened.close()
  }
  // (2) failing migration must roll back DDL + leave user_version untouched (v<4 ALTER hits a
  //     pre-existing `unsent` column after v<2 / v<3 ALTERs already ran inside the same transaction)
  const bad = join(ctx.dataDir, 'legacy-bad.db')
  seedLegacy(bad, `ALTER TABLE messages ADD COLUMN unsent INTEGER NOT NULL DEFAULT 0;`)
  const ob = openTimed(bad)
  R.badOpen = { threw: !!ob.error, error: ob.error, logs: ob.logs.map((l) => l.slice(0, 160)) }
  if (!ob.error) ob.opened.close()
  const raw: Any = new (Database as Any)(bad)
  R.badAfter = { userVersion: raw.pragma('user_version', { simple: true }), messagesColumns: cols(raw, 'messages'), hasNotMineTable: !!raw.prepare(`SELECT 1 FROM sqlite_master WHERE name='todo_not_mine_events'`).get() }
  raw.close()
  R.ok = !o.error && R.state?.userVersion === 6 && R.badOpen.threw && R.badAfter.userVersion === 1 && !R.badAfter.messagesColumns.includes('key_material')
  return R
}

/** Open a DB written by the CURRENT standalone writer (E31 + better-sqlite3 11.10.0) and keep using it. */
export function phaseImport(ctx: Any) {
  const p = join(ctx.dataDir, 'imported', 'line-todo.db')
  const o = openTimed(p)
  if (o.error) return { ok: false, open: o }
  const db = o.opened.db
  const R: Any = { openLogs: o.logs, state: connState(db) }
  R.digest = dbDigest(db)
  R.digestEqualsWriter = R.digest.digest === ctx.expectImport?.digest
  R.normalizedDigestEqualsWriter = R.digest.normalizedDigest === ctx.expectImport?.normalizedDigest
  const repos = createRepositories(db)
  repos.todos.create({ chatId: 'c-team', bucket: 'todo', title: 'written-after-import', sourceMsgIds: [] })
  R.todoCountAfterWrite = repos.todos.count()
  o.opened.close()
  const o2 = openTimed(p)
  R.reopenTodoCount = o2.error ? null : createRepositories(o2.opened.db).todos.count()
  if (!o2.error) o2.opened.close()
  R.ok = R.state.quickCheck === 'ok' && R.digestEqualsWriter && R.reopenTodoCount === R.todoCountAfterWrite
  return R
}

/** Write more rows, then the child kills itself WITHOUT closing (crash after commit). */
export function phaseAppendNoClose(ctx: Any) {
  const o = openTimed(MAIN(ctx.dataDir))
  if (o.error) return { ok: false, open: o }
  const db = o.opened.db
  const repos = createRepositories(db)
  const ins = repos.messages.insertBatch(makeMsgs(300, 20_000, 'after'))
  repos.todos.create({ chatId: 'c-team', bucket: 'todo', title: 'after-crash-marker', sourceMsgIds: [] })
  repos.pipeline.startRun()
  return { ok: true, state: connState(db), inserted: ins.inserted, digest: dbDigest(db), closed: false }
}

/** New process: everything committed before the kill must be there; migrate is a no-op. */
export function phaseReopen(ctx: Any) {
  const o = openTimed(MAIN(ctx.dataDir))
  if (o.error) return { ok: false, open: o }
  const db = o.opened.db
  const R: Any = { openMs: o.openMs, openLogs: o.logs, state: connState(db) }
  R.digest = dbDigest(db)
  R.digestEqualsBeforeKill = R.digest.digest === ctx.expectAppend?.digest
  const repos = createRepositories(db)
  R.markerPresent = repos.todos.list({}).some((t: Any) => t.title === 'after-crash-marker')
  repos.todos.create({ chatId: 'c-team', bucket: 'todo', title: 'after-reopen', sourceMsgIds: [] })
  R.todoCount = repos.todos.count()
  o.opened.close()
  // legacy DB migrated in an earlier process must still be v6 with its rows
  const lg = openTimed(join(ctx.dataDir, 'legacy-v1.db'))
  R.legacy = lg.error ? { error: lg.error } : { userVersion: lg.opened.db.pragma('user_version', { simple: true }), digestEqual: dbDigest(lg.opened.db).digest === ctx.expectLegacy?.digest, logs: lg.logs }
  if (!lg.error) lg.opened.close()
  R.ok = R.state.quickCheck === 'ok' && R.state.userVersion === 6 && R.digestEqualsBeforeKill && R.markerPresent && R.legacy?.userVersion === 6 && R.legacy?.digestEqual
  return R
}
