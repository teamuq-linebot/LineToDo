// Stand-in for what a plugin VIEW sees of TeamUQ Core 1.7.1 when it calls its backend: the installed backend invoke gate, the parts of the
// runtime composition that drive it, and the view bridge. Used by test-plugin-guide.mjs / test-plugin-ui-effects.mjs (G-03, review B1).
//
// It follows Core, not the plugin's wishes. Source (teamuq-electron V1, version 1.7.1; read-only):
//   packages/platform/plugin-runtime/src/main/externalBackend/backendInvokeGate.ts — createInstalledBackendInvokeGate
//     :74       a FENCED plugin gets 'plugin_disabled' for every new call. The fence reason (fenceErrors) is not reported to new calls.
//     :75-76    more than PLUGIN_BACKEND_INVOKE_LIMITS.inFlight (8) calls in flight → 'plugin_backend_unavailable'
//     :121-127  after the (async) policy read: fenced meanwhile → the fence reason; not installed → 'plugin_not_installed';
//               disabled → 'plugin_disabled'; no grant → 'plugin_permission_denied'; method not in the manifest → 'backend_method_not_allowed'
//     :62-69, :144-146  a call past its deadline (timeoutMs 30 s) FENCES the plugin: every call in flight ends 'backend_invoke_timeout',
//               the backend is stopped ('hung'). :157 the runtime reporting plugin_call_timeout does the same.
//     :148      a runtime answer that arrives after the fence → 'backend_invoke_timeout'
//     :153-160  runtime errors: plugin_not_installed / plugin_disabled|plugin_backend_inactive / crash|exited|hanging → plugin_backend_crashed /
//               anything else → plugin_backend_unavailable
//     :172-179  revoke(): FENCE, calls in flight end 'plugin_permission_denied', the backend is stopped ('disabled')
//     :180-184  activate(): the ONLY way out of the fence
//   apps/desktop/src/main/native/startup/pluginRuntimeComposition.ts
//     :239      beforeDisable (the user disables the plugin) → revoke()
//     :240      afterEnable (the user enables it again)      → activate()
//     :447-454  refreshGrants (the user flips a permission in 「我的 AI › 外掛」): backend:invoke revoked → revoke();
//               backend:invoke allowed again → NOTHING (no activate): the fence stays until disable → enable or a TeamUQ restart.
//   packages/platform/plugin-runtime/src/adapters/preload/pluginViewBridge.ts:93-97   { ok:false, error } → the view's call rejects new Error(error)
//
// Not modelled: view generations (closeView), payload-size checks, the signer checks of the generic gate. The stand-in keeps the same runtime
// object across a fence (Core stops the backend and starts a fresh one on the next admitted call — the plugin cannot tell the difference except
// that in-memory backend state is gone; the tests that need a restart model it themselves).
// `npm run check:core-gate-conformance` (scripts/plugin/check-core-gate-conformance.mjs; needs a teamuq-electron checkout, fails when there is
// none) runs the same call sequence against Core's real createInstalledBackendInvokeGate and this stand-in and checks that every call ends the
// same way, and that the composition still wires the gate as described above (review R1-N2). Run it whenever Core moves.

export const CORE_INVOKE_LIMITS = Object.freeze({ inFlight: 8, timeoutMs: 30_000 })

/**
 * @param runtime  `{ call(method, params) }` — the plugin backend (Dispatcher / createPluginBackend). May be swapped later through `setRuntime`.
 * @param options  `methods` (the manifest's backendMethods), `timeoutMs` (the per-call deadline; Core: 30 s), `pluginId`.
 */
export function createCoreGateStandin(runtime, { methods, timeoutMs = CORE_INVOKE_LIMITS.timeoutMs, pluginId = 'tuqdev.line-todo' } = {}) {
  let target = runtime
  let fenced = false
  let fenceError = null
  let generation = 0
  /** install state as resolvePolicy() would read it */
  const policy = { installed: true, enabled: true, grant: true }
  /** calls in flight: cancel(code) → finishes that call with { ok:false, error: code } */
  const inFlight = new Set()
  const state = { calls: [], refusedMethods: [], stops: [], results: [] }

  const fence = (code, stopReason) => {
    fenced = true
    fenceError = code
    generation += 1
    for (const cancel of [...inFlight]) cancel(code)
    state.stops.push(stopReason)
  }

  /** createInstalledBackendInvokeGate().invokeView, reduced to what a view can observe. */
  async function invokeView(method, params) {
    if (fenced) return { ok: false, error: 'plugin_disabled' }
    if (inFlight.size >= CORE_INVOKE_LIMITS.inFlight) return { ok: false, error: 'plugin_backend_unavailable' }
    const admittedAt = generation
    await Promise.resolve() // Core reads the policy asynchronously; a revoke / timeout can land in between
    if (generation !== admittedAt || fenced) return { ok: false, error: fenceError ?? 'plugin_disabled' }
    if (!policy.installed) return { ok: false, error: 'plugin_not_installed' }
    if (!policy.enabled) return { ok: false, error: 'plugin_disabled' }
    if (!policy.grant) return { ok: false, error: 'plugin_permission_denied' }
    if (!methods.includes(method)) { state.refusedMethods.push(method); return { ok: false, error: 'backend_method_not_allowed' } }
    return new Promise((resolve) => {
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        inFlight.delete(cancel)
        resolve(result)
      }
      const cancel = (code) => finish({ ok: false, error: code })
      inFlight.add(cancel)
      const timer = setTimeout(() => fence('backend_invoke_timeout', 'hung'), timeoutMs)
      Promise.resolve().then(() => target.call(method, params)).then((value) => {
        if (fenced) return finish({ ok: false, error: 'backend_invoke_timeout' })
        finish({ ok: true, value })
      }, (error) => {
        const code = error instanceof Error ? error.code : undefined
        if (code === 'plugin_not_installed') return finish({ ok: false, error: 'plugin_not_installed' })
        if (code === 'plugin_disabled' || code === 'plugin_backend_inactive') return finish({ ok: false, error: 'plugin_disabled' })
        if (code === 'plugin_backend_call_timeout' || code === 'plugin_call_timeout') { fence('backend_invoke_timeout', 'hung'); return undefined }
        if (typeof code === 'string' && /crash|exited|hanging/iu.test(code)) return finish({ ok: false, error: 'plugin_backend_crashed' })
        return finish({ ok: false, error: 'plugin_backend_unavailable' })
      })
    })
  }

  return {
    state,
    /** window.tuqPlugin as the view sees it (pluginViewBridge.ts): params/results cross as JSON; a refusal rejects Error(<code>). */
    host: {
      backend: {
        async call(method, params) {
          state.calls.push({ method, path: params?.path })
          const result = await invokeView(method, JSON.parse(JSON.stringify(params)))
          state.results.push({ method, path: params?.path, ok: result.ok, error: result.ok ? null : result.error })
          if (!result.ok) throw new Error(result.error)
          return JSON.parse(JSON.stringify(result.value))
        }
      },
      assets: { url: (p) => `tuqplugin://${pluginId}/data/${p}` }
    },
    /** the gate itself (for direct comparison with Core's) */
    invokeView,
    get fenced() { return fenced },
    get inFlight() { return inFlight.size },
    setRuntime(next) { target = next },
    /** gate.revoke() */
    revoke() { fence('plugin_permission_denied', 'disabled') },
    /** gate.activate() */
    activate() { fenced = false; generation += 1 },
    /** a call's 30 s deadline firing right now (what the timer in the gate does) */
    timeoutNow() { fence('backend_invoke_timeout', 'hung') },
    // ── what the user does in TeamUQ, through the composition ──
    /** 「我的 AI › 外掛」: backend:invoke off (true) → refreshGrants → revoke(); back on (false) → refreshGrants → nothing. */
    setBackendInvokeRevoked(revoked) {
      policy.grant = !revoked
      if (revoked) this.revoke()
    },
    /** disable the plugin: beforeDisable → revoke() */
    disable() { policy.enabled = false; this.revoke() },
    /** enable it again: afterEnable → activate() */
    enable() { policy.enabled = true; this.activate() },
    uninstall() { policy.installed = false }
  }
}
