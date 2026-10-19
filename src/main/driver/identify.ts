/**
 * identify.ts — 名稱正規化、OCR 讀取變體、加權距離（design-v2 §4.1–§4.3；design-v3 §8.1 縮減版）。
 *
 * 純函式、沒有 I/O。v3 把「挑哪一列」交給 DB 名次＋錨點（locate.ts），本檔只負責：
 *   - normalizeName：v1 §4.2 的正規化（NFKC、去空白、只留字母數字、小寫、o→0、i/l→1）
 *   - 從 OCR 行取出名稱行（資料列：最上面的視覺行；標題：最接近標題列中心的行）
 *   - readingVariants：v2 §4.2 的讀取變體（full / dropLead / stripMembers / 截斷）
 *   - score：v2 §4.3 的加權 Levenshtein（截斷時用前綴距離）
 * v2 的跨列挑選、事前可行性判斷與全域標題判定已刪除（v3 改由 locate.ts 的局部判定取代）。
 *
 * 所有門檻都是預先登記的常數，只准往嚴的方向調（I7）。
 */
import type { OcrLineDTO, OcrWordDTO, ScreenRect } from './port'

/** 預先登記、只准收緊（I7）。design-v2 §4.5。 */
export const IDENTIFY_RULES = {
  /** 目標正規化後最短長度；更短 → chat_name_unverifiable。 */
  minTargetLen: 2,
  /** 目標本身的距離上限：至少 2/3 的字相同。 */
  maxErr: (L: number): number => Math.floor(L / 3),
  /** 和第二近名稱的最小差距。 */
  gap: (L: number): number => Math.max(2, Math.ceil(L / 5)),
  /** 一次讀取可參與判定的最短長度（最長變體）。 */
  readableMinLen: (L: number): number => Math.max(2, Math.ceil(L / 2)),
  /** 開頭單字被當成圖示字元時的加權。 */
  dropLeadPenalty: 0.5,
  /** 截斷讀取至少要有幾個正規化字元，才用前綴距離。 */
  minTruncatedLen: 4,
  /** 雜訊字：高度 < 該段字高中位數 × 此值就丟掉。 */
  artifactHeightRatio: 0.6,
  /** 名稱行合併：垂直中心相差不超過最上行高度 × 此值。 */
  topLineMergeRatio: 0.6,
  /** 最左段切分：相鄰字水平間距 > 字高 × 此值就切開。 */
  segmentGapRatio: 2
} as const

/** 一次讀取的一個變體（已正規化）。 */
export interface ReadingVariant {
  norm: string
  penalty: number
  truncated: boolean
}

const SPACES = /[\s　​-‍⁠﻿]/g
// NFKC 之後 '…'(U+2026) 會變成 '...'、'‥'(U+2025) 變成 '..'；'⋯'(U+22EF) 保留。
const TRUNC = /(?:\.{2,}|…|⋯|‥)+$/
const MEMBERS = /[(（]\d{1,4}[)）]$/
const SURROGATE = /[\ud800-\udfff]/

function base(raw: string): string {
  return String(raw ?? '').normalize('NFKC').replace(SPACES, '')
}

function fin(s: string): string {
  return s
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase()
    .replace(/o/g, '0')
    .replace(/[il]/g, '1')
}

/** v1 §4.2：名稱正規化（DB 名稱與 OCR 兩側共用）。冪等。 */
export function normalizeName(raw: string | null | undefined): string {
  return fin(base(raw ?? ''))
}

/** 以 code point 計算長度（CJK 擴充區的字不會算成 2）。 */
export function cpLen(s: string): number {
  if (!SURROGATE.test(s)) return s.length
  let n = 0
  for (const _ of s) n++
  return n
}

function cpPrefix(s: string, n: number): string {
  if (!SURROGATE.test(s)) return s.slice(0, n)
  return Array.from(s).slice(0, n).join('')
}

/**
 * 有上限的 Levenshtein（插入、刪除、替換成本都是 1）。
 * 結果 > cap 時可能回傳任何 > cap 的值（呼叫端只用來比較）。
 */
export function lev(a: string, b: string, cap = Infinity): number {
  let A: ArrayLike<number>
  let B: ArrayLike<number>
  if (SURROGATE.test(a) || SURROGATE.test(b)) {
    A = Array.from(a, (c) => c.codePointAt(0) as number)
    B = Array.from(b, (c) => c.codePointAt(0) as number)
  } else {
    A = strCodes(a)
    B = strCodes(b)
  }
  const m = A.length
  const n = B.length
  if (m === 0) return n
  if (n === 0) return m
  if (Math.abs(m - n) > cap) return Math.abs(m - n)
  let prev = new Array<number>(n + 1)
  let cur = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    let rowMin = i
    const ai = A[i - 1]
    for (let j = 1; j <= n; j++) {
      const sub = prev[j - 1] + (ai === B[j - 1] ? 0 : 1)
      const del = prev[j] + 1
      const ins = cur[j - 1] + 1
      const v = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > cap) return rowMin
    const t = prev
    prev = cur
    cur = t
  }
  return prev[n]
}

function strCodes(s: string): number[] {
  const out = new Array<number>(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/**
 * v2 §4.3：讀取（一組變體）和候選名稱 candidateNorm 的加權距離 s(r, n)。越小越像。
 *   未截斷：min over 變體 [ lev(v, n) + penalty ]
 *   截斷：  lev(v, prefix(n, |v|)) + penalty，且 |v| ≥ 4；否則該變體不適用（Infinity）
 * cap：只需要知道「是否 < cap」時的剪枝上限（結果 ≥ cap 時回傳值不精確，但一定 ≥ cap）。
 */
export function score(variants: readonly ReadingVariant[], candidateNorm: string, cap = Infinity): number {
  let best = Infinity
  const nLen = cpLen(candidateNorm)
  for (const v of variants) {
    const limit = Math.min(best, cap)
    const vLen = cpLen(v.norm)
    if (v.truncated) {
      if (vLen < IDENTIFY_RULES.minTruncatedLen) continue
      const pre = cpPrefix(candidateNorm, vLen)
      const pLen = Math.min(vLen, nLen)
      if (Math.abs(vLen - pLen) + v.penalty >= limit) continue
      const d = lev(v.norm, pre, limit - v.penalty) + v.penalty
      if (d < best) best = d
    } else {
      if (Math.abs(vLen - nLen) + v.penalty >= limit) continue
      const d = lev(v.norm, candidateNorm, limit - v.penalty) + v.penalty
      if (d < best) best = d
    }
  }
  return best
}

/** 最長變體的長度（可讀門檻用）。 */
export function maxVariantLen(variants: readonly ReadingVariant[]): number {
  let m = 0
  for (const v of variants) {
    const l = cpLen(v.norm)
    if (l > m) m = l
  }
  return m
}

/** v2 §4.2-6：這次讀取對長度 L 的目標是否可讀。 */
export function isReadable(variants: readonly ReadingVariant[], L: number): boolean {
  return maxVariantLen(variants) >= IDENTIFY_RULES.readableMinLen(L)
}

// ── 名稱行取法 ────────────────────────────────────────────────────────────

/**
 * 資料列：Windows OCR 常把同一視覺行（中英混排）拆成好幾行。把垂直中心和最上面那行相差
 * 不超過 0.6 倍行高的 OCR 行合併成一行（spike 的 mergeTopVisualLine）。
 */
export function rowNameLine(lines: readonly OcrLineDTO[] | undefined | null): OcrLineDTO | null {
  if (!lines || lines.length === 0) return null
  const top = [...lines].sort((a, b) => a.rect.y - b.rect.y)[0]
  const cy = top.rect.y + top.rect.h / 2
  const tol = Math.max(4, top.rect.h * IDENTIFY_RULES.topLineMergeRatio)
  const band = lines.filter((l) => Math.abs(l.rect.y + l.rect.h / 2 - cy) <= tol)
  const words = band.flatMap((l) => (l.words && l.words.length ? l.words : [{ text: l.text, rect: l.rect }]))
  words.sort((a, b) => a.rect.x - b.rect.x)
  const x1 = Math.min(...band.map((l) => l.rect.x))
  const y1 = Math.min(...band.map((l) => l.rect.y))
  const x2 = Math.max(...band.map((l) => l.rect.x + l.rect.w))
  const y2 = Math.max(...band.map((l) => l.rect.y + l.rect.h))
  return { text: words.map((w) => w.text).join(' '), rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, words }
}

/** 標題：取垂直中心最接近標題列中心的那一行（v1 §4.3）。 */
export function titleNameLine(lines: readonly OcrLineDTO[] | undefined | null, stripRect: ScreenRect): OcrLineDTO | null {
  if (!lines || lines.length === 0) return null
  const cy = stripRect.y + stripRect.h / 2
  let best: OcrLineDTO | null = null
  let bd = Infinity
  for (const l of lines) {
    const d = Math.abs(l.rect.y + l.rect.h / 2 - cy)
    if (d < bd) {
      bd = d
      best = l
    }
  }
  return best
}

/** v1 §4.3：相鄰字水平間距 > 2 倍字高就切開，只保留最左段。 */
function leftmostSegment(words: readonly OcrWordDTO[]): OcrWordDTO[] {
  const ws = [...words].sort((a, b) => a.rect.x - b.rect.x)
  if (ws.length === 0) return []
  const seg = [ws[0]]
  for (let i = 1; i < ws.length; i++) {
    const prev = ws[i - 1]
    const w = ws[i]
    const gap = w.rect.x - (prev.rect.x + prev.rect.w)
    const hgt = Math.max(prev.rect.h, w.rect.h, 1)
    if (gap > IDENTIFY_RULES.segmentGapRatio * hgt) break
    seg.push(w)
  }
  return seg
}

/** v2 §4.2-3：高度小於字高中位數 0.6 倍的字丟掉（殘影、圖示邊緣）。 */
function dropArtifacts(words: readonly OcrWordDTO[]): OcrWordDTO[] {
  if (words.length < 2) return [...words]
  const hs = words.map((w) => w.rect.h).sort((a, b) => a - b)
  const mid = hs.length >> 1
  const median = hs.length % 2 ? hs[mid] : (hs[mid - 1] + hs[mid]) / 2
  return words.filter((w) => w.rect.h >= median * IDENTIFY_RULES.artifactHeightRatio)
}

/**
 * v2 §4.2：OCR 名稱行 → 讀取變體。沒有文字時回傳 []（等同 unreadable）。
 *   full（0）、dropLead（第一個字只有 1 個字元且後面還有字，0.5）、stripMembers（結尾「(數字)」，0）、
 *   dropLead+stripMembers（0.5）。結尾是省略號時所有變體標記 truncated（用前綴距離）。
 */
export function readingVariants(line: OcrLineDTO | null | undefined): ReadingVariant[] {
  if (!line) return []
  const words0 = line.words && line.words.length ? line.words : [{ text: line.text ?? '', rect: line.rect }]
  const words = dropArtifacts(leftmostSegment(words0.filter((w) => String(w.text ?? '').trim() !== '')))
  if (words.length === 0) return []
  const texts = words.map((w) => base(w.text))
  const variants: ReadingVariant[] = []
  const push = (s: string, penalty: number): void => {
    let t = s
    const truncated = TRUNC.test(t)
    if (truncated) t = t.replace(TRUNC, '')
    const add = (raw: string, p: number): void => {
      const norm = fin(raw)
      if (!norm) return
      const dup = variants.find((v) => v.norm === norm && v.truncated === truncated)
      if (dup) {
        if (p < dup.penalty) dup.penalty = p
        return
      }
      variants.push({ norm, penalty: p, truncated })
    }
    add(t, penalty)
    if (MEMBERS.test(t)) add(t.replace(MEMBERS, ''), penalty)
  }
  push(texts.join(''), 0)
  if (texts.length > 1 && cpLen(texts[0]) === 1) push(texts.slice(1).join(''), IDENTIFY_RULES.dropLeadPenalty)
  return variants
}

/** 資料列：各 config 的 OCR 行 → 每組一個讀取（變體陣列）。順序依 configs。 */
export function rowReadings<K extends string>(
  ocr: Partial<Record<K, readonly OcrLineDTO[]>> | undefined,
  configs: readonly K[]
): ReadingVariant[][] {
  return configs.map((c) => readingVariants(rowNameLine(ocr?.[c] ?? null)))
}

/** 標題：各 config 的 OCR 行 → 每組一個讀取，以及顯示用原文（最左段文字）。 */
export function titleReadings<K extends string>(
  byConfig: Partial<Record<K, readonly OcrLineDTO[]>>,
  stripRect: ScreenRect,
  configs: readonly K[]
): { readings: ReadingVariant[][]; texts: string[] } {
  const readings: ReadingVariant[][] = []
  const texts: string[] = []
  for (const c of configs) {
    const line = titleNameLine(byConfig[c] ?? null, stripRect)
    readings.push(readingVariants(line))
    if (!line) {
      texts.push('')
      continue
    }
    const ws = line.words && line.words.length ? line.words : [{ text: line.text, rect: line.rect }]
    texts.push(dropArtifacts(leftmostSegment(ws)).map((w) => w.text).join(' '))
  }
  return { readings, texts }
}
