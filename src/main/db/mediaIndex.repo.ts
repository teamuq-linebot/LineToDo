import type { Database } from 'better-sqlite3'

/**
 * mediaIndex.repo.ts — LINE Cache 圖片索引的本地表（設計 §5.3；附屬表，不動 core user_version，仿 `ensureLineImportSchema`）。
 *
 *   line_media_index        一個 `.eimg` 一列：size（＝明文 FILE_SIZE + 32）、相對 Cache 根的目錄、檔名、live／stale
 *   line_media_dirs         每個已列過的目錄：列舉當時父目錄回報的 mtime、有沒有子目錄、哪一輪（gen）列的
 *   line_media_index_meta   schema_version／cache_root／gen／initial_scan_done／last_full_at／full_gen_done／live_rows
 *
 * `stale_at`、`full_gen_done`、`live_rows` 是設計之外加的欄位／鍵：stale 要「超過 30 天才清」就需要一個時間，而 gen 是遞增的輪次編號、不是時間；
 * 24 小時完整重列要能跨重啟續跑，需要知道「這一輪（gen）做完了沒」；live 列數隨每個切片在同一個 transaction 裡遞增更新（診斷用，不必為了 `backend.info` 每次整表 count 4 萬多列）。
 *
 * 路徑一律是相對 Cache 根、以 `/` 分隔（根目錄本身是空字串）；絕對路徑由 `mediaIndex.ts` 組出來。所有 SQL 都集中在這裡，沒有任何連線以外的狀態。
 */

export const MEDIA_INDEX_SCHEMA_VERSION = 1

export type MediaIndexMetaKey = 'schema_version' | 'cache_root' | 'gen' | 'initial_scan_done' | 'last_full_at' | 'full_gen_done' | 'live_rows'

export interface MediaDirRecord {
  dirPath: string
  mtimeNs: string
  hasSubdirs: boolean
  listedGen: number
}

export interface MediaFileRow {
  size: number
  name: string
  state: 'live' | 'stale'
}

export interface MediaIndexStore {
  getMeta(key: MediaIndexMetaKey): string | null
  setMeta(key: MediaIndexMetaKey, value: string): void
  /** 一個 transaction（better-sqlite3；例外會整個回滾）。 */
  transaction<T>(fn: () => T): T
  /** 這個 size 的 live 檔（相對路徑拆成目錄＋檔名）。 */
  candidates(size: number): Array<{ dirPath: string; name: string }>
  /** 一個目錄底下的所有列（live 與 stale）。 */
  dirRows(dirPath: string): MediaFileRow[]
  upsertLive(size: number, dirPath: string, name: string, gen: number): void
  markStale(size: number, dirPath: string, name: string, at: number): number
  /** 依檔名標 stale（不知道 size 時用；回傳受影響的列數）。 */
  markStaleByName(dirPath: string, name: string, at: number): number
  /** 這個目錄與它底下所有子孫目錄的 live 檔全部標 stale。 */
  markStaleTree(dirPath: string, at: number): number
  deleteDirTree(dirPath: string): void
  upsertDir(dirPath: string, mtimeNs: string, hasSubdirs: boolean, gen: number): void
  loadDirs(): MediaDirRecord[]
  /** 讓這個目錄在下一輪一定重列（清掉 mtime、gen 歸零）。 */
  forceRelist(dirPath: string): void
  /** 刪掉 `stale_at < before` 的 stale 列，最多 `limit` 列；回傳實際刪除數。 */
  purgeStale(before: number, limit: number): number
  countLive(): number
  /** 清空索引與所有 meta（Cache 根換了）。 */
  reset(): void
}

const TABLES = ['line_media_index', 'line_media_dirs', 'line_media_index_meta']

export function isMediaIndexSchemaReady(db: Database): boolean {
  try {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('line_media_index','line_media_dirs','line_media_index_meta')`).all() as Array<{ name: string }>
    return new Set(rows.map((row) => row.name)).size === TABLES.length
  } catch {
    return false
  }
}

export function ensureMediaIndexSchema(db: Database): void {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS line_media_index (
        size INTEGER NOT NULL,
        dir_path TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','stale')),
        seen_gen INTEGER NOT NULL,
        stale_at INTEGER,
        PRIMARY KEY(size, dir_path, name)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_line_media_index_dir ON line_media_index(dir_path);
      CREATE INDEX IF NOT EXISTS idx_line_media_index_stale ON line_media_index(stale_at) WHERE state='stale';
      CREATE TABLE IF NOT EXISTS line_media_dirs (
        dir_path TEXT PRIMARY KEY,
        mtime_ns TEXT NOT NULL,
        has_subdirs INTEGER NOT NULL CHECK(has_subdirs IN (0,1)),
        listed_gen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS line_media_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    db.prepare(`INSERT OR IGNORE INTO line_media_index_meta(key,value) VALUES ('schema_version',?)`).run(String(MEDIA_INDEX_SCHEMA_VERSION))
  })
  tx()
}

/** 準備好所有語句（欄位對不上、表不存在就在這裡 throw，呼叫端據此判定索引不可用）。 */
export function openMediaIndexStore(db: Database): MediaIndexStore {
  const getMeta = db.prepare('SELECT value FROM line_media_index_meta WHERE key=?')
  const setMeta = db.prepare('INSERT INTO line_media_index_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  const selCandidates = db.prepare(`SELECT dir_path, name FROM line_media_index WHERE size=? AND state='live'`)
  const selDirRows = db.prepare('SELECT size, name, state FROM line_media_index WHERE dir_path=?')
  const upLive = db.prepare(`INSERT INTO line_media_index(size,dir_path,name,state,seen_gen,stale_at) VALUES (?,?,?,'live',?,NULL)
    ON CONFLICT(size,dir_path,name) DO UPDATE SET state='live', seen_gen=excluded.seen_gen, stale_at=NULL`)
  const upStale = db.prepare(`UPDATE line_media_index SET state='stale', stale_at=? WHERE size=? AND dir_path=? AND name=? AND state='live'`)
  const upStaleByName = db.prepare(`UPDATE line_media_index SET state='stale', stale_at=? WHERE dir_path=? AND name=? AND state='live'`)
  const upStaleTree = db.prepare(`UPDATE line_media_index SET state='stale', stale_at=? WHERE state='live' AND (dir_path=? OR (dir_path>=? AND dir_path<?))`)
  const delDirTree = db.prepare('DELETE FROM line_media_dirs WHERE dir_path=? OR (dir_path>=? AND dir_path<?)')
  const upDir = db.prepare(`INSERT INTO line_media_dirs(dir_path,mtime_ns,has_subdirs,listed_gen) VALUES (?,?,?,?)
    ON CONFLICT(dir_path) DO UPDATE SET mtime_ns=excluded.mtime_ns, has_subdirs=excluded.has_subdirs, listed_gen=excluded.listed_gen`)
  const selDirs = db.prepare('SELECT dir_path, mtime_ns, has_subdirs, listed_gen FROM line_media_dirs')
  const upForce = db.prepare(`UPDATE line_media_dirs SET mtime_ns='', listed_gen=0 WHERE dir_path=?`)
  const delStale = db.prepare(`DELETE FROM line_media_index WHERE (size,dir_path,name) IN (SELECT size,dir_path,name FROM line_media_index WHERE state='stale' AND stale_at<? LIMIT ?)`)
  const cntLive = db.prepare(`SELECT count(*) AS n FROM line_media_index WHERE state='live'`)
  // 目錄樹的範圍條件：'a/b' 的子孫路徑都落在 ['a/b/', 'a/b0')（'0' 是 '/' 的下一個字元）。根（空字串）的子孫是全部。
  const range = (dirPath: string): [string, string, string] => (dirPath === '' ? ['', '', '￿'] : [dirPath, `${dirPath}/`, `${dirPath}0`])
  return {
    getMeta: (key) => (getMeta.get(key) as { value: string } | undefined)?.value ?? null,
    setMeta: (key, value) => { setMeta.run(key, value) },
    transaction: (fn) => db.transaction(fn)(),
    candidates: (size) => (selCandidates.all(size) as Array<{ dir_path: string; name: string }>).map((row) => ({ dirPath: row.dir_path, name: row.name })),
    dirRows: (dirPath) => selDirRows.all(dirPath) as MediaFileRow[],
    upsertLive: (size, dirPath, name, gen) => { upLive.run(size, dirPath, name, gen) },
    markStale: (size, dirPath, name, at) => upStale.run(at, size, dirPath, name).changes,
    markStaleByName: (dirPath, name, at) => upStaleByName.run(at, dirPath, name).changes,
    markStaleTree: (dirPath, at) => { const [self, lo, hi] = range(dirPath); return upStaleTree.run(at, self, lo, hi).changes },
    deleteDirTree: (dirPath) => { const [self, lo, hi] = range(dirPath); delDirTree.run(self, lo, hi) },
    upsertDir: (dirPath, mtimeNs, hasSubdirs, gen) => { upDir.run(dirPath, mtimeNs, hasSubdirs ? 1 : 0, gen) },
    loadDirs: () => (selDirs.all() as Array<{ dir_path: string; mtime_ns: string; has_subdirs: number; listed_gen: number }>)
      .map((row) => ({ dirPath: row.dir_path, mtimeNs: row.mtime_ns, hasSubdirs: row.has_subdirs === 1, listedGen: row.listed_gen })),
    forceRelist: (dirPath) => { upForce.run(dirPath) },
    purgeStale: (before, limit) => delStale.run(before, limit).changes,
    countLive: () => (cntLive.get() as { n: number }).n,
    reset: () => {
      db.exec('DELETE FROM line_media_index; DELETE FROM line_media_dirs; DELETE FROM line_media_index_meta;')
      setMeta.run('schema_version', String(MEDIA_INDEX_SCHEMA_VERSION))
    }
  }
}
