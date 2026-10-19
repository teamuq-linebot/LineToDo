// Print a compact comparison table across all evidence/*-result.json records.
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const EVID = join(dirname(dirname(fileURLToPath(import.meta.url))), 'evidence')
for (const f of readdirSync(EVID).filter((x) => x.endsWith('-result.json'))) {
  const rec = JSON.parse(readFileSync(join(EVID, f), 'utf8'))
  const r = rec.result
  const line = {
    label: rec.label,
    exit: rec.exitCode,
    abi: r?.runtime?.modules_abi,
    allowAddons: rec.allowAddons,
    selfCheck_ok: r?.selfCheck?.ok,
    selfCheck_code: r?.selfCheck?.code,
    selfCheckAfterAddons_ok: r?.selfCheckAfterAddons?.ok,
    koffi_loaded: r?.experiments?.koffi?.loaded,
    koffi_read_outside: r?.experiments?.koffi?.read_outside?.ok,
    koffi_write_outside: r?.experiments?.koffi?.write_outside?.ok,
    bsqlite_open_outside: r?.experiments?.bsqlite?.open_plain_outside,
    bsqlite_cipher_outside: r?.experiments?.bsqlite?.cipher_outside,
    bsqlite_guard_neutralised: r?.experiments?.bsqlite?.open_plain_outside_guard_neutralised,
    ctrl_nodefs_read_outside: r?.experiments?.control_nodefs?.nodeFsReadOutside,
    ctrl_nodefs_existsSync_outside: r?.experiments?.control_nodefs?.nodeFsExistsSyncOutside,
    ctrl_nodefs_read_inside: r?.experiments?.control_nodefs?.nodeFsReadInsideDataDir,
  }
  console.log('===', rec.label, '===')
  console.log(JSON.stringify(line, null, 2))
}
