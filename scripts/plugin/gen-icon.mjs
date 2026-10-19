// Generates the plugin page icon (src/plugin/ui/icon.png, 256x256 RGBA PNG), reproducibly, from the shapes below.
//   node scripts/plugin/gen-icon.mjs [--check]     --check: fail if the committed icon.png differs from what the shapes produce
// Style: the TeamUQ sidebar icons (16-unit grid, stroke 1.4, round caps/joins, one colour #737373, transparent background), same rasteriser as
// ai-lover / speech-funasr (scripts/plugin/lib/icon-raster.mjs is an identical copy). Theme: a todo board (card with a header line and a check mark).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from './lib/paths.mjs'
import { Shape, iconPng } from './lib/icon-raster.mjs'

export function shape() {
  const s = new Shape()
  s.rect(2.2, 2.2, 11.6, 11.6, 2.2)
  s.M(2.2, 5.9).L(13.8, 5.9)
  s.M(5.1, 10).L(7.1, 12).L(10.9, 8.1)
  return s
}

export const ICON_FILE = path.join(ROOT, 'src', 'plugin', 'ui', 'icon.png')

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const { png } = iconPng(shape(), { size: 256, color: '#737373', stroke: 1.4 })
  if (process.argv.includes('--check')) {
    if (!fs.readFileSync(ICON_FILE).equals(png)) { console.error('src/plugin/ui/icon.png differs from the generated icon; run node scripts/plugin/gen-icon.mjs'); process.exit(1) }
    console.error(`icon.png matches the generator (${png.length} bytes)`)
  } else {
    fs.writeFileSync(ICON_FILE, png)
    console.error(`wrote ${ICON_FILE} (${png.length} bytes)`)
  }
}
