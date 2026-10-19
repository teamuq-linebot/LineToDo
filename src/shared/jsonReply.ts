export type JsonParse = { ok: true; value: unknown } | { ok: false; reason: string }

export function parseModelJson(raw: string): JsonParse {
  const text = raw.replace(/^\uFEFF/, '').trim()
  if (text === '') return { ok: false, reason: 'empty' }
  const candidates = [text]
  const fence = /```(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/.exec(text)
  if (fence && fence[1].trim() !== '') candidates.push(fence[1].trim())
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1))
  let lastError = 'not_json'
  for (const candidate of candidates) {
    try { return { ok: true, value: JSON.parse(candidate) as unknown } }
    catch (error) { lastError = error instanceof Error ? error.message.slice(0, 120) : 'not_json' }
  }
  return { ok: false, reason: lastError }
}
