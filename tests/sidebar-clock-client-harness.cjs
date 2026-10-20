'use strict'
// Real installed SlotCore + official sidebar. Only unrelated browser services
// are stubbed; slot uniqueness, ownership and release semantics are real.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { installedClient } = require('./sidebar-clock-installed.cjs')
// Missing app.asar is an environment limitation, not a test failure: the helper
// prints the canonical SKIP line and returns null, so report the local context
// and exit 0 to keep CI and machines without the DSH desktop green.
const installed = installedClient()
if (!installed) {
  console.log('SKIP: sidebar-clock-client-harness needs the installed DSH shell; nothing to verify')
  process.exit(0)
}
const { read, SlotCore } = installed
const slots = new SlotCore()
slots.register({ name: 'root', children: {
  sidebar: { kind: 'single', scope: 'root' },
  'shell.leading': { kind: 'single', scope: 'root' },
} }, () => null)

const snapshotStore = (initial) => {
  let value = initial
  return { getSnapshot: () => value, set: (next) => { value = next }, subscribe: () => () => {} }
}
const modules = new Map()
const imports = {
  react: { createElement() {}, Component: class {} },
  'react-dom': { createPortal() {} },
  'react/jsx-runtime': {},
  '@deepseek-ai/dsh-client-ui-primitives': {},
  '@deepseek-ai/dsh-client-store': { createSnapshotStore: snapshotStore },
  '@deepseek-ai/dsh-client-ui-slots': { resolveSlotLabel: (label) => typeof label === 'function' ? label() : label },
}
const timers = new Set()
let sequence = 0
const sandbox = {
  console, AbortController,
  window: {
    __ModuleLoader__: { load: (definition) => modules.set(definition.id, definition) },
    setTimeout: () => ++sequence, clearTimeout() {},
    setInterval: () => { const id = ++sequence; timers.add(id); return id },
    clearInterval: (id) => timers.delete(id),
  },
  fetch: async () => ({ ok: true, json: async () => ({ code: 0, holiday: {} }) }),
}
const context = vm.createContext(sandbox)
function load(source, filename, id) {
  vm.runInContext(source, context, { filename })
  return modules.get(id).factory((request) => {
    assert.ok(Object.hasOwn(imports, request), 'unexpected dependency: ' + request)
    return imports[request]
  })
}
function services(registrant) {
  const disposers = []
  const track = (dispose) => { disposers.push(dispose); return dispose }
  return {
    effect: (callback) => track(callback()),
    locale: { register: () => () => {}, subscribe: () => () => {} },
    shortcuts: { catalog: snapshotStore([]) },
    get: () => ({}),
    dispose: () => { for (const dispose of disposers.reverse()) dispose?.() },
    slots: {
      inject: (name, callback) => {
        assert.ok(slots.spec(name), 'missing slot: ' + name)
        return callback()
      },
      register: (options, component) => track(slots.register({ ...options, registrant }, component)),
      entriesOfSlot: (name) => slots.entriesOfSlot(name),
      subscribe: (name, callback) => slots.subscribe(name, callback),
    },
  }
}

const officialId = '@deepseek-ai/dsh-client-ui-sidebar'
load(read('dsh/node_modules/' + officialId + '/lib/client.js'), 'official-sidebar.js', officialId).apply(services(officialId))
const officialEntry = slots.entries('sidebar')[0]
const children = officialEntry.children
assert.throws(() => slots.register({ name: 'sidebar', priority: -1, children }, () => null), /already declared/)
console.log('PASS: original duplicate declaration is rejected by the installed runtime')

// Existing feature entries must survive the clock's activation and unload.
const sentinels = new Map()
for (const [name, spec] of Object.entries(children)) {
  slots.register({ name, ...(spec.kind === 'list' ? { id: 'existing-feature' } : {}) }, () => null)
  sentinels.set(name, slots.entries(name)[0])
}
const pluginId = '@local/dsh-sidebar-clock'
const pluginPath = path.join(__dirname, '..', 'dsh-sidebar-clock', 'client.js')
const plugin = load(fs.readFileSync(pluginPath, 'utf8'), pluginPath, pluginId)
assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale'])
for (let cycle = 1; cycle <= 3; cycle++) {
  const ctx = services(pluginId)
  plugin.apply(ctx)
  const entry = slots.entries('sidebar.footer.action').find((entry) => entry.options.id === pluginId)
  assert.ok(entry, 'clock registered as an additive footer entry')
  assert.equal(entry.children, undefined, 'clock does not declare stock slots')
  assert.equal(slots.entries('sidebar').length, 1)
  assert.equal(slots.entries('sidebar')[0], officialEntry)
  assert.equal(timers.size, 2, 'calendar and balance refresh loops')
  ctx.dispose()
  assert.equal(timers.size, 0, 'refresh loops disposed')
  assert.ok(!slots.entries('sidebar.footer.action').includes(entry))
  for (const [name, sentinel] of sentinels) {
    assert.ok(slots.spec(name), 'child declaration survives: ' + name)
    assert.ok(slots.entries(name).includes(sentinel), 'feature entry survives: ' + name)
  }
  console.log('PASS: activation/unload cycle ' + cycle + ' preserves the official sidebar and all 7 child slots')
}
