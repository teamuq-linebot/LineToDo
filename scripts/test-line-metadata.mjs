import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { rowToObj } from '../src/main/line/engine/rowToObj.ts'
import { SCHEMA_DDL } from '../src/main/db/schema.ts'
import { migrate } from '../src/main/db/migrate.ts'
import { insertMessages, getMessageLineMetadata } from '../src/main/db/messages.repo.ts'
import { backfillMediaKeys } from '../src/main/pipeline/backfill.ts'
import { commitLineImportBatch, ensureLineImportSchema, lineImportBatchId } from '../src/main/db/lineImport.repo.ts'
import { createLineTodoApplication } from '../src/core/application.ts'
import { createSettingsStore } from '../src/main/config/settings.ts'
import { createPipelineConfig } from '../src/main/config/defaults.ts'
import { createQwenConfig } from '../src/main/config/qwen.ts'
import { PipelineScheduler } from '../src/main/pipeline/scheduler.ts'

const ctx = { myMid: 'u-me', iso: () => '2026-01-01T00:00:00', chatName: 'room', senderName: 'sender' }
function message(ct, metadata, id = `id-${ct}`) {
  return rowToObj({ chatId: 'c-room', createdTime: 1, from: 'u-sender', text: null, contentType: ct, id,
    contentMetadata: metadata, contentInfo: null, attribute: 0 }, ctx)
}
function db() { const value = new Database(':memory:'); value.pragma('foreign_keys=ON'); value.exec(SCHEMA_DDL); return value }

test('converter preserves exact opaque numeric tokens, lower-case shared-contact mid, and CT boundaries', () => {
  const media = message(1, '{"nested":{"x":1},"OID":900719925474099312345,"SID":"s\\u0031"}')
  assert.equal(media.oid, '900719925474099312345')
  assert.equal(media.sid, 's1')
  assert.equal(message(13, '{"mid":12345678901234567890,"displayName":"Alice","MID":"wrong"}').sharedContactMid, '12345678901234567890')
  assert.equal(message(13, '{"mid":"c-target","displayName":"Alice","MID":"wrong"}').sharedContactDisplayName, 'Alice')
  assert.equal(message(7, '{"STKID":777,"STKPKGID":"88"}').stickerId, '777')
  assert.equal(message(0, '{"OID":"should-not-save"}').oid, null)
  assert.equal(message(14, '{bad', 'bad').oid, null)
  for (const raw of ['{"OID":"first","OID":"second"}', '{"OID":"second","OID":"first"}']) {
    assert.equal(message(1, raw).oid, null)
  }
  for (const [ct,key,field] of [[14,'SID','sid'],[13,'mid','sharedContactMid'],[13,'displayName','sharedContactDisplayName'],[7,'STKID','stickerId'],[7,'STKPKGID','stickerPackageId']]) {
    for (const raw of [`{"${key}":"first","${key}":"second"}`,`{"${key}":"second","${key}":"first"}`]) assert.equal(message(ct,raw)[field],null)
  }
  assert.equal(message(14,'{"OID":true,"SID":null}').oid,null)
  assert.equal(message(14,'{"OID":"present"}').sid,null)
  assert.equal(message(13,'{"mid":false,"displayName":true}').sharedContactDisplayName,null)
  assert.equal(message(7,'{}').stickerId,null)
  assert.equal(message(1, '{"OID":"ok","nested":{"OID":"nested"}}').oid, 'ok')
})

test('commitLineImportBatch round-trips all six selected metadata columns and preserves todo references', () => {
  const value = db(); ensureLineImportSchema(value)
  const source = { ...message(1, null, 'media'), oid: 'oid-1', sid: 'sid-1', sharedContactMid: 'contact-1',
    sharedContactDisplayName: 'Contact', stickerId: 'sticker-1', stickerPackageId: 'package-1' }
  insertMessages([source], value)
  value.prepare("INSERT INTO todos(id,chat_id,bucket,status,title,detail,priority,due_at,source_msg_ids,confidence,completion_evidence,created_at,updated_at,resolved_at) VALUES('todo-1','c-room','todo','pending','Keep','',2,NULL,?,0.9,NULL,'now','now',NULL)").run(JSON.stringify(['i:media']))
  value.prepare("UPDATE messages SET processed=1,text='kept' WHERE msg_id='i:media'").run()
  const batch = { batchId: lineImportBatchId('line-backfill', {createdTime:0,rowId:Number.MAX_SAFE_INTEGER},{createdTime:1,rowId:1}), source:'line-backfill',
    cursorFrom:{createdTime:0,rowId:Number.MAX_SAFE_INTEGER}, cursorTo:{createdTime:1,rowId:1}, hasMore:false, observedAt:'now',
    items:[{message:source,sourceRowId:1,senderMid:null,accountMid:null}] }
  commitLineImportBatch(value,batch,{resolve:()=>({participantKey:null,scope:'unknown',keyVersion:null,status:'unknown',reason:'source_id_missing'}),epoch:()=>null,persistUnknown:false})
  assert.deepEqual(getMessageLineMetadata('i:media',value),{msgId:'i:media',mediaOid:'oid-1',mediaSid:'sid-1',sharedContactMid:'contact-1',sharedContactDisplayName:'Contact',stickerId:'sticker-1',stickerPackageId:'package-1'})
  assert.deepEqual({...value.prepare("SELECT processed,text FROM messages WHERE msg_id='i:media'").get()},{processed:1,text:'kept'})
  assert.deepEqual(JSON.parse(value.prepare("SELECT source_msg_ids FROM todos WHERE id='todo-1'").get().source_msg_ids),['i:media'])
  value.close()
})

test('metadata-only replay fills null fields idempotently without changing message state and never erases values', () => {
  const value = db()
  const original = message(13, null, 'contact')
  insertMessages([original], value)
  value.prepare("UPDATE messages SET text='original body',processed=1 WHERE msg_id='i:contact'").run()
  const enriched = { ...original, sharedContactMid: 'target-mid', sharedContactDisplayName: 'Alice' }
  assert.equal(insertMessages([enriched], value).metadataBackfilled, 1)
  assert.deepEqual({ ...value.prepare("SELECT msg_id,chat_id,text,processed,shared_contact_mid,shared_contact_display_name FROM messages WHERE msg_id='i:contact'").get() }, {
    msg_id: 'i:contact', chat_id: 'c-room', text: 'original body', processed: 1,
    shared_contact_mid: 'target-mid', shared_contact_display_name: 'Alice'
  })
  assert.equal(insertMessages([enriched], value).metadataBackfilled, 0)
  assert.equal(insertMessages([{ ...original, sharedContactMid: null, sharedContactDisplayName: null }], value).metadataBackfilled, 0)
  assert.deepEqual(getMessageLineMetadata('i:contact', value), { msgId: 'i:contact', mediaOid: null, mediaSid: null,
    sharedContactMid: 'target-mid', sharedContactDisplayName: 'Alice', stickerId: null, stickerPackageId: null })
  value.close()
})

test('v10 database upgrades additively to v11 with six nullable TEXT columns', () => {
  const value = new Database(':memory:')
  value.exec(`CREATE TABLE chats(chat_id TEXT PRIMARY KEY,name TEXT,is_group INTEGER NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0,block_reason TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL);
    CREATE TABLE messages(msg_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,ts INTEGER NOT NULL,time_iso TEXT NOT NULL,direction TEXT NOT NULL,sender TEXT,text TEXT,content_type INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0,ingested_at TEXT NOT NULL,key_material TEXT,orig_filename TEXT,file_size INTEGER,media_backed_up INTEGER NOT NULL DEFAULT 0,unsent INTEGER NOT NULL DEFAULT 0);
    PRAGMA user_version=10;`)
  assert.deepEqual(migrate(value), { from: 10, to: 11 })
  const columns = value.prepare('PRAGMA table_info(messages)').all()
  for (const name of ['media_oid','media_sid','shared_contact_mid','shared_contact_display_name','sticker_id','sticker_package_id']) {
    const col = columns.find((row) => row.name === name)
    assert.ok(col, `${name} exists`)
    assert.equal(col.type, 'TEXT')
    assert.equal(col.notnull, 0)
  }
  value.close()
})

test('existing history backfill entry re-reads and stores identifiers without LLM work', async () => {
  const value = db()
  const old = message(7, null, 'old-sticker')
  insertMessages([old], value)
  const source = { ...old, stickerId: '401', stickerPackageId: '501' }
  const result = await backfillMediaKeys(3650, { db: value, now: () => 1000,
    fetchWindow: async () => ({ messages: [source] }) })
  assert.deepEqual(result, { scanned: 1, mediaBackfilled: 0, metadataBackfilled: 1 })
  assert.deepEqual(getMessageLineMetadata('i:old-sticker', value), { msgId: 'i:old-sticker', mediaOid: null, mediaSid: null,
    sharedContactMid: null, sharedContactDisplayName: null, stickerId: '401', stickerPackageId: '501' })
  value.close()
})

test('history entry commits every production paging page through the durable import caller', async () => {
  const value=db(); ensureLineImportSchema(value)
  const rows=[message(7,null,'p1'),message(7,null,'p2'),message(7,null,'tail')]
  let page=0; const committed=[]
  const fetchImportBatch=async(cursor,{limit})=>{
    assert.equal(limit,20000); const index=page++; const offset=cursor.rowId===Number.MAX_SAFE_INTEGER?0:cursor.rowId; const messages=rows.slice(offset,offset+2)
    const from={...cursor}; const to=messages.length?{createdTime:1,rowId:offset+messages.length}:{...from}
    const batch={batchId:`page-${index}`,source:'line-backfill',cursorFrom:from,cursorTo:to,hasMore:index===0,observedAt:'now',items:messages.map((m,j)=>({message:{...m,stickerId:`s-${offset+j}`,stickerPackageId:`pkg-${offset+j}`},sourceRowId:offset+j,senderMid:null,accountMid:null}))}
    return batch
  }
  const commitImportBatch=(batch)=>{ committed.push(batch.batchId); return commitLineImportBatch(value,batch,{resolve:()=>({participantKey:null,scope:'unknown',keyVersion:null,status:'unknown',reason:'source_id_missing'}),epoch:()=>null,persistUnknown:false}) }
  const result=await backfillMediaKeys(3650,{db:value,now:()=>1000,fetchImportBatch,commitImportBatch})
  assert.equal(page,2); assert.deepEqual(committed,['page-0','page-1']); assert.equal(result.scanned,3)
  assert.deepEqual(value.prepare('SELECT msg_id,sticker_id FROM messages ORDER BY msg_id').all().map((r)=>[r.msg_id,r.sticker_id]),[['i:p1','s-0'],['i:p2','s-1'],['i:tail','s-2']])
  value.close()
})

test('public standalone/plugin application API drains production import pages and persists the tail page', async () => {
  const root=mkdtempSync(join(tmpdir(),'line-metadata-production-'))
  const settings=createSettingsStore({userDataDir:root,secrets:{isEncryptionAvailable:()=>true,encryptString:(v)=>Buffer.from(v),decryptString:(v)=>v.toString()}})
  const getDefaults=createPipelineConfig(()=>settings.get())
  const qwenConfig=createQwenConfig({readApiKey:()=>settings.readApiKey(),readBaseUrl:()=>settings.get().aiBaseUrl})
  let pages=0; let app; let appDb
  const rows=[1,2,3].map((n)=>({...message(7,null,`prod-${n}`),chatId:'production-history',stickerId:`prod-sticker-${n}`,stickerPackageId:`prod-package-${n}`}))
  try {
    app=await createLineTodoApplication({dataDir:root,dbPath:join(root,'app.db'),settings,onDatabase:(value)=>{appDb=value},
      pipelineConfig:{getDefaults,getQwenConfig:qwenConfig,isProviderConfigured:()=>false},providers:{resolveProvider:()=>null},makeExtract:()=>null,
      schedulerFactory:(db,repos)=>new PipelineScheduler({db,getDefaults,isProviderConfigured:()=>false,makeExtract:()=>null,getLastRun:()=>repos.pipeline.getLastRun()}),
      line:{start(){},stop(){},status:()=>({state:'stopped',lastMessageAt:null,messageCount:0,lastError:null,restarts:0}),onMessage:()=>()=>{},onStatus:()=>()=>{},setBatchCommitter(){},getMessagesSince:async()=>[],
        async getLineImportBatch(cursor,{limit}) { assert.equal(limit,20000); const offset=cursor.rowId===Number.MAX_SAFE_INTEGER?0:cursor.rowId; const items=rows.slice(offset,offset+2); const next=offset+items.length; pages++
          return {batchId:`production-page-${pages}`,source:'line-backfill',cursorFrom:{...cursor},cursorTo:{createdTime:Date.now(),rowId:next},hasMore:next<rows.length,observedAt:new Date().toISOString(),items:items.map((m,j)=>({message:m,sourceRowId:offset+j+1,senderMid:null,accountMid:null}))} }},
      media:{open:async()=>({ok:false}),saveAs:async()=>({ok:false})},app:{ping:()=>({ok:true,ts:Date.now(),version:'test'}),openDataFolder:async()=>({ok:true}),openOriginal:async()=>({ok:true})}})
    const result=await app.api.pipeline.backfillMediaKeys(3650)
    assert.equal(result.ok,true); assert.equal(result.scanned,3); assert.equal(pages,2)
    assert.equal(appDb.prepare("SELECT COUNT(*) AS n FROM line_import_batches WHERE source='line-backfill'").get().n,2)
    assert.deepEqual(appDb.prepare("SELECT sticker_id,sticker_package_id FROM messages WHERE chat_id='production-history' ORDER BY msg_id").all().map((r)=>({...r})),[
      {sticker_id:'prod-sticker-1',sticker_package_id:'prod-package-1'},{sticker_id:'prod-sticker-2',sticker_package_id:'prod-package-2'},{sticker_id:'prod-sticker-3',sticker_package_id:'prod-package-3'}])
  } finally { await app?.dispose(); rmSync(root,{recursive:true,force:true}) }
})
