// Cross-engine comparison of the linedb.ts query suite outputs, plus a compact summary table.
// Usage: node scripts/compare.mjs   (reads evidence/*-result.json, writes evidence/compare.json)
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const EVID = join(dirname(dirname(fileURLToPath(import.meta.url))), 'evidence')
const load = (l) => { const f = join(EVID, `${l}-result.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }
const labels = ['e44-wasm-addons', 'e44-wasm-noaddons', 'e31-wasm-addons', 'e31-bsqlite-addons', 'e44-bsqlite-addons']
const runs = Object.fromEntries(labels.map((l) => [l, load(l)]))
const h = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)

const ref = 'e31-bsqlite-addons'
const out = { reference: ref, perCheck: {}, summary: {} }
for (const kind of ['wal', 'rollback']) {
  const refSuite = runs[ref]?.result?.correctness?.[kind]?.suite
  if (!refSuite) continue
  for (const name of Object.keys(refSuite)) {
    const row = { reference: { ok: refSuite[name].ok, hash: h(refSuite[name]) } }
    for (const l of labels.filter((x) => x !== ref)) {
      const s = runs[l]?.result?.correctness?.[kind]?.suite?.[name]
      if (!s) { row[l] = 'n/a'; continue }
      row[l] = { ok: s.ok, sameAsReference: h(s) === row.reference.hash }
      if (h(s) !== row.reference.hash) row[l].diff = { engine: s, reference: refSuite[name] }
    }
    out.perCheck[`${kind}.${name}`] = row
  }
}
for (const l of labels) {
  const r = runs[l]; if (!r) continue
  const x = r.result
  out.summary[l] = {
    exitCode: r.exitCode, abi: x?.runtime?.modules_abi, electron: x?.runtime?.electron, allowAddons: r.allowAddons, copyVia: r.copyVia,
    selfCheck: [x?.selfCheckBoot?.ok, x?.selfCheckAfterEngine?.ok, x?.selfCheckEnd?.ok],
    selfCheckAddonProbe: x?.selfCheckBoot?.probes?.addon_code,
    engineLoaded: x?.engine?.loaded, engineLoadMs: x?.engine?.loadMs, engineErr: x?.engine?.code, engineInfo: x?.engine?.info && { sqlite: x.engine.info.sqlite, mc: x.engine.info.mc, vfs: x.engine.info.defaultVfs },
    controlNodeFsOutside: x?.controlNodeFsOutside, koffi: x?.koffi,
    walDefaultLocking: x?.walDefaultLocking,
    wal: x?.correctness?.wal && { ok: x.correctness.wal.ok, journalMode: x.correctness.wal.journalMode, checkpoint: x.correctness.wal.checkpoint, count: x.correctness.wal.countMatches, digest: x.correctness.wal.digestMatches, maxRow: x.correctness.wal.maxRowMatches },
    rollback: x?.correctness?.rollback && { ok: x.correctness.rollback.ok, journalMode: x.correctness.rollback.journalMode, count: x.correctness.rollback.countMatches, digest: x.correctness.rollback.digestMatches },
    wrongKey: x?.wrongKey, benchMedian: x?.bench?.median, benchFirst: x?.bench?.first, keyScan: x?.keyScan,
    mem: { before: x?.memBefore, afterEngineLoad: x?.memAfterEngineLoad, afterOpenFirstIter: x?.bench?.iters?.[0]?.memAfterOpen, end: x?.memEnd },
  }
}
const allSame = Object.values(out.perCheck).every((row) => Object.entries(row).filter(([k]) => k !== 'reference').every(([, v]) => v === 'n/a' || (v.ok && v.sameAsReference)))
out.allChecksIdenticalAcrossEngines = allSame
out.differingChecks = Object.entries(out.perCheck).filter(([, row]) => Object.entries(row).some(([k, v]) => k !== 'reference' && v !== 'n/a' && !v.sameAsReference)).map(([k]) => k)
writeFileSync(join(EVID, 'compare.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify({ allChecksIdenticalAcrossEngines: allSame, differingChecks: out.differingChecks, nChecks: Object.keys(out.perCheck).length }, null, 2))
for (const k of out.differingChecks) console.log(k, JSON.stringify(out.perCheck[k]).slice(0, 1500))
