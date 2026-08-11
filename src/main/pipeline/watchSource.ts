import type { RawLineMessage } from '../line/types'
import type { LineBridge } from '../db/pipeline.repo'

/**
 * watchSource.ts — pipeline runOnce 的「取本輪新訊息」來源（IMPLEMENTATION_PLAN.md §8 步驟 2）。
 *
 * dbDrainSource：回空 batch + bridge='skipped'。用於「live LineWatcher 已把訊息鏡像進 DB」
 * 的架構（本 App 現況）—— runOnce 只需處理 DB 中未處理列，不必再自行取一次訊息（避免兩個
 * 消費者搶 checkpoint，與 §3「checkpoint 獨立」精神一致）。
 */

export interface WatchSourceResult {
  messages: RawLineMessage[]
  bridge: LineBridge
  error?: string
}

/** live watcher 已餵 DB 的架構：pipeline 不另取訊息，直接吃 DB 未處理列。 */
export async function dbDrainSource(): Promise<WatchSourceResult> {
  return { messages: [], bridge: 'skipped' }
}
