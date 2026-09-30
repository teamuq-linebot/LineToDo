/**
 * psHost.ts — LineUiPortV3 的實作：常駐 PowerShell 5.1 helper（design-v1 §2.3／§2.5、design-v3 §8.2）。
 *
 * - spawn：%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe（絕對路徑，避免 PATH 劫持）
 *   -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <line-uia-host.ps1>，windowsHide。
 * - 協定：JSON Lines over stdio（UTF-8）；送出的 JSON 把非 ASCII 字元一律跳脫成 \uXXXX。
 * - 每個指令有 TS 端逾時；逾時 → kill helper（之後的呼叫會拋 PortTimeoutError／重新 spawn）。
 * - 閒置 5 分鐘自動關閉。
 * - activateLine、focusEdit 之前先 AllowSetForegroundWindow(helperPid)（design-v2 §2.2）。
 * - helper 在守門指令開始等安靜期時，會先送一行 { id, event:'waitingForQuiet' }（不是回應），轉給 onQuietWait 的 listener。
 * 本檔只負責傳輸與逾時，不判斷聊天室對不對。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import {
  HOST_TIMEOUTS_MS,
  PortCommandError,
  PortTimeoutError,
  PortUnavailableError,
  type AnchorReport,
  type EditState,
  type GuardedRow,
  type HostCommandV3,
  type HostEvent,
  type HostHello,
  type HostResponse,
  type LineLocateV3,
  type LineUiPortV3,
  type ListSnapshot,
  type PortResult,
  type PortTelemetry,
  type QuietGuardedCommand,
  type QuietSpec,
  type QuietWaitListener,
  type RowOcrConfig,
  type TitleOcrConfig,
  type TitleReadings
} from './port'

export interface PsHostOptions {
  /** line-uia-host.ps1 的絕對路徑。 */
  scriptPath: string
  /** main 的 AllowSetForegroundWindow（foreground.ts）；省略時不呼叫。 */
  allowSetForeground?: (pid: number) => boolean
  /** 閒置多久自動關閉 helper（ms），預設 5 分鐘。 */
  idleMs?: number
  /** 只記錄技術事件（不含 OCR 原文、名稱、草稿）。 */
  log?: (line: string) => void
  powershellPath?: string
}

export interface PsHost extends LineUiPortV3 {
  helperPid(): number | null
}

function asciiJson(o: unknown): string {
  return JSON.stringify(o).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

interface Pending {
  cmd: string
  resolve: (r: HostResponse) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export function createPsHost(opts: PsHostOptions): PsHost {
  const psPath =
    opts.powershellPath ?? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const idleMs = opts.idleMs ?? 5 * 60 * 1000
  const log = opts.log ?? (() => {})
  let proc: ChildProcessWithoutNullStreams | null = null
  let helloMsg: HostHello | null = null
  let starting: Promise<HostHello> | null = null
  let nextId = 1
  const pending = new Map<number, Pending>()
  let idleTimer: NodeJS.Timeout | null = null
  let activity = false
  const quietWaitMs: PortTelemetry['quietWaitMs'] = {}
  let quietListener: QuietWaitListener | null = null
  const QUIET_CMDS = new Set<string>(['activateLine', 'guardedClick', 'setEdit'])

  const killProc = (why: string): void => {
    const p = proc
    proc = null
    helloMsg = null
    starting = null
    if (p) {
      try {
        p.kill()
      } catch {
        // ignore
      }
    }
    for (const [id, pd] of pending) {
      clearTimeout(pd.timer)
      pd.reject(new PortUnavailableError(`helper_exited:${why}`))
      pending.delete(id)
    }
  }

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      void dispose()
    }, idleMs)
    idleTimer.unref?.()
  }

  const start = (): Promise<HostHello> => {
    if (helloMsg && proc) return Promise.resolve(helloMsg)
    if (starting) return starting
    starting = new Promise<HostHello>((resolve, reject) => {
      let settled = false
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(psPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', opts.scriptPath], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (e) {
        starting = null
        reject(new PortUnavailableError('spawn_failed'))
        return
      }
      proc = child
      let buf = ''
      let stderrLen = 0
      const helloTimer = setTimeout(() => {
        if (settled) return
        settled = true
        log('[driver-host] hello timeout')
        killProc('hello_timeout')
        reject(new PortUnavailableError('hello_timeout'))
      }, HOST_TIMEOUTS_MS.spawnAndHello)
      child.stderr.on('data', (d: Buffer) => {
        stderrLen += d.length // 內容可能含路徑；只記長度
      })
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf8')
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '')
          buf = buf.slice(i + 1)
          if (!line.trim()) continue
          let msg: HostResponse
          try {
            msg = JSON.parse(line) as HostResponse
          } catch {
            continue
          }
          if ((msg as unknown as HostEvent).event === 'waitingForQuiet') {
            // 中途事件：不結束 pending。只轉發給正在等待的守門指令。
            const ev = msg as unknown as HostEvent
            const pd = pending.get(ev.id)
            if (pd && QUIET_CMDS.has(pd.cmd) && quietListener) {
              try {
                quietListener({ command: pd.cmd as QuietGuardedCommand, maxWaitMs: Number(ev.maxWaitMs) || 0 })
              } catch {
                // listener 的錯誤不影響傳輸
              }
            }
            continue
          }
          if (msg.id === 0 && msg.ok && !settled) {
            settled = true
            clearTimeout(helloTimer)
            helloMsg = msg.result as HostHello
            resolve(helloMsg)
            continue
          }
          const p = pending.get(msg.id)
          if (p) {
            pending.delete(msg.id)
            clearTimeout(p.timer)
            p.resolve(msg)
          }
        }
      })
      child.on('error', () => {
        if (!settled) {
          settled = true
          clearTimeout(helloTimer)
          reject(new PortUnavailableError('spawn_error'))
        }
        if (proc === child) killProc('error')
      })
      child.on('exit', (code) => {
        log(`[driver-host] helper exited code=${code} stderrBytes=${stderrLen}`)
        if (!settled) {
          settled = true
          clearTimeout(helloTimer)
          reject(new PortUnavailableError('exited_before_hello'))
        }
        if (proc === child) killProc('exit')
      })
    })
    return starting
  }

  async function raw(cmd: HostCommandV3, args: Record<string, unknown> = {}, timeoutMs: number = HOST_TIMEOUTS_MS.default): Promise<HostResponse> {
    await start()
    const p = proc
    if (!p) throw new PortUnavailableError('no_process')
    const id = nextId++
    const res = await new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        log(`[driver-host] timeout cmd=${cmd}`)
        killProc('timeout')
        reject(new PortTimeoutError(cmd))
      }, timeoutMs)
      pending.set(id, { cmd, resolve, reject, timer })
      try {
        p.stdin.write(asciiJson({ id, cmd, args }) + '\n')
      } catch {
        clearTimeout(timer)
        pending.delete(id)
        reject(new PortUnavailableError('write_failed'))
      }
    })
    activity = activity || !!res.activity
    if ('quietWaitMs' in res && typeof res.quietWaitMs === 'number' && (cmd === 'activateLine' || cmd === 'guardedClick' || cmd === 'setEdit')) {
      quietWaitMs[cmd] = res.quietWaitMs
    }
    armIdle()
    return res
  }

  /** 例外 → 拋 PortCommandError；拒絕 → PortResult；成功 → PortResult。 */
  async function call<T>(cmd: HostCommandV3, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<PortResult<T>> {
    const res = await raw(cmd, args, timeoutMs)
    if (res.ok) return { ok: true, value: res.result as T }
    if ('refusal' in res) return { ok: false, refusal: res.refusal, detail: res.detail }
    throw new PortCommandError(cmd, res.error)
  }

  /** 沒有拒絕路徑的指令：拒絕也當例外。 */
  async function must<T>(cmd: HostCommandV3, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const r = await call<T>(cmd, args, timeoutMs)
    if (!r.ok) throw new PortCommandError(cmd, r.refusal)
    return r.value
  }

  const allow = (): void => {
    const pid = proc?.pid
    if (pid && opts.allowSetForeground) opts.allowSetForeground(pid)
  }

  async function dispose(): Promise<void> {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (!proc) return
    try {
      await Promise.race([raw('shutdown', {}, 1500), new Promise((r) => setTimeout(r, 1500))])
    } catch {
      // ignore
    }
    killProc('dispose')
  }

  return {
    helperPid: () => proc?.pid ?? null,
    hello: () => start(),
    async beginSession() {
      activity = false
      for (const k of Object.keys(quietWaitMs)) delete quietWaitMs[k as keyof typeof quietWaitMs]
      await must('beginSession')
    },
    async endSession() {
      await must('endSession')
    },
    async locateLine(): Promise<LineLocateV3> {
      const r = await must<{ status: string; pid?: number; count?: number; iconic?: boolean; exeVersion?: string | null; otherTopLevel?: string[] }>('locateLine')
      if (r.status === 'ok') {
        return { status: 'ok', pid: Number(r.pid), iconic: !!r.iconic, exeVersion: r.exeVersion ?? null, otherTopLevel: Array.isArray(r.otherTopLevel) ? r.otherTopLevel : [] }
      }
      if (r.status === 'no_window') return { status: 'no_window', pid: Number(r.pid) }
      if (r.status === 'multiple_windows') return { status: 'multiple_windows', pid: Number(r.pid), count: Number(r.count) }
      return { status: 'not_running' }
    },
    probeAnchors: () => must<AnchorReport>('probeAnchors'),
    async readSearch() {
      const r = await must<{ value: string }>('readSearch')
      return String(r.value ?? '')
    },
    readList: (o: { configs: readonly RowOcrConfig[] }) => call<ListSnapshot>('readList', { configs: [...o.configs] }, HOST_TIMEOUTS_MS.readList),
    readListGeometry: () => call<ListSnapshot>('readListGeometry', {}, HOST_TIMEOUTS_MS.readListGeometry),
    readTitle: (o: { configs: readonly TitleOcrConfig[] }) => call<TitleReadings>('readTitle', { configs: [...o.configs] }, HOST_TIMEOUTS_MS.readTitle),
    async activateLine(o: { restore: boolean; quiet: QuietSpec }) {
      await start()
      allow()
      return call<{ foreground: boolean }>('activateLine', { restore: o.restore, quiet: o.quiet }, HOST_TIMEOUTS_MS.guarded)
    },
    guardedClick: (a: { row: GuardedRow; windowRows: GuardedRow[]; quiet: QuietSpec; dryRun?: boolean }) =>
      call<{ clicked: boolean; selectedIndexAfter: number | null }>('guardedClick', { row: a.row, windowRows: a.windowRows, quiet: a.quiet, dryRun: !!a.dryRun }, HOST_TIMEOUTS_MS.guarded),
    waitTitleStable: () => call<{ stripHash: string }>('waitTitleStable', {}, HOST_TIMEOUTS_MS.waitTitleStable),
    readEdit: () => call<EditState>('readEdit'),
    setEdit: (text: string, approvedTitleHash: string, quiet: QuietSpec) =>
      call<{ readback: string }>('setEdit', { text, titleHash: approvedTitleHash, quiet }, HOST_TIMEOUTS_MS.guarded),
    clearEditIfEquals: (expectCurrent: string, approvedTitleHash: string) =>
      call<{ cleared: true }>('clearEditIfEquals', { expect: expectCurrent, titleHash: approvedTitleHash }),
    async focusEdit(approvedTitleHash: string, quiet: QuietSpec) {
      await start()
      allow()
      // helper 會先等安靜期（最多 quiet.maxWaitMs），逾時要把等待時間算進去。
      return call<{ focused: true }>('focusEdit', { titleHash: approvedTitleHash, quiet }, HOST_TIMEOUTS_MS.guarded)
    },
    handBackFocus: (hwnd: bigint) => call<{ handedBack: boolean }>('handBackFocus', { hwnd: hwnd.toString() }),
    telemetry: () => ({ activity, quietWaitMs: { ...quietWaitMs } }),
    onQuietWait: (listener: QuietWaitListener | null) => {
      quietListener = listener
    },
    dispose
  }
}
