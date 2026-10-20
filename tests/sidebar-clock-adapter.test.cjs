'use strict'
// Contract tests for the sidebar-clock DOM adapter (docs/plugin-reflections.md P0-4).
//
// The adapter source is sliced out of the shipped dsh-sidebar-clock/client.js
// between the `sidebar-shell-adapter:start/end` markers, so this test exercises
// the real code rather than a copy. The DOM is a minimal stub and the sidebar
// structure comes from tests/fixtures/sidebar-shell-0.2.1-rc.2.html, captured
// from the installed 0.2.1-rc.2 shell (see docs/compatibility.md).
const fs = require('node:fs')
const path = require('node:path')

const clientPath = path.join(__dirname, '..', 'dsh-sidebar-clock', 'client.js')
const fixturePath = path.join(__dirname, 'fixtures', 'sidebar-shell-0.2.1-rc.2.html')
const source = fs.readFileSync(clientPath, 'utf8')
const fixtureHtml = fs.readFileSync(fixturePath, 'utf8')

const startMarker = '// sidebar-shell-adapter:start'
const endMarker = '// sidebar-shell-adapter:end'
const start = source.indexOf(startMarker)
const end = source.indexOf(endMarker)
if (start < 0 || end < 0 || end <= start) throw new Error('sidebar adapter slice markers not found')
const adapterSource = source.slice(start, end)

// ---------------------------------------------------------------------------
// Minimal DOM stub: only what the adapter may legitimately touch.
// ---------------------------------------------------------------------------

class FakeClassList {
  constructor() {
    this.values = new Set()
  }

  add(...names) {
    for (const name of names) this.values.add(name)
  }

  remove(...names) {
    for (const name of names) this.values.delete(name)
  }

  contains(name) {
    return this.values.has(name)
  }
}

function datasetKey(attributeName) {
  return attributeName
    .slice('data-'.length)
    .replace(/-([a-z])/g, (_, character) => character.toUpperCase())
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.parentNode = null
    this.children = []
    this.classList = new FakeClassList()
    this.dataset = {}
    this.attributes = {}
  }

  get className() {
    return [...this.classList.values].join(' ')
  }

  set className(value) {
    this.classList.values = new Set(String(value).trim().split(/\s+/).filter(Boolean))
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name.startsWith('data-')) this.dataset[datasetKey(name)] = String(value)
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }

  insertBefore(node, reference) {
    if (!node || typeof node !== 'object') throw new TypeError('insertBefore: node is not an element')
    const index =
      reference === null || reference === undefined ? this.children.length : this.children.indexOf(reference)
    if (index < 0) throw new Error('insertBefore: reference node is not a child')
    if (node.parentNode) node.parentNode.removeChild(node)
    this.children.splice(index, 0, node)
    node.parentNode = this
    return node
  }

  appendChild(node) {
    return this.insertBefore(node, null)
  }

  removeChild(node) {
    const index = this.children.indexOf(node)
    if (index < 0) throw new Error('removeChild: node is not a child')
    this.children.splice(index, 1)
    node.parentNode = null
    return node
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  matches(selector) {
    return typeof selector === 'string' && selector.startsWith('.')
      ? this.classList.contains(selector.slice(1))
      : false
  }

  closest(selector) {
    let node = this
    while (node) {
      if (node.matches(selector)) return node
      node = node.parentNode
    }
    return null
  }

  contains(node) {
    let current = node
    while (current) {
      if (current === this) return true
      current = current.parentNode
    }
    return false
  }
}

class FakeDocument {
  constructor() {
    this.elements = []
  }

  createElement(tagName) {
    const element = new FakeElement(tagName, this)
    this.elements.push(element)
    return element
  }

  querySelector(selector) {
    for (const element of this.elements) {
      if (element.matches(selector)) return element
    }
    return null
  }
}

// Parse the fixture's outerHTML into the stub DOM. The fixture only uses
// double-quoted attributes, nested div/span/button/nav elements and comments.
function applyAttributes(element, text) {
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  let match
  while ((match = attributePattern.exec(text)) !== null) {
    const name = match[1]
    const value =
      match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : ''
    if (name === 'class') element.className = value
    else element.setAttribute(name, value)
  }
}

function parseFixture(html) {
  const document = new FakeDocument()
  const text = html.replace(/<!--[\s\S]*?-->/g, '')
  const tagPattern =
    /<\s*(\/?)\s*([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g
  const stack = []
  let root = null
  let match
  while ((match = tagPattern.exec(text)) !== null) {
    const closing = match[1] === '/'
    const tagName = match[2]
    const attributes = match[3] || ''
    const selfClosing = match[4] === '/'
    if (closing) {
      if (stack.length > 0 && stack[stack.length - 1].tagName.toLowerCase() === tagName.toLowerCase()) stack.pop()
      continue
    }
    const element = document.createElement(tagName)
    applyAttributes(element, attributes)
    if (stack.length > 0) stack[stack.length - 1].appendChild(element)
    else if (root === null) root = element
    if (!selfClosing) stack.push(element)
  }
  if (root === null) throw new Error('fixture parse produced no root element')
  return { document, root }
}

function findClass(node, className) {
  if (node.classList.contains(className)) return node
  for (const child of node.children) {
    const found = findClass(child, className)
    if (found) return found
  }
  return null
}

function sameNodes(left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Loader + assertion helpers
// ---------------------------------------------------------------------------

function loadAdapter(consoleApi) {
  const factory = new Function(
    'console',
    adapterSource + '\nreturn { SIDEBAR_SHELL, createTopCardHost }',
  )
  return factory(consoleApi)
}

function captureWarnings() {
  const warnings = []
  return {
    warnings,
    console: {
      warn(...args) {
        warnings.push(args.map((value) => String(value)).join(' '))
      },
    },
  }
}

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log('ok   ' + name + ' = ' + a)
  } else {
    failures += 1
    console.log('FAIL ' + name + ': got ' + a + ', expected ' + e)
  }
}

function noThrow(name, callback) {
  try {
    callback()
    console.log('ok   ' + name + ' does not throw')
  } catch (error) {
    failures += 1
    console.log('FAIL ' + name + ' threw: ' + (error && error.message ? error.message : String(error)))
  }
}

const capture = captureWarnings()
const adapter = loadAdapter(capture.console)
const SHELL = adapter.SIDEBAR_SHELL

/** Build the fixture DOM, put the plugin's hidden anchor in the footer, and return handles. */
function mountScenario(map, options = {}) {
  const { document, root } = parseFixture(fixtureHtml)
  const logoRow = findClass(root, map.logoRow)
  const newSession = findClass(root, map.newSession)
  const footerActions = findClass(root, '_2H3hWW_footerActions')
  if (!logoRow || !newSession || !footerActions) throw new Error('fixture is missing a required shell node')
  const anchor = document.createElement('span')
  anchor.className = 'dsh-sc-anchor'
  anchor.setAttribute('data-sidebar-clock-anchor', '')
  if (options.outsideRoot) {
    const outside = document.createElement('div')
    outside.appendChild(anchor)
  } else {
    footerActions.appendChild(anchor)
  }
  return { document, root, logoRow, newSession, footerActions, anchor }
}

console.log('adapter source: ' + path.relative(process.cwd(), clientPath) + ' (DSH ' + SHELL.dshVersion + ')')
console.log('fixture: ' + path.relative(process.cwd(), fixturePath) + ' (' + fixtureHtml.length + ' bytes)')

// ---------------------------------------------------------------------------
// Versioned class map + fixture provenance
// ---------------------------------------------------------------------------

check('shell map version', SHELL.dshVersion, '0.2.1-rc.2')
check('fixture filename matches shell map version', path.basename(fixturePath), 'sidebar-shell-' + SHELL.dshVersion + '.html')
check('shell map is frozen', Object.isFrozen(SHELL), true)
{
  const { root } = parseFixture(fixtureHtml)
  check('fixture root class matches shell map', findClass(root, SHELL.root) === root, true)
  check('fixture logo row class matches shell map', Boolean(findClass(root, SHELL.logoRow)), true)
  check('fixture new-session class matches shell map', Boolean(findClass(root, SHELL.newSession)), true)
  check('fixture keeps the footer action cell inside the root', Boolean(findClass(root, '_2H3hWW_footerActions')), true)
}

// ---------------------------------------------------------------------------
// Happy path: insert our own host right before New Session, remove only it
// ---------------------------------------------------------------------------

{
  const scenario = mountScenario(SHELL)
  const before = scenario.root.children.slice()
  const host = adapter.createTopCardHost(scenario.anchor)
  check('happy path returns a host', Boolean(host), true)
  check('happy host class', host.className, 'dsh-sc-host')
  check('happy host dataset flag', host.dataset.sidebarClockHost, '')
  check('happy host carries the data attribute', host.getAttribute('data-sidebar-clock-host'), '')
  check('happy host lives in the sidebar root', host.parentNode === scenario.root, true)
  check(
    'happy host sits immediately before New Session',
    scenario.root.children.indexOf(host) === scenario.root.children.indexOf(scenario.newSession) - 1,
    true,
  )
  check('happy path adds exactly one node', scenario.root.children.length, before.length + 1)
  const foreign = scenario.root.children.filter((node) => node !== host)
  check('happy path keeps every foreign node in place', sameNodes(foreign, before), true)

  const again = adapter.createTopCardHost(scenario.anchor)
  check('happy path reuses its own host', again === host, true)
  check('happy path does not duplicate the host', scenario.root.children.length, before.length + 1)

  host.remove()
  check('remove() detaches only our host', host.parentNode, null)
  check('remove() restores every foreign node', sameNodes(scenario.root.children, before), true)
  check('remove() restores the child count', scenario.root.children.length, before.length)
}

// A host our adapter left behind is adopted/moved, never duplicated.
{
  const scenario = mountScenario(SHELL)
  const before = scenario.root.children.slice()
  const stale = scenario.document.createElement('div')
  stale.className = 'dsh-sc-host'
  stale.dataset.sidebarClockHost = ''
  scenario.root.appendChild(stale)
  const adopted = adapter.createTopCardHost(scenario.anchor)
  check('a leftover own host is adopted', adopted === stale, true)
  check(
    'an adopted host is moved before New Session',
    scenario.root.children.indexOf(stale) === scenario.root.children.indexOf(scenario.newSession) - 1,
    true,
  )
  check('adoption does not duplicate nodes', scenario.root.children.length, before.length + 1)
  stale.remove()
  check('adopted host removal restores the fixture', sameNodes(scenario.root.children, before), true)
}

// A foreign node that merely shares the class name is never adopted or moved.
{
  const scenario = mountScenario(SHELL)
  const before = scenario.root.children.slice()
  const foreign = scenario.document.createElement('div')
  foreign.className = 'dsh-sc-host'
  scenario.root.appendChild(foreign)
  const host = adapter.createTopCardHost(scenario.anchor)
  check('a foreign same-class node is not adopted', host === foreign, false)
  check('a foreign same-class node stays where it was', scenario.root.children[scenario.root.children.length - 1] === foreign, true)
  check(
    'only our host is added before New Session',
    scenario.root.children.indexOf(host) === scenario.root.children.indexOf(scenario.newSession) - 1,
    true,
  )
  host.remove()
  check('removing our host leaves the foreign node alone', scenario.root.children.includes(foreign), true)
  check('removing our host restores the rest of the fixture', sameNodes(scenario.root.children.slice(0, -1), before), true)
  scenario.root.removeChild(foreign)
}

// ---------------------------------------------------------------------------
// Recognised root but missing/renamed parts -> null + one warning per kind
// ---------------------------------------------------------------------------

{
  const logger = captureWarnings()
  const isolated = loadAdapter(logger.console)
  const scenario = mountScenario(isolated.SIDEBAR_SHELL)
  scenario.root.classList.remove(isolated.SIDEBAR_SHELL.root)

  check('missing root returns null', isolated.createTopCardHost(scenario.anchor), null)
  check('missing root warns once', logger.warnings.length, 1)
  check('missing root reason', logger.warnings[0].includes('root class not found'), true)
  check('warning uses the stable prefix', logger.warnings[0].startsWith('[sidebar-clock] sidebar adapter: '), true)
  check('warning includes the shell version', logger.warnings[0].includes(isolated.SIDEBAR_SHELL.dshVersion), true)
  check(
    'warning separates adapter mismatch from activation failure',
    logger.warnings[0].includes('not a plugin-activation failure') && logger.warnings[0].includes('did not activate'),
    true,
  )
  isolated.createTopCardHost(scenario.anchor)
  check('missing root warns only once per page load', logger.warnings.length, 1)
}

{
  const logger = captureWarnings()
  const isolated = loadAdapter(logger.console)
  const scenario = mountScenario(isolated.SIDEBAR_SHELL)
  scenario.logoRow.classList.remove(isolated.SIDEBAR_SHELL.logoRow)

  check('missing logo row returns null', isolated.createTopCardHost(scenario.anchor), null)
  check('missing logo row warns once', logger.warnings.length, 1)
  check('missing logo row reason', logger.warnings[0].includes('logo row not found'), true)
  isolated.createTopCardHost(scenario.anchor)
  check('missing logo row warns only once per page load', logger.warnings.length, 1)
}

{
  const logger = captureWarnings()
  const isolated = loadAdapter(logger.console)
  const scenario = mountScenario(isolated.SIDEBAR_SHELL)
  scenario.newSession.classList.remove(isolated.SIDEBAR_SHELL.newSession)

  check('missing new-session button returns null', isolated.createTopCardHost(scenario.anchor), null)
  check('missing new-session button warns once', logger.warnings.length, 1)
  check('missing new-session button reason', logger.warnings[0].includes('new session button not found'), true)
}

{
  const logger = captureWarnings()
  const isolated = loadAdapter(logger.console)
  const scenario = mountScenario(isolated.SIDEBAR_SHELL)
  scenario.root.insertBefore(scenario.newSession, scenario.logoRow)

  check('reversed brand/button order returns null', isolated.createTopCardHost(scenario.anchor), null)
  check('reversed order warns once', logger.warnings.length, 1)
  check('reversed order reason', logger.warnings[0].includes('order unexpected'), true)
}

{
  const logger = captureWarnings()
  const isolated = loadAdapter(logger.console)
  const scenario = mountScenario(isolated.SIDEBAR_SHELL, { outsideRoot: true })

  check('anchor outside the sidebar root returns null', isolated.createTopCardHost(scenario.anchor), null)
  check('anchor outside the root warns once', logger.warnings.length, 1)
  check('anchor outside the root reason', logger.warnings[0].includes('anchor outside sidebar root'), true)
  check('anchor outside the root leaves the footer fallback to the caller', scenario.root.children.length, 5)
}

// Distinct failure kinds each warn once; repeats stay silent.
{
  const logger = captureWarnings()
  const isolated = loadAdapter(logger.console)

  const missingLogo = mountScenario(isolated.SIDEBAR_SHELL)
  missingLogo.logoRow.classList.remove(isolated.SIDEBAR_SHELL.logoRow)
  isolated.createTopCardHost(missingLogo.anchor)

  const missingSession = mountScenario(isolated.SIDEBAR_SHELL)
  missingSession.newSession.classList.remove(isolated.SIDEBAR_SHELL.newSession)
  isolated.createTopCardHost(missingSession.anchor)

  const reversed = mountScenario(isolated.SIDEBAR_SHELL)
  reversed.root.insertBefore(reversed.newSession, reversed.logoRow)
  isolated.createTopCardHost(reversed.anchor)

  check('three distinct failure kinds warn three times', logger.warnings.length, 3)
  isolated.createTopCardHost(missingLogo.anchor)
  isolated.createTopCardHost(missingSession.anchor)
  isolated.createTopCardHost(reversed.anchor)
  check('repeated failures do not warn again', logger.warnings.length, 3)
}

// A shell-map override (test seam) controls the version printed in the warning.
{
  const logger = captureWarnings()
  const isolated = loadAdapter(logger.console)
  const scenario = mountScenario(isolated.SIDEBAR_SHELL)
  scenario.logoRow.classList.remove(isolated.SIDEBAR_SHELL.logoRow)
  const customShell = Object.assign({}, isolated.SIDEBAR_SHELL, { dshVersion: '9.9.9-fake' })
  isolated.createTopCardHost(scenario.anchor, customShell)
  check('warning uses the supplied shell version', logger.warnings.length === 1 && logger.warnings[0].includes('9.9.9-fake'), true)
}

// ---------------------------------------------------------------------------
// Hostile / absent DOM: never throws, returns null, logging cannot break it
// ---------------------------------------------------------------------------

{
  const logger = captureWarnings()
  const isolated = loadAdapter(logger.console)
  const map = isolated.SIDEBAR_SHELL

  for (const hostileAnchor of [null, undefined, 0, 42, 'anchor', {}, [], { closest: 'not-a-function' }]) {
    noThrow('hostile anchor ' + JSON.stringify(hostileAnchor), () => {
      check('hostile anchor returns null', isolated.createTopCardHost(hostileAnchor), null)
    })
  }
  check('all unusable anchors share one warning kind', logger.warnings.length, 1)
  check('unusable anchor reason', logger.warnings[0].includes('anchor outside sidebar root'), true)

  noThrow('anchor whose closest() throws', () => {
    const throwing = {
      closest() {
        throw new Error('hostile closest')
      },
    }
    check('throwing closest returns null', isolated.createTopCardHost(throwing), null)
  })
  check('throwing closest does not emit a new warning kind', logger.warnings.length, 1)

  noThrow('element without classList', () => {
    const scenario = mountScenario(map)
    delete scenario.logoRow.classList
    check('element without classList returns null', isolated.createTopCardHost(scenario.anchor), null)
  })

  noThrow('root whose children getter throws', () => {
    const hostileRoot = {
      classList: { contains: (name) => name === map.root },
      contains: () => true,
    }
    Object.defineProperty(hostileRoot, 'children', {
      get() {
        throw new Error('hostile children')
      },
    })
    const hostileAnchor = { closest: () => hostileRoot }
    check('throwing children getter returns null', isolated.createTopCardHost(hostileAnchor), null)
    check('throwing children getter still returns null on retry', isolated.createTopCardHost(hostileAnchor), null)
  })
  check('hostile DOM failure is reported once', logger.warnings.filter((line) => line.includes('adapter threw')).length, 1)

  noThrow('element whose classList.contains throws', () => {
    const scenario = mountScenario(map)
    scenario.logoRow.classList = {
      contains() {
        throw new Error('hostile classList')
      },
    }
    check('throwing classList returns null', isolated.createTopCardHost(scenario.anchor), null)
  })

  noThrow('anchor and shell without an owner document', () => {
    const rootlessDocumentRoot = {
      classList: { contains: (name) => name === map.root },
      contains: () => true,
      children: [
        { classList: { contains: (name) => name === map.logoRow } },
        { classList: { contains: (name) => name === map.newSession } },
      ],
    }
    const anchor = { closest: () => rootlessDocumentRoot, ownerDocument: null }
    check('missing owner document returns null', isolated.createTopCardHost(anchor), null)
  })
}

// console.warn itself failing must not propagate (page logger can be replaced).
{
  const isolated = loadAdapter({
    warn() {
      throw new Error('console down')
    },
  })
  const scenario = mountScenario(isolated.SIDEBAR_SHELL)
  scenario.root.classList.remove(isolated.SIDEBAR_SHELL.root)
  let host
  noThrow('console.warn that throws', () => {
    host = isolated.createTopCardHost(scenario.anchor)
  })
  check('console.warn that throws still returns null', host, null)
}

// The component keeps the footer fallback when the adapter returns null.
check('client still renders the footer fallback', source.includes("className: 'dsh-sc-fallback'"), true)
check('client still portals into the adapter host', source.includes('createPortal(card, host)'), true)

if (failures > 0) {
  console.error(failures + ' check(s) failed')
  process.exit(1)
}
console.log('all checks passed')
