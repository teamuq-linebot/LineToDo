/**
 * locate.ts — 用 LINE 本機 DB 的名次決定列位置，OCR 只驗證位置（design-v3 §3、§4）。純函式。
 *
 *   locateTarget  L1–L7：錨點 → 位移 → 目標列 → 否決與確認路徑（T / A / B）
 *   orderStable   L8：DB-A、DB-B 在可見窗與目標附近的順序相同、最近沒有更新、擷取穩定
 *   judgeOpen     §4 C1＋C2：UIA 選取列必須是目標列；標題以局部集合判定＋全域否決
 *   dbAck         §4 C3：DB 已讀旁證（只會導致停止，不會導致通過）
 *
 * 不變條件 I13：列的選擇只來自 DB 名次和錨點推定的位移；OCR 相似度永遠不會單獨決定點哪一列。
 * 所有參數預先登記、只准收緊（I7）。
 */
import { IDENTIFY_RULES, cpLen, isReadable, lev, maxVariantLen, normalizeName, score, type ReadingVariant } from './identify'
import { sameTime, type OrderRow, type OrderSnapshot } from './order'

/** 預先登記、只准收緊（I7）。design-v3 §3.5。 */
export const LOCATE_RULES = {
  /** 完整可見：visibleH ≥ 此值 × h。只有完整可見列會 OCR，也只有它們能當錨點或目標列。 */
  fullyVisible: 0.95,
  minAnchors: 3,
  /** 位移一致：零容忍。 */
  offsetTolerance: 0,
  /** 目標上方、下方都要有「其他」錨點（嚴格夾擠，§3.3）。 */
  strictBracket: true,
  /** A 路徑與局部否決的鄰居範圍 ±2。 */
  localWindow: 2,
  /**
   * B 路徑（相鄰錨點）要求 r±1…r±bracketB 都是錨點。design-v3 L6 原為 1；依 §9.6 G2 no-go 程序收緊為 2
   * （Batch 1–4 的 0c-B 正式版在「目標和鄰居同時間＋可見窗插入未知列」找到 1 次點錯：同時間讓目標上移一列、
   * 未知列補進目標原位，r±1 的錨點位移仍一致。要求 r±2 也是錨點後，被擠開的目標落在 r−2 或 r+2，必定不一致或不是錨點）。
   */
  bracketB: 2,
  /** 最新 _lastUpdatedTime 距今 < 此值 → list_changing（等 3 s 重來一次）。 */
  quietMs: 5000,
  retryOnChanging: 1,
  retryDelayMs: 3000,
  /** L8 比對 DB-A／DB-B 時，可見窗外加的邊界與目標附近範圍。 */
  stableWindowPad: 2,
  stableTargetPad: 3
} as const

export interface Anchor {
  /** 螢幕列號（UIA ListItem index）。 */
  row: number
  chatId: string
  rank: number
  offset: number
}

/** 完整可見列（螢幕順序），每列 3 組讀取（R1–R3）。 */
export interface LocateRow {
  index: number
  readings: ReadingVariant[][]
}

/** target_not_visible 的補充資訊（design-v3 §3.6、§7.2）。 */
export interface VisibilityHint {
  direction: 'above' | 'below' | 'edge'
  /** 目標距離完整可見範圍的列數（edge 時為 0）。 */
  rows: number
  /** edge 時：目標在可見範圍的上緣或下緣（缺哪一側的錨點）。 */
  edgeSide?: 'top' | 'bottom'
}

export type LocateFailCode =
  | 'target_not_in_line'
  | 'chat_name_unverifiable'
  | 'list_unrecognized'
  | 'list_order_mismatch'
  | 'target_not_visible'
  | 'row_unconfirmed'
  | 'row_identifies_other'

export type LocateResult =
  | { ok: true; row: number; rank: number; offset: number; anchors: Anchor[]; path: 'T' | 'A' | 'B' }
  | {
      ok: false
      code: LocateFailCode
      /** 已推定出位移時才有（診斷與 L8 範圍用）。 */
      offset?: number
      rank?: number
      anchors?: number
      visibility?: VisibilityHint
      otherChatId?: string
    }

// ── 名次索引 ──────────────────────────────────────────────────────────────

/** R* 的衍生索引：正規化名稱、唯一性、chatId → 名次。 */
export interface OrderIndex {
  order: readonly OrderRow[]
  /** 每個名次的正規化名稱（解析不到或正規化後為空 → null）。 */
  norms: (string | null)[]
  rankById: Map<string, number>
  /** U：所有可解析名稱（去重）。 */
  names: string[]
  /** 名稱 → 出現次數（整個 order）。 */
  count: Map<string, number>
  /** 名稱只出現一次時 → 它的名次。 */
  uniqRank: Map<string, number>
  /** 名稱 → 第一個名次（顯示「另一個聊天室」用）。 */
  firstRank: Map<string, number>
}

export function indexOrder(order: readonly OrderRow[]): OrderIndex {
  const norms = order.map((r) => {
    const n = r.name == null ? '' : normalizeName(r.name)
    return n ? n : null
  })
  const rankById = new Map<string, number>()
  const count = new Map<string, number>()
  const firstRank = new Map<string, number>()
  order.forEach((r, i) => {
    if (!rankById.has(r.chatId)) rankById.set(r.chatId, i)
    const n = norms[i]
    if (n) {
      count.set(n, (count.get(n) ?? 0) + 1)
      if (!firstRank.has(n)) firstRank.set(n, i)
    }
  })
  const uniqRank = new Map<string, number>()
  for (const [n, c] of count) if (c === 1) uniqRank.set(n, firstRank.get(n) as number)
  return { order, norms, rankById, names: [...count.keys()], count, uniqRank, firstRank }
}

/** 一次讀取在 U 中的最近與第二近名稱（不同名稱）。 */
function nearestTwo(v: readonly ReadingVariant[], names: readonly string[]): { n1: string | null; s1: number; s2: number } {
  let s1 = Infinity
  let s2 = Infinity
  let n1: string | null = null
  for (const n of names) {
    const d = score(v, n, s2)
    if (d < s1) {
      s2 = s1
      s1 = d
      n1 = n
    } else if (d < s2) {
      s2 = d
    }
  }
  return { n1, s1, s2 }
}

/** 讀取 v 中，是否有 U 內「目標以外」的名稱嚴格比目標更近，而且在該名稱自己的 maxErr 內（有把握的他者）。 */
function confidentOther(
  v: readonly ReadingVariant[],
  targetNorm: string,
  dT: number,
  names: readonly string[]
): { name: string; d: number } | null {
  let best: { name: string; d: number } | null = null
  for (const n of names) {
    if (n === targetNorm) continue
    const d = score(v, n, best ? Math.min(best.d, dT) : dT)
    if (d < dT && d <= IDENTIFY_RULES.maxErr(cpLen(n)) && (!best || d < best.d)) best = { name: n, d }
  }
  return best
}

/**
 * L1：找出錨點與衝突列。
 * 一組可讀讀取在 U 中的最近名稱 n₁ 滿足 s₁ ≤ maxErr(|n₁|) 且和第二近差距 ≥ G(|n₁|) 時，算「有把握地指向 n₁」。
 * 所有有把握的讀取都指向同一個名稱、而且該名稱 uniq → 錨點（投票給該聊天室）。
 * 有把握的讀取指向不同名稱 → 衝突列。收緊（I7，Batch 1–4 盤點）：design-v3 L1 只把 uniq 名稱算作投票；
 * 這裡把「有把握地指向非 uniq 名稱」也算進衝突判定，避免一組讀到同名聊天室、另一組讀到別的 uniq 名稱時仍被當成錨點。
 */
export function findAnchors(
  rows: readonly LocateRow[],
  idx: OrderIndex
): { anchors: Anchor[]; conflictRows: Set<number> } {
  const anchors: Anchor[] = []
  const conflictRows = new Set<number>()
  for (const row of rows) {
    const confident = new Set<string>()
    for (const v of row.readings) {
      if (maxVariantLen(v) < IDENTIFY_RULES.readableMinLen(0)) continue
      const { n1, s1, s2 } = nearestTwo(v, idx.names)
      if (!n1) continue
      const L1 = cpLen(n1)
      if (s1 <= IDENTIFY_RULES.maxErr(L1) && s2 - s1 >= IDENTIFY_RULES.gap(L1)) confident.add(n1)
    }
    if (confident.size > 1) {
      conflictRows.add(row.index)
      continue
    }
    if (confident.size === 1) {
      const n = [...confident][0]
      const rank = idx.uniqRank.get(n)
      if (rank !== undefined) anchors.push({ row: row.index, chatId: idx.order[rank].chatId, rank, offset: rank - row.index })
    }
  }
  return { anchors, conflictRows }
}

/**
 * design-v3 §3.2 L1–L7。rows 只含完整可見列（螢幕順序）；order = orderRStar(DB-B)。
 * idx 可預先以 indexOrder(order) 建立並重複使用（合成壓力測試用）；省略時現算。
 */
export function locateTarget(
  rows: readonly LocateRow[],
  order: readonly OrderRow[],
  targetChatId: string,
  idx: OrderIndex = indexOrder(order)
): LocateResult {
  const k = idx.rankById.get(targetChatId)
  if (k === undefined) return { ok: false, code: 'target_not_in_line' }
  const tgt = idx.norms[k]
  if (!tgt || cpLen(tgt) < IDENTIFY_RULES.minTargetLen) return { ok: false, code: 'chat_name_unverifiable', rank: k }
  const L = cpLen(tgt)

  // L1、L2
  const { anchors, conflictRows } = findAnchors(rows, idx)
  if (anchors.length < LOCATE_RULES.minAnchors) return { ok: false, code: 'list_unrecognized', rank: k, anchors: anchors.length }
  // L3（零容忍）
  const o = anchors[0].offset
  if (anchors.some((a) => Math.abs(a.offset - o) > LOCATE_RULES.offsetTolerance)) {
    return { ok: false, code: 'list_order_mismatch', rank: k, anchors: anchors.length }
  }
  const base = { rank: k, offset: o, anchors: anchors.length }

  // L4
  const r = k - o
  const visible = rows.map((x) => x.index)
  const first = Math.min(...visible)
  const last = Math.max(...visible)
  const targetRow = rows.find((x) => x.index === r)
  if (!targetRow) {
    if (r < first) return { ok: false, code: 'target_not_visible', ...base, visibility: { direction: 'above', rows: first - r } }
    if (r > last) return { ok: false, code: 'target_not_visible', ...base, visibility: { direction: 'below', rows: r - last } }
    return { ok: false, code: 'target_not_visible', ...base, visibility: { direction: 'edge', rows: 0 } }
  }
  const above = anchors.some((a) => a.row < r)
  const below = anchors.some((a) => a.row > r)
  if (!above || !below) {
    return { ok: false, code: 'target_not_visible', ...base, visibility: { direction: 'edge', rows: 0, edgeSide: !above ? 'top' : 'bottom' } }
  }

  // L5 全域否決
  const readable = targetRow.readings.filter((v) => isReadable(v, L))
  let other: { name: string; d: number } | null = null
  for (const v of readable) {
    const dT = score(v, tgt)
    const c = confidentOther(v, tgt, dT, idx.names)
    if (c && (!other || c.d < other.d)) other = c
  }
  if (other) {
    const rank = idx.firstRank.get(other.name)
    return { ok: false, code: 'row_identifies_other', ...base, otherChatId: rank === undefined ? undefined : idx.order[rank].chatId }
  }
  // L7 衝突列
  if (conflictRows.has(r)) return { ok: false, code: 'row_unconfirmed', ...base }

  // L6 局部否決＋路徑
  const w = LOCATE_RULES.localWindow
  const local: number[] = []
  for (let j = k - w; j <= k + w; j++) if (j !== k && j >= 0 && j < idx.order.length) local.push(j)
  const localNames = local.map((j) => idx.norms[j]).filter((n): n is string => !!n)
  let pathA = false
  for (const v of readable) {
    const dT = score(v, tgt)
    let dLocal = Infinity
    for (const n of localNames) dLocal = Math.min(dLocal, score(v, n, dLocal))
    if (dLocal < dT) return { ok: false, code: 'row_unconfirmed', ...base }
    if (dT <= IDENTIFY_RULES.maxErr(L) && dLocal - dT >= IDENTIFY_RULES.gap(L)) pathA = true
  }
  const anchorAt = (row: number): Anchor | undefined => anchors.find((a) => a.row === row)
  const self = anchorAt(r)
  if (self && self.chatId === targetChatId) return { ok: true, row: r, rank: k, offset: o, anchors, path: 'T' }
  const localDistinct =
    localNames.length === local.length &&
    localNames.every((n) => lev(n, tgt) >= IDENTIFY_RULES.gap(L)) &&
    local.every((j) => !sameTime(idx.order, j, k))
  if (localDistinct && pathA) return { ok: true, row: r, rank: k, offset: o, anchors, path: 'A' }
  let bracketB = true
  for (let d = 1; d <= LOCATE_RULES.bracketB; d++) if (!anchorAt(r - d) || !anchorAt(r + d)) bracketB = false
  if (bracketB) return { ok: true, row: r, rank: k, offset: o, anchors, path: 'B' }
  return { ok: false, code: 'row_unconfirmed', ...base }
}

// ── L8 ────────────────────────────────────────────────────────────────────

export interface RankRange {
  from: number
  to: number
}

/**
 * L8 要比對的名次範圍：可見窗 [o+first−2, o+last+2]（已推定位移時）與目標附近 [k−3, k+3]。
 * 位移未知（錨點不足或不一致）時改比對 [0, max(k+3, 60)]。
 */
export function stableRanges(res: LocateResult, rows: readonly LocateRow[], k: number): RankRange[] {
  const out: RankRange[] = [{ from: k - LOCATE_RULES.stableTargetPad, to: k + LOCATE_RULES.stableTargetPad }]
  const o = res.ok ? res.offset : res.offset
  if (o !== undefined && rows.length) {
    const first = Math.min(...rows.map((r) => r.index))
    const last = Math.max(...rows.map((r) => r.index))
    out.push({ from: o + first - LOCATE_RULES.stableWindowPad, to: o + last + LOCATE_RULES.stableWindowPad })
  } else {
    out.push({ from: 0, to: Math.max(k + LOCATE_RULES.stableTargetPad, 60) })
  }
  return out
}

export type OrderStableResult = { ok: true } | { ok: false; reason: 'order_changed' | 'recent_update' | 'capture_unstable' }

/**
 * L8 新鮮度：DB-A 與 DB-B 的 R* 在 ranges 內完全相同；DB-B 的最新更新距今 ≥ quietMs；helper 擷取時列表穩定。
 * a、b 是兩次快照各自的 R*。
 */
export function orderStable(
  a: readonly OrderRow[],
  b: readonly OrderRow[],
  ranges: readonly RankRange[],
  fresh: { newestUpdate: number; now: number; captureStable: boolean }
): OrderStableResult {
  if (!fresh.captureStable) return { ok: false, reason: 'capture_unstable' }
  if (fresh.now - fresh.newestUpdate < LOCATE_RULES.quietMs) return { ok: false, reason: 'recent_update' }
  for (const rg of ranges) {
    const from = Math.max(0, rg.from)
    const to = Math.min(Math.max(a.length, b.length) - 1, rg.to)
    for (let i = from; i <= to; i++) {
      if (a[i]?.chatId !== b[i]?.chatId) return { ok: false, reason: 'order_changed' }
    }
  }
  return { ok: true }
}

// ── §4 C1、C2 ─────────────────────────────────────────────────────────────

export interface OpenEvidence {
  selectionMatched: boolean
  titleSim: number
  titleGap: number
  titlePass: number
  /** DB 已讀旁證：只記錄與停止，不作為通過條件（design-v3 §4 C3）。 */
  dbAck: 'target_cleared' | 'no_change' | 'na' | 'skipped'
  /** 顯示用；不寫 log。 */
  seenTitle: string
}

export type JudgeOpenResult =
  | { ok: true; evidence: Omit<OpenEvidence, 'dbAck'> }
  | {
      ok: false
      code: 'click_missed' | 'title_unreadable' | 'title_unconfirmed' | 'title_identifies_other'
      otherChatId?: string
      seenTitle?: string
    }

/**
 * design-v3 §4 C1＋C2。
 *   C1：點擊後 UIA 選取列必須是目標列；點擊前選取的不是目標列時，標題 hash 也必須改變。
 *   C2：候選集合＝目標＋R*[k−2..k+2]＋點擊前開著的聊天室（selectedBefore＋offset）。
 *       至少 1 組可讀讀取 s(target) ≤ maxErr(L) 且和局部集合其他名稱的差距 ≥ G(L)；
 *       沒有任何讀取讓局部集合其他名稱嚴格更近；另以全部 U 做 L5 的全域否決。
 */
export function judgeOpen(args: {
  targetRow: number
  offset: number
  targetChatId: string
  selectedBefore: number | null
  selectedAfter: number | null
  titleHashBefore: string
  titleHashAfter: string
  title: { readings: ReadingVariant[][]; texts: string[] }
  order: readonly OrderRow[]
  idx?: OrderIndex
}): JudgeOpenResult {
  // C1
  if (args.selectedAfter === null || args.selectedAfter !== args.targetRow) return { ok: false, code: 'click_missed' }
  if (args.selectedBefore !== args.targetRow && args.titleHashAfter === args.titleHashBefore) return { ok: false, code: 'click_missed' }

  // C2
  const idx = args.idx ?? indexOrder(args.order)
  const k = idx.rankById.get(args.targetChatId)
  if (k === undefined) return { ok: false, code: 'title_unconfirmed' }
  const tgt = idx.norms[k]
  if (!tgt) return { ok: false, code: 'title_unconfirmed' }
  const L = cpLen(tgt)
  const localRanks = new Set<number>()
  for (let j = k - LOCATE_RULES.localWindow; j <= k + LOCATE_RULES.localWindow; j++) {
    if (j !== k && j >= 0 && j < idx.order.length) localRanks.add(j)
  }
  if (args.selectedBefore !== null && args.selectedBefore !== args.targetRow) {
    const j = args.selectedBefore + args.offset
    if (j !== k && j >= 0 && j < idx.order.length) localRanks.add(j)
  }
  const localNames = [...localRanks].map((j) => idx.norms[j]).filter((n): n is string => !!n)

  const { readings, texts } = args.title
  let anyReadable = false
  let passes = 0
  let bestI = -1
  let bestDT = Infinity
  let bestGap = 0
  let nearestI = -1
  let nearestD = Infinity
  let otherName: string | null = null
  let otherD = Infinity
  let localContra = false
  for (let i = 0; i < readings.length; i++) {
    const v = readings[i]
    if (!isReadable(v, L)) continue
    anyReadable = true
    const dT = score(v, tgt)
    if (dT < nearestD) {
      nearestD = dT
      nearestI = i
    }
    let dLocal = Infinity
    for (const n of localNames) dLocal = Math.min(dLocal, score(v, n, dLocal))
    if (dLocal < dT) localContra = true
    const c = confidentOther(v, tgt, dT, idx.names)
    if (c && c.d < otherD) {
      otherName = c.name
      otherD = c.d
    }
    if (dT <= IDENTIFY_RULES.maxErr(L) && dLocal - dT >= IDENTIFY_RULES.gap(L)) {
      passes++
      if (dT < bestDT) {
        bestDT = dT
        bestI = i
        bestGap = Number.isFinite(dLocal) ? dLocal - dT : L
      }
    }
  }
  const seen = nearestI >= 0 ? texts[nearestI] : undefined
  if (!anyReadable) return { ok: false, code: 'title_unreadable' }
  if (otherName !== null) {
    const r = idx.firstRank.get(otherName)
    return { ok: false, code: 'title_identifies_other', otherChatId: r === undefined ? undefined : idx.order[r].chatId, seenTitle: seen }
  }
  if (localContra || bestI < 0) return { ok: false, code: 'title_unconfirmed', seenTitle: seen }
  return {
    ok: true,
    evidence: {
      selectionMatched: true,
      titleSim: Math.max(0, Math.round((1 - bestDT / L) * 1000) / 1000),
      titleGap: bestGap,
      titlePass: passes,
      seenTitle: texts[bestI] ?? ''
    }
  }
}

// ── §4 C3 ─────────────────────────────────────────────────────────────────

export type DbAckResult = { verdict: 'target_cleared' | 'no_change' } | { verdict: 'other_cleared'; otherChatId: string }

/**
 * design-v3 §4 C3（stop-only）：比較 DB-B（開啟前）與 DB-C（開啟後）。
 * 另一個聊天室的未讀從 > 0 變成 0，而目標沒有 → other_cleared（停止）。
 * 目標從 > 0 變成 0 → target_cleared（只記錄）。沒有變化 → no_change（視為沒有證據，照常繼續）。
 */
export function dbAck(before: OrderSnapshot, after: OrderSnapshot, targetChatId: string): DbAckResult {
  const prev = new Map<string, number>()
  for (const r of before.rows) prev.set(r.chatId, r.unread > 0 ? r.unread : 0)
  let targetCleared = false
  let otherCleared: string | null = null
  for (const r of after.rows) {
    const p = prev.get(r.chatId)
    if (p === undefined || p <= 0) continue
    if ((r.unread > 0 ? r.unread : 0) !== 0) continue
    if (r.chatId === targetChatId) targetCleared = true
    else if (otherCleared === null) otherCleared = r.chatId
  }
  if (otherCleared !== null && !targetCleared) return { verdict: 'other_cleared', otherChatId: otherCleared }
  return { verdict: targetCleared ? 'target_cleared' : 'no_change' }
}
