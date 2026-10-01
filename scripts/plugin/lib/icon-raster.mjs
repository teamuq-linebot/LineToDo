// Tiny deterministic icon rasteriser: thin round-capped strokes (the TeamUQ sidebar icon style: 16-unit grid, stroke 1.4, round caps and
// joins, one colour) drawn into an RGBA PNG. Only + - * / and sqrt are used (no trig), so the output is bit-identical on every machine.
// The same file lives in ai-lover and speech-funasr; keep them identical.
import zlib from 'node:zlib'

const GRID = 16
const KAPPA = 0.5522847498307936 // circle -> cubic bezier

// path builder: collects polylines (arrays of [x, y] in grid units)
export class Shape {
  constructor() { this.lines = []; this.cur = null }
  M(x, y) { this.cur = [[x, y]]; this.lines.push(this.cur); return this }
  L(x, y) { this.cur.push([x, y]); return this }
  C(x1, y1, x2, y2, x, y) {
    const [x0, y0] = this.cur[this.cur.length - 1]
    const steps = 24
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps; const u = 1 - t
      const a = u * u * u; const b = 3 * u * u * t; const c = 3 * u * t * t; const d = t * t * t
      this.cur.push([a * x0 + b * x1 + c * x2 + d * x, a * y0 + b * y1 + c * y2 + d * y])
    }
    return this
  }
  Z() { this.cur.push(this.cur[0]); return this }
  // rounded rectangle, clockwise from the top edge
  rect(x, y, w, h, r) {
    const k = r * KAPPA
    return this.M(x + r, y).L(x + w - r, y).C(x + w - r + k, y, x + w, y + r - k, x + w, y + r)
      .L(x + w, y + h - r).C(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h)
      .L(x + r, y + h).C(x + r - k, y + h, x, y + h - r + k, x, y + h - r)
      .L(x, y + r).C(x, y + r - k, x + r - k, y, x + r, y).Z()
  }
}

// coverage of a stroke of width `stroke` (grid units) at every pixel of a size x size canvas
export function renderCoverage(shape, size, stroke = 1.4, pad = 0) {
  const scale = size / GRID
  const half = (stroke * scale) / 2
  const segments = []
  for (const line of shape.lines) {
    for (let i = 1; i < line.length; i += 1) {
      segments.push([line[i - 1][0] * scale, line[i - 1][1] * scale, line[i][0] * scale, line[i][1] * scale])
    }
  }
  const alpha = new Float64Array(size * size)
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const cx = px + 0.5 - pad; const cy = py + 0.5 - pad
      let best = Infinity
      for (const [ax, ay, bx, by] of segments) {
        const dx = bx - ax; const dy = by - ay
        const len2 = dx * dx + dy * dy
        let t = len2 === 0 ? 0 : ((cx - ax) * dx + (cy - ay) * dy) / len2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const ex = ax + t * dx - cx; const ey = ay + t * dy - cy
        const d2 = ex * ex + ey * ey
        if (d2 < best) best = d2
      }
      const v = half + 0.5 - Math.sqrt(best)
      alpha[py * size + px] = v < 0 ? 0 : v > 1 ? 1 : v
    }
  }
  return alpha
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

// RGBA 8-bit PNG, filter 0, no ancillary chunks: the bytes depend only on the pixels
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const hexToRgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]

// single-colour icon: RGB constant, alpha = stroke coverage
export function iconPng(shape, { size = 256, color = '#737373', stroke = 1.4 } = {}) {
  const alpha = renderCoverage(shape, size, stroke)
  const [r, g, b] = hexToRgb(color)
  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = Math.round(alpha[i] * 255)
  }
  return { png: encodePng(size, size, rgba), size, rgba }
}

// contact sheet for the evidence: the icon at full size and at 1/8 size (32 px for a 256 px icon), on a light and a dark background
export function previewPng(rgba, size, { light = '#ffffff', dark = '#1e1e1e', factor = 8, gap = 16 } = {}) {
  const n = size / factor
  const mini = Buffer.alloc(n * n * 4)
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) {
    let sum = 0
    for (let j = 0; j < factor; j += 1) for (let i = 0; i < factor; i += 1) sum += rgba[((y * factor + j) * size + x * factor + i) * 4 + 3]
    const o = (y * n + x) * 4
    mini[o] = rgba[0]; mini[o + 1] = rgba[1]; mini[o + 2] = rgba[2]; mini[o + 3] = Math.round(sum / (factor * factor))
  }
  const width = gap + (size + gap) * 2
  const height = gap + size + gap + n + gap
  const out = Buffer.alloc(width * height * 4)
  const fill = (x0, y0, w, h, hex) => {
    const [r, g, b] = hexToRgb(hex)
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) { const o = (y * width + x) * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255 }
  }
  const blend = (x0, y0, side, data) => {
    for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) {
      const s = (y * side + x) * 4; const a = data[s + 3] / 255; const o = ((y0 + y) * width + x0 + x) * 4
      for (let c = 0; c < 3; c += 1) out[o + c] = Math.round(data[s + c] * a + out[o + c] * (1 - a))
    }
  }
  fill(0, 0, width, height, '#c8c8c8')
  const left = gap; const right = gap + size + gap; const top = gap; const bottom = gap + size + gap
  fill(left, top, size, size, light); fill(right, top, size, size, dark)
  fill(left, bottom, size, n, light); fill(right, bottom, size, n, dark)
  blend(left, top, size, rgba); blend(right, top, size, rgba); blend(left, bottom, n, mini); blend(right, bottom, n, mini)
  return encodePng(width, height, out)
}
