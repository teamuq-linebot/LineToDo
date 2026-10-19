// node:sqlite candidate loader. The engine is part of the Electron/Node runtime itself: no package,
// no .node file, no --allow-addons needed.
export async function loadEngine() {
  const { DatabaseSync } = await import('node:sqlite')
  const { default: NodeSqliteDatabase } = await import('./node-sqlite-adapter.mjs')
  const probe = new DatabaseSync(':memory:')
  const info = {
    engine: 'node:sqlite',
    sqlite: probe.prepare('select sqlite_version() v').get().v,
    processVersionsSqlite: process.versions.sqlite ?? null,
    hasSetAllowUnknownNamedParameters: typeof probe.prepare('select 1').setAllowUnknownNamedParameters === 'function',
    compileOptionsSample: probe.prepare('PRAGMA compile_options').all().map((r) => r.compile_options).filter((o) => /DQS|FOREIGN|THREADSAFE|WAL|DEFAULT_WAL|OMIT/.test(o)),
  }
  probe.close()
  return { info, factory: (filename, options) => new NodeSqliteDatabase(filename, options), adapterFiles: ['node-sqlite-adapter.mjs'] }
}
