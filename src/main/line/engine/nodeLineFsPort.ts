/**
 * nodeLineFsPort.ts — `LineFsPort` 的 standalone 實作（node:fs + `tasklist`）。
 *
 * 逐字保留 Phase 0 之前 linedb / linekey / watchEngine / media/decrypt 直接呼叫的
 * node:fs API 與參數，standalone 行為不變。外掛 backend 不用這個實作
 * （LINE 目錄被 Node 權限模型擋、child_process 被 self-check 禁止），改注入 koffi 版。
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LineDirEntry, LineFileStat, LineFsPort } from './fsPort'

export interface NodeLineFsPortOptions {
  /** makeTempDir 的根目錄；預設 os.tmpdir()（與原 `mkdtempSync(join(tmpdir(), prefix))` 相同）。 */
  tempRoot?: string
}

/** 解析 `tasklist /FO CSV /NH` 輸出，回所有映像名相符的 PID（對齊 linekey.py:36-47 的 '","' 切法）。 */
export function parseTasklistCsv(out: string, imageName: string): number[] {
  const target = imageName.toLowerCase()
  const pids: number[] = []
  for (const line of out.split(/\r?\n/)) {
    // CSV 格式："LINE.exe","12345","Console",...
    const parts = line.split('","').map((p) => p.replace(/^"|"$/g, ''))
    if (parts.length >= 2 && parts[0].toLowerCase() === target) {
      const pid = parseInt(parts[1].trim(), 10)
      if (Number.isFinite(pid)) pids.push(pid)
    }
  }
  return pids
}

export class NodeLineFsPort implements LineFsPort {
  private readonly tempRoot: string | undefined

  constructor(options: NodeLineFsPortOptions = {}) {
    this.tempRoot = options.tempRoot
  }

  readDir(dir: string): LineDirEntry[] {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }))
  }

  stat(path: string): LineFileStat {
    const st = statSync(path, { bigint: true })
    return { size: Number(st.size), mtimeNs: st.mtimeNs }
  }

  exists(path: string): boolean {
    return existsSync(path)
  }

  readFile(path: string): Buffer {
    return readFileSync(path)
  }

  copyFile(src: string, dst: string): void {
    copyFileSync(src, dst)
  }

  makeTempDir(prefix: string): string {
    // tmpdir() 在呼叫當下解析（與原本每次 mkdtempSync(join(tmpdir(), …)) 相同）。
    return mkdtempSync(join(this.tempRoot ?? tmpdir(), prefix))
  }

  removeDir(dir: string): void {
    rmSync(dir, { recursive: true, force: true })
  }

  ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true })
  }

  readTextFile(path: string): string {
    return readFileSync(path, 'utf8')
  }

  writeTextFile(path: string, data: string): void {
    writeFileSync(path, data, 'utf8')
  }

  renameFile(from: string, to: string): void {
    renameSync(from, to)
  }

  listProcessIds(imageName: string): number[] {
    let out: string
    try {
      out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      })
    } catch {
      return []
    }
    return parseTasklistCsv(out, imageName)
  }
}

export function createNodeLineFsPort(options: NodeLineFsPortOptions = {}): LineFsPort {
  return new NodeLineFsPort(options)
}
