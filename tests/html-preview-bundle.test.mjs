import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { buildHtmlPreview } from '../tools/build-html-preview.mjs'

const root = new URL('../dsh-html-preview/', import.meta.url)
const read = file => readFileSync(new URL(file, root), 'utf8')
const bundle = read('client.js')
assert.ok(bundle === buildHtmlPreview(), 'generated bundle is stale; run node tools/build-html-preview.mjs')
const pkg = JSON.parse(read('package.json'))
assert.equal(pkg.name, '@local/dsh-html-preview')
assert.equal(pkg.exports['./client'], './client.js')
assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-chat'])
for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE', 'locale/en.json', 'locale/zh.json', 'vendor/LICENSE-DOMPurify']) {
  assert.ok(existsSync(new URL(file, root)), file)
}
for (const language of ['en', 'zh']) {
  const { meta } = JSON.parse(read(`locale/${language}.json`))
  assert.ok(meta.title && meta.description)
}

// Exercise module registration and lifecycle without rendering or emulating DOM.
// This test cannot validate browser parsing, iframe sandbox or CSP enforcement.
let loaded
const sandbox = { window: { __ModuleLoader__: { load: module => { loaded = module } } } }
vm.runInNewContext(bundle, sandbox, { timeout: 3000 })
assert.equal(loaded.id, pkg.name)
const requested = []
const plugin = loaded.factory(id => { requested.push(id); assert.equal(id, 'react'); return {} })
assert.deepEqual(requested, ['react'])
const events = []
const cleanups = []
let registration
let dictionaries
plugin.apply({
  effect(fn) { const dispose = fn(); if (dispose) cleanups.push(dispose) },
  locale: { register(ns, dicts) { assert.equal(ns, 'htmlPreview'); dictionaries = dicts; return () => events.push('locale disposed') } },
  slots: {
    inject(name, callback) { assert.equal(name, 'conversation.chat.turnTail'); const dispose = callback(); if (dispose) cleanups.push(dispose) },
    register(options, component) { registration = { options, component }; return () => events.push('slot disposed') },
  },
})
assert.equal(registration.options.name, 'conversation.chat.turnTail')
assert.equal(registration.options.id, 'html-preview')
assert.equal(typeof registration.component, 'function')
assert.ok(dictionaries.en.context && dictionaries.zh.context)
assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort())
for (const dispose of cleanups.reverse()) dispose()
assert.deepEqual(events.sort(), ['locale disposed', 'slot disposed'])
const host = await import('../dsh-html-preview/index.js')
// Display-only Host must not touch services or register model request handlers.
host.apply(new Proxy({}, { get() { throw Error('Host unexpectedly accesses services') } }))
console.log('PASS: HTML bundle generation, vendor hashes, manifest, locale, registration/disposal; Host does not alter context')
console.log('NOT TESTED: rendered UI, browser sanitizer behavior, or sandbox/CSP enforcement')
