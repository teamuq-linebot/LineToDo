// The shared local development signing key (keyId dev-e6301dd7a2967155) for the DEV-SIGNED variant only (build-plugin-devsigned.mjs).
// The default chain (build-plugin.mjs, `pack --unsigned`) never imports this file.
//
// The private key stays in its file (lib/paths.mjs DEV_KEY_FILE, the same file 0.1.1 / ai-lover / speech-funasr were signed with). It is read into
// a KeyObject in memory for the signing call and for the "no key material in the package" audit; nothing here prints, logs or writes it.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { DEV_KEY_FILE, DEV_KEY_ID } from './paths.mjs'

const SPKI_ED25519_PREFIX_BYTES = 12

/** Core's dev keyId rule (trust/signature.ts devKeyIdOf): `dev-` + the first 16 hex of sha256(raw 32-byte public key). */
export const devKeyIdOf = (publicRaw) => `dev-${crypto.createHash('sha256').update(publicRaw).digest('hex').slice(0, 16)}`

function readStored(file) {
  if (!fs.existsSync(file)) throw new Error(`development key not found: ${file} (set LINE_TODO_DEV_KEY)`)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof stored.privatePkcs8 !== 'string' || stored.privatePkcs8.length < 16) throw new Error(`${file} has no privatePkcs8`)
  return stored
}

/** { keyId, key: KeyObject (private), publicBase64 }. Throws when the file does not hold dev-e6301dd7a2967155. */
export function loadDevSigningKey(file = DEV_KEY_FILE) {
  const stored = readStored(file)
  const key = crypto.createPrivateKey({ key: Buffer.from(stored.privatePkcs8, 'base64'), format: 'der', type: 'pkcs8' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an ed25519 key`)
  const der = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })
  const publicRaw = Buffer.from(der.subarray(SPKI_ED25519_PREFIX_BYTES))
  const keyId = devKeyIdOf(publicRaw)
  if (keyId !== DEV_KEY_ID) throw new Error(`the key file holds ${keyId}, expected ${DEV_KEY_ID}`)
  return { keyId, key, publicBase64: publicRaw.toString('base64') }
}

/** The raw private-key material, only as needles for the package audit (base64 text, PKCS8 DER, raw 32-byte seed). Never printed or written. */
export function devKeySecretNeedles(file = DEV_KEY_FILE) {
  if (!fs.existsSync(file)) return []
  const stored = readStored(file)
  const der = Buffer.from(stored.privatePkcs8, 'base64')
  return [Buffer.from(stored.privatePkcs8, 'utf8'), der, der.subarray(der.length - 32)]
}
