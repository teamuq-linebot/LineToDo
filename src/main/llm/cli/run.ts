import { execFile, spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import { ERR_CLI_UNSAFE_ARG } from './errors'
import { invalidateCliCache, isBatchPath, locateCli, locateCliOrThrow } from './locate'
import type { LocateDeps } from './locate'
import type { CliLocation, CliName, CliRunOptions, CliRunResult } from './types'

/**
 * cli/run.ts — spawn / stdin / 逾時 / kill 的共用實作（design.md §2.3 / §2.4，Batch 2）。
 *
 * 全部設計決策都來自 spike-results.md 的實測，與原設計衝突處以實測為準：
 *
 * 1. **`.cmd` / `.bat` 一律走 `cmd.exe /c`，絕不用 `shell: true`**（§9 A/C：直接 spawn 會 EINVAL）。
 *    `shell: true` 等於自己處理引號，等於自己製造跳脫 bug 與 injection。
 * 2. **EINVAL 是同步 throw、不是 `error` 事件**（§9-1）。所以 `spawn()` 一定要包 try/catch，
 *    只掛 `.on('error')` 會讓 main 進程直接崩。
 * 3. **`cmd.exe /c` 傳遞含 `& ^ | < > " %` 的路徑或參數一定壞**（§9 G/H/I），
 *    而且是「壞得很安靜」（cmd 把後半段當另一條指令）。→ 前置檢查擋下並明確報錯。
 * 4. **kill 的 exit code 不是 143**（§10）：原生 exe 回 `code=null, signal='SIGTERM'`，
 *    taskkill 掉的 cmd 樹回 `code=1`。→ 只信自己的 `timedOut` 旗標。
 * 5. **`cmd.exe → node → codex` 三層被 `child.kill()` 殺會留兩個孤兒，且 `close` 事件永不觸發**（§10）。
 *    → win32 一律 `taskkill /T /F`，而且 kill 之後**必掛寬限計時器**，
 *    到期就自行 resolve，不能因為等不到 close 就永遠掛著。
 * 6. **stdin 一定要 `end()`**（§8）：不關的話 claude 會等 3 秒然後直接失敗。
 * 7. `windowsHide: true`：否則打包後每次呼叫都閃一個主控台視窗。
 */

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_KILL_GRACE_MS = 1500
const TASKKILL_TIMEOUT_MS = 5000

/** cmd.exe 會自行解析 / 展開的字元。出現在路徑或任一參數都會壞（spike §9）。 */
const CMD_UNSAFE_RE = /[&^|<>"%]/

/**
 * 回傳有問題的參數**索引**（0 = exePath，1 以後為 args）。
 * 刻意只回索引不回內容——參數可能含 prompt 片段（隱私，見 redact.ts）。
 */
export function findCmdUnsafeIndexes(parts: readonly string[]): number[] {
  const bad: number[] = []
  parts.forEach((part, index) => {
    if (CMD_UNSAFE_RE.test(part)) bad.push(index)
  })
  return bad
}

/**
 * 殺整棵樹。win32 一律 `taskkill /T /F`——`child.kill()` 在 `cmd.exe → node → codex`
 * 三層下會留孤兒（spike §10）。非同步發射不等結果：進程可能已自行結束（taskkill 回 128），
 * 那不是錯誤；真正的收尾靠 runCli 的寬限計時器。
 */
export function killTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已結束 */
    }
    return
  }
  try {
    execFile(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
      () => {
        /* 進程可能已不存在；忽略 */
      }
    )
  } catch {
    /* execFile 極少數情況會同步 throw；忽略 */
  }
}

interface Collector {
  push(chunk: Buffer): void
  text(): string
  isTruncated(): boolean
}

function makeCollector(maxBytes: number): Collector {
  const chunks: Buffer[] = []
  let bytes = 0
  let truncated = false
  return {
    push(chunk: Buffer): void {
      if (truncated) return
      const room = maxBytes - bytes
      if (room <= 0) {
        truncated = true
        return
      }
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room))
        bytes = maxBytes
        truncated = true
        return
      }
      chunks.push(chunk)
      bytes += chunk.length
    },
    // 多位元組字元可能被切在 chunk 邊界，所以最後才一次解碼。
    text: () => Buffer.concat(chunks).toString('utf8'),
    isTruncated: () => truncated
  }
}

function toErrno(err: unknown): NodeJS.ErrnoException {
  if (err instanceof Error) return err as NodeJS.ErrnoException
  return new Error(String(err)) as NodeJS.ErrnoException
}

function failedBeforeStart(startedAt: number, spawnError: NodeJS.ErrnoException): CliRunResult {
  return {
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
    killedByUs: false,
    closeTimedOut: false,
    durationMs: Date.now() - startedAt,
    truncated: { stdout: false, stderr: false },
    spawnError
  }
}

/**
 * 跑一次 CLI。**永遠 resolve，永遠不 reject**——所有失敗都以 `spawnError` / `timedOut`
 * 的形式回在結果裡，呼叫端用 `classifyRunFailure()` 統一分類。
 */
export function runCli(opts: CliRunOptions): Promise<CliRunResult> {
  const startedAt = Date.now()
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const batch = isBatchPath(opts.exePath)
  const command = batch ? (process.env.ComSpec ?? 'cmd.exe') : opts.exePath
  const argv = batch ? ['/c', opts.exePath, ...opts.args] : [...opts.args]

  if (batch) {
    const bad = findCmdUnsafeIndexes([opts.exePath, ...opts.args])
    if (bad.length > 0) {
      const err = new Error(
        `cmd.exe 無法安全傳遞含 & ^ | < > " % 的參數（索引 ${bad.join(',')}，0=執行檔路徑）`
      ) as NodeJS.ErrnoException
      err.code = ERR_CLI_UNSAFE_ARG
      return Promise.resolve(failedBeforeStart(startedAt, err))
    }
  }

  return new Promise<CliRunResult>((resolve) => {
    const spawnImpl = opts.spawnImpl ?? nodeSpawn
    let child: ChildProcess
    try {
      child = spawnImpl(command, argv, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      // spike §9-1：.cmd 在 shell:false 下的 EINVAL 走的是這條同步路徑。
      resolve(failedBeforeStart(startedAt, toErrno(err)))
      return
    }

    const stdout = makeCollector(maxBytes)
    const stderr = makeCollector(maxBytes)
    let settled = false
    let timedOut = false
    let aborted = false
    let killedByUs = false
    let closeTimedOut = false
    let timeoutTimer: NodeJS.Timeout | null = null
    let graceTimer: NodeJS.Timeout | null = null

    const onAbort = (): void => {
      aborted = true
      requestKill()
    }

    const clearTimers = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
    }

    /** 放生子程序：close 不會來了，別讓 listener 與 pipe 一直掛著。 */
    const detach = (): void => {
      child.stdout?.removeAllListeners()
      child.stderr?.removeAllListeners()
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.stdin?.destroy()
      child.removeAllListeners()
      child.unref()
    }

    const settle = (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: NodeJS.ErrnoException
    ): void => {
      if (settled) return
      settled = true
      clearTimers()
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        aborted,
        killedByUs,
        closeTimedOut,
        durationMs: Date.now() - startedAt,
        truncated: { stdout: stdout.isTruncated(), stderr: stderr.isTruncated() },
        spawnError
      })
    }

    function requestKill(): void {
      if (settled || killedByUs) return
      killedByUs = true
      if (typeof child.pid === 'number') killTree(child.pid)
      else {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已結束 */
        }
      }
      // ⚠ 這個計時器是「close 事件永不觸發」的唯一防線（spike §10）。
      // 沒有它，逾時的 cmd.exe 三層結構會讓這個 Promise 永遠不 settle，
      // 整條 pipeline 的那一輪就卡死了。
      graceTimer = setTimeout(() => {
        closeTimedOut = true
        detach()
        settle(null, null)
      }, graceMs)
    }

    if (opts.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        requestKill()
      }, opts.timeoutMs)
    }

    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.stdout?.on('error', () => {
      /* 我們 destroy 掉時可能噴 ERR_STREAM_PREMATURE_CLOSE */
    })
    child.stderr?.on('error', () => {
      /* 同上 */
    })

    // 長輸入一律走 stdin；end() 不可省（spike §8）。
    const stdin = child.stdin
    if (stdin) {
      stdin.on('error', () => {
        /* 子程序提前退場 → EPIPE，不是我們的錯 */
      })
      stdin.end(opts.stdin)
    }

    child.on('error', (err) => {
      settle(null, null, toErrno(err))
    })
    child.on('close', (code, signal) => {
      settle(code, signal)
    })
  })
}

export interface RunLocatedCliOptions extends Omit<CliRunOptions, 'exePath'> {
  name: CliName
  /** 設定頁的手動指定路徑（Batch 5 接上）；空字串＝自動偵測。 */
  execPathOverride?: string
  locateDeps?: LocateDeps
}

export interface RunLocatedCliOutcome {
  location: CliLocation
  result: CliRunResult
}

/**
 * 定位 + 執行，並實作 design §3.2 失效時機 3：
 * 拿到 ENOENT（快取指到的檔案被移走／使用者剛裝好 CLI）就清快取、重新定位、重試一次。
 *
 * 定位失敗會 throw `LlmProviderError`；執行失敗仍走 `result.spawnError`。
 */
export async function runLocatedCli(opts: RunLocatedCliOptions): Promise<RunLocatedCliOutcome> {
  const { name, execPathOverride = '', locateDeps, ...runOpts } = opts

  let location = await locateCliOrThrow(name, execPathOverride, locateDeps)
  let result = await runCli({ ...runOpts, exePath: location.path })

  if (result.spawnError?.code === 'ENOENT') {
    invalidateCliCache(name)
    const relocated = await locateCli(name, execPathOverride, locateDeps)
    if (relocated.ok && relocated.location.path !== location.path) {
      location = relocated.location
      result = await runCli({ ...runOpts, exePath: location.path })
    }
  }

  return { location, result }
}
