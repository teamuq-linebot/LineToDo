// 在 Electron main 進程內驗證 better-sqlite3 native module 能否載入並運作。
// 由 `npx electron scripts/probe-sqlite.cjs` 執行。
// 成功印 [probe] sqlite-ok=<value> 後 exit 0；ABI 不符會在 require 時拋 NODE_MODULE_VERSION 錯。
const { app } = require('electron')

app.whenReady().then(() => {
  try {
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (42);')
    const row = db.prepare('SELECT x FROM t').get()
    console.log('[probe] sqlite-ok=' + row.x)
    console.log('[probe] sqlite-version=' + db.prepare('SELECT sqlite_version() AS v').get().v)
    db.close()
    app.exit(0)
  } catch (err) {
    console.error('[probe] sqlite-FAILED: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  }
})
