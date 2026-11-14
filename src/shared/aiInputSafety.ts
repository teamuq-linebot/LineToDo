import { CHAT_PROFILE_SAFETY_VERSION } from './chatProfiles'

export interface SafeAiInputResult {
  status: 'ready' | 'redacted' | 'blocked'
  payload?: string
  redactionCount: number
  omissionCodes: string[]
  safetyVersion: string
}

const LIMIT = 2_000_000
const MARKER = '[REDACTED:CREDENTIAL]'
const BLOCKED = (): SafeAiInputResult => ({ status: 'blocked', redactionCount: 0, omissionCodes: ['invalid_or_unavailable_input'], safetyVersion: CHAT_PROFILE_SAFETY_VERSION })

const RULES: Array<[RegExp, string]> = [
  [/\b(authorization\s*:\s*bearer)\s+[^\s,;"']+/gi, `$1 ${MARKER}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, `$1 ${MARKER}`],
  [/\b((?:access|refresh)[_-]?token|api[_-]?key|password|passwd|secret|private[_ -]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi, `$1=${MARKER}`],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, MARKER],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MARKER}@`]
]

function scrub(text: string): { text: string; count: number } {
  let value = text
  let count = 0
  for (const [pattern, replacement] of RULES) {
    value = value.replace(pattern, (...args: unknown[]) => {
      count += 1
      // Preserve labelled key and scheme while never returning the matched value.
      if (replacement.startsWith('$1')) return `${String(args[1])}${replacement.slice(2)}`
      return replacement
    })
  }
  return { text: value, count }
}

function deepScrub(value: unknown, seen: Set<object>, budget: { chars: number; count: number }): unknown {
  if (typeof value === 'string') {
    budget.chars += value.length
    if (budget.chars > LIMIT) throw new Error('blocked')
    const result = scrub(value)
    budget.count += result.count
    // A string can itself contain serialized nested JSON. Reparse only valid JSON strings;
    // retain original formatting when no nested credential was found.
    if (result.count === 0 && /^[\s]*[\[{]/.test(value)) {
      try {
        const parsed: unknown = JSON.parse(value)
        if (parsed && typeof parsed === 'object') {
          const nested = deepScrub(parsed, seen, budget)
          return JSON.stringify(nested)
        }
      } catch { /* ordinary prose or malformed JSON remains unchanged */ }
    }
    return result.text
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object' || seen.has(value)) throw new Error('blocked')
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => deepScrub(item, seen, budget))
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) output[key] = deepScrub(item, seen, budget)
  return output
}

/** Scans strings, nested data, and JSON serialized inside strings. Unknown object shapes fail closed. */
export function projectAiInputSafely(input: unknown): SafeAiInputResult {
  try {
    if (typeof input !== 'string' && (!input || typeof input !== 'object')) return BLOCKED()
    const budget = { chars: 0, count: 0 }
    const cleaned = deepScrub(input, new Set(), budget)
    const payload = typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned)
    if (!payload || payload.length > LIMIT) return BLOCKED()
    return { status: budget.count ? 'redacted' : 'ready', payload, redactionCount: budget.count, omissionCodes: [], safetyVersion: CHAT_PROFILE_SAFETY_VERSION }
  } catch { return BLOCKED() }
}
