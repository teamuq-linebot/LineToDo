// The SQL line-todo runs against the (decrypted) LINE DB, ported 1:1 from
//   src/main/line/engine/linedb.ts       myMid / chatName / listChats / resolveChat / newMessages /
//                                         newMessagesAfter / iso   (SQL strings verbatim)
//   src/main/line/engine/watchEngine.ts:244-256  per-row chatName x2 + myMid (the incremental batch)
//   src/main/line/engine/watchEngine.ts:307      tail query (resetNow)
//   src/main/pipeline/reconcile.ts:93-98         SOURCE_MONTHLY_SQL (strftime ... 'localtime')
// written against a tiny engine-neutral adapter { get(sql,args), all(sql,args) } so the exact
// same code runs on better-sqlite3-multiple-ciphers and on the sqlite3mc WASM oo1 API.
import { createHash } from 'node:crypto'

export function myMid(c) {
  const r = c.get('SELECT _mid FROM _profile LIMIT 1', [])
  return r ? r._mid : null
}

export function chatName(c, chatId) {
  const g = c.get('SELECT _chatName FROM _groupChat WHERE _chatMid=?', [chatId])
  if (g && g._chatName) return g._chatName
  try {
    const sq = c.get('SELECT _name FROM _square WHERE _mid=?', [chatId])
    if (sq && sq._name) return sq._name
  } catch { /* _square missing */ }
  const ct = c.get('SELECT _displayNameOverridden,_displayName,_targetProfileDetail FROM _contact WHERE _mid=?', [chatId])
  if (ct) {
    if (ct._displayNameOverridden) return ct._displayNameOverridden
    if (ct._displayName) return ct._displayName
    if (ct._targetProfileDetail) {
      try { const pn = JSON.parse(ct._targetProfileDetail).profileName; if (pn) return pn } catch { /* bad json */ }
    }
  }
  return null
}

export function iso(ms) {
  if (!ms) return null
  const d = new Date(Number(ms))
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

export function listChats(c, limit = 50) {
  const rows = c.all('SELECT _id,_lastUpdatedTime,_lastMessage FROM _chat ORDER BY _lastUpdatedTime DESC LIMIT ?', [limit])
  return rows.map((r) => ({ chatId: r._id, name: chatName(c, r._id), lastUpdated: iso(r._lastUpdatedTime), isGroup: r._id.slice(0, 1) !== 'u' }))
}

export function resolveChat(c, name) {
  const direct = c.get('SELECT 1 FROM _chat WHERE _id=? LIMIT 1', [name])
  if (direct) return name
  const chats = listChats(c, 5000)
  const exact = chats.filter((x) => x.name === name)
  if (exact.length === 1) return exact[0].chatId
  if (exact.length > 1) throw new Error(JSON.stringify({ error: 'ambiguous exact name', matches: exact.map((x) => x.name) }))
  const fuzzy = chats.filter((x) => x.name && x.name.includes(name))
  if (fuzzy.length === 1) return fuzzy[0].chatId
  if (fuzzy.length > 1) throw new Error(JSON.stringify({ error: 'ambiguous name', matches: fuzzy.slice(0, 20).map((x) => x.name) }))
  throw new Error(JSON.stringify({ error: `no chat named '${name}'` }))
}

const mapRow = (r) => ({ rowId: r._rowid, chatId: r._chatId, createdTime: r._createdTime, from: r._from, text: r._text, contentType: r._contentType, msgId: r._id, contentMetadata: r._contentMetadata, contentInfo: r._contentInfo, attribute: r._attribute })

export function newMessages(c, sinceTs, name, limit = 500) {
  const cid = name ? resolveChat(c, name) : null
  let q = 'SELECT rowid AS _rowid,_chatId,_createdTime,_from,_text,_contentType,_id,' + '_contentMetadata,_contentInfo,_attribute FROM _message ' + 'WHERE _createdTime > ?'
  const args = [sinceTs]
  if (cid) { q += ' AND _chatId=?'; args.push(cid) }
  q += ' ORDER BY _createdTime, rowid LIMIT ?'
  args.push(limit)
  return c.all(q, args).map(mapRow)
}

export function newMessagesAfter(c, cursor, name, limit = 500, createdTimeExclusive) {
  const cid = name ? resolveChat(c, name) : null
  let q = 'SELECT rowid AS _rowid,_chatId,_createdTime,_from,_text,_contentType,_id,' + '_contentMetadata,_contentInfo,_attribute FROM _message ' + 'WHERE (_createdTime > ? OR (_createdTime = ? AND rowid > ?))'
  const args = [cursor.createdTime, cursor.createdTime, cursor.rowId]
  if (cid) { q += ' AND _chatId=?'; args.push(cid) }
  if (createdTimeExclusive !== undefined) { q += ' AND _createdTime < ?'; args.push(createdTimeExclusive) }
  q += ' ORDER BY _createdTime, rowid LIMIT ?'
  args.push(limit)
  return c.all(q, args).map(mapRow)
}

// watchEngine.ts:244-256 — one incremental batch: rows + myMid + chatName(chat) + chatName(sender)
export function watchBatch(c, cursor, limit = 500) {
  const rows = newMessagesAfter(c, cursor, null, limit + 1)
  const hasMore = rows.length > limit
  if (hasMore) rows.pop()
  const accountMid = myMid(c)
  const items = rows.map((r) => ({ r, chatName: chatName(c, r.chatId), senderName: r.from ? chatName(c, r.from) : null, time: iso(r.createdTime), accountMid }))
  return { hasMore, items }
}

export const TAIL_SQL = 'SELECT _createdTime AS m, rowid AS rid FROM _message ORDER BY _createdTime DESC, rowid DESC LIMIT 1'
export const SOURCE_MONTHLY_SQL = "SELECT strftime('%Y-%m', _createdTime/1000, 'unixepoch', 'localtime') AS ym, " + 'COUNT(*) AS c, MIN(_createdTime) AS lo, MAX(_createdTime) AS hi ' + 'FROM _message ' + 'WHERE _createdTime IS NOT NULL ' + 'GROUP BY ym'

export function jsonSafe(v) {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)))
}
export function sha(v) {
  return createHash('sha256').update(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))).digest('hex')
}

// Full correctness suite. Returns { checks: {name: {value|digest}}, digests } — compared across
// engines by the summarizer, and against expected.json ground truth.
export function runSuite(c, expected) {
  const out = {}
  const tryIt = (name, fn) => { try { out[name] = { ok: true, value: fn() } } catch (e) { out[name] = { ok: false, error: String(e.message).slice(0, 300) } } }
  tryIt('myMid', () => myMid(c))
  tryIt('listChats50', () => { const v = listChats(c, 50); return { n: v.length, first3: v.slice(0, 3), digest: sha(v) } })
  tryIt('listChats5000_digest', () => sha(listChats(c, 5000)))
  tryIt('chatName_override', () => chatName(c, listChats(c, 5000).find((x) => x.name && x.name.startsWith('覆寫名'))?.chatId ?? ''))
  tryIt('chatName_badJsonContactIsNull', () => { const all = c.all("SELECT _mid FROM _contact WHERE _targetProfileDetail='{bad json'", []); return all.map((r) => chatName(c, r._mid)) })
  tryIt('resolveChat_direct', () => { const id = c.get('SELECT _id FROM _chat ORDER BY _id LIMIT 1', [])._id; return resolveChat(c, id) === id })
  tryIt('resolveChat_exactGroup', () => resolveChat(c, '專案群組42號🚀'))
  tryIt('resolveChat_ambiguousExact', () => { try { resolveChat(c, '重複群組名'); return 'NO-THROW' } catch (e) { return JSON.parse(e.message).error } })
  tryIt('resolveChat_fuzzyUnique', () => resolveChat(c, '社群17'))
  tryIt('resolveChat_walOnlyContact', () => resolveChat(c, 'WAL新聯絡人'))
  tryIt('newMessages_tail', () => { const since = Number(expected.maxRow.createdTime) - 3600000; const v = newMessages(c, since, null, 500); return { n: v.length, last: v.at(-1), digest: sha(v) } })
  tryIt('newMessages_byName', () => { const v = newMessages(c, 0, '專案群組42號🚀', 500); return { n: v.length, digest: sha(v) } })
  tryIt('newMessagesAfter_walBoundary', () => { const cur = expected.cursorAtWalBoundary ?? { createdTime: 0, rowId: 0 }; const v = newMessagesAfter(c, cur, null, 501); return { n: v.length, firstRowId: v[0]?.rowId, lastRowId: v.at(-1)?.rowId, digest: sha(v) } })
  tryIt('newMessagesAfter_exclusiveBound', () => { const v = newMessagesAfter(c, { createdTime: 0, rowId: 0 }, null, 500, 1740758400000); return { n: v.length, digest: sha(v) } })
  tryIt('pagingFullScan_tieBreak', () => {
    // page through the whole table with limit 500 (exercises rowid tie-break on duplicate ms)
    let cur = { createdTime: 0, rowId: 0 }; let n = 0; const h = []
    for (;;) { const v = newMessagesAfter(c, cur, null, 500); if (!v.length) break; n += v.length; h.push(sha(v)); const l = v.at(-1); cur = { createdTime: l.createdTime, rowId: l.rowId } }
    return { n, digest: sha(h) }
  })
  tryIt('watchBatch_walBoundary', () => { const b = watchBatch(c, expected.cursorAtWalBoundary ?? { createdTime: 0, rowId: 0 }, 500); return { hasMore: b.hasMore, n: b.items.length, sample: b.items.slice(0, 2), digest: sha(b) } })
  tryIt('tail', () => c.get(TAIL_SQL, []))
  tryIt('sourceMonthly', () => { const v = c.all(SOURCE_MONTHLY_SQL, []); return { rows: v, digest: sha(v) } })
  tryIt('messageCount', () => c.get('SELECT count(*) AS c FROM _message', []).c)
  tryIt('messageDigest', () => {
    const h = createHash('sha256')
    for (const r of c.all('SELECT rowid AS r,_id,_chatId,_createdTime,_from,_text,_contentType,_contentMetadata,_contentInfo,_attribute FROM _message ORDER BY rowid', [])) h.update(JSON.stringify([r.r, r._id, r._chatId, r._createdTime, r._from, r._text, r._contentType, r._contentMetadata, r._contentInfo, r._attribute]) + '\n')
    return h.digest('hex')
  })
  tryIt('int64probe', () => c.all('SELECT k, v, typeof(v) AS t FROM _int64probe ORDER BY k', []).map((r) => ({ k: r.k, jsType: typeof r.v, v: typeof r.v === 'bigint' ? `${r.v}n` : r.v, sqlType: r.t })))
  return jsonSafe(out)
}
