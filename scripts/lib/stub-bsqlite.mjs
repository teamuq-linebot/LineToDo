// Stand-in for better-sqlite3-multiple-ciphers in the plugin-backend bundle. enginePorts.ts statically imports
// the standalone engine (Phase 0), but the plugin never uses it (it injects the WASM engine), so the native
// package must not be bundled. Calling it is a bug, hence the loud failure.
export default class Database {
  constructor() {
    throw new Error('better-sqlite3-multiple-ciphers is not available in the plugin backend (WASM engine is injected)')
  }
}
