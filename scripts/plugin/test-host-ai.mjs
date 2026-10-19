import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSettingsStore } from '../../src/main/config/settings.ts'
import { DEFAULT_HOST_AI_SELECTION, normalizeHostAiSelection } from '../../src/shared/hostAi.ts'

const noSecrets = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } }

test('AI selection survives unrelated settings updates and a settings-store restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-ai-settings-'))
  try {
    const first = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    const selection = { providerId: 'codex', modelId: 'gpt-6-luna', effort: 'high' }
    first.update({ pluginAi: selection })
    first.update({ pollIntervalSec: 45 })
    const second = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    assert.deepEqual(second.get().pluginAi, selection)
    assert.equal(second.get().pollIntervalSec, 45)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).pluginAi, selection)
    second.update({ pluginAi: DEFAULT_HOST_AI_SELECTION })
    assert.deepEqual(second.get().pluginAi, DEFAULT_HOST_AI_SELECTION)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('legacy settings use TeamUQ defaults; malformed selection is bounded and contains only model preferences', () => {
  assert.deepEqual(normalizeHostAiSelection(undefined), DEFAULT_HOST_AI_SELECTION)
  assert.deepEqual(normalizeHostAiSelection({ providerId: '../../other', modelId: 'x'.repeat(97), effort: 'unlimited', apiKey: 'not-persisted' }), DEFAULT_HOST_AI_SELECTION)
  assert.deepEqual(normalizeHostAiSelection({ providerId: 'codex', modelId: ' gpt-6-luna ', effort: 'low', apiKey: 'not-persisted' }), { providerId: 'codex', modelId: 'gpt-6-luna', effort: 'low' })
})

test('the vendor pathname patch preserves relative, absolute, Unicode, percent-encoded and Windows pathnames', () => {
  for (const input of ['db.sqlite', '../db.sqlite', '/data/test.sqlite', '資料/LINE 空白.sqlite', 'data/a%20b.sqlite', 'file:///C:/LINE/db.sqlite', 'file://server/share/db.sqlite', 'C:/LINE/db.sqlite']) {
    assert.equal(new URL(input, 'file:///').pathname, new URL(input, 'file://localhost/').pathname, input)
  }
})

test('the copied SDK declarations match their pinned Core 1.7.12 metadata', async () => {
  const { createHash } = await import('node:crypto')
  const metadata = JSON.parse(readFileSync(new URL('../../src/plugin/sdk/tuq-plugin-sdk.version.json', import.meta.url), 'utf8'))
  const bytes = readFileSync(new URL('../../src/plugin/sdk/tuq-plugin-sdk.d.ts', import.meta.url))
  assert.equal(metadata.coreVersion, '1.7.12')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256)
})
