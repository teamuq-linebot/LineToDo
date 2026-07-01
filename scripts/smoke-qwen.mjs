// smoke:qwen — 用 QWEN_API_KEY 驗證 qwen 連線 + 結構化抽取（IMPLEMENTATION_PLAN.md §10 M2）。
//
// 兩段：
//   1) GET /v1/models —— 驗證金鑰 / 端點可達，列出 model id。
//   2) 一次真抽取 —— 用本專案的 EXTRACT_SYSTEM_PROMPT + EXTRACT_JSON_SCHEMA + 一段假 LINE 對話，
//      先試 response_format:json_schema，失敗（不支援徵兆）再 fallback guided_json，
//      回應以本專案 zod schema 驗證，印出 newTodos / resolved / importance。
//
// 無 QWEN_API_KEY → 印提示並 exit 0（不視為失敗：本機沒金鑰是預期情況）。
// 由 `npm run smoke:qwen`（需先 export QWEN_API_KEY）執行。此檔走 esbuild 即時編譯 TS 模組，
// 重用「真正的」prompt/schema/extractor，不重寫，避免漂移。

import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const apiKey = (process.env.QWEN_API_KEY || '').trim()
const baseURL = (process.env.QWEN_BASE_URL || 'https://qwen.tuq.tw/v1').trim()
const model = (process.env.QWEN_MODEL || 'qwen36-fp8').trim()

if (!apiKey) {
  console.log('[smoke:qwen] QWEN_API_KEY 未設定 —— 略過真呼叫（這是預期情況，不算失敗）。')
  console.log('[smoke:qwen] 要做真驗證：在 shell 設 QWEN_API_KEY 後再跑 `npm run smoke:qwen`。')
  process.exit(0)
}

const ENTRY = `
export { EXTRACT_SYSTEM_PROMPT, buildUserPayload } from './src/main/llm/extractPrompt.ts'
export { EXTRACT_JSON_SCHEMA, parseExtractResult } from './src/main/llm/schema.ts'
export { makeQwen, listModels } from './src/main/llm/qwenClient.ts'
export { extractTodos } from './src/main/llm/extractor.ts'
`

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'line-todo-smoke-'))
  const entryFile = join(ROOT, '__smoke_entry.ts')
  const outFile = join(tmp, 'smoke.bundle.mjs')
  writeFileSync(entryFile, ENTRY, 'utf8')
  try {
    await build({
      entryPoints: [entryFile],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: outFile,
      external: ['openai'],
      absWorkingDir: ROOT,
      logLevel: 'silent'
    })
    const m = await import(pathToFileURL(outFile).href)

    const client = m.makeQwen({ apiKey, baseURL, timeoutMs: 60000 })

    // 1) /v1/models
    const models = await m.listModels(client)
    console.log('[smoke:qwen] models ok=' + models.ok + (models.ok ? ' ids=' + JSON.stringify(models.models) : ' error=' + models.error))

    // 2) 真抽取（一段假 LINE 對話）
    const now = new Date().toISOString().slice(0, 19)
    const input = {
      now,
      chat: { chatId: 'usmoke', name: 'Abby', isGroup: false },
      newMessages: [
        { msgId: 's1', ts: Date.now() - 600000, time: now, direction: 'in', sender: 'Abby', text: '幫我明天下午三點前把報價單寄出好嗎', contentType: 0 },
        { msgId: 's2', ts: Date.now() - 300000, time: now, direction: 'out', sender: 'me', text: '好，我處理', contentType: 0 },
        { msgId: 's3', ts: Date.now() - 60000, time: now, direction: 'in', sender: 'Abby', text: '另外週五要開週會記得', contentType: 0 }
      ],
      recentContext: [],
      openTodos: []
    }

    let result
    try {
      result = await m.extractTodos(client, input, { model, structuredMode: 'auto' })
    } catch (err) {
      console.error('[smoke:qwen] 抽取失敗: ' + (err && err.stack ? err.stack : err))
      process.exitCode = 1
      return
    }

    console.log('[smoke:qwen] importance=' + result.importance)
    console.log('[smoke:qwen] newTodos=' + JSON.stringify(result.newTodos, null, 0))
    console.log('[smoke:qwen] resolved=' + JSON.stringify(result.resolved))
    const ok = models.ok && Array.isArray(result.newTodos)
    console.log('[smoke:qwen] PASS=' + ok)
    process.exitCode = ok ? 0 : 1
  } finally {
    try { rmSync(entryFile, { force: true }) } catch {}
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

main().catch((err) => {
  console.error('[smoke:qwen] FATAL: ' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
