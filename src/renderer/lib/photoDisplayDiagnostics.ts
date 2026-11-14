/** Explicitly requested, privacy-filtered rendering facts for visible photo groups. */
export type PhotoDisplayDiagnostics = {
  capturedAt: string
  environment: { chromium: string | null; electron: string | null }
  devicePixelRatio: number
  viewport: { width: number; height: number; visualScale: number | null }
  imageCount: number
  distinctSourceCount: number
  groups: Array<{
    imageCount: number
    images: Array<{
      natural: { width: number; height: number }
      rendered: { width: number; height: number }
      layers: Array<{
        level: number
        tag: string
        opacity: number | null
        hasFilter: boolean
        hasTransform: boolean
        hasAnimation: boolean
        zoom: number | null
        imageRendering: 'auto' | 'smooth' | 'high-quality' | 'crisp-edges' | 'pixelated' | 'other'
        hasBackgroundImage: boolean
      }>
    }>
  }>
}

function visibleInViewport(element: Element, win: Window): boolean {
  const rect = element.getBoundingClientRect()
  const style = win.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
    rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth
}

function version(userAgent: string, name: 'Chrome' | 'Electron'): string | null {
  return userAgent.match(new RegExp(`${name}/([0-9.]+)`))?.[1] ?? null
}

function numericStyle(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function imageRenderingStyle(value: string): PhotoDisplayDiagnostics['groups'][number]['images'][number]['layers'][number]['imageRendering'] {
  return ['auto', 'smooth', 'high-quality', 'crisp-edges', 'pixelated'].includes(value)
    ? value as PhotoDisplayDiagnostics['groups'][number]['images'][number]['layers'][number]['imageRendering']
    : 'other'
}

export function collectPhotoDisplayDiagnostics(doc: Document = document, win: Window = window): PhotoDisplayDiagnostics {
  const groups = Array.from(doc.querySelectorAll<HTMLElement>('.chat-message-photo-group')).filter((group) => visibleInViewport(group, win))
  const sources = new Set<string>()
  let imageCount = 0
  const inspectedGroups = groups.map((group) => {
    const images = Array.from(group.querySelectorAll<HTMLImageElement>('.sm-thumb'))
    imageCount += images.length
    return {
      imageCount: images.length,
      images: images.map((image) => {
        const source = image.currentSrc || image.src
        if (source) sources.add(source)
        const rect = image.getBoundingClientRect()
        const layers: PhotoDisplayDiagnostics['groups'][number]['images'][number]['layers'] = []
        let node: Element | null = image
        let level = 0
        while (node && level < 10) {
          const style = win.getComputedStyle(node)
          layers.push({
            level,
            tag: node.tagName.toLowerCase(),
            opacity: numericStyle(style.opacity),
            hasFilter: style.filter !== 'none',
            hasTransform: style.transform !== 'none',
            hasAnimation: style.animationName !== 'none',
            zoom: numericStyle(style.zoom),
            imageRendering: imageRenderingStyle(style.imageRendering),
            hasBackgroundImage: style.backgroundImage !== 'none'
          })
          if (node === group) break
          node = node.parentElement
          level += 1
        }
        return {
          natural: { width: image.naturalWidth, height: image.naturalHeight },
          rendered: { width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 },
          layers
        }
      })
    }
  })
  const userAgent = win.navigator.userAgent
  return {
    capturedAt: new Date().toISOString(),
    environment: { chromium: version(userAgent, 'Chrome'), electron: version(userAgent, 'Electron') },
    devicePixelRatio: win.devicePixelRatio,
    viewport: {
      width: win.innerWidth,
      height: win.innerHeight,
      visualScale: win.visualViewport?.scale ?? null
    },
    imageCount,
    distinctSourceCount: sources.size,
    groups: inspectedGroups
  }
}
