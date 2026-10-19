// Content audit of a built plugin package (pure: works on { path, data } entries, so the tests can feed it synthetic packages).
// The rules (Phase 5 acceptance 3): no PowerShell script, no better-sqlite3-multiple-ciphers, no private key, no standalone better-sqlite3 11.x.
import crypto from 'node:crypto'

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')

const SCRIPT_EXT = /\.(?:ps1|psm1|psd1|bat|cmd|vbs|wsf|sh|exe|msi|scr|com|dll|so|dylib)$/i
const NATIVE_EXT = /\.node$/i
const PRIVATE_KEY_MARKERS = ['PRIVATE KEY', 'privatePkcs8', 'BEGIN OPENSSH']

/**
 * @param entries   [{ path, data: Buffer }] every file of the package (including manifest.json / integrity.json / signature.json)
 * @param options   { allowedNative: { [path]: sha256 }  the only native modules that may exist,
 *                    standalone11Sha256: string[]        sha256 of the standalone better-sqlite3 11.x binaries (must not appear),
 *                    secretNeedles: Buffer[]             private-key material (must not appear in any file) }
 * @returns { ok, problems, listing, natives }
 */
export function auditPackage(entries, { allowedNative = {}, standalone11Sha256 = [], secretNeedles = [] } = {}) {
  const problems = []
  const listing = []
  const natives = []
  for (const { path: name, data } of entries) {
    const lower = name.toLowerCase()
    listing.push({ path: name, size: data.length })
    if (/\.ps1$/i.test(name) || /\.psm1$/i.test(name) || /line-driver/i.test(name)) problems.push(`${name}: PowerShell script / line-driver (driver_post is not part of the plugin)`)
    else if (SCRIPT_EXT.test(name) && !NATIVE_EXT.test(name)) problems.push(`${name}: script / executable file`)
    if (/node_modules\//i.test(name)) problems.push(`${name}: node_modules content`)
    if (lower.includes('better-sqlite3-multiple-ciphers')) problems.push(`${name}: better-sqlite3-multiple-ciphers in the file name`)
    if (/(^|\/)dev-key[^/]*$/i.test(name) || /\.(?:key|pem)$/i.test(name)) problems.push(`${name}: looks like a key file`)
    if (data.includes(Buffer.from('better-sqlite3-multiple-ciphers'))) problems.push(`${name}: the text "better-sqlite3-multiple-ciphers" appears in the content`)
    for (const marker of PRIVATE_KEY_MARKERS) if (data.includes(Buffer.from(marker))) problems.push(`${name}: private-key marker "${marker}" appears in the content`)
    for (const needle of secretNeedles) if (needle.length >= 16 && data.includes(needle)) problems.push(`${name}: the development signing key material appears in the content`)
    if (NATIVE_EXT.test(name)) {
      const digest = sha256(data)
      natives.push({ path: name, size: data.length, sha256: digest })
      if (allowedNative[name] === undefined) problems.push(`${name}: native module that is not on the allow-list`)
      else if (allowedNative[name] !== digest) problems.push(`${name}: sha256 ${digest} differs from the pinned ${allowedNative[name]}`)
      if (standalone11Sha256.includes(digest)) problems.push(`${name}: this is the standalone better-sqlite3 11.x binary`)
    } else if (standalone11Sha256.includes(sha256(data))) problems.push(`${name}: this is the standalone better-sqlite3 11.x binary`)
  }
  const names = entries.map((entry) => entry.path)
  if (new Set(names).size !== names.length) problems.push('duplicate entry names')
  const sqliteNodes = natives.filter((native) => /better_sqlite3\.node$/i.test(native.path))
  if (sqliteNodes.length !== 1) problems.push(`expected exactly one better_sqlite3.node (the 13.0.2 plugin build), found ${sqliteNodes.length}`)
  return { ok: problems.length === 0, problems, listing, natives }
}
