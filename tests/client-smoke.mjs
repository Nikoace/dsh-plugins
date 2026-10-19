// Stub-DOM logic test for the Client half: verifies registration, locale
// coverage, band logic, formatting, and that the open dialog renders without
// throwing. It is a logic test, not visual verification.
import assert from 'node:assert/strict'

const loaded = []
const styleTags = []
const listeners = []

function createElement(type, props = {}, ...children) {
  return { type, props: { ...props, children: children.flat(Infinity) } }
}
const Fragment = Symbol('Fragment')

const React = {
  Fragment,
  createElement,
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    // Force the dialog open: useNow(initializer), open(false), anchor(null).
    if (initial === false) return [true, () => {}]
    if (initial === null) return [{ left: 8, bottom: 120, width: 340 }, () => {}]
    return [value, () => {}]
  },
  useEffect(callback) {
    const cleanup = callback()
    if (typeof cleanup === 'function') cleanup()
  },
  useRef() {
    return { current: { getBoundingClientRect: () => ({ left: 120, top: 600 }), focus() {} } }
  },
}
const ReactDOM = { createPortal: (node) => node }

const document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: (tag) => styleTags.push(tag) },
  body: {},
  addEventListener: (...args) => listeners.push(args),
  removeEventListener: () => {},
}
const window = {
  __ModuleLoader__: { load: (module) => loaded.push(module) },
  setInterval: () => 1,
  clearInterval: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1200,
  innerHeight: 900,
}
globalThis.window = window
globalThis.document = document

await import('../dsh-token-cost/client.js')
assert.equal(loaded.length, 1)
assert.equal(loaded[0].id, '@local/dsh-token-cost')

const require = (id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return ReactDOM
  throw new Error(`unexpected require: ${id}`)
}
const plugin = loaded[0].factory(require)
assert.deepEqual(plugin.inject, ['slots', 'locale'])

let registration = null
let dictionaries = null
const ctx = {
  effect: (callback) => callback(),
  locale: { register: (_ns, dicts) => ((dictionaries = dicts), () => {}) },
  slots: {
    inject: (_slot, callback) => callback(),
    register: (options, Component) => ((registration = { options, Component }), () => {}),
  },
}
plugin.apply(ctx)

assert.equal(registration.options.name, 'conversation.composer.dock')
assert.equal(registration.options.id, 'cost')
assert.equal(registration.options.order, 2)
assert.equal(registration.options.locale, 'tokenCost')
assert.ok(dictionaries.zh && dictionaries.en, 'both dictionaries registered')
assert.equal(styleTags.length, 1, 'stylesheet installed')
assert.match(styleTags[0].textContent, /\.dsh-tc-panel/, 'panel styles present')

const t = (key, params = {}) => {
  const template = dictionaries.zh[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
}

// Every `t('key')` call site must exist in both dictionaries, and both
// languages must use the same placeholder names.
{
  const fs = await import('node:fs')
  const source = fs.readFileSync(new URL('../dsh-token-cost/client.js', import.meta.url), 'utf8')
  const keys = [...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1])
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
  for (const key of new Set(keys)) {
    assert.ok(dictionaries.zh[key], `zh dictionary has ${key}`)
    assert.ok(dictionaries.en[key], `en dictionary has ${key}`)
    assert.equal(placeholders(dictionaries.zh[key]), placeholders(dictionaries.en[key]), `placeholders agree for ${key}`)
  }
}

const view = {
  currency: 'USD',
  symbol: '$',
  calls: 3,
  unpricedCalls: 0,
  estimatedCalls: 1,
  micros: 12_345_678,
  peakMicros: 9_000_000,
  offPeakMicros: 3_345_678,
  savedMicros: 2_000_000,
  tokens: { input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 100_000, output: 500_000, reasoning: 0 },
  bucketMicros: { input: 2_000_000, cacheRead: 400_000, cacheWrite: 200_000, output: 9_745_678, reasoning: 0 },
  peak: { calls: 2, micros: 9_000_000, tokens: { input: 800_000, cacheRead: 1_500_000, cacheWrite: 100_000, output: 300_000, reasoning: 0 } },
  offPeak: { calls: 1, micros: 3_345_678, tokens: { input: 200_000, cacheRead: 500_000, cacheWrite: 0, output: 200_000, reasoning: 0 } },
  models: [
    {
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      calls: 3,
      unpricedCalls: 0,
      estimatedCalls: 1,
      micros: 12_345_678,
      savedMicros: 2_000_000,
      tokens: { input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 100_000, output: 500_000, reasoning: 0 },
      peak: { calls: 2, micros: 9_000_000, tokens: { input: 800_000, cacheRead: 1_500_000, cacheWrite: 100_000, output: 300_000, reasoning: 0 } },
      offPeak: { calls: 1, micros: 3_345_678, tokens: { input: 200_000, cacheRead: 500_000, cacheWrite: 0, output: 200_000, reasoning: 0 } },
    },
  ],
  pricing: {
    version: 'official-1',
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    effectiveFrom: 1792380000000,
    fetchedAt: 1792380000000,
    currency: 'USD',
    symbol: '$',
    exchangeRate: 1,
    peakWindows: [[60, 240], [360, 600]],
    weekdaysOnly: true,
    offPeakEnabled: true,
    reasoningBilling: 'included',
    holidays: [],
    holidaysSource: 'auto',
    autoRefresh: { pricing: true, holidays: true },
    holidayOffsetMinutes: 480,
  },
}

function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node.type === 'function') {
    texts(node.type(node.props), out)
    return out
  }
  if (node.props && Array.isArray(node.props.children)) for (const child of node.props.children) texts(child, out)
  return out
}

function render(componentView, translate = t) {
  const tree = registration.Component({ useProjection: () => componentView, t: translate })
  return texts(tree).join(' | ')
}

// Empty session: no pill.
assert.equal(render(undefined), '')
assert.equal(render({ ...view, calls: 0 }), '')

// Populated session: pill + open dialog render with the money, band, windows,
// pricing source and holiday warning.
const output = render(view)
for (const expected of ['$12.35', '高峰费用', '低谷费用', '低谷已节省', '未缓存输入', '缓存命中', '缓存写入', '输出', 'deepseek-flash', '按模型', 'Token 费用', '高峰窗口', '判定基准', '官方价目表', '节假日日历']) {
  assert.ok(output.includes(expected), `rendered output should include ${expected}: ${output}`)
}
// The dialog renders the UTC windows in the system time zone, keeps the UTC
// reference, and names the zone.
{
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const offset = -new Date(Date.now()).getTimezoneOffset()
  const clock = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  const localWindows = view.pricing.peakWindows
    .map(([start, end]) => `${clock((((start + offset) % 1440) + 1440) % 1440)}–${clock((((end + offset) % 1440) + 1440) % 1440)}`)
    .join(' / ')
  assert.ok(output.includes(localWindows), `rendered output should include local windows ${localWindows}: ${output}`)
  assert.ok(output.includes(zone), `rendered output should name the system zone ${zone}: ${output}`)
}
assert.ok(output.includes('本会话创建时未获取'), 'an empty frozen calendar explains that it predates the fetch')
assert.ok(!output.includes('{'), `no unresolved placeholders in rendered text: ${output}`)

const tEn = (key, params = {}) => {
  const template = dictionaries.en[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
}
const english = render(view, tEn)
for (const expected of ['Token cost', 'Peak spend', 'Off-peak spend', 'Saved off-peak', 'Uncached input', 'By model', 'official price page', 'Peak windows', 'Rule basis', 'holiday']) {
  assert.ok(english.includes(expected), `english output should include ${expected}: ${english}`)
}
assert.ok(!english.includes('{'), `no unresolved placeholders in the English render: ${english}`)

// A configured holiday list removes the warning and reports an automatic count.
const holidayView = { ...view, pricing: { ...view.pricing, holidays: ['2026-10-19'], holidaysSource: 'auto' } }
const holidayOutput = render(holidayView)
assert.ok(!holidayOutput.includes('未配置节假日'), 'no holiday warning once a calendar is configured')
assert.ok(holidayOutput.includes('自动获取 1 天'), 'an automatic calendar reports its size')

// Local-only catalog reports the fallback source.
const localView = { ...view, pricing: { ...view.pricing, source: 'config', version: 'config' } }
const localOutput = render(localView)
assert.ok(localOutput.includes('本地后备费率'), 'a config card is labeled as fallback')
assert.ok(localOutput.includes('尚未获取官方价目表'), 'a bootstrap card explains that it predates the fetch')

console.log('client tests: all assertions passed')
console.log(`rendered: ${output.slice(0, 280)}…`)
