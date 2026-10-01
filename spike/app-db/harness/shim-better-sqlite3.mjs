// esbuild redirects every `import Database from 'better-sqlite3'` in line-todo's src/main/db/** to
// this shim. The permissioned child installs the candidate engine's factory before importing the
// bundle, so the UNMODIFIED line-todo code (`new Database(path)`) runs on the selected engine.
export default function Database(filename, options) {
  const factory = globalThis.__APPDB_FACTORY__
  if (typeof factory !== 'function') throw new Error('app-db spike: engine factory not installed')
  return factory(filename, options)
}
