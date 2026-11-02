// A backend whose event loop is blocked (mode "sync") or whose call never settles (mode "async") — what a Core 30 s timeout fence leaves behind.
// Run by scripts/plugin/test-invoke-trace.mjs with the same flags as the other tests, then SIGKILLed by the test:
//   node --experimental-strip-types --experimental-loader=./scripts/ts-test-loader.mjs scripts/plugin/fixtures/invoke-trace-hang-child.mjs <logFile> <sync|async>
// It makes one normal call (ping), then one call to `db.messages.list` whose handler hangs; the test watches the log file, not stdout.
// The only thing this file writes is the trace log (through InvokeTrace).
import { Dispatcher } from '../../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../../src/plugin/backend/eventHub.ts'
import { InvokeTrace } from '../../../src/plugin/backend/invokeTrace.ts'

const [file, mode] = process.argv.slice(2)
const trace = new InvokeTrace({ file, version: 'child', slowMs: 50, stallMs: 100, tickMs: 20, heartbeatMs: 60 })
const api = {
  ping: async () => ({ ok: true }),
  db: {
    messages: {
      list: mode === 'sync'
        ? () => { for (;;) { /* blocks the event loop for good */ } }
        : () => new Promise(() => undefined)
    }
  }
}
const dispatcher = new Dispatcher({ getApi: () => api, hub: new EventHub(), queue: { stats: () => ({}) }, info: () => ({}), trace })
await dispatcher.call('ping', { path: 'ping', args: [] })
setInterval(() => undefined, 1000) // a real backend has other live handles; without one a never-settling call would just let the process exit
void dispatcher.call('db.messages', { path: 'db.messages.list', args: [{ limit: 1000, secretMarker: 'CHILD-SECRET-TEXT' }] })
