// Stand-in for `require('electron')` in the plugin backend bundle (esbuild resolve plugin). The engine modules probe
// `require('electron')?.app?.getPath('userData')` inside try/catch and fall back to explicit paths; the plugin always passes
// explicit dataDir paths, so an empty module is the correct (and quiet) answer.
module.exports = {}
