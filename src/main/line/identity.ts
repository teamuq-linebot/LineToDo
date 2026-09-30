import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface ParticipantIdentity {
  participantKey: string | null
  scope: 'chat' | 'unknown'
  keyVersion: number | null
  status: 'keyed' | 'unknown'
  reason: 'source_id_missing' | 'account_unknown' | 'safe_storage_unavailable' | null
}

export interface ParticipantIdentityProvider {
  resolve(input: { senderMid: string | null; accountMid: string | null; chatId: string }): ParticipantIdentity
  epoch(): string | null
}

function hmac(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex')
}

/**
 * Local-only participant pseudonymizer. The install secret is persisted only as
 * Electron safeStorage ciphertext; encryption failure has no plaintext fallback.
 * v1 deliberately scopes keys to a chat until LINE MID cross-chat stability has
 * been accepted against real source evidence.
 */
export function createParticipantIdentityProvider(options: {
  userDataDir: string
  safeStorage: SafeStoragePort
}): ParticipantIdentityProvider {
  const secretPath = join(options.userDataDir, 'line-participant-key.enc')
  let secret: Buffer | null | undefined

  const loadSecret = (): Buffer | null => {
    if (secret !== undefined) return secret
    secret = null
    try {
      if (!options.safeStorage.isEncryptionAvailable()) return null
      mkdirSync(options.userDataDir, { recursive: true })
      if (existsSync(secretPath)) {
        const decrypted = options.safeStorage.decryptString(readFileSync(secretPath))
        const decoded = Buffer.from(decrypted, 'base64')
        if (decoded.length === 32) secret = decoded
        return secret
      }
      const generated = randomBytes(32)
      const encrypted = options.safeStorage.encryptString(generated.toString('base64'))
      writeFileSync(secretPath, encrypted, { flag: 'wx' })
      secret = generated
      return secret
    } catch {
      // safeStorage, filesystem, or decrypt failure must fail closed without MID fallback.
      return null
    }
  }

  return {
    resolve({ senderMid, accountMid, chatId }): ParticipantIdentity {
      if (!senderMid) return { participantKey: null, scope: 'unknown', keyVersion: null, status: 'unknown', reason: 'source_id_missing' }
      if (!accountMid || !chatId) return { participantKey: null, scope: 'unknown', keyVersion: null, status: 'unknown', reason: 'account_unknown' }
      const key = loadSecret()
      if (!key) return { participantKey: null, scope: 'unknown', keyVersion: null, status: 'unknown', reason: 'safe_storage_unavailable' }
      const accountFingerprint = hmac(key, `line-account-v1\0${accountMid}`)
      const scope = `chat:${chatId}`
      const participantKey = hmac(key, `line-participant-v1\0${accountFingerprint}\0${scope}\0${senderMid}`)
      return { participantKey, scope: 'chat', keyVersion: 1, status: 'keyed', reason: null }
    },
    epoch(): string | null {
      const key = loadSecret()
      return key ? hmac(key, 'line-identity-epoch-v1') : null
    }
  }
}
