// Phase 4 repair — reviewLastDays in plugin mode with hundreds of chats under ai:chat's 18 turns/minute.
//
// Everything runs on a FAKE clock (queue `now` + `schedule`, review ledger `now`, the simulated UI's quota window), so a 33-minute review takes a couple of seconds.
// The "UI" here is a simulated orchestrator: pull one item, wait for a free slot in a sliding 60 s window of 18 turns, answer, commit — the same extract.pull/commit
// channel the real orchestrator uses (its own behaviour is covered by test-ai-orchestrator / test-ai-e2e).
//
//   * ~300 chats, 2 day-slices each, 18 turns/min -> the review runs > 30 fake minutes and completes (no 15-minute wait cap kills it); progress is visible meanwhile
//   * one chat that alone needs > 15 fake minutes of turns completes (the wait cap is a *stall* cap, not a total-time cap)
//   * the board goes away mid-review (UI offline) -> the review pauses (no mass failure, no 15-minutes-per-chat pile-up), finished chats are kept,
//     "paused, N/M done" is reported; the next review continues and sends only what is left — also across a backend restart (ledger on disk)
//   * ExtractQueue stall semantics, unit level
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULTS } from '../../src/main/config/defaults.ts'
import { openDatabase } from '../../src/main/db/database.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { ExtractQueue } from '../../src/plugin/backend/extractQueue.ts'
import { ReviewCoordinator, ReviewLedger } from '../../src/plugin/backend/reviewRun.ts'

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
    schedule(fn, ms) { const id = seq++; timers.set(id, { at: time + ms, fn }); return () => { timers.delete(id) } },
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
    timers: () => timers.size
  }
  return clock
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ───────────── fake LINE + backend + simulated UI ─────────────

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

async function startBackend({ dir, messages, clock, extract = {}, line }) {
  return createPluginBackend({
    pluginId: 'tuqdev.line-todo', version: 'repair', dataDir: dir, line: line ?? fakeLine(messages),
    extract: { now: clock.now, schedule: clock.schedule, ...extract },
    review: { now: clock.now },
    dispatcher: { softDeadlineMs: 3_600_000 } // the test awaits the review call itself (no job polling needed)
  })
}

function invoker(backend) {
  return async (path, ...args) => {
    const env = await backend.call('api.invoke', { path, args })
    assert.equal(env.ok, true, `${path}: ${JSON.stringify(env)}`)
    if (env.chunked === true) {
      // results over 64 KiB come back in pieces (what the UI transport does)
      const parts = []
      for (let index = 0; index < env.chunks; index += 1) {
        const piece = await backend.call('api.invoke', { path: 'result.chunk', args: [{ resultId: env.resultId, index }] })
        assert.equal(piece.ok, true)
        parts.push(piece.value.data)
      }
      return JSON.parse(parts.join(''))
    }
    return env.value
  }
}

/** What a model would answer for a payload: one todo citing the first new message (the first part of a chat only, to keep the todo count small). */
function modelReply(user) {
  const payload = JSON.parse(user)
  const first = payload.newMessages[0]
  return { importance: 'action', newTodos: [{ bucket: 'todo', title: `處理${payload.chat.name}的報價問題 ${first.msgId}`, detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [first.msgId] }], resolved: [], updates: [] }
}

/** A simulated orchestrator: one turn at a time, at most `rate` turns inside any 60 s window of fake time, nothing at all while `hidden`. */
function makeUi({ backend, clock, rate = TURNS_PER_MIN, reply = modelReply }) {
  const call = invoker(backend)
  const ui = {
    hidden: false,
    turns: [], // { at, chatId, msgIds, user }
    maxInWindow: 0,
    async step() {
      if (ui.hidden) { clock.advance(30_000); await tick(); return 'hidden' }
      const { items } = await call('extract.pull', { max: 1 })
      if (items.length === 0) return 'empty'
      const item = items[0]
      // wait for a free slot of the sliding window (same rule as the host: >= rate turns in the last 60 s -> refuse)
      for (;;) {
        const recent = ui.turns.filter((t) => clock.now() - t.at <= MIN)
        if (recent.length < rate) break
        clock.advanceTo(recent[0].at + MIN + 1)
      }
      const at = clock.now()
      ui.turns.push({ at, chatId: item.chatId, user: item.user, msgIds: JSON.parse(item.user).newMessages.map((m) => m.msgId) })
      ui.maxInWindow = Math.max(ui.maxInWindow, ui.turns.filter((t) => at - t.at < MIN).length)
      const committed = await call('extract.commit', { results: [{ itemId: item.itemId, ok: true, result: reply(item.user, item) }] })
      assert.equal(committed.results[0].status === 'accepted' || committed.results[0].status === 'applied', true, JSON.stringify(committed.results[0]))
      return 'turn'
    },
    /** Drive until `done()` — with a guard so a bug can only fail the test, never hang it. */
    async drive(done, { maxSteps = 200_000, onStep } = {}) {
      let empties = 0
      for (let i = 0; i < maxSteps; i += 1) {
        if (await done()) return i
        const what = await ui.step()
        if (onStep) await onStep(what, i)
        if (what === 'empty') {
          empties += 1
          await tick()
          if (empties % 4 === 0) await realSleep(1) // let the review's own async work (DB, core) run
          if (empties % 40 === 0) clock.advance(15_000) // the board's backup poll interval
        } else empties = 0
        if (what === 'turn') await tick()
      }
      assert.fail('simulated UI did not reach the goal in time')
    }
  }
  return ui
}

function trackSettled(promise) {
  const box = { settled: false, value: null, error: null }
  promise.then((value) => { box.settled = true; box.value = value }, (error) => { box.settled = true; box.error = error })
  return box
}

const reviewCall = (backend, days = 3) => backend.call('api.invoke', { path: 'pipeline.reviewLastDays', args: [days] })

async function withBackend(options, body) {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-review-'))
  const clock = options.clock ?? makeClock()
  let backend = null
  try {
    backend = await startBackend({ dir, clock, ...options })
    await body({ backend, clock, dir, call: invoker(backend) })
  } finally {
    await backend?.dispose().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

// ───────────── 300 chats at 18 turns/minute ─────────────

test('review of 300 chats under 18 turns/minute: runs > 30 fake minutes, no wait-cap failure, finishes ok, progress visible while it runs, ledger cleared at the end', async () => {
  const messages = reviewMessages({ chats: 300, slices: 2 })
  await withBackend({ messages }, async ({ backend, clock, dir, call }) => {
    const ui = makeUi({ backend, clock })
    const t0 = clock.now()
    const reviewP = reviewCall(backend)
    const review = trackSettled(reviewP)
    const samples = []
    await ui.drive(() => review.settled, {
      onStep: async (what, i) => {
        if (what === 'turn' && ui.turns.length % 100 === 0) samples.push({ turns: ui.turns.length, status: await call('review.status') })
      }
    })
    assert.equal(review.error, null)
    const env = review.value
    assert.equal(env.ok, true, JSON.stringify(env).slice(0, 300))
    const result = env.value
    const elapsedMin = (clock.now() - t0) / MIN
    assert.ok(elapsedMin > 30, `the review took ${elapsedMin.toFixed(1)} fake minutes (the old wait cap was 15)`)
    assert.ok(ui.turns.length >= 600 && ui.turns.length <= 610, `${ui.turns.length} turns for 300 chats x 2 day-slices`)
    assert.ok(ui.maxInWindow <= TURNS_PER_MIN, `never more than ${TURNS_PER_MIN} turns in 60 s (saw ${ui.maxInWindow})`)
    assert.equal(result.ok, true)
    assert.equal(result.chatsSeen, 300)
    assert.equal(result.chatsProcessed, 300, 'every chat completed')
    assert.equal(result.chatsFailed, 0, 'no chat failed on a wait cap')
    assert.equal(result.todosCreated + result.todosMerged, 600)
    // progress was reportable all along: running with N/M, then done
    assert.ok(samples.length >= 5)
    for (const sample of samples) {
      assert.equal(sample.status.running, true)
      assert.equal(sample.status.state, 'running')
      assert.equal(sample.status.chatsTotal, 300)
      assert.match(sample.status.summary, /回顧進行中：已處理 \d+\/300 個聊天/)
    }
    assert.ok(samples.at(-1).status.chatsDone > samples[0].status.chatsDone, 'the done count grows')
    const final = await call('review.status')
    assert.equal(final.running, false)
    assert.equal(final.state, 'done')
    assert.equal(final.chatsDone, 300)
    assert.equal(final.chatsTotal, 300)
    assert.equal(final.slicesFailed, 0)
    assert.equal(final.resumableMessages, 0, 'a completed review leaves no ledger behind')
    assert.equal(existsSync(join(dir, 'review-ledger.json')), false)
    assert.equal((await call('backend.info')).review.state, 'done')
    assert.equal((await call('db.todos.list', {})).length >= 300, true)
    assert.equal(clock.timers(), 0, 'no stall timer is left armed')
  })
})

test('a second reviewLastDays call while one is running shares it (single flight): no second pass over the chats', async () => {
  const messages = reviewMessages({ chats: 20, slices: 2 })
  await withBackend({ messages }, async ({ backend, clock }) => {
    const ui = makeUi({ backend, clock })
    const first = trackSettled(reviewCall(backend))
    await realSleep(20)
    const second = trackSettled(reviewCall(backend))
    await ui.drive(() => first.settled && second.settled)
    assert.equal(first.value.ok, true)
    assert.deepEqual(second.value, first.value)
    assert.equal(ui.turns.length, 40, 'each day-slice was sent once, not twice')
  })
})

test('one chat that alone needs more than 15 fake minutes of turns still completes: the wait cap is a stall cap, not a total-time cap', async () => {
  // maxUserChars 1500 -> about 7 messages per turn -> 2,300 messages = ~330 turns = ~18 minutes at 18/min for this ONE request
  const messages = reviewMessages({ chats: 1, slices: 1, perSlice: 2300 }).concat(reviewMessages({ chats: 3, slices: 2 }).map((m) => ({ ...m, chatId: `u-s${m.chatId}`, msgId: `s${m.msgId}`, chat: `小聊天${m.chat}` })))
  await withBackend({ messages, extract: { maxUserChars: 1500 } }, async ({ backend, clock }) => {
    const ui = makeUi({ backend, clock, reply: (user, item) => (item.part === 1 ? modelReply(user) : { importance: 'fyi', newTodos: [], resolved: [], updates: [] }) })
    const t0 = clock.now()
    const review = trackSettled(reviewCall(backend))
    await ui.drive(() => review.settled)
    const result = review.value.value
    const bigTurns = ui.turns.filter((t) => t.chatId === 'u-1')
    const elapsedMin = (clock.now() - t0) / MIN
    assert.ok(bigTurns.length > 270, `the big chat alone took ${bigTurns.length} turns`)
    assert.ok(elapsedMin > 15, `${elapsedMin.toFixed(1)} fake minutes in total`)
    assert.equal(review.value.ok, true)
    assert.equal(result.ok, true)
    assert.equal(result.chatsFailed, 0, 'a request that waits longer than 15 minutes in total is fine as long as the queue keeps moving')
    assert.equal(result.chatsProcessed, 4)
    for (const turn of ui.turns) assert.ok(turn.user.length <= 1500)
    const sent = bigTurns.flatMap((t) => t.msgIds)
    assert.equal(sent.length, 2300)
    assert.equal(new Set(sent).size, 2300, 'every message of the big chat exactly once')
  })
})

// ───────────── the board goes away mid-review ─────────────

test('UI offline mid-review: the review pauses (not a mass failure, not 15 minutes per chat), keeps what is finished, reports "paused N/M"; the next review sends only what is left', async () => {
  const messages = reviewMessages({ chats: 300, slices: 2 })
  await withBackend({ messages }, async ({ backend, clock, dir, call }) => {
    const ui = makeUi({ backend, clock })
    const t0 = clock.now()
    const first = trackSettled(reviewCall(backend))
    // run normally until ~half of the turns are done, then the board disappears
    await ui.drive(() => ui.turns.length >= 250 || first.settled)
    assert.equal(first.settled, false)
    const turnsBeforeHide = ui.turns.length
    ui.hidden = true
    const hiddenAt = clock.now()
    await ui.drive(() => first.settled)
    const hiddenForMin = (clock.now() - hiddenAt) / MIN

    assert.equal(first.value.ok, true, 'the call itself returns an in-band result')
    const paused = first.value.value
    assert.equal(paused.ok, false, 'not finished: ok:false so the UI shows the note')
    assert.match(paused.note, /^回顧暫停：已完成 \d+\/300 個聊天/)
    assert.ok(hiddenForMin >= 14 && hiddenForMin < 20, `the review gave up after ${hiddenForMin.toFixed(1)} fake minutes without a UI (not 15 minutes per remaining chat)`)
    assert.ok(clock.now() - t0 < 80 * MIN, 'and finished quickly after that')
    const doneChats = paused.chatsProcessed
    assert.ok(doneChats >= 100 && doneChats < 300, `${doneChats} chats were completed before the pause`)
    assert.ok(paused.chatsFailed >= 300 - doneChats - 4, `the rest failed fast (${paused.chatsFailed})`)
    assert.ok(paused.todosCreated + paused.todosMerged >= turnsBeforeHide - 4, 'finished work is persisted (todos from the answered turns exist)')
    const todosAfterPause = (await call('db.todos.list', {})).length
    assert.ok(todosAfterPause >= 100)

    const status = await call('review.status')
    assert.equal(status.running, false)
    assert.equal(status.state, 'paused')
    assert.equal(status.chatsDone, doneChats)
    assert.equal(status.chatsTotal, 300)
    assert.match(status.summary, /^回顧暫停：已完成 \d+\/300 個聊天，看板回到前景後再按一次「回顧」即可接續/)
    assert.ok(status.resumableMessages >= turnsBeforeHide - 4, `ledger remembers ${status.resumableMessages} messages`)
    assert.equal(existsSync(join(dir, 'review-ledger.json')), true, 'the ledger is on disk')

    // the board is back: continue
    ui.hidden = false
    const turnsBefore = ui.turns.length
    const second = trackSettled(reviewCall(backend))
    await ui.drive(() => second.settled)
    const resumed = second.value.value
    assert.equal(second.value.ok, true)
    assert.equal(resumed.ok, true, JSON.stringify(resumed).slice(0, 300))
    assert.equal(resumed.chatsProcessed, 300)
    assert.equal(resumed.chatsFailed, 0)
    const secondTurns = ui.turns.slice(turnsBefore)
    assert.ok(secondTurns.length <= 600 - turnsBeforeHide + 6, `the second pass sent ${secondTurns.length} turns, only what was left (600 - ${turnsBeforeHide})`)
    assert.ok(secondTurns.length >= 600 - ui.turns.slice(0, turnsBefore).length - 4)
    // no message was answered twice, except the (<= 4) turns that were in flight when the board went away
    const counts = new Map()
    for (const turn of ui.turns) for (const id of turn.msgIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    const repeated = [...counts.values()].filter((n) => n > 1).length
    assert.ok(repeated <= 4, `${repeated} messages were sent twice`)
    assert.equal(counts.size, 600)
    assert.ok((await call('db.todos.list', {})).length >= todosAfterPause, 'the first pass\'s todos are still there')
    const final = await call('review.status')
    assert.equal(final.state, 'done')
    assert.equal(final.resumableMessages, 0)
    assert.equal(existsSync(join(dir, 'review-ledger.json')), false)
  })
})

test('progress survives a backend restart: the ledger file is read again and the finished slices are not sent again', async () => {
  const messages = reviewMessages({ chats: 40, slices: 2 })
  const dir = mkdtempSync(join(tmpdir(), 'plugin-review-restart-'))
  const clock = makeClock()
  let backend = await startBackend({ dir, messages, clock })
  try {
    const ui = makeUi({ backend, clock })
    const first = trackSettled(reviewCall(backend))
    await ui.drive(() => ui.turns.length >= 30 || first.settled)
    ui.hidden = true
    await ui.drive(() => first.settled)
    assert.equal(first.value.value.ok, false)
    assert.match(first.value.value.note, /^回顧暫停：已完成 \d+\/40 個聊天/)
    const sentBefore = new Set(ui.turns.flatMap((t) => t.msgIds))
    await backend.dispose()

    backend = await startBackend({ dir, messages, clock })
    assert.equal((await invoker(backend)('review.status')).state, 'idle', 'a fresh process has no run in memory')
    const ui2 = makeUi({ backend, clock })
    const second = trackSettled(reviewCall(backend))
    await ui2.drive(() => second.settled)
    const result = second.value.value
    assert.equal(result.ok, true)
    assert.equal(result.chatsProcessed, 40)
    assert.equal(result.chatsFailed, 0)
    const sentAfter = ui2.turns.flatMap((t) => t.msgIds)
    const resent = sentAfter.filter((id) => sentBefore.has(id))
    assert.ok(resent.length <= 4, `${resent.length} messages were sent again after the restart`)
    assert.equal(new Set([...sentBefore, ...sentAfter]).size, 80)
    assert.equal(existsSync(join(dir, 'review-ledger.json')), false, 'cleared after the completed second pass')
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
  const wrapped = review.wrapExtract(async (input) => { calls.push(input.newMessages.map((m) => m.msgId)); if (input.chat.chatId === 'bad') throw new Error('invalid_json'); return { importance: 'noise', newTodos: [], resolved: [], updates: [] } })
  const input = (chatId, ids) => ({ now: 'n', chat: { chatId, name: chatId, isGroup: false }, newMessages: ids.map((id) => ({ msgId: id })), recentContext: [], openTodos: [] })
  const base = { ok: true, hasApiKey: true, days: 3, sinceMs: 0, newMsgs: 0, chatsSkippedNoise: 0, todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [], note: null }
  const first = await review.run(3, async () => {
    await wrapped(input('good', ['a1']))
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
const fyi = { importance: 'fyi', newTodos: [], resolved: [], updates: [] }

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
