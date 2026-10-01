import type { BackfillProgress } from '../../types/api'

/** Keep only the newest background progress event and publish it at most once per frame. */
export function createProgressFrameCoalescer(
  requestFrame: (callback: () => void) => number,
  cancelFrame: (id: number) => void,
  publish: (progress: BackfillProgress) => void
): { push: (progress: BackfillProgress) => void; dispose: () => void } {
  let frameId = 0
  let latest: BackfillProgress | null = null
  let active = true

  return {
    push(progress) {
      if (!active) return
      latest = progress
      if (frameId !== 0) return
      frameId = requestFrame(() => {
        frameId = 0
        const value = latest
        latest = null
        if (active && value) publish(value)
      })
    },
    dispose() {
      active = false
      latest = null
      if (frameId !== 0) cancelFrame(frameId)
      frameId = 0
    }
  }
}
