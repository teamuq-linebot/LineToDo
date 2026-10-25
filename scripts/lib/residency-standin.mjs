// Stand-in for TeamUQ Core's `context.residency` (background:resident), the object the plugin backend reads in `activate(context)`.
//
// It follows Core, not the plugin's wishes. Source (teamuq-electron, read-only; HEAD 0e46b155a, Core version still 1.7.15):
//   apps/plugin-host/src/external/context.ts       createExternalResidency(initial): the state starts as `init.residency ?? BACKEND_RESIDENCY_UNREQUESTED`;
//                                                  `current()` returns the frozen current value; `onChange(listener)` returns an unsubscribe;
//                                                  `apply(raw)` parses ExternalResidencyMessageSchema, IGNORES an invalid message and an identical value, otherwise
//                                                  stores the value and calls every listener
//   apps/plugin-host/src/external/index.ts:220     the host feeds it from the `ext-residency` message — the ONLY notification: a revoke or a downgrade sends
//                                                  no `ext-permission-revoked` (design D:162, 502)
//   packages/plugin-sdk/src/backendContracts.ts    PluginBackendResidencyV1: { requested: boolean, level: 'on-demand'|'resident', reason: <8 codes>|null } with
//                                                  the refine  level==='resident' ? requested && reason===null : requested || reason===null
//   packages/plugin-sdk/src/backendInvokeContracts.ts:66   context.residency is a REQUIRED member of PluginBackendContextV1 in a Core that has the feature;
//                                                  a Core without the feature has no such member at all (mode 'absent' below)
//
// Modes:
//   'absent'   an old Core: the context has no `residency` property
//   'present'  a Core with the feature; the initial value is `initial` (default: unrequested, like Core when init.residency is missing)
//
// Two ways to change the value:
//   apply(raw)  what Core's host does with an `ext-residency` message (schema-checked: an unknown reason code is IGNORED, like the real parser would)
//   push(raw)   a LATER Core that has added a reason code: the shape is checked but the reason is an open string. The plugin must treat reason codes as an open
//               set (design D:151 lists today's eight; the contract report says "open set"), so tests use push() to prove it.
export const CORE_REASONS = Object.freeze(['resident_not_granted', 'resident_inactive', 'resident_budget_exceeded', 'resident_crash_budget_exhausted', 'resident_boot_failed', 'resident_artifact_revoked', 'resident_revalidation_failed', 'resident_policy_error'])
export const CORE_LEVELS = Object.freeze(['on-demand', 'resident'])

export const UNREQUESTED = Object.freeze({ requested: false, level: 'on-demand', reason: null })
export const RESIDENT = Object.freeze({ requested: true, level: 'resident', reason: null })
/** the user turned the switch off (a downgrade: the process keeps running, Core only restarts the idle timer) */
export const DOWNGRADED_NOT_GRANTED = Object.freeze({ requested: true, level: 'on-demand', reason: 'resident_not_granted' })
/** another plugin took the slot */
export const DOWNGRADED_BUDGET = Object.freeze({ requested: true, level: 'on-demand', reason: 'resident_budget_exceeded' })
/** a code Core does not know today */
export const DOWNGRADED_FUTURE_REASON = Object.freeze({ requested: true, level: 'on-demand', reason: 'resident_future_new_reason' })

const KEYS = ['requested', 'level', 'reason']
const frozen = (value) => Object.freeze({ requested: value.requested, level: value.level, reason: value.reason })
const same = (a, b) => a.requested === b.requested && a.level === b.level && a.reason === b.reason

/** ExternalResidencyMessageSchema's payload check (PluginBackendResidencyV1Schema), strict. `openReasons`: accept any string reason (a later Core). */
function parse(raw, { openReasons }) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (Object.keys(raw).some((key) => !KEYS.includes(key))) return null
  if (typeof raw.requested !== 'boolean' || !CORE_LEVELS.includes(raw.level)) return null
  if (raw.reason !== null && !(openReasons ? typeof raw.reason === 'string' : CORE_REASONS.includes(raw.reason))) return null
  const ok = raw.level === 'resident' ? raw.requested && raw.reason === null : raw.requested || raw.reason === null
  return ok ? frozen(raw) : null
}

export function createResidencyStandin({ mode = 'present', initial } = {}) {
  let current = frozen(parse(initial ?? UNREQUESTED, { openReasons: true }) ?? UNREQUESTED)
  const listeners = new Set()
  const stats = { currentCalls: 0, subscribes: 0, unsubscribes: 0, applied: 0, ignored: 0, notified: 0, listenerErrors: 0 }
  const api = Object.freeze({
    current: () => { stats.currentCalls += 1; return current },
    onChange: (listener) => {
      stats.subscribes += 1
      listeners.add(listener)
      let live = true
      return () => { if (live) { live = false; stats.unsubscribes += 1; listeners.delete(listener) } }
    },
  })
  const deliver = (raw, openReasons) => {
    const next = parse(raw, { openReasons })
    if (next === null || same(next, current)) { stats.ignored += 1; return false }
    current = next
    stats.applied += 1
    for (const listener of [...listeners]) {
      stats.notified += 1
      try { listener(current) } catch { stats.listenerErrors += 1 }
    }
    return true
  }
  return {
    mode,
    api,
    stats,
    listeners: () => listeners.size,
    value: () => current,
    apply: (raw) => deliver(raw, false),
    push: (raw) => deliver(raw, true),
    /** the property the host adds to the frozen context; nothing at all for an old Core */
    contextPart: () => (mode === 'absent' ? {} : { residency: api }),
  }
}
