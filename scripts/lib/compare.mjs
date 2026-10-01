// Deep comparison of two linedb-suite results (see linedb-suite.mjs).
//
// Rule: every check must be deep-equal between engines, EXCEPT — for the int64 fixture under the 'exact'
// int64 mode — the checks whose output contains the message `_id` (msgId). There the WASM engine
// intentionally keeps the exact 18-digit id where standalone better-sqlite3 returns a lossy Number
// (src/main/line/engine/wasm/int64.ts); those checks are asserted separately against the writer's ground truth.
import assert from 'node:assert/strict'

export const ID_BEARING_CHECKS = [
  'newMessagesTail', 'newMessagesByName', 'newMessagesAfterBoundary', 'newMessagesAfterExclusive',
  'pagingFullScan', 'watchBatch', 'messageDigest', 'int64MsgIds', 'int64RawIdTypes',
]

/** @returns {string[]} human-readable list of mismatches (empty = engines agree). */
export function diffSuites(reference, got, { int64Mode = 'exact' } = {}) {
  const diffs = []
  for (const kind of Object.keys(reference.variants)) {
    const a = reference.variants[kind]
    const b = got.variants[kind]
    if (!b) { diffs.push(`${kind}: missing variant`); continue }
    for (const name of Object.keys(a)) {
      if (kind === 'int64' && int64Mode === 'exact' && ID_BEARING_CHECKS.includes(name)) continue
      try {
        assert.deepEqual(b[name], a[name])
      } catch {
        diffs.push(`${kind}.${name}: reference=${JSON.stringify(a[name]).slice(0, 160)} got=${JSON.stringify(b[name]).slice(0, 160)}`)
      }
    }
    for (const name of Object.keys(b)) if (!(name in a)) diffs.push(`${kind}.${name}: not in reference`)
  }
  try {
    assert.deepEqual(got.wrongKey, reference.wrongKey)
  } catch {
    diffs.push(`wrongKey: reference=${JSON.stringify(reference.wrongKey)} got=${JSON.stringify(got.wrongKey)}`)
  }
  return diffs
}
