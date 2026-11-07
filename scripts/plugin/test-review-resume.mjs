// Phase 4 repair — reviewLastDays in plugin mode with hundreds of chats under ai:chat's 18 turns/minute (0.2.0: the AI runs in the backend).
//
// Everything runs on a FAKE clock shared by the queue (`now` + `schedule`), the review ledger, the backend's AI port and worker (`ai.clock`) and the mock `context.host.ai`
// (scripts/lib/mock-tuq-ai.mjs: Core 1.7.15 semantics, 20/min window), so a 33-minute review takes a couple of seconds. The consumer of the queue is the REAL ExtractWorker + HostAiPort
// inside the backend; the test only drives the fake clock and the event loop (`makeDriver`) and never touches the queue.
//
//   * ~190 chats (380 turns, below Core's hard cap of 400 turns/hour), 2 day-slices each, 18 turns/min (20/min minus the 2 kept for user actions) -> the review runs > 15 fake minutes and completes (no 15-minute wait cap kills it); progress is visible meanwhile
//   * one chat that alone needs > 15 fake minutes of turns completes (the wait cap is a *stall* cap, not a total-time cap)
//   * the AI goes away mid-review (Codex logged out) -> the review pauses (no mass failure, no 15-minutes-per-chat pile-up), finished chats are kept,
//     "paused, N/M done" is reported; the next review continues and sends only what is left — also across a backend restart (ledger on disk)
//   * ExtractQueue stall semantics, unit level
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULTS } from '../../src/main/config/defaults.ts'
import { openDatabase } from '../../src/main/db/database.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { ExtractQueue } from '../../src/plugin/backend/extractQueue.ts'
import { ReviewCoordinator, ReviewLedger } from '../../src/plugin/backend/reviewRun.ts'
import { LongTaskTracker } from '../../src/plugin/backend/taskStatus.ts'
import { backendMethodFor } from '../../src/shared/pluginWire.ts'
import { createMockTuqAi } from '../lib/mock-tuq-ai.mjs'

const DAY = 24 * 60 * 60 * 1000
const MIN = 60_000
const TURNS_PER_MIN = 18

// ───────────── fake clock ─────────────

function makeClock(start = 50_000_000) {
  let time = start
  let seq = 1
  const timers = new Map()
  const clock = {
    now: () => time,
    /** the ExtractQueue's `schedule` (returns a canceller). */
    schedule(fn, ms) { const id = seq++; timers.set(id, { at: time + ms, fn, tag: 'queue' }); return () => { timers.delete(id) } },
    /** the AI port's / worker's Clock. */
    setTimeout(fn, ms) { const id = seq++; timers.set(id, { at: time + Math.max(0, ms), fn, tag: 'ai' }); return id },
    clearTimeout(id) { timers.delete(id) },
    advanceTo(target) {
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        time = Math.max(time, due[1].at)
        timers.delete(due[0])
        due[1].fn()
      }
      time = Math.max(time, target)
    },
    advance(ms) { clock.advanceTo(time + ms) },
    /** when the next timer is due (null = none). */
    nextAt() { const all = [...timers.values()].map((t) => t.at); return all.length === 0 ? null : Math.min(...all) },
    timers: (tag) => (tag === undefined ? timers.size : [...timers.values()].filter((t) => t.tag === tag).length)
  }
  return clock
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ───────────── fake LINE + backend + the mock host AI ─────────────

function fakeLine(messages) {
  const listeners = new Set()
  let running = false
  return {
    start() { running = true }, stop() { running = false },
    status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    onStatus() { return () => {} },
    getMessagesSince: async () => messages
  }
}

/** `chats` chats, `slices` messages-groups each (one per day, inside the 3-day window: days -2.5, -1.5, -0.5), `perSlice` messages in every group. */
function reviewMessages({ chats, slices = 2, perSlice = 1, base = Date.now() }) {
  const out = []
  const offsets = [-2.5, -0.5, -1.5]
  for (let c = 1; c <= chats; c += 1) {
    for (let s = 0; s < slices; s += 1) {
      for (let k = 0; k < perSlice; k += 1) {
        const ts = base + offsets[s] * DAY + k * 1000
        out.push({ msgId: `c${c}s${s}k${k}`, chat: `客戶${c}`, chatId: `u-${c}`, isGroup: false, ts, time: new Date(ts).toISOString(), direction: 'in', sender: `客戶${c}`, text: `請回覆客戶${c}第${s}天的報價問題（${k}）`, contentType: 0 })
      }
    }
  }
  return out
}

/** What a model would answer for a payload: one todo citing the first new message (the first part of a chat only, to keep the todo count small). */
function modelReply(user) {
  const payload = JSON.parse(user)
  const first = payload.newMessages[0]
  const draftRef = `draft_${first.msgId.replace(/[^a-z0-9_-]/giu, '_')}`
  const candidate = payload.historicalCandidates?.find((item) => item.entityType === 'todo')
  return { importance: 'action', newTodos: [{ draftRef, bucket: 'todo', title: `處理${payload.chat.name}的報價問題 ${first.msgId}`, detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [first.msgId] }], identityDecisions: [{ draftRef, outcome: candidate ? 'update_existing' : 'new', candidateType: candidate ? 'todo' : null, candidateId: candidate?.entityId ?? null, relationKind: null, reasonCode: candidate ? 'same_active_action' : 'insufficient_evidence', confidenceBand: 'high', evidenceMsgIds: [first.msgId] }], resolved: [], updates: [] }
}
const fyiReply = { importance: 'fyi', newTodos: [], identityDecisions: [], resolved: [], updates: [] }
const asReply = (value) => '```json\n' + JSON.stringify(value) + '\n```'

/** A mock `context.host.ai` on the shared fake clock; `turns` = what reached the host, `maxInWindow` = the most turns in any 60 s window. */
function makeHostAi(clock, { reply = (user) => modelReply(user) } = {}) {
  const mock = createMockTuqAi({ now: clock.now, reply: (ctx) => asReply(reply(ctx.user, ctx)) })
  return {
    ...mock,
    turns: () => mock.stats.turns.map((turn) => ({ at: turn.at, user: turn.text, chatId: JSON.parse(turn.text).chat.chatId, msgIds: JSON.parse(turn.text).newMessages.map((m) => m.msgId) })),
    maxInWindow: () => { const at = mock.stats.turns.map((turn) => turn.at); return Math.max(0, ...at.map((start) => at.filter((t) => t >= start && t < start + MIN).length)) }
  }
}

async function startBackend({ dir, messages, clock, extract = {}, line, host, startupDelayMs }) {
  return createPluginBackend({
    pluginId: 'tuqdev.line-todo', version: 'repair', dataDir: dir, line: line ?? fakeLine(messages),
    ...(startupDelayMs === undefined ? {} : { watcher: { startupDelayMs } }),
    extract: { now: clock.now, schedule: clock.schedule, ...extract },
    review: { now: clock.now },
    dispatcher: { softDeadlineMs: 3_600_000 }, // the test awaits the review call itself (no job polling needed)
    ...(host ? { hostAi: host.ai, ai: { clock, worker: { pollIntervalMs: 15_000 } } } : {})
  })
}

function invoker(backend) {
  return async (path, ...args) => {
    const env = await backend.call(backendMethodFor(path), { path, args })
    assert.equal(env.ok, true, `${path}: ${JSON.stringify(env)}`)
    if (env.chunked === true) {
      // results over 64 KiB come back in pieces (what the UI transport does)
      const parts = []
      for (let index = 0; index < env.chunks; index += 1) {
        const piece = await backend.call('result', { path: 'result.chunk', args: [{ resultId: env.resultId, index }] })
        assert.equal(piece.ok, true)
        parts.push(piece.value.data)
      }
      return JSON.parse(parts.join(''))
    }
    return env.value
  }
}

/**
 * Drives the fake clock and the event loop for a backend whose ExtractWorker is the consumer: yields to the event loop so the worker, the AI port and the mock host run,
 * and moves fake time to the next timer only when nothing has changed for a while (a window wait, a backoff, a stall timer). A guard makes a bug fail the test instead of hanging it.
 */
function makeDriver({ clock, backend, host }) {
  const snapshot = () => `${host.stats.completes}|${host.stats.refused.length}|${JSON.stringify(backend.diagnostics().extract)}|${clock.timers()}`
  return {
    async drive(done, { maxSteps = 300_000, onStep } = {}) {
      let idle = 0
      let last = snapshot()
      for (let i = 0; i < maxSteps; i += 1) {
        if (await done()) return i
        await tick(); await tick(); await tick()
        const now = snapshot()
        if (now === last) {
          idle += 1
          if (idle % 3 === 0) await realSleep(1) // let the review's own async work (DB, core) run
          if (idle >= 6) { const next = clock.nextAt(); clock.advanceTo(next ?? clock.now() + 15_000); idle = 0 }
        } else { idle = 0; last = now }
        if (onStep) await onStep(i)
      }
      assert.fail('the clock driver did not reach the goal in time')
    }
  }
}

function trackSettled(promise) {
  const box = { settled: false, value: null, error: null }
  promise.then((value) => { box.settled = true; box.value = value }, (error) => { box.settled = true; box.error = error })
  return box
}

const reviewCall = (backend, days = 3) => backend.call('pipeline', { path: 'pipeline.reviewLastDays', args: [days] })

async function withBackend(options, body) {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-review-'))
  const clock = options.clock ?? makeClock()
  const host = makeHostAi(clock, options.hostOptions)
  let backend = null
  try {
    backend = await startBackend({ dir, clock, ...options, host })
    await body({ backend, clock, dir, host, call: invoker(backend), driver: makeDriver({ clock, backend, host }) })
  } finally {
    await backend?.dispose().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

// ───────────── 300 chats at 18 turns/minute ─────────────

test('review of 190 chats (380 turns) under 18 turns/minute: runs > 15 fake minutes, no wait-cap failure, finishes ok, progress visible while it runs, ledger cleared at the end', async () => {
  const messages = reviewMessages({ chats: 190, slices: 2 })
  await withBackend({ messages }, async ({ backend, clock, dir, host, call, driver }) => {
    const t0 = clock.now()
    const review = trackSettled(reviewCall(backend))
    const samples = []
    await driver.drive(() => review.settled, {
      onStep: async () => {
        const turns = host.stats.completes
        if (turns > 0 && turns % 50 === 0 && samples.at(-1)?.turns !== turns) samples.push({ turns, status: await call('review.status') })
      }
    })
    assert.equal(review.error, null)
    const env = review.value
    assert.equal(env.ok, true, JSON.stringify(env).slice(0, 300))
    const result = env.value
    const elapsedMin = (clock.now() - t0) / MIN
    assert.ok(elapsedMin > 15, `the review took ${elapsedMin.toFixed(1)} fake minutes (longer than the 15-minute stall cap)`)
    assert.ok(host.stats.completes >= 380 && host.stats.completes <= 390, `${host.stats.completes} turns for 190 chats x 2 day-slices`)
    assert.ok(host.maxInWindow() <= TURNS_PER_MIN, `never more than ${TURNS_PER_MIN} turns in 60 s (saw ${host.maxInWindow()})`)
    assert.equal(host.stats.errors.rate_limited, 0, 'the host never had to refuse a turn')
    assert.equal(result.ok, true)
    assert.equal(result.chatsSeen, 190)
    assert.equal(result.chatsProcessed, 190, 'every chat completed')
    assert.equal(result.chatsFailed, 0, 'no chat failed on a wait cap')
    assert.equal(result.todosCreated + result.todosMerged, 380)
    // progress was reportable all along: running with N/M, then done
    assert.ok(samples.length >= 5)
    for (const sample of samples) {
      assert.equal(sample.status.running, true)
      assert.equal(sample.status.state, 'running')
      assert.equal(sample.status.chatsTotal, 190)
      assert.match(sample.status.summary, /回顧進行中：已處理 \d+\/190 個聊天/)
    }
    assert.ok(samples.at(-1).status.chatsDone > samples[0].status.chatsDone, 'the done count grows')
    const final = await call('review.status')
    assert.equal(final.running, false)
    assert.equal(final.state, 'done')
    assert.equal(final.chatsDone, 190)
    assert.equal(final.chatsTotal, 190)
    assert.equal(final.slicesFailed, 0)
    assert.equal(final.resumableMessages, 0, 'a completed review leaves no ledger behind')
    assert.equal(existsSync(join(dir, 'review-ledger.json')), false)
    assert.equal((await call('backend.info')).review.state, 'done')
    assert.equal((await call('db.todos.list', {})).length >= 190, true)
    assert.equal(clock.timers('queue'), 0, 'no stall timer is left armed')
    assert.equal(host.control.liveSessions(), 0)
  })
})

test('a second reviewLastDays call while one is running shares it (single flight): no second pass over the chats', async () => {
  const messages = reviewMessages({ chats: 20, slices: 2 })
  await withBackend({ messages }, async ({ backend, host, driver }) => {
    const first = trackSettled(reviewCall(backend))
    await realSleep(20)
    const second = trackSettled(reviewCall(backend))
    await driver.drive(() => first.settled && second.settled)
    assert.equal(first.value.ok, true)
    assert.deepEqual(second.value, first.value)
    assert.equal(host.stats.completes, 40, 'each day-slice was sent once, not twice')
  })
})

test('one chat that alone needs more than 15 fake minutes of turns still completes: the wait cap is a stall cap, not a total-time cap', async () => {
  // maxUserChars 1500 -> about 7 messages per turn -> 2,300 messages = ~330 turns = ~18 minutes at 18/min for this ONE request
  const messages = reviewMessages({ chats: 1, slices: 1, perSlice: 2300 }).concat(reviewMessages({ chats: 3, slices: 2 }).map((m) => ({ ...m, chatId: `u-s${m.chatId}`, msgId: `s${m.msgId}`, chat: `小聊天${m.chat}` })))
  await withBackend({ messages, extract: { maxUserChars: 1500 }, hostOptions: { reply: (user) => (JSON.parse(user).newMessages[0].msgId.endsWith('k0') ? modelReply(user) : fyiReply) } }, async ({ backend, clock, host, driver }) => {
    const t0 = clock.now()
    const review = trackSettled(reviewCall(backend))
    await driver.drive(() => review.settled)
    const result = review.value.value
    const bigTurns = host.turns().filter((t) => t.chatId === 'u-1')
    const elapsedMin = (clock.now() - t0) / MIN
    assert.ok(bigTurns.length > 270, `the big chat alone took ${bigTurns.length} turns`)
    assert.ok(elapsedMin > 15, `${elapsedMin.toFixed(1)} fake minutes in total`)
    assert.equal(review.value.ok, true)
    assert.equal(result.ok, true)
    assert.equal(result.chatsFailed, 0, 'a request that waits longer than 15 minutes in total is fine as long as the queue keeps moving')
    assert.equal(result.chatsProcessed, 4)
    for (const turn of host.turns()) assert.ok(turn.user.length <= 1500)
    const sent = bigTurns.flatMap((t) => t.msgIds)
    assert.equal(sent.length, 2300)
    assert.equal(new Set(sent).size, 2300, 'every message of the big chat exactly once')
  })
})

// ───────────── the AI goes away mid-review ─────────────

test('AI unavailable mid-review (Codex logged out): the review pauses (not a mass failure, not 15 minutes per chat), keeps what is finished, reports "paused N/M"; the next review sends only what is left', async () => {
  const messages = reviewMessages({ chats: 190, slices: 2 })
  await withBackend({ messages }, async ({ backend, clock, dir, host, call, driver }) => {
    const t0 = clock.now()
    const first = trackSettled(reviewCall(backend))
    // run normally until ~half of the turns are done, then Codex is logged out
    await driver.drive(() => host.stats.completes >= 150 || first.settled)
    assert.equal(first.settled, false)
    const turnsBeforeHide = host.stats.completes
    host.control.set({ providerState: 'not_logged_in' })
    const hiddenAt = clock.now()
    await driver.drive(() => first.settled)
    const hiddenForMin = (clock.now() - hiddenAt) / MIN

    assert.equal(first.value.ok, true, 'the call itself returns an in-band result')
    const paused = first.value.value
    assert.equal(paused.ok, false, 'not finished: ok:false so the UI shows the note')
    assert.match(paused.note, /^回顧暫停：已完成 \d+\/190 個聊天/)
    assert.ok(hiddenForMin >= 14 && hiddenForMin < 20, `the review gave up after ${hiddenForMin.toFixed(1)} fake minutes without an AI (not 15 minutes per remaining chat)`)
    assert.ok(clock.now() - t0 < 80 * MIN, 'and finished quickly after that')
    const doneChats = paused.chatsProcessed
    assert.ok(doneChats >= 60 && doneChats < 190, `${doneChats} chats were completed before the pause`)
    assert.ok(paused.chatsFailed >= 190 - doneChats - 4, `the rest failed fast (${paused.chatsFailed})`)
    assert.ok(paused.todosCreated + paused.todosMerged >= turnsBeforeHide - 4, 'finished work is persisted (todos from the answered turns exist)')
    const todosAtPause = await call('db.todos.list', {})
    const todosAfterPause = todosAtPause.length
    assert.ok(todosAfterPause >= 60)

    const status = await call('review.status')
    assert.equal(status.running, false)
    assert.equal(status.state, 'paused')
    assert.equal(status.chatsDone, doneChats)
    assert.equal(status.chatsTotal, 190)
    assert.match(status.summary, /^回顧暫停：已完成 \d+\/190 個聊天。原因：/)
    assert.match(status.summary, /extract_await_timeout/u)
    assert.match(status.summary, /上次進度時間 .*Z（UTC）/u)
    assert.ok(status.resumableMessages >= turnsBeforeHide - 4, `ledger remembers ${status.resumableMessages} messages`)
    assert.equal(existsSync(join(dir, 'review-ledger.json')), true, 'the ledger is on disk')
    const pendingRows = (await call('db.messages.list', { limit: 1000 })).filter((message) => !message.processed)
    assert.ok(pendingRows.length > 0, 'source messages in failed chats remain unprocessed and queryable')
    const checkpointIds = new Set(JSON.parse(readFileSync(join(dir, 'review-ledger.json'), 'utf8')).done)
    const checkpointedPending = pendingRows.filter((message) => checkpointIds.has(message.msgId)).map((message) => message.msgId)
    assert.equal(checkpointedPending.length, 0, 'the apply receipt keeps every uncommitted source out of the resume ledger')

    // while Codex is out, a new review does not even start (immediate, explained)
    const refused = (await call('pipeline.reviewLastDays', 3))
    assert.equal(refused.ok, false)
    assert.match(refused.note, /尚未登入/)

    // Codex is back: continue
    host.control.set({ providerState: 'ready' })
    const turnsBefore = host.stats.completes
    const second = trackSettled(reviewCall(backend))
    await driver.drive(() => second.settled)
    const resumed = second.value.value
    assert.equal(second.value.ok, true)
    assert.equal(resumed.ok, true, JSON.stringify(resumed).slice(0, 300))
    assert.equal(resumed.chatsProcessed, 190)
    assert.equal(resumed.chatsFailed, 0)
    assert.equal((await call('db.messages.list', { limit: 1000 })).filter((message) => !message.processed).length, 0, 'resumed review processes the retained source rows')
    const turns = host.turns()
    const secondTurns = turns.slice(turnsBefore)
    assert.ok(secondTurns.length <= 380 - turnsBeforeHide + 6, `the second pass sent ${secondTurns.length} turns, only what was left (380 - ${turnsBeforeHide})`)
    assert.ok(secondTurns.length >= 380 - turns.slice(0, turnsBefore).length - 4)
    // no message was answered twice, except the (<= 4) turns that were in flight when the AI went away
    const counts = new Map()
    for (const turn of turns) for (const id of turn.msgIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    const repeated = [...counts.values()].filter((n) => n > 1).length
    assert.ok(repeated <= 4, `${repeated} messages were sent twice`)
    assert.equal(counts.size, 380)
    assert.ok((await call('db.todos.list', {})).length >= todosAfterPause, 'the first pass\'s todos are still there')
    const final = await call('review.status')
    assert.equal(final.state, 'done')
    assert.equal(final.resumableMessages, 0)
    assert.equal(existsSync(join(dir, 'review-ledger.json')), false)
  })
})

test('a review request made during the scheduled worker startup waits for the consumer instead of recording a false offline pause', async () => {
  const clock = makeClock(Date.now())
  const messages = reviewMessages({ chats: 1, slices: 1, base: clock.now() })
  await withBackend({ messages, clock, startupDelayMs: 500 }, async ({ backend, host, driver, call }) => {
    const first = trackSettled(reviewCall(backend))
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 400
      const timer = setInterval(() => {
        if (backend.diagnostics().extract.awaiting === 1) { clearInterval(timer); resolve() }
        else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error('review request is queued while the worker startup timer is pending')) }
      }, 5)
    })
    assert.equal(first.settled, false)
    await realSleep(520) // let the scheduled worker start before the fake-clock stall timer advances
    await driver.drive(() => first.settled)

    assert.equal(first.error, null)
    assert.equal(first.value.ok, true)
    assert.equal(first.value.value.ok, true, JSON.stringify(first.value.value))
    assert.equal(first.value.value.chatsProcessed, 1, JSON.stringify(first.value.value))
    assert.equal(first.value.value.todosCreated, 1, 'the real review caller and worker path committed the controlled todo')
    assert.equal(host.stats.completes, 1, 'the message reached the worker after its scheduled start')
    const todos = await call('db.todos.list', {})
    assert.equal(todos.length, 1)
    assert.deepEqual(todos[0].sourceMsgIds, ['i:c1s0k0'])
    const status = await call('review.status')
    assert.equal(status.state, 'done')
  })
})

test('a resumed paused status exposes its exact offline or timeout reason, timestamp, and retained progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-review-status-reason-'))
  try {
    const clock = makeClock(Date.parse('2026-10-25T07:07:05.921Z'))
    const ledgerFile = join(dir, 'review-ledger.json')
    const statusFile = join(dir, 'review-status.json')
    const review = new ReviewCoordinator({ ledger: new ReviewLedger({ file: ledgerFile, now: clock.now }), statusFile, now: clock.now })
    const wrapped = review.wrapExtract(async (input) => {
      if (input.newMessages[0].msgId === 'offline') throw new Error('extract_ui_offline')
      return { importance: 'noise', newTodos: [], identityDecisions:[], resolved: [], updates: [] }
    })
    const input = (msgId) => ({ now: '2026-10-25T07:07:00.000Z', chat: { chatId: 'chat', name: 'chat', isGroup: false }, newMessages: [{ msgId }], recentContext: [], openTodos: [] })
    const result = await review.run(2, async () => {
      const doneInput=input('done')
      await wrapped(doneInput)
      doneInput.onIdentityApplied?.() // model success counts only after the owning apply reports its commit receipt
      await assert.rejects(wrapped(input('offline')), /extract_ui_offline/u)
      return { ok: true, hasApiKey: true, days: 2, sinceMs: 0, newMsgs: 2, chatsSeen: 2, chatsProcessed: 1, chatsSkippedNoise: 0, chatsFailed: 1, todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [], note: null }
    })
    assert.equal(result.ok, false)
    assert.match(result.note, /extract_ui_offline/u)
    const restored = new ReviewCoordinator({ ledger: new ReviewLedger({ file: ledgerFile, now: clock.now }), statusFile, now: clock.now }).status()
    assert.equal(restored.pausedReason, 'extract_ui_offline')
    assert.equal(restored.finishedAt, Date.parse('2026-10-25T07:07:05.921Z'))
    assert.equal(restored.resumableMessages, 1)
    assert.match(restored.summary, /extract_ui_offline/u)
    assert.match(restored.summary, /2026-10-25T07:07:05\.921Z/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Core\'s hard cap of 400 turns per hour: a review that needs more never sends more than 400 in any hour (no host rate_limited), pauses with an explained note, and the next review after the window frees finishes only what is left', async () => {
  const messages = reviewMessages({ chats: 250, slices: 2 }) // 500 turns
  await withBackend({ messages }, async ({ backend, clock, host, call, driver }) => {
    const first = trackSettled(reviewCall(backend))
    await driver.drive(() => first.settled)
    const paused = first.value.value
    assert.equal(paused.ok, false)
    assert.match(paused.note, /^回顧暫停：已完成 \d+\/250 個聊天/)
    assert.match(paused.note, /15 分鐘沒有結果回報（extract_await_timeout）/u, 'the note names the queue no-progress timeout observed by this run')
    const sent = host.stats.completes
    // 0.2.0 (review F5): background work keeps extractHourReserve (20) of the 400 turns an hour for the user's own actions
    assert.ok(sent >= 375 && sent <= 380, `${sent} turns went out before the hourly cap (400 - 20 kept for the user) held the rest back`)
    assert.equal(host.stats.errors.rate_limited, 0, 'the port never let the host refuse a turn')
    assert.equal((await call('review.status')).state, 'paused')
    // the hour passes (the first turns leave the window), the user presses 回顧 again
    clock.advance(61 * MIN)
    const second = trackSettled(reviewCall(backend))
    await driver.drive(() => second.settled)
    const resumed = second.value.value
    assert.equal(resumed.ok, true, JSON.stringify(resumed).slice(0, 300))
    assert.equal(resumed.chatsProcessed, 250)
    assert.equal(host.stats.completes <= 506, true, `${host.stats.completes} turns in total — only what was left was sent`)
    const times = host.stats.turns.map((turn) => turn.at)
    const perHour = Math.max(...times.map((start) => times.filter((t) => t >= start && t < start + 60 * MIN).length))
    assert.ok(perHour <= 400, `at most 400 turns in any hour (saw ${perHour})`)
    assert.equal(host.stats.errors.rate_limited, 0)
    assert.equal(new Set(host.turns().flatMap((t) => t.msgIds)).size, 500, 'every message was sent')
  })
})

test('progress survives a backend restart: the ledger file is read again and the finished slices are not sent again', async () => {
  const messages = reviewMessages({ chats: 40, slices: 2 })
  const dir = mkdtempSync(join(tmpdir(), 'plugin-review-restart-'))
  const clock = makeClock()
  const host = makeHostAi(clock)
  let backend = await startBackend({ dir, messages, clock, host })
  try {
    const driver = makeDriver({ clock, backend, host })
    const first = trackSettled(reviewCall(backend))
    await driver.drive(() => host.stats.completes >= 30 || first.settled)
    host.control.set({ providerState: 'not_logged_in' })
    await driver.drive(() => first.settled)
    assert.equal(first.value.value.ok, false)
    assert.match(first.value.value.note, /^回顧暫停：已完成 \d+\/40 個聊天/)
    const sentBefore = new Set(host.turns().flatMap((t) => t.msgIds))
    await backend.dispose()

    // TeamUQ starts the backend again (Codex works again, new mock host process)
    const host2 = makeHostAi(clock)
    backend = await startBackend({ dir, messages, clock, host: host2 })
    // G-05: a fresh process has no run in memory, but it reports what the previous backend persisted (paused, N/40, resumable) instead of a blank 'idle'
    const restarted = await invoker(backend)('review.status')
    assert.equal(restarted.running, false, 'a fresh process has no run in memory')
    assert.equal(restarted.state, 'paused', 'the state the previous backend left in review-status.json')
    assert.equal(restarted.chatsTotal, 40)
    assert.ok(restarted.chatsDone > 0 && restarted.chatsDone < 40, `N/M kept: ${restarted.chatsDone}/40`)
    assert.ok(restarted.resumableMessages > 0, 'the ledger is loaded for the status query, so the resumable count survives the restart')
    assert.match(restarted.summary, /回顧暫停/)
    const tasks = await invoker(backend)('tasks.status')
    assert.equal(tasks.review.state, 'paused')
    assert.equal(tasks.mediaBackfill.state, 'idle')
    const driver2 = makeDriver({ clock, backend, host: host2 })
    const second = trackSettled(reviewCall(backend))
    await driver2.drive(() => second.settled)
    const result = second.value.value
    assert.equal(result.ok, true)
    assert.equal(result.chatsProcessed, 40)
    assert.equal(result.chatsFailed, 0)
    const sentAfter = host2.turns().flatMap((t) => t.msgIds)
    const resent = sentAfter.filter((id) => sentBefore.has(id))
    assert.ok(resent.length <= 4, `${resent.length} messages were sent again after the restart`)
    assert.equal(new Set([...sentBefore, ...sentAfter]).size, 80)
    assert.equal(existsSync(join(dir, 'review-ledger.json')), false, 'cleared after the completed second pass')
  } finally {
    await backend.dispose().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G-05: a backend that dies in the middle of a review (no dispose, no settle) is reported as interrupted by the next one, with N/M; the next review resumes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-review-interrupted-'))
  try {
    const statusFile = join(dir, 'review-status.json')
    let now = 1_000_000
    const clock = () => now
    const ledger = new ReviewLedger({ file: join(dir, 'review-ledger.json'), now: clock })
    const first = new ReviewCoordinator({ ledger, statusFile, now: clock })
    // the review never settles: the process is "killed" while it runs
    void first.run(2, () => new Promise(() => undefined))
    first.noteProgress({ processed: 7, total: 20, phase: 'extracting' })
    now += 10_000
    first.noteProgress({ processed: 9, total: 20, phase: 'extracting' }) // persisted (>= 5 s since the last write)
    assert.equal(first.status().state, 'running')
    assert.equal(JSON.parse(readFileSync(statusFile, 'utf8')).state, 'running', 'the status file says running while the review runs')
    ledger.add(['m1', 'm2', 'm3'])
    ledger.flush()

    // the next backend process
    const second = new ReviewCoordinator({ ledger: new ReviewLedger({ file: join(dir, 'review-ledger.json'), now: clock }), statusFile, now: clock })
    const status = second.status()
    assert.equal(status.running, false)
    assert.equal(status.state, 'interrupted')
    assert.equal(status.chatsDone, 9)
    assert.equal(status.chatsTotal, 20)
    assert.equal(status.resumableMessages, 3)
    assert.match(status.summary, /重新啟動，沒有做完（已處理 9\/20 個聊天）；再按一次「回顧」即可接續/)
    assert.equal(JSON.parse(readFileSync(statusFile, 'utf8')).state, 'interrupted', 'rewritten at once, so a third process does not mistake it for a run')
    // a new review starts normally from the interrupted state
    const result = await second.run(2, async () => ({ ok: true, chatsSeen: 20, chatsProcessed: 20, chatsSkippedNoise: 0, chatsFailed: 0, todosCreated: 0, todosMerged: 0 }))
    assert.equal(result.ok, true)
    assert.equal(second.status().state, 'done')
    assert.equal(JSON.parse(readFileSync(statusFile, 'utf8')).state, 'done')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G-05: LongTaskTracker (補媒體金鑰) is single-flight, persists start / end, and a run cut off by a restart reads back as interrupted; tasks.status reports it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-task-status-'))
  try {
    const file = join(dir, 'media-backfill-status.json')
    const tracker = new LongTaskTracker({ name: 'mediaBackfill', file })
    assert.equal(tracker.status().state, 'idle')
    let release
    const exec = () => new Promise((resolve) => { release = resolve })
    const describe = (v) => ({ ok: v.ok === true, summary: `補了 ${v.mediaBackfilled}`, result: { mediaBackfilled: v.mediaBackfilled } })
    const a = tracker.run(exec, describe, '補媒體金鑰進行中…')
    const b = tracker.run(exec, describe, '補媒體金鑰進行中…')
    assert.equal(a, b, 'single flight: the second call shares the first')
    assert.equal(tracker.status().running, true)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).state, 'running')
    // restart while it runs
    const afterCrash = new LongTaskTracker({ name: 'mediaBackfill', file, interruptedSummary: '中斷了' })
    assert.deepEqual([afterCrash.status().state, afterCrash.status().running, afterCrash.status().summary], ['interrupted', false, '中斷了'])
    release({ ok: true, mediaBackfilled: 4 })
    await a
    assert.equal(tracker.status().state, 'done')
    assert.equal(tracker.status().summary, '補了 4')
    assert.deepEqual(new LongTaskTracker({ name: 'mediaBackfill', file }).status().result, { mediaBackfilled: 4 }, 'the finished result is read back by the next process')
    // failure
    await assert.rejects(tracker.run(async () => { throw new Error('disk full') }, describe, 'x'), /disk full/)
    assert.equal(tracker.status().state, 'failed')
    assert.match(tracker.status().summary, /disk full/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G-05: through the dispatcher, pipeline.backfillMediaKeys is tracked and tasks.status answers after a restart of the whole backend', async () => {
  const messages = reviewMessages({ chats: 2, slices: 1 })
  const dir = mkdtempSync(join(tmpdir(), 'plugin-task-status-backend-'))
  const clock = makeClock()
  let backend = await startBackend({ dir, messages, clock })
  try {
    const call = invoker(backend)
    const before = await call('tasks.status')
    assert.equal(before.mediaBackfill.state, 'idle')
    assert.equal(before.review.state, 'idle')
    const done = await call('pipeline.backfillMediaKeys', 1)
    const after = await call('tasks.status')
    assert.equal(after.mediaBackfill.running, false)
    assert.equal(after.mediaBackfill.state, done.ok ? 'done' : 'failed')
    await backend.dispose()
    backend = await startBackend({ dir, messages, clock })
    const restarted = await invoker(backend)('tasks.status')
    assert.equal(restarted.mediaBackfill.state, after.mediaBackfill.state, 'the last result is still there after the restart')
    assert.equal(restarted.mediaBackfill.summary, after.mediaBackfill.summary)
  } finally {
    await backend.dispose().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a ledger older than its TTL is ignored: the next review is a full one again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-review-ttl-'))
  try {
    const clock = makeClock()
    const file = join(dir, 'ledger.json')
    const a = new ReviewLedger({ file, now: clock.now, ttlMs: 60 * MIN })
    a.load()
    a.add(['m1', 'm2'])
    a.flush()
    const b = new ReviewLedger({ file, now: clock.now, ttlMs: 60 * MIN })
    b.load()
    assert.equal(b.size, 2)
    clock.advance(61 * MIN)
    const c = new ReviewLedger({ file, now: clock.now, ttlMs: 60 * MIN })
    c.load()
    assert.equal(c.size, 0)
    assert.equal(existsSync(file), false)
    // a damaged file is just "no ledger"
    const bad = join(dir, 'bad.json')
    const fs = await import('node:fs')
    fs.writeFileSync(bad, '{not json')
    const d = new ReviewLedger({ file: bad, now: clock.now })
    d.load()
    assert.equal(d.size, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ReviewCoordinator: failed chats that are not a pause keep ok:true but say how many are left; a clean run clears the ledger; a skipped slice costs no AI call', async () => {
  const clock = makeClock()
  const ledger = new ReviewLedger({ now: clock.now })
  const review = new ReviewCoordinator({ ledger, now: clock.now })
  const calls = []
  const wrapped = review.wrapExtract(async (input) => { calls.push(input.newMessages.map((m) => m.msgId)); if (input.chat.chatId === 'bad') throw new Error('invalid_json'); return { importance: 'noise', newTodos: [], identityDecisions:[], resolved: [], updates: [] } })
  const input = (chatId, ids) => ({ now: 'n', chat: { chatId, name: chatId, isGroup: false }, newMessages: ids.map((id) => ({ msgId: id })), recentContext: [], openTodos: [] })
  const base = { ok: true, hasApiKey: true, days: 3, sinceMs: 0, newMsgs: 0, chatsSkippedNoise: 0, todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [], note: null }
  const first = await review.run(3, async () => {
    const goodInput=input('good', ['a1'])
    await wrapped(goodInput)
    goodInput.onIdentityApplied?.() // stand-in for a successful atomic backfill apply
    await assert.rejects(wrapped(input('bad', ['b1'])), /invalid_json/)
    return { ...base, chatsSeen: 2, chatsProcessed: 1, chatsFailed: 1 }
  })
  assert.equal(first.ok, true)
  assert.match(first.note, /^尚有 1 個聊天未完成（已完成 1\/2）/)
  assert.equal(review.status().state, 'incomplete')
  assert.equal(ledger.has('a1'), true)
  assert.equal(ledger.has('b1'), false)
  calls.length = 0
  const second = await review.run(3, async () => {
    const skipped = await wrapped(input('good', ['a1']))
    assert.equal(skipped.importance, 'noise')
    await wrapped(input('bad2', ['c1']))
    return { ...base, chatsSeen: 2, chatsProcessed: 2, chatsFailed: 0 }
  })
  assert.deepEqual(calls, [['c1']], 'a1 was not sent again')
  assert.equal(second.note, null)
  assert.equal(review.status().state, 'done')
  assert.equal(review.status().slicesSkipped, 1)
  assert.equal(ledger.size, 0)
})

// ───────────── ExtractQueue: stall semantics (unit) ─────────────

const config = { ...DEFAULTS, concurrency: 2 }
const dto = (i, text) => ({ msgId: `m${i}`, chatId: 'u-big', ts: 1_700_000_000_000 + i, timeIso: new Date(1_700_000_000_000 + i).toISOString(), direction: 'in', sender: 'Alice', text, contentType: 0, processed: false, ingestedAt: '', origFilename: null, fileSize: null, unsent: false })
const inputOf = (messages, chatId = 'u-big') => ({ now: '2026-10-01T10:00:00.000', chat: { chatId, name: chatId, isGroup: false }, newMessages: messages.map((m) => ({ ...m, chatId })), recentContext: [], openTodos: [] })
const fyi = { importance: 'fyi', newTodos: [], identityDecisions: [], resolved: [], updates: [] }

function queueWithClock(extra = {}) {
  const clock = makeClock()
  const { db } = openDatabase({ dbPath: ':memory:' })
  const queue = new ExtractQueue({ db, getConfig: () => config, now: clock.now, schedule: clock.schedule, awaitTimeoutMs: 15 * MIN, leaseMs: 120_000, ...extra })
  return { queue, clock }
}
const track = (promise) => { const box = { state: 'pending', value: null }; promise.then((v) => { box.state = 'resolved'; box.value = v }, (e) => { box.state = 'rejected'; box.value = e }); return box }

test('queue: a request is not failed by total waiting time — one part comes back every 10 minutes for 40 minutes and it still resolves', async () => {
  const { queue, clock } = queueWithClock({ maxUserChars: 900 })
  const messages = Array.from({ length: 12 }, (_, i) => dto(i + 1, `訊息${i + 1}：` + '很長的內容'.repeat(12)))
  const box = track(queue.request(inputOf(messages)))
  let parts = 0
  for (let guard = 0; guard < 40 && box.state === 'pending'; guard += 1) {
    const { items } = queue.pull()
    if (items.length === 1) { parts += 1; queue.commit({ results: [{ itemId: items[0].itemId, ok: true, result: fyi }] }) }
    clock.advance(10 * MIN)
    await tick()
  }
  assert.ok(parts >= 4, `${parts} parts`)
  assert.equal(box.state, 'resolved', `still ${box.state} after ${parts} parts / ${parts * 10} fake minutes`)
  assert.equal(queue.stats().awaiting, 0)
  queue.dispose()
})

test('queue: a request whose queue makes no progress at all is failed as a stall (extract_await_timeout) after 15 minutes — not before', async () => {
  const { queue, clock } = queueWithClock()
  const box = track(queue.request(inputOf([dto(1, 'hi')])))
  clock.advance(14 * MIN)
  await tick()
  assert.equal(box.state, 'pending')
  clock.advance(1.5 * MIN)
  await tick()
  assert.equal(box.state, 'rejected')
  assert.equal(box.value.message, 'extract_await_timeout')
  assert.equal(queue.stats().awaiting, 0)
  queue.dispose()
})

test('queue: other chats being committed counts as progress (the queue is moving, this request just has to wait its turn)', async () => {
  const { queue, clock } = queueWithClock()
  const waiting = track(queue.request(inputOf([dto(1, 'hi')], 'u-slow')))
  const [slow] = queue.pull().items // the UI holds it... then releases it, as a rate-limited orchestrator does
  queue.release({ itemIds: [slow.itemId] })
  for (let n = 0; n < 6; n += 1) {
    const other = track(queue.request(inputOf([dto(10 + n, 'other')], `u-other${n}`)))
    clock.advance(1 * MIN)
    const pulled = queue.pull({ max: 2 }).items.find((i) => i.chatId === `u-other${n}`)
    queue.commit({ results: [{ itemId: pulled.itemId, ok: true, result: fyi }] })
    clock.advance(9 * MIN)
    await tick()
    assert.equal(other.state, 'resolved')
  }
  assert.equal(waiting.state, 'pending', '60 fake minutes, still waiting, still alive')
  queue.dispose()
})

test('queue: a UI that keeps polling but never commits (Codex logged out) is a stall too — pull/release alone is not progress', async () => {
  const { queue, clock } = queueWithClock()
  const box = track(queue.request(inputOf([dto(1, 'hi')])))
  for (let n = 0; n < 62 && box.state === 'pending'; n += 1) {
    const { items } = queue.pull()
    if (items.length) queue.release({ itemIds: items.map((i) => i.itemId) })
    clock.advance(15_000)
    await tick()
  }
  assert.equal(box.state, 'rejected')
  assert.equal(box.value.message, 'extract_await_timeout')
  queue.dispose()
})

test('queue: when no UI has touched the queue for 15 minutes a NEW request fails at once (extract_ui_offline) instead of waiting 15 minutes of its own', async () => {
  const { queue, clock } = queueWithClock()
  clock.advance(16 * MIN)
  await assert.rejects(queue.request(inputOf([dto(1, 'hi')])), /extract_ui_offline/)
  assert.equal(queue.stats().awaiting, 0)
  assert.equal(clock.timers(), 0, 'no timer was armed for the refused request')
  queue.pull() // the board polls: alive again
  const box = track(queue.request(inputOf([dto(2, 'hi')])))
  await tick()
  assert.equal(box.state, 'pending')
  queue.dispose()
})
