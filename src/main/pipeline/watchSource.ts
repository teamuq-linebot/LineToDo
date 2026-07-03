import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname } from 'node:path'
import type { RawLineMessage } from '../line/types'
import type { LineBridge } from '../db/pipeline.repo'
import { getLineEngine } from '../config/lineBridge'
import { getNewMessagesOnce } from '../line/engine/watchEngine'

/**
 * watchSource.ts — pipeline runOnce 的「取本輪新訊息」來源（IMPLEMENTATION_PLAN.md §8 步驟 2）。
 *
 * 兩種來源：
 *   1) spawnWatchOnce：spawn watch_json.py --once，逐行解析 NDJSON（符合 §3 / §8）。
 *      適合「pipeline 自己拉訊息」的部署。
 *   2) dbDrainSource：回空 batch + bridge='skipped'。用於「live LineWatcher 已把訊息鏡像進 DB」
 *      的架構（本 App 現況）—— runOnce 只需處理 DB 中未處理列，不必再 spawn 一次（避免兩個
 *      消費者搶 checkpoint，與 §3「checkpoint 獨立」精神一致）。
 */

export interface WatchOnceOptions {
  python: string
  script: string
  limit?: number
  /** spawn 逾時（毫秒），逾時殺子程序並回 error。 */
  timeoutMs?: number
}

export interface WatchSourceResult {
  messages: RawLineMessage[]
  bridge: LineBridge
  error?: string
}

/** live watcher 已餵 DB 的架構：pipeline 不另 spawn，直接吃 DB 未處理列。 */
export async function dbDrainSource(): Promise<WatchSourceResult> {
  return { messages: [], bridge: 'skipped' }
}

/**
 * spawn watch_json.py --once，收集 NDJSON。解析失敗的行記錄但跳過。
 * exit code 2 或 stderr 有 {"error":...} → bridge='error'。
 */
export function spawnWatchOnce(opts: WatchOnceOptions): Promise<WatchSourceResult> {
  const { python, script, limit = 500, timeoutMs = 60_000 } = opts
  // Batch 4b：LINE_ENGINE=ts 走 in-process watchEngine.getNewMessagesOnce（自 checkpoint
  // 取增量，對應舊 spawn --once）；ts 路徑的錯誤以 reject/throw 表達 → 下面 catch 轉成
  // bridge:'error'，與舊 spawn（exit 2 / stderr error → bridge:'error'）語意一致。
  // 未設 / 非 ts → 落到下方原 spawn 路徑不變。
  if (getLineEngine() === 'ts') {
    return getNewMessagesOnce({ limit })
      .then((messages): WatchSourceResult => ({ messages, bridge: 'ok' }))
      .catch(
        (err): WatchSourceResult => ({
          messages: [],
          bridge: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      )
  }
  return new Promise<WatchSourceResult>((resolve) => {
    const messages: RawLineMessage[] = []
    let errored = false
    let errorMsg: string | null = null
    let settled = false

    const finish = (res: WatchSourceResult): void => {
      if (settled) return
      settled = true
      resolve(res)
    }

    let child
    try {
      child = spawn(python, [script, '--once', '--limit', String(limit)], {
        cwd: dirname(script),
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      })
    } catch (err) {
      finish({
        messages: [],
        bridge: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
      return
    }

    const killTimer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already dead */
      }
      finish({ messages, bridge: 'error', error: `watch_json.py 逾時 ${timeoutMs}ms` })
    }, timeoutMs)

    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const t = line.trim()
      if (!t) return
      try {
        const msg = JSON.parse(t) as RawLineMessage
        if (typeof msg.chatId === 'string' && typeof msg.ts === 'number') {
          messages.push(msg)
        }
      } catch {
        /* 非 JSON 行：跳過，不中斷整輪 */
      }
    })

    const errRl = createInterface({ input: child.stderr })
    errRl.on('line', (line) => {
      const t = line.trim()
      if (!t) return
      try {
        const obj = JSON.parse(t) as { error?: string }
        if (obj && typeof obj.error === 'string') {
          errored = true
          errorMsg = obj.error
        }
      } catch {
        /* 非 JSON stderr：忽略 */
      }
    })

    child.on('error', (err) => {
      clearTimeout(killTimer)
      finish({ messages: [], bridge: 'error', error: err.message })
    })

    child.on('exit', (code) => {
      clearTimeout(killTimer)
      rl.close()
      errRl.close()
      if (code === 2 || errored) {
        finish({
          messages,
          bridge: 'error',
          error: errorMsg ?? `watch_json.py exited code ${code}`
        })
        return
      }
      finish({ messages, bridge: 'ok' })
    })
  })
}
