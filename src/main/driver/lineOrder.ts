/**
 * lineOrder.ts — LINE 本機 DB 唯讀 adapter（design-v3 §8.3、types-draft-v3 §H）。
 *
 * 走 production 既有的唯讀路徑：linekey.getKey → linedb.openDb（複製 edb/WAL/SHM 到暫存目錄後開啟，
 * 用完 cleanup 刪除）。只讀下列欄位（M25 以 rg 檢查）：
 *   _chat(_id, _lastUpdatedTime, _unreadCount, _status, _midType)
 *   _chatOption(_id, _pinnedTime, _hidden)
 *   名稱：linedb.chatName()＋_squareChat._name（midType 4）＋_profile._mid（自己＝Keep筆記）
 * 不讀任何訊息表或訊息內容欄位。
 *
 * 金鑰（design-v3 D5，Manager 裁定）：只用 env／快取檔（getKey 的 skipRecover），
 * 由使用者觸發的流程**不掃描 LINE 記憶體**。取得後在本 adapter 內快取；解密失敗時重新取一次。
 * 取不到金鑰 → line_key_unavailable；DB 找不到或讀取失敗 → line_db_unavailable。
 */
import { chatName, findDb, openDb } from '../line/engine/linedb'
import { getKey } from '../line/engine/linekey'
import { resolveDisplayName, toOrderRow, type OrderRow, type OrderSnapshot, type RawOrderRow } from './order'
import type { LineOrderFailCode, LineOrderPort } from './port'

const ORDER_SQL =
  'SELECT c._id, c._lastUpdatedTime, c._unreadCount, c._status, c._midType, ' +
  'coalesce(o._pinnedTime,0) AS pin, coalesce(o._hidden,0) AS hidden ' +
  'FROM _chat c LEFT JOIN _chatOption o ON o._id = c._id'
const PROFILE_SQL = 'SELECT _mid FROM _profile LIMIT 1'
const SQUARE_CHAT_SQL = 'SELECT _name FROM _squareChat WHERE _squareChatMid = ?'

export interface LineOrderOptions {
  /** 金鑰快取檔；省略時由 linekey 決定（<userData>/.linekey）。 */
  cacheFile?: string
  /** LINE DB 路徑；省略時 findDb()。 */
  dbPath?: string | null
  now?: () => number
}

export interface LineOrderAdapter extends LineOrderPort {
  /** 最近一次失敗的分類（只供 log，不含路徑或金鑰）。 */
  lastProblem(): string | null
  /** 清掉記憶體中的金鑰。 */
  forgetKey(): void
}

export function createLineOrder(opts: LineOrderOptions = {}): LineOrderAdapter {
  const now = opts.now ?? Date.now
  let key: string | null = null
  let problem: string | null = null

  const fetchKey = (dbPath: string): string | null =>
    getKey({ dbPath, cacheFile: opts.cacheFile, skipRecover: true })

  const read = (k: string, dbPath: string): OrderSnapshot => {
    const t0 = now()
    const { con, cleanup } = openDb(k, dbPath)
    try {
      const raws = con.prepare(ORDER_SQL).all() as RawOrderRow[]
      const prof = con.prepare(PROFILE_SQL).get() as { _mid: string | null } | undefined
      const selfMid = prof?._mid ?? null
      let squareStmt: { get(id: string): unknown } | null = null
      try {
        squareStmt = con.prepare(SQUARE_CHAT_SQL)
      } catch {
        squareStmt = null // 表不存在
      }
      const lookup = {
        chatName: (id: string): string | null => {
          try {
            return chatName(con, id)
          } catch {
            return null
          }
        },
        squareChatName: (id: string): string | null => {
          if (!squareStmt) return null
          try {
            const r = squareStmt.get(id) as { _name: string | null } | undefined
            return r?._name ?? null
          } catch {
            return null
          }
        }
      }
      const rows: OrderRow[] = raws.map((r) =>
        toOrderRow(r, resolveDisplayName(String(r._id), Number(r._midType ?? 0), selfMid, lookup))
      )
      let newest = 0
      for (const r of rows) if (r.lastUpdated > newest) newest = r.lastUpdated
      const takenAt = now()
      return { rows, selfMid, takenAt, newestUpdate: newest, readMs: takenAt - t0 }
    } finally {
      cleanup()
    }
  }

  const fail = (code: LineOrderFailCode, why: string): { ok: false; code: LineOrderFailCode } => {
    problem = why
    return { ok: false, code }
  }

  return {
    async snapshot() {
      const dbPath = opts.dbPath ?? findDb()
      if (!dbPath) return fail('line_db_unavailable', 'db_not_found')
      if (!key) {
        try {
          key = fetchKey(dbPath)
        } catch {
          key = null
        }
        if (!key) return fail('line_key_unavailable', 'no_cached_key')
      }
      try {
        const value = read(key, dbPath)
        problem = null
        return { ok: true as const, value }
      } catch {
        // 金鑰可能已輪替（LINE 重新登入）：重新從快取取一次（仍不掃記憶體）。
        let fresh: string | null = null
        try {
          fresh = fetchKey(dbPath)
        } catch {
          fresh = null
        }
        if (!fresh) {
          key = null
          return fail('line_key_unavailable', 'cached_key_rejected')
        }
        key = fresh
        try {
          const value = read(key, dbPath)
          problem = null
          return { ok: true as const, value }
        } catch {
          return fail('line_db_unavailable', 'read_failed')
        }
      }
    },
    lastProblem: () => problem,
    forgetKey: () => {
      key = null
    }
  }
}
