// The linedb query suite used to compare LINE DB engines. It drives the REAL production functions
// (src/main/line/engine/linedb.ts: openDb / myMid / chatName / listChats / resolveChat / newMessages /
// newMessagesAfter) plus the raw SQL that other production modules run through the same handle
// (watchEngine tail query, reconcile monthly fingerprint, lineOrder profile/square lookups).
//
// The suite is engine-agnostic: the caller passes the linedb module namespace (`api`) that has already
// been wired to an engine (standalone better-sqlite3-multiple-ciphers under Electron 31, or the WASM
// engine under Node 24 / Electron 44). The returned object is plain JSON: two engines "agree" when
// their results are deep-equal, and every engine must also match the writer's ground truth.
import { createHash } from 'node:crypto'

// Raw SQL copied verbatim from production modules. scripts/test-wasm-linedb.mjs asserts that each
// string still appears verbatim in its source file, so this copy cannot silently drift.
export const RAW_SQL = {
  watchEngineTail: 'SELECT _createdTime AS m, rowid AS rid FROM _message ORDER BY _createdTime DESC, rowid DESC LIMIT 1',
  reconcileMonthly:
    "SELECT strftime('%Y-%m', _createdTime/1000, 'unixepoch', 'localtime') AS ym, " +
    'COUNT(*) AS c, MIN(_createdTime) AS lo, MAX(_createdTime) AS hi ' +
    'FROM _message ' +
    'WHERE _createdTime IS NOT NULL ' +
    'GROUP BY ym',
  lineOrderProfile: 'SELECT _mid FROM _profile LIMIT 1',
  lineOrderSquareChat: 'SELECT _name FROM _squareChat WHERE _squareChatMid = ?',
}

/** sha256 over JSON; a stray bigint is rendered as `<n>n` so a BigInt leak is visible, not fatal. */
export function sha(v) {
  return createHash('sha256')
    .update(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)))
    .digest('hex')
}

function jsonSafe(v) {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)))
}

/** Run one check; an exception becomes `{ threw }` so engines can also be compared on error behaviour. */
function check(fn) {
  try {
    return { ok: true, value: jsonSafe(fn()) }
  } catch (e) {
    return { ok: false, threw: String(e?.message ?? e).slice(0, 300) }
  }
}

const hasBigInt = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? '\u0000bigint' : x)).includes('\u0000bigint')

/**
 * @param api  linedb module namespace (openDb, listChats, ...)
 * @param ctx  { key, edbPath, kind: 'wal'|'rollback'|'int64', expected } expected = that variant's writer ground truth
 */
export function runVariantSuite(api, ctx) {
  const { key, edbPath, kind, expected } = ctx
  const { con, cleanup } = api.openDb(key, edbPath)
  const out = {}
  try {
    out.myMid = check(() => api.myMid(con))
    out.listChats50 = check(() => {
      const v = api.listChats(con, 50)
      return { n: v.length, first3: v.slice(0, 3), digest: sha(v) }
    })
    out.listChats5000 = check(() => sha(api.listChats(con, 5000)))
    out.chatNameOverride = check(() => {
      const c = api.listChats(con, 5000).find((x) => x.name && x.name.startsWith('覆寫名'))
      return api.chatName(con, c?.chatId ?? '')
    })
    out.chatNameBadJson = check(() =>
      con.prepare("SELECT _mid FROM _contact WHERE _targetProfileDetail='{bad json'").all().map((r) => api.chatName(con, r._mid)),
    )
    out.resolveChatDirect = check(() => {
      const id = con.prepare('SELECT _id FROM _chat ORDER BY _id LIMIT 1').get()._id
      return api.resolveChat(con, id) === id
    })
    out.resolveChatExactGroup = check(() => api.resolveChat(con, '專案群組42號🚀'))
    out.resolveChatAmbiguous = check(() => {
      try {
        api.resolveChat(con, '重複群組名')
        return 'NO-THROW'
      } catch (e) {
        return JSON.parse(e.message).error
      }
    })
    out.resolveChatFuzzy = check(() => api.resolveChat(con, '社群17'))
    out.resolveChatMissing = check(() => api.resolveChat(con, '__no_such_chat__'))
    out.messageCount = check(() => con.prepare('SELECT count(*) AS c FROM _message').get().c)

    const maxCreated = Number(expected.maxRow?.createdTime ?? 0)
    out.newMessagesTail = check(() => {
      const v = api.newMessages(con, maxCreated - 3600000, null, 500)
      return { n: v.length, last: v.at(-1), digest: sha(v), bigint: hasBigInt(v) }
    })
    out.newMessagesByName = check(() => {
      const v = api.newMessages(con, 0, '專案群組42號🚀', 500)
      return { n: v.length, digest: sha(v) }
    })
    const cursor = expected.cursorAtWalBoundary ?? { createdTime: 0, rowId: 0 }
    out.newMessagesAfterBoundary = check(() => {
      const v = api.newMessagesAfter(con, cursor, null, 501)
      return { n: v.length, firstRowId: v[0]?.rowId, lastRowId: v.at(-1)?.rowId, digest: sha(v), bigint: hasBigInt(v) }
    })
    out.newMessagesAfterExclusive = check(() => {
      const v = api.newMessagesAfter(con, { createdTime: 0, rowId: 0 }, null, 500, 1740758400000)
      return { n: v.length, digest: sha(v) }
    })
    out.pagingFullScan = check(() => {
      let cur = { createdTime: 0, rowId: 0 }
      let n = 0
      const h = []
      for (;;) {
        const v = api.newMessagesAfter(con, cur, null, 200)
        if (!v.length) break
        n += v.length
        h.push(sha(v))
        const l = v.at(-1)
        cur = { createdTime: l.createdTime, rowId: l.rowId }
      }
      return { n, digest: sha(h) }
    })
    // watchEngine's incremental batch: rows + myMid + chatName(chat) + chatName(sender) + iso(time)
    out.watchBatch = check(() => {
      const rows = api.newMessagesAfter(con, cursor, null, 101)
      const mid = api.myMid(con)
      const items = rows.map((r) => ({ r, chatName: api.chatName(con, r.chatId), sender: r.from ? api.chatName(con, r.from) : null, time: api.iso(r.createdTime), mid }))
      return { n: items.length, sample: items.slice(0, 2), digest: sha(items) }
    })
    out.tailSql = check(() => con.prepare(RAW_SQL.watchEngineTail).get())
    out.reconcileMonthly = check(() => {
      const v = con.prepare(RAW_SQL.reconcileMonthly).all()
      return { rows: v, digest: sha(v) }
    })
    out.lineOrderProfile = check(() => con.prepare(RAW_SQL.lineOrderProfile).get())
    // lineOrder.ts: a missing table must throw at prepare() time (it catches that to mean "no square table")
    out.lineOrderSquareMissing = check(() => {
      try {
        con.prepare(RAW_SQL.lineOrderSquareChat)
        return 'NO-THROW'
      } catch {
        return 'threw-at-prepare'
      }
    })
    // a statement object reused across calls (lineOrder's squareStmt pattern)
    out.statementReuse = check(() => {
      const st = con.prepare('SELECT _name FROM _square WHERE _mid = ?')
      const ids = con.prepare('SELECT _mid FROM _square ORDER BY _mid LIMIT 5').all().map((r) => r._mid)
      return ids.map((id) => st.get(id)?._name ?? null)
    })
    out.messageDigest = check(() => {
      const h = createHash('sha256')
      for (const r of con.prepare('SELECT rowid AS r,_id,_chatId,_createdTime,_from,_text,_contentType,_contentMetadata,_contentInfo,_attribute FROM _message ORDER BY rowid').all()) {
        h.update(JSON.stringify([r.r, r._id, r._chatId, r._createdTime, r._from, r._text, r._contentType, r._contentMetadata, r._contentInfo, r._attribute], (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)) + '\n')
      }
      return h.digest('hex')
    })
    if (kind === 'int64') {
      // msgId as linedb exposes it, plus the dedup key production derives from it (rowToObj String(id) -> 'i:' + id)
      out.int64MsgIds = check(() => {
        const v = api.newMessages(con, 0, null, 500)
        return { msgIds: v.map((r) => r.msgId), types: [...new Set(v.map((r) => typeof r.msgId))], bigint: hasBigInt(v) }
      })
      out.int64RawIdTypes = check(() => [...new Set(con.prepare('SELECT _id FROM _message').all().map((r) => typeof r._id))].sort())
    }
  } finally {
    cleanup()
  }
  return out
}

/** Wrong key must fail with the fixed JSON error and leave nothing behind (checked by the caller). */
export function runWrongKey(api, { edbPath }) {
  return check(() => {
    try {
      api.openDb('f'.repeat(32), edbPath)
      return 'NO-THROW'
    } catch (e) {
      return String(e.message)
    }
  })
}

export function runAllVariants(api, { fixtureDir, expected }) {
  const sep = fixtureDir.includes('\\') ? '\\' : '/'
  const edb = (kind) => `${fixtureDir}${sep}${kind}${sep}m.edb`
  const result = { variants: {}, wrongKey: {} }
  for (const kind of ['wal', 'rollback', 'int64']) {
    result.variants[kind] = runVariantSuite(api, { key: expected.key, edbPath: edb(kind), kind, expected: expected[kind] })
    result.wrongKey[kind] = runWrongKey(api, { edbPath: edb(kind) })
  }
  return result
}
