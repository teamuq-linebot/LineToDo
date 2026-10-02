// A minimal DOM — just enough for the REAL react-dom/client (React 18, production build) to mount, update and unmount plain elements in node:test,
// so effects, state updates and catch blocks of the real components actually run (a server render runs none of them).
//
// Not a browser: no layout, no CSS, no event dispatch. Tests call a React handler directly through the props React keeps on each DOM node
// (`reactProps(el).onClick(...)`), which is the same function React would call for a click.
// install() must run BEFORE react-dom is imported (react-dom checks `window` / `document` when it loads).

const HTML_NS = 'http://www.w3.org/1999/xhtml'

class Node {
  constructor(nodeType, nodeName, ownerDocument) {
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.ownerDocument = ownerDocument
    this.parentNode = null
    this.childNodes = []
    this.listeners = new Map()
  }
  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null }
  get previousSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] ?? null }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null }
  appendChild(child) { return this.insertBefore(child, null) }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child)
    const index = ref ? this.childNodes.indexOf(ref) : -1
    if (index < 0) this.childNodes.push(child)
    else this.childNodes.splice(index, 0, child)
    child.parentNode = this
    return child
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child)
    if (index < 0) throw new Error('removeChild: not a child')
    this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true
    return false
  }
  get textContent() {
    if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue
    return this.childNodes.filter((c) => c.nodeType !== 8).map((c) => c.textContent).join('')
  }
  set textContent(value) {
    for (const c of this.childNodes) c.parentNode = null
    this.childNodes = []
    const text = value == null ? '' : String(value)
    if (text !== '') this.appendChild(this.ownerDocument.createTextNode(text))
  }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener) }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
}

class Text extends Node {
  constructor(value, doc) { super(3, '#text', doc); this.nodeValue = String(value) }
  get data() { return this.nodeValue }
  set data(v) { this.nodeValue = String(v) }
}

class Comment extends Node {
  constructor(value, doc) { super(8, '#comment', doc); this.nodeValue = String(value) }
}

class Style {
  setProperty(name, value) { this[name] = value }
  removeProperty(name) { delete this[name] }
}

class Element extends Node {
  constructor(tag, doc, namespaceURI = HTML_NS) {
    super(1, tag.toUpperCase(), doc)
    this.tagName = tag.toUpperCase()
    this.localName = tag.toLowerCase()
    this.namespaceURI = namespaceURI
    this.attributes = new Map()
    this.style = new Style()
    this.name = ''
    this.selectionStart = 0
    this.selectionEnd = 0
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  get id() { return this.getAttribute('id') ?? '' }
  get options() { return walk(this).filter((n) => n.localName === 'option') }
  focus() { this.ownerDocument.activeElement = this }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body }
  querySelectorAll() { return [] }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } }
  scrollIntoView() {}
  get offsetParent() { return this.parentNode }
}

class Document extends Node {
  constructor() {
    super(9, '#document', null)
    this.ownerDocument = null
    this.documentElement = new Element('html', this)
    this.body = new Element('body', this)
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
    this.activeElement = this.body
  }
  createElement(tag) { return new Element(tag, this) }
  createElementNS(ns, tag) { return new Element(tag, this, ns) }
  createTextNode(text) { return new Text(text, this) }
  createComment(text) { return new Comment(text, this) }
  getElementById() { return null }
}

/** every element under `root` (depth first, root included) */
export function walk(root) {
  const out = []
  const visit = (n) => { if (n.nodeType === 1) out.push(n); for (const c of n.childNodes) visit(c) }
  visit(root)
  return out
}

/** the props React attached to a host node (React's own handlers, the same ones it would call for a real event) */
export function reactProps(el) {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'))
  if (!key) throw new Error(`no React props on <${el.localName}>`)
  return el[key]
}

/** the first element whose own text (trimmed) equals / matches `text`, optionally limited to a tag */
export function byText(root, text, tag) {
  return walk(root).find((el) => (!tag || el.localName === tag) && (typeof text === 'string' ? el.textContent.trim() === text : text.test(el.textContent))) ?? null
}

export function byAttr(root, name, value) {
  return walk(root).find((el) => el.getAttribute(name) === value) ?? null
}

/** Install `window` / `document` globals. Returns the document and a restore function. */
export function install() {
  const previous = { window: globalThis.window, document: globalThis.document }
  const document = new Document()
  const storage = new Map()
  const window = {
    document,
    HTMLIFrameElement: class HTMLIFrameElement {},
    event: undefined,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    confirm: () => true,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)) },
      removeItem: (k) => { storage.delete(k) },
      key: (i) => [...storage.keys()][i] ?? null,
      get length() { return storage.size }
    },
    setTimeout, clearTimeout, setInterval, clearInterval
  }
  document.defaultView = window
  globalThis.window = window
  globalThis.document = document
  return {
    document,
    window,
    restore() {
      if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window
      if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document
    }
  }
}
