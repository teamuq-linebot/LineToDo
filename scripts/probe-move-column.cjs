// 確定性驗收 probe：看板拖曳搬移 moveTodoToColumn（kanban-drag-drop-20260629）。
//
// 沿用既有 esbuild+electron probe harness（暫存 sqlite + migrate 建表，自動清理）。
// 涵蓋契約 §1 對照表 / §2.1 repo / §2.2 IPC 防呆 / §2.5 store isNoopMove：
//   1. §1 對照表：6 來源狀態 × 4 目標欄 → assert (bucket, status, resolved_at)。
//   2. 使用者決策案例：否決建議 / 取消完成 / 標記完成 / 確認建議完成。
//   3. 冪等防抖：同卡同欄第二次 no-op（updated_at/resolved_at 不變）；done 再拖 done 不重寫；查無 id → null。
//   4. IPC todos:moveColumn 入參防呆：非法 toColumn / 非字串 id → null 不進 repo；合法 → DTO。
//   5. store isNoopMove（真原始碼經 esbuild.transform 抽出執行）：6×4 真值表 == 契約 no-op 定義 == repo no-op。
//
// 注意：HTML5 DnD 手勢層（dragstart/dragover/drop）為瀏覽器原生事件，本資料層 probe 不涵蓋（見回報誠實標註）。
// 由 `npx electron scripts/probe-move-column.cjs` 執行。全綠 exit 0。

const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')

const ENTRY = `
export { getDb, closeDb } from './src/main/db/database.ts'
export { upsertChat } from './src/main/db/chats.repo.ts'
export { createTodo, getTodo, moveTodoToColumn } from './src/main/db/todos.repo.ts'
export { registerTodosIpc } from './src/main/ipc/todos.ipc.ts'
`

const CANON = { todo: 'pending', waiting: 'waiting_reply', schedule: 'scheduled' }
const COLS = ['todo', 'waiting', 'schedule', 'done']

// 6 來源狀態（涵蓋契約 §1 要求：pending/waiting_reply/scheduled/suggested_done/done(具體 resolved_at) + dismissed）。
const SRC = [
  { name: 'pending(todo)', bucket: 'todo', status: 'pending' },
  { name: 'waiting_reply(waiting)', bucket: 'waiting', status: 'waiting_reply' },
  { name: 'scheduled(schedule)', bucket: 'schedule', status: 'scheduled' },
  { name: 'suggested_done(todo)', bucket: 'todo', status: 'suggested_done' },
  { name: 'done(schedule)', bucket: 'schedule', status: 'done' }, // createTodo 會給具體 resolved_at
  { name: 'dismissed(todo)', bucket: 'todo', status: 'dismissed' } // createTodo 會給具體 resolved_at
]

// 契約 §1 的 no-op 定義（獨立編碼，用來雙向比對 store 與 repo）。
function referenceNoop(src, col) {
  if (col === 'done') return src.status === 'done'
  return src.bucket === col && src.status === CANON[col] && (src.resolvedAt ?? null) === null
}

const results = []
function assert(name, pass, expected, actual) {
  results.push({ name, pass: !!pass })
  console.log(
    `[probe-mc] ${pass ? 'PASS' : 'FAIL'} ${name}\n         expected=${JSON.stringify(expected)}\n         actual  =${JSON.stringify(actual)}`
  )
}
function eq(name, expected, actual) {
  assert(name, JSON.stringify(expected) === JSON.stringify(actual), expected, actual)
}

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__mc_entry.ts')
  const outFile = path.join(root, '__mc.bundle.cjs')
  const cleanup = () => {
    try { fs.rmSync(entryFile, { force: true }) } catch (_) {}
    try { fs.rmSync(outFile, { force: true }) } catch (_) {}
  }
  let tmpDir = null
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-mc-'))
    process.env.LINE_TODO_DB_PATH = path.join(tmpDir, 'line-todo.db')
    delete process.env.QWEN_API_KEY

    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({
      entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs',
      outfile: outFile, external: ['electron', 'better-sqlite3', 'openai'],
      absWorkingDir: root, logLevel: 'silent'
    })
    const m = require(outFile)
    m.getDb()
    console.log('[probe-mc] db-ready=' + process.env.LINE_TODO_DB_PATH)
    m.upsertChat({ chatId: 'c-mc', name: 'MC', isGroup: false, seenAt: '2026-06-26T16:00:00' })

    let seq = 0
    // 建立一張處於指定來源狀態的卡，回傳建立後 DTO。
    const mkCard = (src) =>
      m.createTodo({ chatId: 'c-mc', bucket: src.bucket, status: src.status, title: src.name + '#' + (++seq), dueAt: null })

    // ── 1 + repo no-op 矩陣：6×4 對照表 ──────────────────────
    for (const src of SRC) {
      for (const col of COLS) {
        const card = mkCard(src)
        const before = m.getTodo(card.id)
        const ret = m.moveTodoToColumn(card.id, col)
        const after = m.getTodo(card.id)

        // 期望 (bucket,status,resolved_at)
        let expBucket, expStatus, resolvedCheck
        if (col === 'done') {
          expBucket = before.bucket
          expStatus = 'done'
          resolvedCheck =
            before.status === 'done'
              ? after.resolvedAt === before.resolvedAt // 已 done：保留現值
              : after.resolvedAt !== null && typeof after.resolvedAt === 'string' // 否則 now（非 null）
        } else {
          expBucket = col
          expStatus = CANON[col]
          resolvedCheck = after.resolvedAt === null
        }
        const tupleOk = after.bucket === expBucket && after.status === expStatus && resolvedCheck
        assert(
          `§1 [${src.name} → ${col}] (bucket,status,resolved_at)`,
          tupleOk,
          { bucket: expBucket, status: expStatus, resolvedAt: col === 'done' ? (before.status === 'done' ? before.resolvedAt : '<now,非null>') : null },
          { bucket: after.bucket, status: after.status, resolvedAt: after.resolvedAt }
        )

        // repo no-op 判定（結果三元組 === 來源三元組 ⟺ 未寫庫；與 referenceNoop 比對）。
        const repoNoop =
          after.bucket === before.bucket &&
          after.status === before.status &&
          after.resolvedAt === before.resolvedAt
        const refNoop = referenceNoop({ bucket: before.bucket, status: before.status, resolvedAt: before.resolvedAt }, col)
        assert(
          `repo no-op [${src.name} → ${col}] == 契約定義(${refNoop})`,
          repoNoop === refNoop,
          refNoop,
          repoNoop
        )
        // no-op 時 updated_at 必不變；非 no-op 時回傳的 DTO 不為 null。
        if (refNoop) {
          eq(`repo no-op [${src.name} → ${col}] updated_at 不變`, before.updatedAt, after.updatedAt)
        } else {
          assert(`repo write [${src.name} → ${col}] 回傳 DTO 非 null`, ret !== null, 'DTO', ret === null ? null : 'DTO')
        }
      }
    }

    // ── 2. 使用者決策案例（明列）──────────────────────────────
    // 否決建議：suggested_done(todo) → 拖 waiting ⇒ waiting/waiting_reply/null（不保留 suggested_done）
    {
      const c = mkCard({ name: 'sd', bucket: 'todo', status: 'suggested_done' })
      m.moveTodoToColumn(c.id, 'waiting')
      const a = m.getTodo(c.id)
      eq('決策.否決建議 suggested_done→waiting', { b: 'waiting', s: 'waiting_reply', r: null }, { b: a.bucket, s: a.status, r: a.resolvedAt })
    }
    // 取消完成：done → 拖 todo ⇒ todo/pending/resolved_at=NULL（清除）
    {
      const c = mkCard({ name: 'd', bucket: 'schedule', status: 'done' })
      const beforeResolved = m.getTodo(c.id).resolvedAt
      m.moveTodoToColumn(c.id, 'todo')
      const a = m.getTodo(c.id)
      assert('決策.取消完成 done 卡原本有 resolved_at', beforeResolved !== null, 'non-null', beforeResolved)
      eq('決策.取消完成 done→todo（resolved_at 清除）', { b: 'todo', s: 'pending', r: null }, { b: a.bucket, s: a.status, r: a.resolvedAt })
    }
    // 標記完成：pending → 拖 done ⇒ status=done, resolved_at=now(非 null), bucket 不變
    {
      const c = mkCard({ name: 'p', bucket: 'todo', status: 'pending' })
      m.moveTodoToColumn(c.id, 'done')
      const a = m.getTodo(c.id)
      assert('決策.標記完成 pending→done', a.status === 'done' && a.bucket === 'todo' && a.resolvedAt !== null,
        { s: 'done', b: 'todo', r: 'non-null' }, { s: a.status, b: a.bucket, r: a.resolvedAt })
    }
    // 確認建議完成：suggested_done → 拖 done ⇒ status=done
    {
      const c = mkCard({ name: 'sd2', bucket: 'waiting', status: 'suggested_done' })
      m.moveTodoToColumn(c.id, 'done')
      const a = m.getTodo(c.id)
      assert('決策.確認建議完成 suggested_done→done', a.status === 'done' && a.resolvedAt !== null,
        { s: 'done', r: 'non-null' }, { s: a.status, r: a.resolvedAt })
    }

    // ── 3. 冪等防抖 ──────────────────────────────────────────
    // 同卡同欄兩次：第二次 no-op（updated_at / resolved_at 不變）
    {
      const c = mkCard({ name: 'idem', bucket: 'todo', status: 'pending' })
      m.moveTodoToColumn(c.id, 'schedule')            // 第1次：寫庫
      const after1 = m.getTodo(c.id)
      const ret2 = m.moveTodoToColumn(c.id, 'schedule') // 第2次：no-op
      const after2 = m.getTodo(c.id)
      assert('冪等.第2次回傳現值 DTO（非 null）', ret2 !== null && ret2.id === c.id, c.id, ret2 && ret2.id)
      eq('冪等.第2次 updated_at 不變', after1.updatedAt, after2.updatedAt)
      eq('冪等.第2次 resolved_at 不變', after1.resolvedAt, after2.resolvedAt)
    }
    // done 卡再拖 done：resolved_at 與 updated_at 都不變（關鍵防抖點）
    {
      const c = mkCard({ name: 'donejit', bucket: 'schedule', status: 'done' })
      const b = m.getTodo(c.id)
      const ret = m.moveTodoToColumn(c.id, 'done')
      const a = m.getTodo(c.id)
      assert('冪等.done→done 回傳現值 DTO', ret !== null && ret.id === c.id, c.id, ret && ret.id)
      eq('冪等.done→done updated_at 不變', b.updatedAt, a.updatedAt)
      eq('冪等.done→done resolved_at 不變', b.resolvedAt, a.resolvedAt)
    }
    // 查無 id → null
    eq('冪等.查無 id → null', null, m.moveTodoToColumn('no-such-id-xyz', 'todo'))

    // ── 4. IPC todos:moveColumn 入參防呆（攔截真實 handler）──
    const electron = require('electron')
    const handlers = {}
    const origHandle = electron.ipcMain.handle
    electron.ipcMain.handle = (ch, fn) => { handlers[ch] = fn } // 攔截註冊，捕捉真實 handler 閉包
    try {
      m.registerTodosIpc()
    } finally {
      electron.ipcMain.handle = origHandle
    }
    const moveH = handlers['todos:moveColumn']
    assert('IPC.handler 已註冊', typeof moveH === 'function', 'function', typeof moveH)

    // 合法卡（供合法/防呆「不污染」對照）
    const ipcCard = mkCard({ name: 'ipc', bucket: 'todo', status: 'pending' })
    const ipcBefore = m.getTodo(ipcCard.id)

    eq('IPC.非法 toColumn="x" → null', null, moveH(null, { id: ipcCard.id, toColumn: 'x' }))
    eq('IPC.缺 toColumn → null', null, moveH(null, { id: ipcCard.id }))
    eq('IPC.toColumn 非字串(123) → null', null, moveH(null, { id: ipcCard.id, toColumn: 123 }))
    eq('IPC.id 非字串(123) → null', null, moveH(null, { id: 123, toColumn: 'todo' }))
    eq('IPC.缺 args → null', null, moveH(null, undefined))
    // 防呆未進 repo：卡片未被污染
    const ipcAfterBad = m.getTodo(ipcCard.id)
    eq('IPC.防呆未改動卡片 (bucket/status/updated_at)',
      { b: ipcBefore.bucket, s: ipcBefore.status, u: ipcBefore.updatedAt },
      { b: ipcAfterBad.bucket, s: ipcAfterBad.status, u: ipcAfterBad.updatedAt })
    // 合法 → 回 DTO 並生效
    const ipcOk = moveH(null, { id: ipcCard.id, toColumn: 'waiting' })
    assert('IPC.合法 toColumn=waiting → DTO 且 bucket=waiting',
      !!(ipcOk && ipcOk.bucket === 'waiting' && ipcOk.status === 'waiting_reply'),
      { bucket: 'waiting', status: 'waiting_reply' }, ipcOk ? { bucket: ipcOk.bucket, status: ipcOk.status } : null)

    // ── 5. store isNoopMove（抽真原始碼執行）+ 6×4 真值表 ─────
    let storeIsNoopMove = null
    let storeLoadErr = null
    try {
      const storeSrc = fs.readFileSync(path.join(root, 'src/renderer/store/useTodos.ts'), 'utf8')
      const start = storeSrc.indexOf('function activeStatusForBucket')
      const end = storeSrc.indexOf('export function useTodos')
      if (start < 0 || end < 0 || end <= start) throw new Error('找不到 isNoopMove/activeStatusForBucket 區段')
      const snippet = storeSrc.slice(start, end) + '\nexport { activeStatusForBucket, isNoopMove }\n'
      const transformed = await esbuild.transform(snippet, { loader: 'ts', format: 'cjs' })
      const factory = new Function('exports', 'require', 'module', transformed.code)
      const modObj = { exports: {} }
      factory(modObj.exports, require, modObj)
      storeIsNoopMove = modObj.exports.isNoopMove
      if (typeof storeIsNoopMove !== 'function') throw new Error('isNoopMove 非函式')
    } catch (e) {
      storeLoadErr = e && e.message ? e.message : String(e)
    }
    assert('store.isNoopMove 由真原始碼成功載入', storeIsNoopMove !== null, 'function', storeLoadErr || 'function')

    if (storeIsNoopMove) {
      // store 6×4 真值表，逐格與「契約 no-op 定義」比對（store == 契約）。
      for (const src of SRC) {
        for (const col of COLS) {
          const dto = { bucket: src.bucket, status: src.status, resolvedAt: src.status === 'done' || src.status === 'dismissed' ? '2026-06-20T10:00:00' : null }
          const got = storeIsNoopMove(dto, col)
          const ref = referenceNoop(dto, col)
          assert(`store isNoopMove [${src.name} → ${col}] == 契約(${ref})`, got === ref, ref, got)
        }
      }
    }

    // ── 收尾 ──
    const failed = results.filter((r) => !r.pass)
    const ok = failed.length === 0
    console.log('[probe-mc] SUMMARY total=' + results.length + ' pass=' + (results.length - failed.length) + ' fail=' + failed.length)
    if (failed.length) console.log('[probe-mc] FAILED: ' + failed.map((f) => f.name).join(' | '))
    console.log('[probe-mc] ALL-ASSERTIONS-PASS=' + ok)
    m.closeDb()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    cleanup()
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[probe-mc] FAILED: ' + (err && err.stack ? err.stack : err))
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    cleanup()
    app.exit(1)
  }
})
