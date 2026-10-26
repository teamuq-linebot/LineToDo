import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { listMessages } from '../src/main/db/messages.repo.ts'
import { ensureLineImportSchema, commitLineImportBatch } from '../src/main/db/lineImport.repo.ts'
import { SCHEMA_DDL } from '../src/main/db/schema.ts'
import { createParticipantIdentityProvider } from '../src/main/line/identity.ts'
import { scanRecentUnsent } from '../src/main/pipeline/backfill.ts'
import { createPluginBackend } from '../src/plugin/backend/assemble.ts'
import { backendMethodFor } from '../src/shared/pluginWire.ts'
import { hasSavedMessageText, mergeMessageCopies, recalledMessageNotice, recalledMessageText, UNKNOWN_RECALLED_CONTENT_NOTICE, UNSAVED_RECALLED_CONTENT_TEXT, WHITESPACE_RECALLED_CONTENT_NOTICE } from '../src/renderer/lib/recalledMessage.ts'
import { rowToObj } from '../src/main/line/engine/rowToObj.ts'

function createDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA_DDL)
  ensureLineImportSchema(db)
  return db
}

function identityProvider(userDataDir) {
  return createParticipantIdentityProvider({ userDataDir, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => Buffer.from(value).toString('utf8')
  } })
}

function sourceItem(message, sourceRowId) {
  return { sourceRowId, senderMid: 'mid-sender', accountMid: 'mid-self', message }
}

function sourceBatch(items, batchId) {
  return {
    batchId,
    source: 'line-backfill',
    cursorFrom: { createdTime: 0, rowId: 0 },
    cursorTo: { createdTime: items.at(-1)?.message.ts ?? 0, rowId: items.at(-1)?.sourceRowId ?? 0 },
    hasMore: false,
    observedAt: new Date().toISOString(),
    items
  }
}

function message(msgId, values = {}) {
  const ts = values.ts ?? Date.now()
  return {
    msgId,
    chat: '測試群組',
    chatId: 'c-recalled-fixture',
    isGroup: true,
    ts,
    time: new Date(ts).toISOString(),
    direction: 'in',
    sender: '測試成員',
    text: '',
    contentType: 0,
    ...values
  }
}

test('saved text and media survive recall scan, database reload, and repeated placeholder imports', async () => {
  const db = createDb()
  const temp = mkdtempSync(join(tmpdir(), 'recalled-message-'))
  const identity = identityProvider(temp)
  const now = Date.now()
  const savedText = message('recall-text', { ts: now - 1000, text: '收回前已保存的原文' })
  const savedFile = message('recall-file', {
    ts: now - 500,
    text: '',
    contentType: 14,
    keyMaterial: Buffer.alloc(32, 7).toString('base64'),
    fileName: '會議紀錄.pdf',
    fileSize: 4096
  })
  const firstSeenRecall = message('recall-first-seen', { ts: now, text: '', unsent: true })
  const initial = sourceBatch([sourceItem(savedText, 1), sourceItem(savedFile, 2)], 'recalled-initial-capture')
  const committed = commitLineImportBatch(db, initial, identity)
  assert.equal(committed.inserted, 2)
  assert.deepEqual(committed.chatIds, ['c-recalled-fixture'])

  const recalledText = { ...savedText, text: '[type=0]', contentType: 0, unsent: true, keyMaterial: null, fileName: null, fileSize: null }
  const recalledFile = { ...savedFile, text: '[type=0]', contentType: 0, unsent: true, keyMaterial: null, fileName: null, fileSize: null }
  let importNo = 0
  const scan = () => scanRecentUnsent(3, {
    db,
    now: () => now,
    fetchImportBatch: async (cursor) => ({
      ...sourceBatch([sourceItem(recalledText, 1), sourceItem(recalledFile, 2), sourceItem(firstSeenRecall, 3)], `recalled-scan-${++importNo}`),
      cursorFrom: cursor,
      cursorTo: cursor
    }),
    commitImportBatch: (batch) => commitLineImportBatch(db, batch, identity)
  })

  const firstScan = await scan()
  assert.deepEqual(firstScan, {
    scanned: 3,
    unsentMarked: 2,
    unsentInserted: 1,
    unsentChatIds: ['c-recalled-fixture']
  })

  const reloaded = listMessages({ chatId: 'c-recalled-fixture', limit: 10 }, db)
  const textRow = reloaded.find((row) => row.msgId === 'i:recall-text')
  const fileRow = reloaded.find((row) => row.msgId === 'i:recall-file')
  assert.equal(textRow.text, '收回前已保存的原文')
  assert.equal(textRow.unsent, true)
  assert.equal(fileRow.contentType, 14)
  assert.equal(fileRow.origFilename, '會議紀錄.pdf')
  assert.equal(fileRow.fileSize, 4096)
  assert.equal(fileRow.unsent, true)
  assert.equal(reloaded.find((row) => row.msgId === 'i:recall-first-seen').text, '')
  assert.equal(reloaded.find((row) => row.msgId === 'i:recall-first-seen').unsent, true)
  assert.equal(db.prepare("SELECT key_material FROM messages WHERE msg_id='i:recall-file'").get().key_material, savedFile.keyMaterial)

  const repeated = await scan()
  assert.equal(repeated.unsentMarked, 0)
  assert.equal(repeated.unsentInserted, 0)
  assert.deepEqual(repeated.unsentChatIds, ['c-recalled-fixture'])
  const afterReplay = listMessages({ chatId: 'c-recalled-fixture', limit: 10 }, db)
  assert.equal(afterReplay.find((row) => row.msgId === 'i:recall-text').text, '收回前已保存的原文')
  assert.equal(afterReplay.find((row) => row.msgId === 'i:recall-file').origFilename, '會議紀錄.pdf')
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('renderer merge retains saved recalled content and media over a stale placeholder copy', () => {
  const persisted = {
    msgId: 'i:stable-id', chatId: 'c-room', chat: 'Room', isGroup: true,
    ts: 10, time: '2026-10-26T08:00:00', direction: 'in', sender: 'A',
    text: '原本保存的文字', contentType: 0, unsent: false
  }
  const recalledPlaceholder = {
    ...persisted, chat: '', text: '[type=0]', contentType: 0, unsent: true,
    origFilename: null, fileSize: null
  }
  const merged = mergeMessageCopies(persisted, recalledPlaceholder)
  assert.equal(merged.text, '原本保存的文字')
  assert.equal(merged.unsent, true)
  assert.equal(recalledMessageText(merged), '原本保存的文字')

  const savedFile = { ...persisted, text: '', contentType: 14, origFilename: '資料.pdf', fileSize: 1234 }
  const fileAfterRecall = mergeMessageCopies(savedFile, { ...recalledPlaceholder, msgId: savedFile.msgId })
  assert.equal(fileAfterRecall.contentType, 14)
  assert.equal(fileAfterRecall.origFilename, '資料.pdf')
  assert.equal(fileAfterRecall.fileSize, 1234)
  assert.equal(fileAfterRecall.unsent, true)

  const staleUnsentCopy = { ...recalledPlaceholder, unsent: false, text: '[type=0]' }
  assert.equal(mergeMessageCopies(merged, staleUnsentCopy).unsent, true)
})

test('empty type-0 source is missing, while literal legacy markers and whitespace stay readable with honest status', () => {
  const context = { myMid: 'mid-self', iso: (ts) => new Date(ts).toISOString(), chatName: 'fixture', senderName: 'fixture member' }
  const row = (id, text) => ({
    chatId: 'c-provenance-fixture', createdTime: 1792983600000, from: 'mid-member', text,
    contentType: 0, id, contentMetadata: null, contentInfo: null, attribute: 1
  })
  const literalSource = rowToObj(row(1, '[type=0]'), context)
  const emptySource = rowToObj(row(2, ''), context)
  const whitespaceSource = rowToObj(row(3, '   \t'), context)

  assert.equal(literalSource.text, '[type=0]', 'a literal source marker remains intact')
  assert.equal(emptySource.text, '', 'a newly normalized empty type-0 source remains empty instead of becoming a marker')
  assert.notEqual(literalSource.text, emptySource.text, 'the persisted value now distinguishes new empty rows from literal markers')
  assert.equal(hasSavedMessageText(literalSource.text), true)
  assert.equal(recalledMessageText(literalSource), '[type=0]', 'ambiguous legacy-looking text remains readable')
  assert.equal(recalledMessageNotice(literalSource), UNKNOWN_RECALLED_CONTENT_NOTICE, 'the UI does not claim the ambiguous marker was saved or recovered')

  assert.equal(hasSavedMessageText(emptySource.text), false)
  assert.equal(recalledMessageText(emptySource), UNSAVED_RECALLED_CONTENT_TEXT)
  assert.equal(recalledMessageNotice(emptySource), null, 'a fresh empty source is definitely missing without a second warning')

  assert.equal(whitespaceSource.text, '   \t', 'whitespace is preserved byte-for-byte')
  assert.equal(hasSavedMessageText(whitespaceSource.text), true, 'whitespace is non-empty source content')
  assert.equal(recalledMessageText(whitespaceSource), '   \t')
  assert.equal(recalledMessageNotice(whitespaceSource), WHITESPACE_RECALLED_CONTENT_NOTICE, 'the UI says the whitespace was saved rather than claiming content is absent')

  const persistedLiteral = { ...literalSource, msgId: 'i:literal', chatId: 'c-provenance-fixture' }
  const newerEmptyCopy = { ...persistedLiteral, text: '', unsent: true }
  assert.equal(mergeMessageCopies(persistedLiteral, newerEmptyCopy).text, '[type=0]', 'a later empty copy cannot erase the saved literal')
})

test('plugin production scan publishes the existing persistence event after saved content is marked recalled', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'recalled-plugin-event-'))
  const listeners = new Set()
  let recentMessages = []
  let recentReads = 0
  let running = false
  const line = {
    start() { running = true },
    stop() { running = false },
    status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage(callback) { listeners.add(callback); return () => listeners.delete(callback) },
    onStatus() { return () => undefined },
    getMessagesSince: async () => { recentReads += 1; return recentMessages }
  }
  const settingsPath = join(dataDir, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ version: 1, reconcile: { enabled: false, scopeMonths: 0 } }))
  const backend = await createPluginBackend({
    pluginId: 'tuqdev.line-todo', version: 'test', dataDir, line, reconcile: {}
  })
  const call = async (path, ...args) => backend.call(backendMethodFor(path), { path, args })
  try {
    const original = message('plugin-recall-id', { text: '外掛收回掃描前保存的原文' })
    for (const listener of listeners) listener(original)
    const before = await call('db.messages.list', { chatId: original.chatId, limit: 10 })
    assert.equal(before.value[0].text, '外掛收回掃描前保存的原文')
    assert.equal(before.value[0].unsent, false)

    const session = (await call('events.open', {})).value
    recentMessages = [{ ...original, text: '[type=0]', unsent: true }]
    const pipelineRun = await call('pipeline.runOnce')

    let event = null
    const observedEvents = []
    let afterSeq = session.seq
    for (let attempt = 0; attempt < 30 && !event; attempt += 1) {
      const pulled = (await call('events.pull', {
        sessionId: session.sessionId,
        afterSeq,
        waitMs: 250
      })).value
      afterSeq = pulled.seq
      observedEvents.push(...pulled.events.map((item) => item.type))
      event = pulled.events.find((item) => item.type === 'messages-persisted') ?? null
    }
    const diagnostic = (await call('backend.info')).value
    assert.ok(event, `the background scan publishes its persistence event; reads=${recentReads} logs=${JSON.stringify(diagnostic.recentLog)} pipeline=${JSON.stringify(pipelineRun)} observed=${JSON.stringify(observedEvents)}`)
    assert.deepEqual(event.payload, {
      chatIds: [original.chatId], inserted: 0, updated: 1
    })
    const after = await call('db.messages.list', { chatId: original.chatId, limit: 10 })
    assert.equal(after.value[0].text, '外掛收回掃描前保存的原文')
    assert.equal(after.value[0].unsent, true)
  } finally {
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
