// Small packaging helpers shared by the build, the verifier and the tests. The container itself is written by the official
// author tool (lib/tuqTool.mjs, `pack --unsigned`); nothing here signs or reads a key (G-08 / G-09).
import crypto from 'node:crypto'

export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex')

export function parseArgs(argv) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=')
      if (inline !== undefined) out[key] = inline
      else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) { out[key] = argv[index + 1]; index += 1 } else out[key] = true
    } else out._.push(token)
  }
  return out
}
