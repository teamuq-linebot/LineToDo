// Packing and signing helpers. The container writer is the official teamuq-electron plugin-artifact test fixture builder
// (packages/platform/plugin-artifact/test/zipFixtures.mjs) taken from the PINNED commit with `git show`, so the container format
// cannot drift with the working tree (same approach as ai-lover / speech-funasr). Nothing is written into teamuq-electron.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DEV_KEY_FILE, DEV_KEY_ID, TE_COMMIT, TE_DIR, WORK } from './paths.mjs'

export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex')

export function gitShow(rel, commit = TE_COMMIT) {
  const shown = spawnSync('git', ['-C', TE_DIR, 'show', `${commit}:${rel}`], { encoding: 'buffer', maxBuffer: 1 << 26 })
  if (shown.status !== 0) throw new Error(`cannot read ${rel} at ${commit} from ${TE_DIR} (set TEAMUQ_ELECTRON_DIR / TE_COMMIT)`)
  return shown.stdout
}

export async function loadTeBuilder() {
  const rel = 'packages/platform/plugin-artifact/test/zipFixtures.mjs'
  const file = path.join(WORK, `zipFixtures-${TE_COMMIT}.mjs`)
  fs.mkdirSync(WORK, { recursive: true })
  fs.writeFileSync(file, gitShow(rel))
  return import(pathToFileURL(file).href)
}

export function loadPrivateKey(pkcs8Base64) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(pkcs8Base64, 'base64'), format: 'der', type: 'pkcs8' })
  const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const publicRaw = Buffer.from(der.subarray(der.length - 32))
  return { privateKey, publicRaw, publicBase64: publicRaw.toString('base64'), publicHex: publicRaw.toString('hex') }
}

/** { pair, keyId, kind, publicBase64 } for the shared dev key. The private key is held in memory only for the signing call. */
export async function loadDevSigner() {
  if (!fs.existsSync(DEV_KEY_FILE)) throw new Error(`development key not found: ${DEV_KEY_FILE} (set LINE_TODO_DEV_KEY)`)
  const { devKeyId } = await loadTeBuilder()
  const stored = JSON.parse(fs.readFileSync(DEV_KEY_FILE, 'utf8'))
  const pair = loadPrivateKey(stored.privatePkcs8)
  const keyId = devKeyId(pair)
  if (keyId !== DEV_KEY_ID) throw new Error(`the key file holds ${keyId}, expected ${DEV_KEY_ID}`)
  return { pair, keyId, kind: 'dev', publicBase64: pair.publicBase64 }
}

/** The raw private-key material of the dev key, for the "no private key in the package" audit only (never printed, never written). */
export function devKeySecretNeedles() {
  if (!fs.existsSync(DEV_KEY_FILE)) return []
  const stored = JSON.parse(fs.readFileSync(DEV_KEY_FILE, 'utf8'))
  const needles = []
  if (typeof stored.privatePkcs8 === 'string' && stored.privatePkcs8.length > 16) {
    const der = Buffer.from(stored.privatePkcs8, 'base64')
    needles.push(Buffer.from(stored.privatePkcs8, 'utf8'), der, der.subarray(der.length - 32)) // base64 text, PKCS8 DER, raw 32-byte seed
  }
  return needles
}

export function parseArgs(argv) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=')
      if (inline !== undefined) out[key] = inline
      else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) { out[key] = argv[index + 1]; index += 1 } else out[key] = true
    } else out._.push(token)
  }
  return out
}
