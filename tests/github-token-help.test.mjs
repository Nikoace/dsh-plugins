// Offline harness for the GitHub Settings token-acquisition guidance.
//
// Run from D:\hobby\dsh-plugins with: node tests/github-token-help.test.mjs
//
// `dsh-github/client.js` is a `window.__ModuleLoader__` artifact, so this
// harness evaluates it with a minimal React stub, renders the Settings section
// once, and checks the token-creation links plus the bilingual guidance. No
// network, token, or DOM is involved.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'dsh-github', 'client.js'), 'utf8')

let definition
vm.runInNewContext(
  source,
  { window: { __ModuleLoader__: { load: (value) => { definition = value } } } },
  { filename: 'dsh-github/client.js' },
)
assert.ok(definition, 'client.js registers a module loader definition')

const react = {
  createElement: (...args) => ({ args }),
  useCallback: (callback) => callback,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, read) => read(),
}

const loaded = definition.factory((id) => {
  assert.equal(id, 'react', 'the client imports only React from the module table')
  return react
})

let registration
let dictionaries
const form = {
  subscribe: () => () => {},
  getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: {} }),
  dispose: () => {},
}
const ctx = {
  locale: {
    bind: (ns) => (key) => `${ns}:${key}`,
    register: (ns, value) => {
      dictionaries = value
      return () => {}
    },
  },
  effect: (fn) => {
    fn()
    return () => {}
  },
  configForms: {
    get: () => form,
    whileServed: (names, register) => register(new Set(names)),
  },
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => {
      registration = { options, component }
      return () => {}
    },
  },
  remote: { credentials: { describe: async () => ({ ok: true, value: {} }) } },
}

loaded.apply(ctx)

assert.ok(registration, 'the Settings section is registered')
assert.ok(dictionaries?.zh && dictionaries?.en, 'both dictionaries are registered')
assert.equal(registration.options.id, 'github')

const t = (key) => `settings.github:${key}`
const tree = registration.component({ form, remote: ctx.remote, t })

const nodes = (node) => {
  if (!node?.args) return []
  return [node, ...node.args.slice(2).flatMap(nodes)]
}
const anchors = nodes(tree).filter((node) => node.args[0] === 'a')

assert.equal(anchors.length, 2, 'the token card renders exactly two token-creation links')
const byText = (text) => anchors.find((node) => node.args[2] === text)
const fineGrained = byText('settings.github:tokenHelpFineGrained')
const classic = byText('settings.github:tokenHelpClassic')
assert.ok(fineGrained && classic, 'both token-creation links are rendered')

assert.equal(fineGrained.args[1].href, 'https://github.com/settings/personal-access-tokens/new')
assert.equal(classic.args[1].href, 'https://github.com/settings/tokens/new')
for (const link of [fineGrained, classic]) {
  assert.equal(link.args[1].target, '_blank', 'the links leave the app shell instead of navigating it')
  assert.match(link.args[1].rel, /noreferrer/, 'an opener is not left behind')
  assert.match(link.args[1].href, /^https:\/\//)
  assert.equal(typeof link.args[1].className, 'string', 'the links are styled by the plugin')
}

const rendered = JSON.stringify(tree)
for (const key of ['tokenHelpIntro', 'tokenHelpFineGrained', 'tokenHelpClassic', 'tokenHelpScopes', 'tokenHelpRateLimit']) {
  assert.ok(rendered.includes(`settings.github:${key}`), `${key} appears in the rendered card`)
}

assert.match(dictionaries.en.tokenHelpIntro, /credential store/)
assert.match(dictionaries.zh.tokenHelpIntro, /凭据存储/)
assert.match(dictionaries.zh.tokenHelpIntro, /profile/)
assert.match(dictionaries.en.tokenHelpScopes, /Contents: Read/)
assert.match(dictionaries.en.tokenHelpScopes, /Read and write/)
assert.match(dictionaries.zh.tokenHelpScopes, /Contents: Read/)
assert.match(dictionaries.zh.tokenHelpScopes, /public_repo/)
assert.match(dictionaries.en.tokenHelpRateLimit, /5,000/)
assert.match(dictionaries.zh.tokenHelpRateLimit, /5 000/)
assert.match(dictionaries.en.tokenHelpFineGrained, /recommended/)
assert.match(dictionaries.zh.tokenHelpFineGrained, /推荐/)

for (const text of [
  dictionaries.en.tokenHelpIntro,
  dictionaries.zh.tokenHelpIntro,
  dictionaries.en.tokenHelpScopes,
  dictionaries.zh.tokenHelpScopes,
  dictionaries.en.tokenHelpRateLimit,
  dictionaries.zh.tokenHelpRateLimit,
]) {
  assert.equal(/http:\/\//.test(text), false, 'the guidance never embeds an insecure URL')
}

console.log('github token help: 1 passed, 0 failed (1 total)')
