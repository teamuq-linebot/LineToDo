// Aggregate evidence/runs/*/result.json into the acceptance matrix (evidence/compare.json).
// References: e31-sa-bs3-11.10.0 (today's line-todo writer) and e44-bs3-13.0.3-npm (zero-adapter
// better-sqlite3 on the target runtime). Usage: node scripts/compare.mjs
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNS = join(ROOT, 'evidence', 'runs')
const labels = readdirSync(RUNS).filter((d) => statSync(join(RUNS, d)).isDirectory() && existsSync(join(RUNS, d, 'result.json')))
const load = (l) => JSON.parse(readFileSync(join(RUNS, l, 'result.json'), 'utf8'))
const all = Object.fromEntries(labels.map((l) => [l, load(l)]))
const phase = (r, p) => r.phases.find((x) => x.phase === p)
const pr = (r, p) => phase(r, p)?.result?.phaseResult
const J = (v) => JSON.stringify(v)
const REF_PROD = 'e31-sa-bs3-11.10.0', REF_E44 = 'e44-bs3-13.0.3-npm'

function diffKeys(a, b) {
  if (!a || !b) return null
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  return keys.filter((k) => J(a[k]) !== J(b[k])).map((k) => ({ key: k, candidate: a[k], reference: b[k] }))
}
const refApi = pr(all[REF_E44], 'create') && phase(all[REF_E44], 'create').result.apiProbes
const refApiProd = phase(all[REF_PROD], 'create')?.result?.apiProbes
const refOps = pr(all[REF_E44], 'create')?.ops
const refOpsProd = pr(all[REF_PROD], 'create')?.ops
const adapterLoc = (files) => files.reduce((n, f) => n + readFileSync(join(ROOT, 'harness', 'engines', f), 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length, 0)

const matrix = {}
for (const [label, r] of Object.entries(all)) {
  const ph = r.phases.filter((p) => !p.skipped)
  const create = phase(r, 'create')?.result
  const c = pr(r, 'create'), lg = pr(r, 'legacy'), im = pr(r, 'import'), ap = pr(r, 'append-noclose'), ro = pr(r, 'reopen')
  const selfChecks = ph.map((p) => (p.result ? [p.result.selfCheckBoot?.ok, p.result.selfCheckAfterEngine?.ok, p.result.selfCheckEnd?.ok] : null))
  matrix[label] = {
    runtime: create?.runtime ?? null, permission: r.permission, allowAddons: r.allowAddons, engine: r.engine, vendor: r.vendor, wasmExclusive: r.wasmExclusive, wasmSyncSkip: r.wasmSyncSkip,
    exitCodes: Object.fromEntries(r.phases.map((p) => [p.phase, p.exitCodeHex ?? p.skipped])),
    load: { engineLoaded: !!create?.engine?.loaded, engineError: create?.engine?.loaded ? null : (create?.engine ?? { processExit: phase(r, 'create')?.exitCodeHex }), info: create?.engine?.info ?? null, selfChecksAllOk: selfChecks.length > 0 && selfChecks.every((s) => s && s.every(Boolean)), selfChecks },
    walPersist: c ? { phaseOk: c.ok, phaseError: create.phaseError ?? null, journalMode: c.state?.journalMode, lockingMode: c.state?.lockingMode, quickCheck: c.state?.quickCheck, foreignKeys: c.state?.foreignKeys, filesAfterAppendKill: phase(r, 'append-noclose')?.filesAfter?.filter((f) => f.name.startsWith('line-todo')) } : { phaseError: create?.phaseError ?? null },
    schemaMigration: {
      freshUserVersion: c?.state?.userVersion, openLogs: c?.openLogs, schemaDigest: c?.digest?.schemaDigest,
      schemaDigestEqualsProd: c?.digest?.schemaDigest != null && c.digest.schemaDigest === pr(all[REF_PROD], 'create')?.digest?.schemaDigest,
      legacyV1toV6: lg ? { ok: lg.ok, logs: lg.open?.logs?.filter((l) => l.includes('opened')), userVersion: lg.state?.userVersion, messagesColumns: lg.messagesColumns, badMigrationThrew: lg.badOpen?.threw, badMigrationIsDbIntegrityError: lg.badOpen?.error?.isDbIntegrityError, badAfter: lg.badAfter } : (phase(r, 'legacy')?.result?.phaseError ?? null),
      importCurrentWriterDb: im ? { ok: im.ok, digestEqualsWriter: im.digestEqualsWriter, quickCheck: im.state?.quickCheck, journalMode: im.state?.journalMode } : (phase(r, 'import')?.result?.phaseError ?? phase(r, 'import')?.skipped ?? null),
    },
    restart: ro ? { ok: ro.ok, killExit: phase(r, 'append-noclose')?.exitCodeHex, digestEqualsBeforeKill: ro.digestEqualsBeforeKill, markerPresent: ro.markerPresent, legacyStillV6: ro.legacy?.userVersion === 6 && ro.legacy?.digestEqual, quickCheck: ro.state?.quickCheck, userVersion: ro.state?.userVersion } : (phase(r, 'reopen')?.result?.phaseError ?? null),
    apiShape: create?.apiProbes ? {
      adapterFiles: create.engine.adapterFiles, adapterNonCommentLines: adapterLoc(create.engine.adapterFiles),
      apiDiffVsE44Bs3: diffKeys(create.apiProbes, refApi), apiDiffVsProdBs3_11: diffKeys(create.apiProbes, refApiProd),
      repoOpsDiffVsE44Bs3: c ? diffKeys(c.ops, refOps)?.map((d) => d.key) : null, repoOpsDiffVsProdBs3_11: c ? diffKeys(c.ops, refOpsProd)?.map((d) => d.key) : null,
      opsSha: c?.opsSha,
    } : null,
    outsideDataDirOpen: create?.outsideDataDirOpen ?? null,
    interopSystemNodeSqlite: r.interopSystemNodeSqlite ?? null,
    perf: c ? { openDatabaseMs: c.openMs, ...c.timings, engineLoadMs: create.engine.loadMs, rssMB: create.memoryRssMB } : null,
    wasmVfs: create?.wasmVfs ? { syncMode: create.wasmVfs.stats.syncMode, xSync: create.wasmVfs.stats.xSync, xSyncSkippedDenied: create.wasmVfs.stats.xSyncSkippedDenied, lastError: create.wasmVfs.lastError } : null,
  }
}
writeFileSync(join(ROOT, 'evidence', 'compare.json'), JSON.stringify({ references: { prod: REF_PROD, e44: REF_E44 }, matrix }, null, 2))
const brief = Object.fromEntries(Object.entries(matrix).map(([l, m]) => [l, {
  load: m.load.engineLoaded, selfChecks: m.load.selfChecksAllOk, journal: m.walPersist.journalMode, create: m.walPersist.phaseOk ?? m.walPersist.phaseError?.message?.slice(0, 60),
  legacy: m.schemaMigration.legacyV1toV6?.ok ?? m.schemaMigration.legacyV1toV6?.message?.slice(0, 50), import: m.schemaMigration.importCurrentWriterDb?.ok ?? m.schemaMigration.importCurrentWriterDb, restart: m.restart?.ok ?? m.restart?.message?.slice(0, 50),
  apiDiff: m.apiShape?.apiDiffVsE44Bs3?.map((d) => d.key), opsDiff: m.apiShape?.repoOpsDiffVsE44Bs3, adapterLoc: m.apiShape?.adapterNonCommentLines, outside: m.outsideDataDirOpen?.opened,
}]))
console.log(JSON.stringify(brief, null, 1))
