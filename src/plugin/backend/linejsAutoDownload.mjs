import { randomUUID, createHash } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, writeFile, link, unlink, rename, realpath, access, open, constants } from 'node:fs/promises';
import path from 'node:path';

export const MAX_AUTO_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
const JPEG_FRAME_MARKERS = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);

function hasPngContainer(b) {
  if (b.length < 8 || !b.subarray(0,8).equals(PNG_SIGNATURE)) return false;
  let offset=8, sawHeader=false, sawData=false;
  while (offset + 12 <= b.length) {
    const size=b.readUInt32BE(offset);
    if (size > b.length - offset - 12) return false;
    const type=b.toString('ascii',offset+4,offset+8);
    if (!sawHeader && (type !== 'IHDR' || size !== 13)) return false;
    if (type === 'IHDR') {
      if (sawHeader || size !== 13 || b.readUInt32BE(offset+8) === 0 || b.readUInt32BE(offset+12) === 0) return false;
      sawHeader=true;
    } else if (type === 'IDAT') {
      if (!sawHeader || size === 0) return false;
      sawData=true;
    } else if (type === 'IEND') {
      return sawHeader && sawData && size === 0 && offset + 12 === b.length;
    }
    offset += size + 12;
  }
  return false;
}

function hasJpegFrameAndScan(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[b.length-2] !== 0xff || b[b.length-1] !== 0xd9) return false;
  let offset=2, sawFrame=false;
  while (offset < b.length - 2) {
    if (b[offset++] !== 0xff) return false;
    while (offset < b.length && b[offset] === 0xff) offset++;
    if (offset >= b.length) return false;
    const marker=b[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (offset + 2 > b.length) return false;
    const size=b.readUInt16BE(offset);
    if (size < 2 || size > b.length - offset) return false;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (size < 8) return false;
      const height=b.readUInt16BE(offset+3), width=b.readUInt16BE(offset+5), components=b[offset+7];
      if (!width || !height || !components || size !== 8 + components * 3) return false;
      sawFrame=true;
    }
    if (marker === 0xda) {
      const components=b[offset+2];
      if (!sawFrame || size < 6 || !components || size !== 6 + components * 2) return false;
      const scanStart=offset+size;
      return b.length - 2 > scanStart;
    }
    offset += size;
  }
  return false;
}

function hasGifFrameAndTrailer(b) {
  if (b.length < 14 || !['GIF87a','GIF89a'].includes(b.subarray(0,6).toString('ascii'))) return false;
  if (!b.readUInt16LE(6) || !b.readUInt16LE(8)) return false;
  let offset=13, sawFrame=false;
  if (b[10] & 0x80) offset += 3 * (1 << ((b[10] & 7) + 1));
  if (offset > b.length) return false;
  while (offset < b.length) {
    const marker=b[offset++];
    if (marker === 0x3b) return sawFrame && offset === b.length;
    if (marker === 0x21) {
      if (offset >= b.length) return false;
      offset++;
      let ended=false;
      while (offset < b.length) { const size=b[offset++]; if (!size) { ended=true; break; } if (size > b.length-offset) return false; offset += size; }
      if (!ended) return false;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > b.length) return false;
    const width=b.readUInt16LE(offset+4), height=b.readUInt16LE(offset+6), flags=b[offset+8];
    if (!width || !height) return false;
    offset += 9;
    if (flags & 0x80) offset += 3 * (1 << ((flags & 7) + 1));
    if (offset >= b.length || b[offset] < 2 || b[offset] > 8) return false;
    offset++;
    let dataBytes=0, ended=false;
    while (offset < b.length) { const size=b[offset++]; if (!size) { ended=true; break; } if (size > b.length-offset) return false; dataBytes += size; offset += size; }
    if (!ended || !dataBytes) return false;
    sawFrame=true;
  }
  return false;
}

function hasWebpFrame(b) {
  if (b.length < 20 || b.toString('ascii',0,4) !== 'RIFF' || b.toString('ascii',8,12) !== 'WEBP' || b.readUInt32LE(4) + 8 !== b.length) return false;
  let offset=12, sawFrame=false;
  while (offset + 8 <= b.length) {
    const type=b.toString('ascii',offset,offset+4), size=b.readUInt32LE(offset+4), data=offset+8;
    if (size > b.length-data) return false;
    if (type === 'VP8X') {
      if (size !== 10) return false;
    } else if (type === 'VP8 ') {
      if (size < 10 || (b[data] & 1) !== 0 || b[data+3] !== 0x9d || b[data+4] !== 0x01 || b[data+5] !== 0x2a || !(b.readUInt16LE(data+6)&0x3fff) || !(b.readUInt16LE(data+8)&0x3fff)) return false;
      sawFrame=true;
    } else if (type === 'VP8L') {
      if (size < 5 || b[data] !== 0x2f) return false;
      const width=1 + ((b[data+2]&0x3f)<<8) + b[data+1];
      const height=1 + ((b[data+4]&0x0f)<<10) + (b[data+3]<<2) + (b[data+2]>>6);
      if (!width || !height) return false;
      sawFrame=true;
    }
    offset=data+size+(size&1);
    if (offset > b.length) return false;
  }
  return offset === b.length && sawFrame;
}

export function detectSupportedImageMime(body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (hasPngContainer(b)) return 'image/png';
  if (hasJpegFrameAndScan(b)) return 'image/jpeg';
  if (hasGifFrameAndTrailer(b)) return 'image/gif';
  if (hasWebpFrame(b)) return 'image/webp';
  return null;
}
const LEDGER_NAME = 'auto-download-ledger.json';
const SETTINGS_NAME = 'auto-download-settings.json';
const MAX_LEDGER = 10000;
const MAX_PENDING = 128;
const MAX_ACTIVE = 2;
export const MAX_SAVED_FILE_CHUNK_BYTES = 32 * 1024;
const KEY_TTL = 90 * 24 * 60 * 60 * 1000;
const safeSegment = value => {
  let name = String(value || '').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.{2,}/g, '_').replace(/[. ]+$/g, '').replace(/^\.+$/g, '_').slice(0, 80) || 'unknown';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
};
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const inside = (root, child) => child === root || child.startsWith(root + path.sep);

async function checkedDirectory(dir, boundary) {
  const absolute = path.resolve(dir);
  const root = await realpath(boundary);
  if (!inside(root, absolute)) throw Object.assign(new Error('下載路徑越出允許根目錄'), { code: 'PATH_ESCAPE' });
  const relative = path.relative(root, absolute);
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { const stat = await lstat(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('下載路徑含有連結或非目錄'), { code: 'UNSAFE_PATH' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(cursor); }
  }
  const resolved = await realpath(absolute);
  if (!inside(root, resolved)) throw Object.assign(new Error('下載路徑連結逸出安全根目錄'), { code: 'PATH_ESCAPE' });
  return resolved;
}

export async function resolveAutoDownloadPath(dataDir, configuredPath = '.teamuq') {
  if (typeof configuredPath !== 'string' || !configuredPath.trim() || configuredPath.length > 1024 || /[\x00-\x1f]/.test(configuredPath)) throw Object.assign(new Error('下載路徑無效'), { code: 'PATH_INVALID' });
  const basePath = await realpath(dataDir);
  const resolvedPath = path.resolve(path.isAbsolute(configuredPath) ? configuredPath : path.join(basePath, configuredPath));
  if (!path.isAbsolute(configuredPath) && !inside(basePath, resolvedPath)) throw Object.assign(new Error('相對下載路徑不可離開外掛資料夾'), { code: 'PATH_ESCAPE' });
  if (path.isAbsolute(configuredPath)) {
    let cursor = path.parse(resolvedPath).root;
    for (const part of resolvedPath.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      try { const stat = await lstat(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('自訂絕對路徑含連結或非目錄'), { code: 'UNSAFE_PATH' }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(cursor); }
    }
    const actual = await realpath(resolvedPath);
    if (actual !== resolvedPath) throw Object.assign(new Error('自訂絕對路徑含連結'), { code: 'UNSAFE_PATH' });
  } else await checkedDirectory(resolvedPath, basePath);
  await access(resolvedPath, constants.W_OK);
  return { configuredPath, basePath, resolvedPath };
}

async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.part`;
  await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    try { await rename(temp, file); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  await unlink(temp);
}

/**
 * v1 自動下載（LINEJS 'message' 事件 → `.teamuq` 樹）。X2b 之後接收改成以電腦版訊息為準（linejsReceive.ts），v1 下載路徑停用：
 * LineJsMediaService 以 `{ frozen: true }` 建立本 store——v1 ledger 變成唯讀的歷史紀錄：
 *   - init 只讀（不修剪、不寫回），所以 90 天 TTL 不會再刪掉舊的 completed 項目（X4 回填要靠它們找到 `.teamuq` 裡的舊檔）；
 *   - enqueue／save／retry 一律回 `disabled`，flush／close／open 不寫檔；
 *   - readSavedChunk（設定頁「另存附件」匯出已完成的舊檔）照舊可用。
 * 遷移狀態（review-x2a I-5）：ledger v2 在 v2 檔不存在時從這份 v1 匯入一次；之後 v1 不再變動，所以不會有「匯入之後 v1 又完成了新項目」的遺漏。
 */
export class AutoDownloadStore {
  constructor(dataDir, options = {}) { this.dataDir = dataDir; this.now = options.now || Date.now; this.readFile = options.readFile || readFile; this.writeFile = options.writeFile || writeFile; this.renameFile = options.renameFile || rename; this.queueCap = options.queueCap || MAX_PENDING; this.activeCap = options.activeCap || MAX_ACTIVE; this.frozen = options.frozen === true; this.jobs = new Map(); this.running = new Set(); this.flushChain = Promise.resolve(); this.overflowCount = 0; this.closed = false; this.enabled = true; this.configuredPath = '.teamuq'; this.root = null; this.ownerKey = null; this.ledgerFile = path.join(dataDir, LEDGER_NAME); this.settingsFile = path.join(dataDir, SETTINGS_NAME); }
  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try { const settings = JSON.parse(await this.readFile(this.settingsFile, 'utf8')); this.enabled = settings.enabled !== false; this.configuredPath = typeof settings.path === 'string' ? settings.path : '.teamuq'; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const resolved = await resolveAutoDownloadPath(this.dataDir, this.configuredPath); this.root = resolved.resolvedPath;
    try { const ledger = JSON.parse(await this.readFile(this.ledgerFile, 'utf8')); this.overflowCount = Math.min(50, Math.max(0, Number(ledger.overflowCount) || 0)); for (const item of Array.isArray(ledger.items) ? ledger.items.slice(-MAX_LEDGER) : []) { if (item.status === 'running') item.status = 'pending'; this.jobs.set(item.key, item); } } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.frozen) return this.snapshot();
    this.prune(); await this.flush(); return this.snapshot();
  }
  prune() { const cutoff = this.now() - KEY_TTL; for (const [key, item] of this.jobs) if (item.updatedAt < cutoff && !['pending','running','paused'].includes(item.status)) this.jobs.delete(key); while (this.jobs.size > MAX_LEDGER) { const first = this.jobs.keys().next().value; if (['pending','running','paused'].includes(this.jobs.get(first).status)) break; this.jobs.delete(first); } }
  async flush() { if (this.frozen) return; const commit = this.flushChain.then(async () => { const temp = `${this.ledgerFile}.${randomUUID()}.part`; const body = JSON.stringify({ version: 1, overflowCount: this.overflowCount, items: [...this.jobs.values()].slice(-MAX_LEDGER) }); await this.writeFile(temp, body, { flag: 'wx', mode: 0o600 }); try { await this.renameFile(temp, this.ledgerFile); } catch (error) { await unlink(temp).catch(() => {}); throw error; } }); this.flushChain = commit.catch(() => {}); return commit; }
  async settings() { const pathInfo = await resolveAutoDownloadPath(this.dataDir, this.configuredPath); return { enabled: this.enabled, ...pathInfo }; }
  async configure({ enabled = this.enabled, path: configuredPath = this.configuredPath }) { const info = await resolveAutoDownloadPath(this.dataDir, configuredPath); const nextEnabled = Boolean(enabled); const temp = `${this.settingsFile}.${randomUUID()}.part`; await this.writeFile(temp, JSON.stringify({ version: 1, enabled: nextEnabled, path: configuredPath }), { flag: 'wx', mode: 0o600 }); try { await this.renameFile(temp, this.settingsFile); } catch (error) { await unlink(temp).catch(() => {}); throw error; } this.enabled = nextEnabled; this.configuredPath = configuredPath; this.root = info.resolvedPath; if (!this.enabled) { for (const item of this.jobs.values()) if (item.status === 'pending' || item.status === 'running') item.status = 'paused'; } else { for (const item of this.jobs.values()) if (item.status === 'paused') item.status = 'pending'; } await this.flush(); return { enabled: this.enabled, ...info }; }
  setOwner(accountId) { this.ownerKey = digest(String(accountId || 'unknown-account')); }
  key(chatId, messageId, kind) { return `${this.ownerKey || 'unassigned'}\0${chatId}\0${messageId}\0${kind}`; }
  async enqueue({ chatId, chatName, message, kind, metadata = {} }) {
    if (this.frozen) return { accepted: false, status: 'disabled' };
    if (this.closed || !this.enabled) return { accepted: false, status: this.closed ? 'stopped' : 'disabled' };
    const messageId = String(message?.raw?.id || ''); if (!chatId || !messageId) return { accepted: false, status: 'invalid_message' };
    const key = this.key(chatId, messageId, kind); if (this.jobs.has(key)) return { accepted: false, duplicate: true, status: this.jobs.get(key).status };
    if (this.jobs.size >= MAX_LEDGER) { this.overflowCount = Math.min(50, this.overflowCount + 1); await this.flush(); return { accepted: false, status: 'failed', errorCode: 'ledger_full' }; }
    const pending = [...this.jobs.values()].filter(item => ['pending','running'].includes(item.status)).length;
    if (pending >= this.queueCap) return this.record(key, { chatId, messageId, kind, status: 'failed', errorCode: 'queue_full', name: safeSegment(metadata.name) });
    const chatFolder = `account-${(this.ownerKey||'unassigned').slice(0,10)}--${safeSegment(chatName || chatId)}--${digest(chatId).slice(0, 10)}`;
    const original = safeSegment(metadata.name || (kind === 'IMAGE' ? `${messageId}.jpg` : `${messageId}.bin`));
    const ext = path.extname(original).slice(0, 16); const base = path.basename(original, ext).slice(0, 100);
    const filename = `${base}--${digest(messageId).slice(0, 10)}${ext}`;
    const item = { key, chatId, messageId, kind, chatFolder, name: filename, status: 'pending', bytes: 0, attempts: 0, createdAt: this.now(), updatedAt: this.now(), metadata: { type: String(metadata.type || '').slice(0, 80), declaredBytes: Number.isFinite(Number(metadata.size)) ? Number(metadata.size) : null }, message };
    delete item.message;
    return this.record(key, item);
  }
  async record(key, item) { this.jobs.set(key, item); await this.flush(); return { accepted: item.status === 'pending', status: item.status, errorCode: item.errorCode }; }
  async save(key, bytes, { signal } = {}) {
    const item = this.jobs.get(key); if (this.frozen) return { status: 'disabled' }; if (!item || item.status !== 'pending') return { status: item?.status || 'unknown' };
    if (this.closed || !this.enabled) { item.status = 'paused'; item.updatedAt = this.now(); await this.flush(); return { status: item.status }; }
    if (this.running.size >= this.activeCap) return { status: 'pending' };
    this.running.add(key); item.status = 'running'; item.updatedAt = this.now(); await this.flush();
    try {
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (body.length > MAX_AUTO_DOWNLOAD_BYTES) throw Object.assign(new Error('附件超過 25 MiB'), { code: 'oversize' });
      const saveRoot = this.root; const dir = await checkedDirectory(path.join(saveRoot, item.chatFolder), saveRoot);
      let target = path.join(dir, item.name); const part = path.join(dir, `.${randomUUID()}.part`);
      await this.writeFile(part, body, { flag: 'wx', mode: 0o600, signal });
      try { await link(part, target); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing=await lstat(target).catch(()=>null);
        if(existing?.isFile()&&!existing.isSymbolicLink()&&(await readFile(target)).equals(body)){await unlink(part);item.status='completed';item.bytes=body.length;item.savedName=item.name;item.savedRoot=saveRoot;item.updatedAt=this.now();await this.flush();return {status:item.status,name:item.name,bytes:body.length,chatFolder:item.chatFolder,alreadyPresent:true};}
        const ext=path.extname(item.name),base=path.basename(item.name,ext),suffix=digest(item.key).slice(0,12);let committed=false;
        for(let index=0;index<4&&!committed;index++){item.name=`${base}--${suffix}${index?`-${index}`:''}${ext}`;target=path.join(dir,item.name);try{await link(part,target);committed=true}catch(conflict){if(conflict.code!=='EEXIST')throw conflict;const statExisting=await lstat(target).catch(()=>null);if(statExisting?.isFile()&&!statExisting.isSymbolicLink()&&(await readFile(target)).equals(body)){committed=true;item.alreadyPresent=true}}}
        if(!committed)throw Object.assign(new Error('安全提交檔名衝突'),{code:'SAFE_COMMIT_CONFLICT'});
      }
      await unlink(part); item.status = 'completed'; item.bytes = body.length; item.savedName = item.name; item.savedRoot = saveRoot; item.updatedAt = this.now(); await this.flush(); return { status: item.status, name: item.name, bytes: body.length, chatFolder: item.chatFolder };
    } catch (error) { item.attempts++; item.errorCode = String(error.code || 'io_error').slice(0, 40); item.status = item.attempts < 5 && !['oversize','PATH_ESCAPE','UNSAFE_PATH'].includes(error.code) ? 'pending' : 'failed'; item.updatedAt = this.now(); await this.flush(); return { status: item.status, errorCode: item.errorCode }; }
    finally { this.running.delete(key); }
  }
  async retry(key) { if (this.frozen) return { status: 'disabled' }; const item = this.jobs.get(key); if (!item || item.status !== 'failed') return { status: item?.status || 'unknown' }; item.status = 'pending'; item.attempts = 0; item.errorCode = null; item.updatedAt = this.now(); await this.flush(); return { status: item.status }; }
  async saveFile(key, body, { signal } = {}) { return this.save(key, body, { signal }); }
  keyFor(chatId, messageId, kind) { return this.key(chatId, messageId, kind); }
  async savedLocation(key) { const item=this.jobs.get(String(key)); if(!item||item.status!=='completed'||!item.savedRoot||!item.chatFolder||!item.savedName) return null; const root=await realpath(item.savedRoot), file=path.resolve(root,item.chatFolder,item.savedName); if(!inside(root,file)) throw Object.assign(new Error('保存檔案位置不安全'),{code:'UNSAFE_PATH'}); const stat=await lstat(file); if(!stat.isFile()||stat.isSymbolicLink()) throw Object.assign(new Error('保存檔案不可用'),{code:'SAVED_FILE_UNAVAILABLE'}); const actual=await realpath(file); if(path.dirname(actual)!==root&& !inside(root,actual)) throw Object.assign(new Error('保存檔案位置不安全'),{code:'UNSAFE_PATH'}); return {path:actual,name:item.savedName,bytes:item.bytes}; }
  async readSavedChunk(key, offset, length) {
    const item = this.jobs.get(String(key));
    if (!item || !this.ownerKey || !item.key.startsWith(`${this.ownerKey}\0`)) return null;
    if (item.status !== 'completed' || !item.savedRoot || !item.chatFolder || !item.savedName) return null;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_SAVED_FILE_CHUNK_BYTES || offset > item.bytes || offset + length > item.bytes) throw Object.assign(new Error('附件讀取範圍無效'), { code: 'INVALID_FILE_RANGE' });
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_AUTO_DOWNLOAD_BYTES) throw Object.assign(new Error('保存附件大小無效'), { code: 'SAVED_FILE_UNAVAILABLE' });
    const configuredRoot = await realpath(this.root);
    const savedRoot = await realpath(item.savedRoot);
    if (savedRoot !== configuredRoot || path.resolve(item.savedRoot) !== savedRoot) throw Object.assign(new Error('保存檔案位置不安全'), { code: 'UNSAFE_PATH' });
    if (path.basename(item.chatFolder) !== item.chatFolder || path.basename(item.savedName) !== item.savedName) throw Object.assign(new Error('保存檔案位置不安全'), { code: 'UNSAFE_PATH' });
    const directory = path.join(savedRoot, item.chatFolder);
    const realDirectory = await realpath(directory);
    if (realDirectory !== directory || !inside(savedRoot, realDirectory)) throw Object.assign(new Error('保存檔案位置不安全'), { code: 'UNSAFE_PATH' });
    const file = path.join(directory, item.savedName);
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== item.bytes) throw Object.assign(new Error('保存檔案不可用'), { code: 'SAVED_FILE_UNAVAILABLE' });
    if (await realpath(file) !== file) throw Object.assign(new Error('保存檔案位置不安全'), { code: 'UNSAFE_PATH' });
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(file, flags);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== item.bytes || (before.ino && opened.ino !== before.ino) || (before.dev && opened.dev !== before.dev)) throw Object.assign(new Error('保存檔案已變更'), { code: 'SAVED_FILE_UNAVAILABLE' });
      if (await realpath(file) !== file) throw Object.assign(new Error('保存檔案位置不安全'), { code: 'UNSAFE_PATH' });
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw Object.assign(new Error('保存檔案已截短'), { code: 'SAVED_FILE_UNAVAILABLE' });
      return { name: item.savedName, size: item.bytes, offset, data: buffer.toString('base64') };
    } finally { await handle.close(); }
  }
  setImageExtension(key,mime) { const extension=({ 'image/jpeg':'.jpg','image/png':'.png','image/gif':'.gif','image/webp':'.webp' })[String(mime||'').toLowerCase()];const item=this.jobs.get(key);if(item&&item.kind==='IMAGE'&&extension&&item.status==='pending'){item.name=`${path.basename(item.name,path.extname(item.name))}${extension}`;item.updatedAt=this.now();return this.flush()} }
  async close() { this.closed = true; if (this.frozen) return; let changed=false; for (const item of this.jobs.values()) if (['pending','running'].includes(item.status)) { item.status = 'paused'; changed=true; } if(changed)await this.flush(); }
  async open() { this.closed = false; if (this.frozen) return; for (const item of this.jobs.values()) if (item.status === 'paused') item.status = 'pending'; await this.flush(); }
  snapshot() { const values=[...this.jobs.values()].filter(item=>item.key.startsWith(`${this.ownerKey || 'unassigned'}\0`)); return { enabled: this.enabled, pending: values.filter(x => ['pending','paused'].includes(x.status)).length, active: [...this.running].filter(key=>key.startsWith(`${this.ownerKey || 'unassigned'}\0`)).length, completed: values.filter(x => x.status === 'completed').length, failed: values.filter(x => x.status === 'failed').length, overflowCount:this.overflowCount, recent: values.slice(-50).map(({ key, chatId, messageId, kind, name, status, bytes, errorCode, chatFolder }) => ({ key, chatId, messageId, kind, name, status, bytes, errorCode, chatFolder })) }; }
}

// ───────────────────────── X2a：耐久寫入（review-x2a F-4） ─────────────────────────

/**
 * 寫一個新檔（flag wx、0600）並 fsync 後才關閉——之後的 rename／link 才不會在斷電後留下空檔或半個檔。
 * 失敗時關閉並移除這個新檔，再拋出原本的錯誤。
 */
export async function writeFileDurable(file, data) {
  const handle = await open(file, 'wx', 0o600);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let pos = 0;
    while (pos < buf.length) { const { bytesWritten } = await handle.write(buf, pos, buf.length - pos, pos); pos += bytesWritten; }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw error;
  }
  await handle.close();
}

// ───────────────────────── X2a：影片檔頭判斷（移植 linejs-lab detectSupportedVideoMime；只看檔頭、不設大小上限） ─────────────────────────

/**
 * 不是影片的 ISO-BMFF brand（HEIF／AVIF 系列）。X1 stream 的 sniff 與 sink 的 detectSupportedVideoMime 共用這一份
 * （review-x2a F-2a：兩邊不一致時 stream 會下載完整檔案再被 sink 拒收）。
 */
export const UNSUPPORTED_VIDEO_BRANDS = Object.freeze(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis']);
export function isUnsupportedVideoBrand(brand) { return UNSUPPORTED_VIDEO_BRANDS.includes(String(brand)); }

/**
 * 影片的格式只依內容判斷（IP1 §2.4）：offset 4 是 `ftyp` → mp4（brand `qt  ` 是 mov；HEIF／AVIF 系列的 brand 不是影片 → null）；
 * `1A45DFA3` → webm。`declared` 是宣告的 MIME：空的或 octet-stream 不限制；有宣告時必須是同一族（ftyp：mp4／quicktime；
 * EBML：webm），否則 null（與 lab 版相同）。與 lab 版不同：mp4／mov 由 brand 決定，不照抄宣告。
 * lab 版有 25 MiB 上限並要求整檔；這裡只需要檔頭（前 12 B 以上），所以大檔也能判斷。
 */
export function detectSupportedVideoMime(head, declared = '') {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head);
  const type = String(declared || '').split(';')[0].trim().toLowerCase();
  const generic = !type || type === 'application/octet-stream';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (isUnsupportedVideoBrand(brand)) return null;
    // the type comes from the content (the extension follows it); a declaration only has to be one of the ftyp family
    return generic || type === 'video/mp4' || type === 'video/quicktime' ? (brand === 'qt  ' ? 'video/quicktime' : 'video/mp4') : null;
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return generic || type === 'video/webm' ? 'video/webm' : null;
  return null;
}

// ───────────────────────── X2a：ledger v2（implementation-plan-v2.md X2a；history-download.md §5.1、§5.3） ─────────────────────────
//
// 主鍵是 `owner + stem`（owner = sha256(帳號 mid)，與 v1 的 ownerKey 相同；stem = mediaCacheStem('i:' + 訊息 id)）。即時接收、
// 歷史下載、回填、outbound 共用同一筆紀錄：第一個寫入的 origin 留在紀錄上，之後的 origin 不會再開一筆。
// 每筆欄位：{owner, stem, origin, kind, state, class, code, attempts, nextAt, bytesDone, declaredBytes, sessionId?, fingerprint,
//          partName?, createdAt, updatedAt}。keyMaterial 永遠不進 ledger。
//   - state：queued | running | paused | done | failed。
//   - 終態的負面紀錄：`expired`，以及 code 不是 SIZE_MISMATCH 的 `undecryptable`。上限 MEDIA_LEDGER_TERMINAL_MAX（20 000）筆，超過就丟
//     最舊的（依最後更新順序）。SIZE_MISMATCH 依 X1b L-2 的裁決不是永久終態（非 E2EE 的大小不符可能是宣告錯，之後可以再試）。
//   - `forbidden` 綁 sessionId：只對同一個 session 是終態；換 session 就失效。
//   - fingerprint = sha256(oid + "\0" + sid) 前 16 碼。查詢時帶入目前的 fingerprint，不同就代表訊息列的 OID／SID 變了，終態失效（刪除該筆）。
//   - 讀得進 v1（auto-download-ledger.json，version 1）：v2 檔不存在時從 v1 匯入，v1 檔本身不動。
//   - 耐久與復原（review-x2a F-4）：flush 先 fsync 暫存檔再 rename；載入時 v2 檔是空的或解析不了（含不是 JSON 物件）→ 原檔改名為
//     `media-ledger.json.corrupt-<ms>`，以空 ledger 開始（不再匯入 v1，並立刻寫出空的 v2），log 一行只有 code；v1 檔壞掉 → 不匯入、不改它，
//     同樣只 log code。不認得的版本（例如 3）仍然丟錯：那是較新的格式，不能當成損毀蓋掉。載入時清掉崩潰留下的 `media-ledger.json.<uuid>.part`。

export const MEDIA_LEDGER_NAME = 'media-ledger.json';
export const MEDIA_LEDGER_V1_NAME = LEDGER_NAME;
export const MEDIA_LEDGER_TERMINAL_MAX = 20000;
/** 可重試的失敗（transient、SIZE_MISMATCH 等）之後手動重試的冷卻時間（HD §5.1）。 */
export const MEDIA_LEDGER_RETRY_COOLDOWN_MS = 30000;
const LEDGER_STATES = new Set(['queued', 'running', 'paused', 'done', 'failed']);
const LEDGER_ORIGINS = new Set(['history', 'receive', 'outbound', 'backfill']);
const LEDGER_KINDS = new Set(['IMAGE', 'VIDEO', 'FILE']);
const STEM_RE = /^[0-9a-f]{32}$/;
const OWNER_RE = /^(?:[0-9a-f]{64}|unassigned)$/;
const LEDGER_TEMP_RE = /^media-ledger\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;

/** ledger 檔的文字 → JSON 物件；空的、解析不了、不是物件（null、陣列、數字…）→ null。 */
function parseLedgerDoc(text) {
  if (!String(text).trim()) return null;
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
}

/** 與 media.ts mediaCacheStem 相同：sha256(msgId) 前 32 碼 hex（msgId 含 `i:` 前綴）。 */
export function mediaStem(msgId) { return createHash('sha256').update(String(msgId), 'utf8').digest('hex').slice(0, 32); }
/** 帳號 → ledger owner（與 v1 AutoDownloadStore.setOwner 相同）。 */
export function ledgerOwner(accountId) { return digest(String(accountId || 'unknown-account')); }
/** 訊息列 OID／SID 的指紋：sha256(oid + "\0" + sid) 前 16 碼。 */
export function ledgerFingerprint(oid, sid) { return createHash('sha256').update(`${oid ?? ''}\0${sid ?? ''}`, 'utf8').digest('hex').slice(0, 16); }

/** 永久終態的負面紀錄（佔 20 000 上限）：expired，或 SIZE_MISMATCH 以外的 undecryptable。 */
export function isTerminalNegative(entry) {
  if (!entry || entry.state !== 'failed') return false;
  if (entry.class === 'expired') return true;
  return entry.class === 'undecryptable' && entry.code !== 'SIZE_MISMATCH';
}

/** 這筆紀錄在目前的 session／指紋下是否擋住新的請求（本地短路，HD §5.3）。 */
export function ledgerBlocks(entry, { sessionId = null } = {}) {
  if (isTerminalNegative(entry)) return true;
  return Boolean(entry && entry.state === 'failed' && entry.class === 'forbidden' && entry.sessionId && entry.sessionId === sessionId);
}

export class MediaLedger {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.file = path.join(dir, MEDIA_LEDGER_NAME);
    this.v1File = path.join(dir, MEDIA_LEDGER_V1_NAME);
    this.now = options.now || Date.now;
    this.terminalMax = options.terminalMax || MEDIA_LEDGER_TERMINAL_MAX;
    this.entries = new Map();
    this.terminalCount = 0;
    this.flushChain = Promise.resolve();
    this.migratedFromV1 = 0;
    /** 損毀復原的 log（一行只有 code，不含路徑或內容）。 */
    this.log = options.log || ((line) => console.warn(line));
    /** 上一次 load 把損毀的 v2 檔改名成的檔名（沒有就是 null）。 */
    this.quarantined = null;
  }

  key(owner, stem) { return `${owner}\0${stem}`; }

  /**
   * 讀 v2；沒有 v2 檔時匯入 v1（v1 檔不改）。v2 檔空的或解析不了 → 改名為 `.corrupt-<ms>`、以空 ledger 開始（F-4）。
   * 不認得的版本 → 丟錯（較新的格式，不蓋掉）。先清掉崩潰留下的暫存檔。
   */
  async load() {
    await this.flushChain;
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir)) if (LEDGER_TEMP_RE.test(name)) await unlink(path.join(this.dir, name)).catch(() => {});
    this.quarantined = null;
    let doc = null;
    let text = null;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let recovered = false;
    if (text !== null) {
      doc = parseLedgerDoc(text);
      if (doc === null) {
        const code = String(text).trim() ? 'LEDGER_CORRUPT' : 'LEDGER_EMPTY';
        this.quarantined = `${MEDIA_LEDGER_NAME}.corrupt-${this.now()}`;
        await rename(this.file, path.join(this.dir, this.quarantined));
        this.log(`code=${code}`);
        recovered = true;
      }
    } else {
      let v1 = null;
      try { v1 = await readFile(this.v1File, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (v1 !== null) { doc = parseLedgerDoc(v1); if (doc === null) this.log('code=LEDGER_V1_CORRUPT'); }
    }
    this.entries.clear();
    this.terminalCount = 0;
    // start empty and say so on disk at once: otherwise the next start would import v1 again
    if (recovered) { await this.flush(); return this.counts(); }
    if (doc === null) return this.counts();
    if (doc.version === 2) { for (const raw of Array.isArray(doc.items) ? doc.items : []) { const entry = normalizeV2(raw); if (entry) this.put(entry); } }
    else if (doc.version === 1 || doc.version === undefined) { for (const raw of Array.isArray(doc.items) ? doc.items : []) { const entry = fromV1(raw, this.now()); if (entry && !this.entries.has(this.key(entry.owner, entry.stem))) { this.put(entry); this.migratedFromV1++; } } }
    else throw Object.assign(new Error('ledger 版本不支援'), { code: 'LEDGER_VERSION' });
    this.evict();
    return this.counts();
  }

  /** 放入（移到最新）並維護終態計數。 */
  put(entry) {
    const key = this.key(entry.owner, entry.stem);
    const previous = this.entries.get(key);
    if (previous) { if (isTerminalNegative(previous)) this.terminalCount--; this.entries.delete(key); }
    this.entries.set(key, entry);
    if (isTerminalNegative(entry)) this.terminalCount++;
    return entry;
  }

  remove(owner, stem) {
    const key = this.key(owner, stem);
    const previous = this.entries.get(key);
    if (!previous) return false;
    if (isTerminalNegative(previous)) this.terminalCount--;
    return this.entries.delete(key);
  }

  /** 終態負面紀錄超過上限 → 從最舊的開始丟（只丟終態負面紀錄）。 */
  evict() {
    if (this.terminalCount <= this.terminalMax) return 0;
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (this.terminalCount <= this.terminalMax) break;
      if (!isTerminalNegative(entry)) continue;
      this.entries.delete(key);
      this.terminalCount--;
      dropped++;
    }
    return dropped;
  }

  /**
   * 查一筆。帶 `fingerprint` 時：該筆的 fingerprint 不同（訊息列的 OID／SID 變了）→ 終態失效，刪除並回 null。
   * `forbidden` 只在同一個 sessionId 下有效（由 ledgerBlocks 判斷，這裡不刪）。
   */
  get(owner, stem, { fingerprint } = {}) {
    const entry = this.entries.get(this.key(owner, stem)) ?? null;
    if (!entry) return null;
    if (fingerprint !== undefined && entry.fingerprint !== null && entry.fingerprint !== fingerprint && (isTerminalNegative(entry) || entry.class === 'forbidden')) { this.remove(owner, stem); return null; }
    return entry;
  }

  /**
   * 開一筆或沿用既有的一筆（同一個 owner + stem 只有一筆；第一個 origin 留下）。終態的負面紀錄不會被 begin 改掉
   * （呼叫端先用 get + ledgerBlocks 短路；指紋改變時 get 已經刪掉它）。
   */
  begin(owner, stem, { origin, kind, declaredBytes = null, fingerprint = null, sessionId } = {}) {
    if (!OWNER_RE.test(String(owner)) || !STEM_RE.test(String(stem))) throw Object.assign(new Error('ledger 主鍵無效'), { code: 'LEDGER_KEY_INVALID' });
    if (!LEDGER_ORIGINS.has(origin) || !LEDGER_KINDS.has(kind)) throw Object.assign(new Error('ledger 欄位無效'), { code: 'LEDGER_FIELD_INVALID' });
    const now = this.now();
    const existing = this.entries.get(this.key(owner, stem));
    if (existing && isTerminalNegative(existing)) return existing;
    const entry = existing ? { ...existing } : { owner, stem, origin, kind, state: 'queued', class: null, code: null, attempts: 0, nextAt: null, bytesDone: 0, declaredBytes: null, fingerprint: null, createdAt: now, updatedAt: now };
    if (Number.isSafeInteger(declaredBytes) && declaredBytes >= 0) entry.declaredBytes = declaredBytes;
    if (typeof fingerprint === 'string' && /^[0-9a-f]{16}$/.test(fingerprint)) entry.fingerprint = fingerprint;
    if (typeof sessionId === 'string' && sessionId) entry.sessionId = sessionId;
    // begin is called only when the file is not on disk (callers short-circuit on the file first): a stale done goes back to queued
    if (entry.state !== 'running') entry.state = 'queued';
    entry.updatedAt = now;
    return this.put(entry);
  }

  /** 進行中（part 名稱給續傳用）。 */
  running(owner, stem, { partName, sessionId } = {}) {
    const entry = this.entries.get(this.key(owner, stem));
    if (!entry || isTerminalNegative(entry)) return entry ?? null;
    const next = { ...entry, state: 'running', updatedAt: this.now() };
    if (typeof partName === 'string' && /^\.[0-9a-f]{32}\.[0-9a-f-]{36}\.part$/.test(partName)) next.partName = partName;
    if (typeof sessionId === 'string' && sessionId) next.sessionId = sessionId;
    return this.put(next);
  }

  /**
   * 記下一次 streamDownload 的結果（X1 的 Outcome）。
   *   - done：state done，清掉 class／code／nextAt／partName。
   *   - paused：state paused，不消耗次數；有 retryAfterMs 就記 nextAt。
   *   - failed：attempts + 1。終態（expired、非 SIZE_MISMATCH 的 undecryptable、forbidden 綁 session）沒有 nextAt；
   *     其他（transient、SIZE_MISMATCH、unsupported…）nextAt = now + 冷卻。
   */
  record(owner, stem, outcome, { sessionId, bytesDone } = {}) {
    const entry = this.entries.get(this.key(owner, stem));
    if (!entry) return null;
    const now = this.now();
    const next = { ...entry, updatedAt: now };
    if (Number.isSafeInteger(bytesDone) && bytesDone >= 0) next.bytesDone = bytesDone;
    if (outcome?.status === 'done') {
      Object.assign(next, { state: 'done', class: null, code: null, nextAt: null, bytesDone: Number.isSafeInteger(outcome.bytes) ? outcome.bytes : next.bytesDone });
      delete next.partName;
    } else if (outcome?.status === 'paused') {
      Object.assign(next, { state: 'paused', class: String(outcome.class), code: String(outcome.code).slice(0, 64), nextAt: Number.isFinite(outcome.retryAfterMs) ? now + outcome.retryAfterMs : null });
    } else if (outcome?.status === 'failed') {
      Object.assign(next, { state: 'failed', class: String(outcome.class), code: String(outcome.code).slice(0, 64), attempts: (entry.attempts || 0) + 1 });
      if (next.class === 'forbidden' && typeof sessionId === 'string' && sessionId) next.sessionId = sessionId;
      const terminal = isTerminalNegative(next) || next.class === 'forbidden';
      next.nextAt = terminal ? null : now + MEDIA_LEDGER_RETRY_COOLDOWN_MS;
      if (terminal) delete next.partName;
    } else throw Object.assign(new Error('結果無法辨識'), { code: 'LEDGER_OUTCOME_INVALID' });
    this.put(next);
    this.evict();
    return next;
  }

  counts() {
    let queued = 0, running = 0, paused = 0, done = 0, failed = 0;
    for (const e of this.entries.values()) { if (e.state === 'queued') queued++; else if (e.state === 'running') running++; else if (e.state === 'paused') paused++; else if (e.state === 'done') done++; else if (e.state === 'failed') failed++; }
    return { total: this.entries.size, queued, running, paused, done, failed, terminalNegative: this.terminalCount, migratedFromV1: this.migratedFromV1 };
  }

  /** 原子寫入（part → fsync → rename，0600）；串行化。running 存檔時維持 running，載入時再轉回 queued。 */
  async flush() {
    const commit = this.flushChain.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const temp = `${this.file}.${randomUUID()}.part`;
      await writeFileDurable(temp, JSON.stringify({ version: 2, items: [...this.entries.values()] }));
      try { await rename(temp, this.file); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
    });
    this.flushChain = commit.catch(() => {});
    return commit;
  }
}

/** v2 檔裡的一筆 → 驗證過的 entry（欄位不合格回 null）；running 載入時轉回 queued（行程已經不在了）。 */
function normalizeV2(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!OWNER_RE.test(String(raw.owner)) || !STEM_RE.test(String(raw.stem)) || !LEDGER_ORIGINS.has(raw.origin) || !LEDGER_KINDS.has(raw.kind) || !LEDGER_STATES.has(raw.state)) return null;
  const num = (v, fallback = null) => (Number.isSafeInteger(v) && v >= 0 ? v : fallback);
  const entry = {
    owner: raw.owner, stem: raw.stem, origin: raw.origin, kind: raw.kind, state: raw.state === 'running' ? 'queued' : raw.state,
    class: typeof raw.class === 'string' ? raw.class : null, code: typeof raw.code === 'string' ? raw.code.slice(0, 64) : null,
    attempts: num(raw.attempts, 0), nextAt: num(raw.nextAt), bytesDone: num(raw.bytesDone, 0), declaredBytes: num(raw.declaredBytes),
    fingerprint: typeof raw.fingerprint === 'string' && /^[0-9a-f]{16}$/.test(raw.fingerprint) ? raw.fingerprint : null,
    createdAt: num(raw.createdAt, 0), updatedAt: num(raw.updatedAt, 0),
  };
  if (typeof raw.sessionId === 'string' && raw.sessionId) entry.sessionId = raw.sessionId.slice(0, 64);
  if (typeof raw.partName === 'string' && /^\.[0-9a-f]{32}\.[0-9a-f-]{36}\.part$/.test(raw.partName)) entry.partName = raw.partName;
  return entry;
}

/**
 * v1 的一筆（AutoDownloadStore：key = ownerKey\0chatId\0messageId\0kind）→ v2。v1 只有即時接收（origin receive），沒有分類：
 * completed → done（code V1_COMPLETED：原檔在舊的 .teamuq 樹，X4 回填）；failed → failed／transient（不是終態）；其餘 → queued。
 */
function fromV1(raw, now) {
  if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string') return null;
  const owner = raw.key.split('\0')[0];
  const messageId = String(raw.messageId ?? '');
  if (!OWNER_RE.test(owner) || !/^\d{1,32}$/.test(messageId) || !LEDGER_KINDS.has(raw.kind)) return null;
  const num = (v, fallback = null) => (Number.isSafeInteger(v) && v >= 0 ? v : fallback);
  const state = raw.status === 'completed' ? 'done' : raw.status === 'failed' ? 'failed' : 'queued';
  return {
    owner, stem: mediaStem(`i:${messageId}`), origin: 'receive', kind: raw.kind, state,
    class: state === 'failed' ? 'transient' : null,
    code: state === 'done' ? 'V1_COMPLETED' : state === 'failed' ? String(raw.errorCode || 'V1_FAILED').slice(0, 64) : null,
    attempts: num(raw.attempts, 0), nextAt: null, bytesDone: state === 'done' ? num(raw.bytes, 0) : 0, declaredBytes: num(raw.metadata?.declaredBytes),
    fingerprint: null, createdAt: num(raw.createdAt, now), updatedAt: num(raw.updatedAt, now),
  };
}
