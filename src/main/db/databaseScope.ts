import { resolve } from 'node:path'
import type { Database } from 'better-sqlite3'

/** The path is bound to the opened handle, independent of SQLite driver-specific name fields. */
const databasePaths=new WeakMap<object,string>()

export function bindDatabasePath(db:Database,path:string):void{
  const canonical=path===':memory:'?':memory:':resolve(path)
  const existing=databasePaths.get(db)
  if(existing!==undefined&&existing!==canonical)throw new Error('database_scope_conflict')
  databasePaths.set(db,canonical)
}

export function databasePathFor(db:Database):string|undefined{
  return databasePaths.get(db)
}

export function unbindDatabasePath(db:Database):void{
  databasePaths.delete(db)
}
