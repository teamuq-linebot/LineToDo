import assert from 'node:assert/strict'
import test from 'node:test'
import { collectPhotoDisplayDiagnostics } from '../src/renderer/lib/photoDisplayDiagnostics.ts'

test('photo display diagnostics mask URL-bearing computed CSS and never serialize image sources', () => {
  const rect = { width: 120, height: 80, left: 10, right: 130, top: 10, bottom: 90 }
  const group = {
    tagName: 'LI', parentElement: null,
    getBoundingClientRect: () => rect,
    querySelectorAll: () => [image]
  }
  const image = {
    tagName: 'IMG', parentElement: group, currentSrc: 'https://private.invalid/media/opaque', src: 'https://private.invalid/media/opaque', naturalWidth: 1474, naturalHeight: 1110,
    getBoundingClientRect: () => rect
  }
  const win = {
    innerWidth: 800, innerHeight: 600, devicePixelRatio: 1.5, visualViewport: { scale: 1 },
    navigator: { userAgent: 'Mozilla Chrome/157.0.0.0 Electron/41.1.0' },
    getComputedStyle: (element) => ({
      display: 'block', visibility: 'visible', opacity: '0.8', filter: element === image ? 'url("#secret-filter-token")' : 'none',
      transform: 'matrix(1, 0, 0, 1, 2, 3)', animationName: element === image ? 'private-animation-name' : 'none', animationDuration: '0s', animationDelay: '0s', animationIterationCount: '1', zoom: '1.5',
      imageRendering: 'high-quality', backgroundImage: element === image ? 'url("#secret-background-token")' : 'none'
    })
  }
  const payload = collectPhotoDisplayDiagnostics({ querySelectorAll: () => [group] }, win)
  const serialized = JSON.stringify(payload)
  assert.equal(payload.imageCount, 1)
  assert.equal(payload.distinctSourceCount, 1)
  assert.equal(payload.groups[0].images[0].layers[0].hasFilter, true)
  assert.equal(payload.groups[0].images[0].layers[0].hasTransform, true)
  assert.equal(payload.groups[0].images[0].layers[0].hasAnimation, true)
  assert.equal(payload.groups[0].images[0].layers[0].opacity, 0.8)
  assert.equal(payload.groups[0].images[0].layers[0].zoom, 1.5)
  assert.equal(payload.groups[0].images[0].layers[0].imageRendering, 'high-quality')
  assert.equal(payload.groups[0].images[0].layers[0].hasBackgroundImage, true)
  assert.doesNotMatch(serialized, /#secret|private-animation|https?:|url\(/i)
})
