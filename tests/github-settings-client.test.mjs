// Offline harness for the dsh-github Settings client half.
//
// Run from D:\hobby\dsh-plugins with: node tests/github-settings-client.test.mjs
//
// The client module is a `window.__ModuleLoader__` artifact, not an ESM module,
// so this harness evaluates it in a vm sandbox with stubbed React/locale/slots
// services. It verifies the boot artifact, dictionaries, configForms binding,
// and the Settings section registration. Visual rendering stays unverified
// without browser control.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'dsh-github', 'client.js'), 'utf8')

let definition
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  },
}
vm.runInNewContext(source, sandbox, { filename: 'dsh-github/client.js' })

assert.ok(definition, 'client.js registers a module loader definition')
assert.equal(definition.id, '@local/dsh-github', 'the module id matches the package name')
assert.equal(typeof definition.factory, 'function')

const react = { createElement: (...args) => ({ args }), useCallback: (fn) => fn }
const loaded = definition.factory((id) => {
  assert.equal(id, 'react', 'the client imports only React from the module table')
  return react
})

assert.ok(loaded && typeof loaded === 'object')
assert.ok(Array.isArray(loaded.inject))
for (const service of ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']) {
  assert.ok(loaded.inject.includes(service), `inject declares ${service}`)
}

let gotFormId
const form = {
  getSnapshot: () => ({ status: 'loading', writable: false }),
  subscribe: () => () => {},
  mutate: async () => true,
  set: async () => true,
  unset: async () => true,
  dispose: async () => {},
}
let served
let injectedKey
let registration
let localeRegistration
const cleanups = []
const ctx = {
  locale: {
    bind: (ns) => (key, params) => `${ns}:${key}${params ? JSON.stringify(params) : ''}`,
    register: (ns, dicts) => {
      localeRegistration = { ns, dicts }
      return () => {}
    },
  },
  effect: (fn) => {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    return () => {}
  },
  configForms: {
    get: (id) => {
      gotFormId = id
      return form
    },
    whileServed: (names, register) => {
      served = names
      return register(new Set(names))
    },
  },
  slots: {
    inject: (key, callback) => {
      injectedKey = key
      return callback()
    },
    register: (options, component) => {
      registration = { options, component }
      return () => {}
    },
  },
  remote: {
    credentials: {
      describe: async () => ({ ok: true, value: { GITHUB_TOKEN: { configured: false, writable: true } } }),
      set: async () => ({ ok: true }),
      unset: async () => ({ ok: true }),
    },
  },
}

loaded.apply(ctx)

assert.equal(localeRegistration.ns, 'settings.github')
assert.ok(localeRegistration.dicts.zh && localeRegistration.dicts.en, 'both dictionaries are registered')
assert.equal(localeRegistration.dicts.zh.nav, 'GitHub')
assert.equal(localeRegistration.dicts.en.nav, 'GitHub')
assert.equal(gotFormId, 'github', 'the form binds the Host entry id')
assert.deepEqual([...served], ['github'], 'the section follows the served namespace')
assert.equal(injectedKey, 'settings.section')
assert.ok(registration, 'a Settings section is registered')
assert.equal(registration.options.name, 'settings.section')
assert.equal(registration.options.id, 'github')
assert.equal(registration.options.order, 25)
assert.equal(registration.options.locale, 'settings.github')
assert.equal(typeof registration.options.label, 'function')
assert.equal(registration.options.label(), 'settings.github:nav')
assert.equal(typeof registration.component, 'function', 'the section component is a function')
assert.equal(typeof registration.options.inject, 'function')
const injected = registration.options.inject()
assert.equal(injected.form, form)
assert.equal(injected.remote, ctx.remote)
assert.equal(typeof injected.fallbackT, 'function')

assert.match(localeRegistration.dicts.en.hintRequireApproval, /without further confirmation/)
assert.match(localeRegistration.dicts.en.hintRequireApproval, /real GitHub repository/)
assert.match(localeRegistration.dicts.zh.hintRequireApproval, /不经再次确认/)
assert.match(localeRegistration.dicts.zh.hintRequireApproval, /真实 GitHub 仓库/)

// Exercise the actual Settings handlers with persistent hook state and a fake
// credential store. No real credential or profile is read or written.
const hooks = []
let cursor = 0
let effects = []
const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]))
react.useState = (initial) => {
  const i = cursor++
  if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
  return [hooks[i].value, (next) => { hooks[i].value = typeof next === 'function' ? next(hooks[i].value) : next }]
}
react.useCallback = (callback, deps) => {
  const i = cursor++
  if (!sameDeps(hooks[i]?.deps, deps)) hooks[i] = { value: callback, deps }
  return hooks[i].value
}
react.useEffect = (effect, deps) => {
  const i = cursor++
  if (!sameDeps(hooks[i]?.deps, deps)) {
    hooks[i] = { deps }
    effects.push(effect)
  }
}
react.useSyncExternalStore = (_subscribe, read) => read()

let storedToken = ''
const credentialCalls = []
const settingsWrites = []
form.getSnapshot = () => ({ status: 'ready', writable: true, revision: 1, value: { allowWrites: false, requireApproval: true } })
form.mutate = async (operations) => { settingsWrites.push(operations); return true }
ctx.remote.credentials = {
  async describe(refs) {
    credentialCalls.push(['describe', ...refs])
    return { ok: true, value: { GITHUB_TOKEN: { configured: storedToken.length > 0, writable: true, source: 'store' } } }
  },
  async set(ref, token) {
    credentialCalls.push(['set', ref])
    storedToken = token
    return { ok: true }
  },
  async unset(ref) {
    credentialCalls.push(['unset', ref])
    storedToken = ''
    return { ok: true }
  },
}

const render = () => {
  cursor = 0
  const tree = registration.component(injected)
  const pending = effects
  effects = []
  pending.forEach((effect) => effect())
  return tree
}
const nodes = (tree) => {
  if (!tree?.args) return []
  return [tree, ...tree.args.slice(2).flatMap(nodes)]
}
const input = (tree) => nodes(tree).find((node) => node.args[0] === 'input' && node.args[1].type === 'password')
const button = (tree, key) => nodes(tree).find((node) => node.args[0] === 'button' && node.args[2] === `settings.github:${key}`)
const flush = () => new Promise((resolve) => setImmediate(resolve))

let tree = render()
await flush()
tree = render()
assert.equal(input(tree).args[1].value, '')
assert.equal(button(tree, 'tokenClear').args[1].disabled, true)
assert.ok(JSON.stringify(tree).includes('settings.github:hintRequireApproval'), 'the approval hint is rendered')
input(tree).args[1].onChange({ target: { value: '  test-settings-token  ' } })
tree = render()
assert.equal(button(tree, 'tokenSave').args[1].disabled, false)
button(tree, 'tokenSave').args[1].onClick()
await flush()
tree = render()
assert.equal(storedToken, 'test-settings-token', 'the credential service receives the trimmed token')
assert.equal(input(tree).args[1].value, '', 'the input is cleared after saving')
assert.ok(!JSON.stringify(tree).includes('test-settings-token'), 'stored credentials are not echoed')
assert.equal(button(tree, 'tokenClear').args[1].disabled, false)
button(tree, 'tokenClear').args[1].onClick()
await flush()
tree = render()
assert.equal(storedToken, '')
assert.equal(button(tree, 'tokenClear').args[1].disabled, true)
assert.deepEqual(credentialCalls, [
  ['describe', 'GITHUB_TOKEN'], ['set', 'GITHUB_TOKEN'], ['describe', 'GITHUB_TOKEN'],
  ['unset', 'GITHUB_TOKEN'], ['describe', 'GITHUB_TOKEN'],
])
assert.equal(settingsWrites.length, 0, 'credential changes do not write tokens or permissions to the settings form')

console.log('github-settings client: 2 passed, 0 failed (2 total)')
