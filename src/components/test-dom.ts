// A DOM just large enough for React 19 to render a component and dispatch a click in Vitest
// (node environment, no jsdom). Not a browser: attributes, bubbling clicks, and form values only.

type Listener = (event: DomEvent) => void

class DomEvent {
  type: string
  bubbles: boolean
  cancelable: boolean
  defaultPrevented = false
  cancelBubble = false
  target: DomNode | null = null
  currentTarget: DomNode | null = null
  button = 0
  ctrlKey = false
  metaKey = false
  shiftKey = false
  altKey = false
  timeStamp = 0
  key = ''
  keyCode = 0
  which = 0
  isComposing = false
  constructor(type: string, bubbles = true) {
    this.type = type
    this.bubbles = bubbles
    this.cancelable = true
  }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() { this.cancelBubble = true }
}

class DomNode {
  nodeType: number
  nodeName: string
  ownerDocument: DomDocument | null = null
  parentNode: DomNode | null = null
  childNodes: DomNode[] = []
  nodeValue: string | null = null
  constructor(nodeType: number, nodeName: string) {
    this.nodeType = nodeType
    this.nodeName = nodeName
  }
  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
  get nextSibling(): DomNode | null {
    const siblings = this.parentNode?.childNodes
    if (!siblings) return null
    const index = siblings.indexOf(this)
    return index >= 0 ? siblings[index + 1] ?? null : null
  }
  get previousSibling(): DomNode | null {
    const siblings = this.parentNode?.childNodes
    if (!siblings) return null
    const index = siblings.indexOf(this)
    return index > 0 ? siblings[index - 1] : null
  }
  get parentElement(): DomElement | null {
    return this.parentNode instanceof DomElement ? this.parentNode : null
  }
  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue ?? ''
    return this.childNodes.map((child) => child.textContent).join('')
  }
  set textContent(value: string) {
    this.childNodes = []
    if (value) this.appendChild(this.ownerDocument?.createTextNode(value) ?? new DomNode(3, '#text'))
  }
  get isConnected() {
    let node: DomNode | null = this
    while (node) {
      if (node === this.ownerDocument) return true
      node = node.parentNode
    }
    return false
  }
  contains(other: DomNode | null) {
    let node = other
    while (node) {
      if (node === this) return true
      node = node.parentNode
    }
    return false
  }
  appendChild<T extends DomNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    child.ownerDocument = this.ownerDocument
    this.childNodes.push(child)
    return child
  }
  insertBefore<T extends DomNode>(child: T, ref: DomNode | null): T {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    child.ownerDocument = this.ownerDocument
    const index = ref ? this.childNodes.indexOf(ref) : -1
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child)
    return child
  }
  removeChild<T extends DomNode>(child: T): T {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }
  addEventListener(_type: string, _listener: Listener, _options?: boolean | object) { /* elements override */ }
  removeEventListener(_type: string, _listener: Listener, _options?: boolean | object) { /* elements override */ }
  dispatchEvent(event: DomEvent) {
    event.target = this
    let node: DomNode | null = this
    while (node) {
      event.currentTarget = node
      node.dispatchToSelf(event)
      if (event.cancelBubble || !event.bubbles) break
      node = node.parentNode
    }
    return !event.defaultPrevented
  }
  dispatchToSelf(_event: DomEvent) { /* elements override */ }
}

class DomElement extends DomNode {
  tagName: string
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  attributes = new Map<string, string>()
  style: { setProperty: (name: string, value: string) => void; getPropertyValue: (name: string) => string; cssText: string } & Record<string, string>
  listeners = new Map<string, Listener[]>()
  className = ''
  id = ''
  value = ''
  disabled = false
  tabIndex = 0
  type = ''
  constructor(tag: string) {
    super(1, tag.toUpperCase())
    this.tagName = tag.toUpperCase()
    const style = {
      setProperty: (name: string, value: string) => { style[name] = value },
      getPropertyValue: (name: string) => style[name] ?? '',
      cssText: '',
    } as DomElement['style']
    this.style = style
    if (tag.toLowerCase() === 'input' && !this.type) this.type = 'text'
  }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()))
    if (selector.startsWith('.')) {
      const own = new Set(this.className.split(/\s+/).filter(Boolean))
      return selector.split('.').filter(Boolean).every((name) => own.has(name))
    }
    const attribute = /^\[([^=\]]+)="([^"]*)"\]$/.exec(selector)
    if (attribute) return this.getAttribute(attribute[1]) === attribute[2]
    return this.tagName.toLowerCase() === selector.toLowerCase()
  }
  querySelectorAll(selector: string): DomElement[] {
    const found: DomElement[] = []
    const visit = (node: DomNode) => {
      for (const child of node.childNodes) {
        if (child instanceof DomElement) {
          if (child.matches(selector)) found.push(child)
          visit(child)
        }
      }
    }
    visit(this)
    return found
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
  closest(selector: string): DomElement | null {
    let node: DomNode | null = this
    while (node) {
      if (node instanceof DomElement && node.matches(selector)) return node
      node = node.parentNode
    }
    return null
  }
  scrollIntoView() { /* no layout */ }
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 } }
  setSelectionRange() { /* caret is not simulated */ }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value))
    if (name === 'class') this.className = String(value)
    if (name === 'id') this.id = String(value)
    if (name === 'value') this.value = String(value)
    if (name === 'type') this.type = String(value)
    if (name === 'disabled') this.disabled = true
  }
  getAttribute(name: string) {
    if (name === 'class') return this.className || null
    return this.attributes.get(name) ?? null
  }
  hasAttribute(name: string) { return this.attributes.has(name) || (name === 'class' && Boolean(this.className)) }
  removeAttribute(name: string) {
    this.attributes.delete(name)
    if (name === 'class') this.className = ''
    if (name === 'disabled') this.disabled = false
  }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value) }
  removeAttributeNS(_namespace: string, name: string) { this.removeAttribute(name) }
  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, listener: Listener) {
    const list = (this.listeners.get(type) ?? []).filter((item) => item !== listener)
    this.listeners.set(type, list)
  }
  dispatchToSelf(event: DomEvent) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener.call(this, event)
  }
  focus() { this.ownerDocument && (this.ownerDocument.activeElement = this) }
  blur() { if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null }
  get innerHTML() { return this.textContent }
  set innerHTML(value: string) { this.textContent = value.replace(/<[^>]*>/g, '') }
  click() {
    this.dispatchEvent(new DomEvent('click'))
  }
  get clientHeight() { return 0 }
  get clientWidth() { return 0 }
  get scrollHeight() { return 0 }
  get scrollTop() { return 0 }
  set scrollTop(_value: number) { /* layout is not simulated */ }
  get classList() {
    const element = this
    return {
      add: (...names: string[]) => {
        const own = new Set(element.className.split(/\s+/).filter(Boolean))
        for (const name of names) own.add(name)
        element.className = [...own].join(' ')
      },
      remove: (...names: string[]) => {
        const drop = new Set(names)
        element.className = element.className.split(/\s+/).filter((name) => name && !drop.has(name)).join(' ')
      },
      contains: (name: string) => element.className.split(/\s+/).includes(name),
    }
  }
}

class DomRange {
  startContainer: DomNode | null = null
  endContainer: DomNode | null = null
  startOffset = 0
  endOffset = 0
  setStart(node: DomNode, offset: number) { this.startContainer = node; this.startOffset = offset }
  setEnd(node: DomNode, offset: number) { this.endContainer = node; this.endOffset = offset }
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 } }
}

class DomTreeWalker {
  private nodes: DomNode[] = []
  private index = -1
  currentNode: DomNode
  constructor(root: DomNode, filter: { acceptNode: (node: DomNode) => number } | null) {
    const visit = (node: DomNode) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const verdict = filter ? filter.acceptNode(child) : 1
          if (verdict === 1) this.nodes.push(child)
        }
        visit(child)
      }
    }
    visit(root)
    this.currentNode = root
  }
  nextNode() {
    this.index += 1
    const node = this.nodes[this.index]
    if (!node) return null
    this.currentNode = node
    return node
  }
}

class DomDocument extends DomNode {
  documentElement: DomElement
  body: DomElement
  head: DomElement
  activeElement: DomElement | null = null
  defaultView: unknown
  hidden = false
  constructor() {
    super(9, '#document')
    this.ownerDocument = this
    this.documentElement = new DomElement('html')
    this.head = new DomElement('head')
    this.body = new DomElement('body')
    this.appendChild(this.documentElement)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }
  createElement(tag: string) {
    const element = new DomElement(tag)
    element.ownerDocument = this
    return element
  }
  createElementNS(_namespace: string, tag: string) { return this.createElement(tag) }
  createTextNode(text: string) {
    const node = new DomNode(3, '#text')
    node.nodeValue = String(text)
    node.ownerDocument = this
    return node
  }
  createComment(text: string) {
    const node = new DomNode(8, '#comment')
    node.nodeValue = String(text)
    node.ownerDocument = this
    return node
  }
  createDocumentFragment() {
    const node = new DomNode(11, '#document-fragment')
    node.ownerDocument = this
    return node
  }
  createTreeWalker(root: DomNode, _whatToShow: number, filter?: { acceptNode: (node: DomNode) => number } | null) {
    return new DomTreeWalker(root, filter ?? null)
  }
  createRange() { return new DomRange() }
}

// React decides once, at load, whether `input` events can drive onChange. The check is `oninput in document`.
for (const name of ['click', 'input', 'change', 'keydown', 'keyup', 'keypress', 'submit', 'focus', 'blur']) {
  Object.defineProperty(DomDocument.prototype, `on${name}`, { writable: true, configurable: true, value: null })
}

const memoryStorage = new Map<string, string>()
const localStorage = {
  getItem: (key: string) => memoryStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { memoryStorage.set(key, String(value)) },
  removeItem: (key: string) => { memoryStorage.delete(key) },
  clear: () => { memoryStorage.clear() },
}
// Composer reads `location` while its module loads. Installing it here, before that import, keeps tests off the network.
if (typeof globalThis.location === 'undefined') {
  Object.assign(globalThis, { location: { search: '', href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' } })
}

/** Installs the shim on the global object. Returns a container React can render into. */
export function installTestDom() {
  memoryStorage.clear()
  const document = new DomDocument()
  class DomIframe extends DomElement {
    contentWindow: unknown = null
    constructor() { super('iframe') }
  }
  const window = {
    document,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    HTMLElement: DomElement,
    HTMLIFrameElement: DomIframe,
    Element: DomElement,
    Node: DomNode,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    getSelection: () => null,
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (...args: Parameters<typeof clearInterval>) => clearInterval(...args),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  document.defaultView = window
  Object.assign(window, { localStorage })
  Object.assign(globalThis, {
    document, window, localStorage, HTMLElement: DomElement, Element: DomElement, Node: DomNode, IS_REACT_ACT_ENVIRONMENT: true,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { document, container, DomEvent, DomElement }
}

export function walkElements(root: DomNode, visit: (element: DomElement) => boolean): DomElement | null {
  const step = (node: DomNode): DomElement | null => {
    if (node instanceof DomElement && visit(node)) return node
    for (const child of node.childNodes) {
      const found = step(child)
      if (found) return found
    }
    return null
  }
  return step(root)
}

export function buttonByText(root: DomNode, text: string) {
  return walkElements(root, (element) => element.tagName === 'BUTTON' && element.textContent.trim() === text)
}

export function fieldByLabel(root: DomNode, label: string) {
  return walkElements(root, (element) => (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') && element.getAttribute('aria-label') === label)
}

export function typeInto(element: DomElement, value: string) {
  element.value = value
  element.dispatchEvent(new DomEvent('input'))
}

export function pressKey(element: DomElement, key: string, extra: { keyCode?: number; isComposing?: boolean } = {}) {
  const event = new DomEvent('keydown')
  event.key = key
  event.keyCode = extra.keyCode ?? (extra.isComposing ? 229 : 0)
  event.which = event.keyCode
  event.isComposing = Boolean(extra.isComposing)
  element.dispatchEvent(event)
}

// React reads `window.document` once, while its module loads. The test file imports this module first.
installTestDom()
