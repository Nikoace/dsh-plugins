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

console.log('github-settings client: 1 passed, 0 failed (1 total)')
