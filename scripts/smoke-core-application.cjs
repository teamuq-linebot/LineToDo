const { app } = require('electron')
const esbuild = require('esbuild')
const Module = require('node:module')
const path = require('node:path')

async function run() {
  await app.whenReady()
  try {
    const result = await esbuild.build({
      entryPoints: [path.join(process.cwd(), 'scripts', 'smoke-core-application.ts')],
      bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false,
      external: ['better-sqlite3', 'koffi', 'electron']
    })
    const filename = path.join(process.cwd(), 'scripts', '.smoke-core-application.bundle.cjs')
    const compiled = new Module(filename, module)
    compiled.filename = filename
    compiled.paths = Module._nodeModulePaths(process.cwd())
    compiled._compile(result.outputFiles[0].text, filename)
    await compiled.exports.smoke
  } finally {
    app.quit()
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
