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
  currency: 'CNY',
  symbol: '¥',
  calls: 3,
  unpricedCalls: 0,
  estimatedCalls: 1,
  excludedCalls: 0,
  excludedTokens: 0,
  micros: 12_345_678,
  peakMicros: 9_000_000,
  offPeakMicros: 3_345_678,
  savedMicros: 2_000_000,
  tokens: { input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 100_000, output: 500_000, reasoning: 0 },
  bucketMicros: { input: 2_000_000, cacheRead: 400_000, cacheWrite: 200_000, output: 9_745_678, reasoning: 0 },
  peak: { calls: 2, micros: 9_000_000, tokens: { input: 800_000, cacheRead: 1_500_000, cacheWrite: 100_000, output: 300_000, reasoning: 0 } },
  offPeak: { calls: 1, micros: 3_345_678, tokens: { input: 200_000, cacheRead: 500_000, cacheWrite: 0, output: 200_000, reasoning: 0 } },
  // This session delegated to two children; the pill shows the whole tree while
  // the dialog keeps the own/children split.
  subtree: { micros: 20_345_678, ownMicros: 12_345_678, childrenMicros: 8_000_000, childCount: 2, unknownCount: 0, calls: 9 },
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
      epochs: [
        { effectiveFrom: 1792000000000, effectiveTo: 1792380000000, version: 'config', currency: 'CNY', symbol: '¥', rateBasis: 'exact', calls: 1, tokens: { input: 400_000, cacheRead: 900_000, cacheWrite: 0, output: 200_000, reasoning: 0 }, micros: 9_000_000, savedMicros: 0 },
        { effectiveFrom: 1792380000000, effectiveTo: null, version: 'official-1', currency: 'CNY', symbol: '¥', rateBasis: 'exact', calls: 2, tokens: { input: 600_000, cacheRead: 1_100_000, cacheWrite: 100_000, output: 300_000, reasoning: 0 }, micros: 3_345_678, savedMicros: 2_000_000 },
      ],
    },
  ],
  pricing: {
    version: 'official-1',
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    effectiveFrom: 1792380000000,
    fetchedAt: 1792380000000,
    currency: 'CNY',
    symbol: '¥',
    exchangeRate: 1,
    peakWindows: [[60, 240], [360, 600]],
    weekdaysOnly: true,
    offPeakEnabled: true,
    reasoningBilling: 'included',
    holidays: [],
    holidaysSource: 'auto',
    holidayProvenance: { auto: [], manual: [], fixed: [] },
    parserVersion: 1,
    pageVariant: 'zh',
    autoRefresh: { pricing: true, holidays: true },
    holidayOffsetMinutes: 480,
    // Two rate segments: the timeline is what lets a session span a price change.
    epochs: [
      {
        version: 'config',
        effectiveFrom: 1792000000000,
        effectiveTo: 1792380000000,
        fetchedAt: null,
        currency: 'CNY',
        symbol: '¥',
        source: 'config',
        pageVariant: null,
        rates: { 'deepseek-flash': { input: 4, cacheRead: 0.08, cacheWrite: 4, output: 16 } },
      },
      {
        version: 'official-1',
        effectiveFrom: 1792380000000,
        effectiveTo: null,
        fetchedAt: 1792380000000,
        currency: 'CNY',
        symbol: '¥',
        source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
        pageVariant: 'zh',
        rates: { 'deepseek-flash': { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 } },
      },
    ],
  },
  // Live Host state (not frozen): freshness and degradation of the two sources.
  status: {
    catalogVersion: 'official-1',
    pricing: {
      fetchedAt: 1792380000000,
      attemptedAt: 1792380003600000,
      parserVersion: 1,
      source: 'https://api-docs.deepseek.com/quick_start/pricing',
      degraded: false,
      degradedReason: null,
      stale: false,
      refreshIntervalMs: 21_600_000,
    },
    holidays: {
      fetchedAt: 1792380000000,
      attemptedAt: 1792380000000,
      source: 'https://timor.tech/api/holiday/year/{year}',
      error: null,
      stale: false,
      consecutiveFailures: 0,
      nextRetryAt: 1792466400000,
      refreshIntervalMs: 86_400_000,
    },
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

/** The rendered element tree (the stub `useState` forces the dialog open). */
function renderTree(componentView, translate = t) {
  return registration.Component({ useProjection: () => componentView, t: translate })
}

/** Every `className` token in a rendered tree, resolving function components. */
function classNames(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) classNames(child, out)
    return out
  }
  if (typeof node.type === 'function') {
    classNames(node.type(node.props), out)
    return out
  }
  if (node.props && typeof node.props.className === 'string') for (const name of node.props.className.split(/\s+/)) out.push(name)
  if (node.props && Array.isArray(node.props.children)) for (const child of node.props.children) classNames(child, out)
  return out
}

// Empty session: no pill.
assert.equal(render(undefined), '')
assert.equal(render({ ...view, calls: 0 }), '')

// Populated session: pill + open dialog render with the money, band, windows,
// pricing source and holiday warning.
const output = render(view)
for (const expected of [
  '¥20.35',
  '¥12.35',
  '含子会话',
  '（自身 ¥12.35 + 2 个子 agent ¥8.00）',
  '高峰费用',
  '低谷费用',
  '低谷已节省',
  '未缓存输入',
  '缓存命中',
  '缓存写入',
  '输出',
  'deepseek-flash',
  '按模型',
  'Token 费用',
  '高峰窗口',
  '判定基准',
  '官方价目表',
  '本年度暂无已知节假日',
  '本会话最早的一段费率生效于',
  '当前最新费率读取于',
  '费率按请求发生时间取当时有效的价格',
  '费率时间线：2 段',
  '未缓存 ¥4/M',
  '未缓存 ¥2/M',
  '2 个费率时段',
]) {
  assert.ok(output.includes(expected), `rendered output should include ${expected}: ${output}`)
}

// A Session with no children shows only its own total and no subtree row.
{
  const solo = render({ ...view, subtree: { micros: 12_345_678, ownMicros: 12_345_678, childrenMicros: 0, childCount: 0, unknownCount: 0, calls: 3 } })
  assert.ok(!solo.includes('含子会话'), `no subtree row without children: ${solo}`)
  assert.ok(solo.includes('¥12.35'), 'the solo total is the own amount')
}

// A child whose amount is not known yet is disclosed, not counted as free.
{
  const partial = render({ ...view, subtree: { micros: 12_345_678, ownMicros: 12_345_678, childrenMicros: 0, childCount: 1, unknownCount: 2, calls: 3 } })
  assert.ok(partial.includes('另 2 个子会话未取到金额'), `unknown children are disclosed: ${partial}`)
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
assert.ok(output.includes('不预估假期'), 'an empty calendar explains that dates are not estimated')
assert.ok(output.includes('按周末和峰谷时段计费'), 'an empty calendar retains normal billing rules')
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

// The money follows the interface language: the English render shows the USD
// amount from the Host's USD table, not a conversion of the CNY one.
{
  const dual = {
    ...view,
    currencies: ['CNY', 'USD'],
    amounts: { CNY: 20_345_678, USD: 3_050_000 },
    subtree: { ...view.subtree, amounts: { CNY: 20_345_678, USD: 3_050_000 } },
  }
  const zhRender = render(dual)
  assert.ok(zhRender.includes('¥20.35'), `the Chinese UI shows CNY: ${zhRender}`)
  assert.ok(!zhRender.includes('$'), `the Chinese UI has no dollar amounts: ${zhRender}`)
  const enRender = render(dual, tEn)
  assert.ok(enRender.includes('$3.05'), `the English UI shows the USD amount: ${enRender}`)
  assert.ok(!enRender.includes('¥'), `the English UI has no yuan amounts: ${enRender}`)
}

// A session where only the CNY table was fetched keeps its symbol in English:
// the amount is never relabelled as dollars.
{
  const cnyOnly = render({ ...view, currencies: ['CNY'], amounts: { CNY: 12_345_678 } }, tEn)
  assert.ok(cnyOnly.includes('¥12.35'), `a single-currency view keeps its own symbol: ${cnyOnly}`)
  assert.ok(!cnyOnly.includes('$'), `a missing USD table is not faked: ${cnyOnly}`)
}

// A pinned currency wins over the interface language.
{
  const pinned = { ...view, currencies: ['CNY', 'USD'], amounts: { CNY: 20_345_678, USD: 3_050_000 }, pinnedCurrency: 'USD' }
  assert.ok(render(pinned).includes('$20.35'), `a pinned USD view shows dollars even in the Chinese UI: ${render(pinned)}`)
  const pinnedCny = { ...pinned, pinnedCurrency: 'CNY' }
  assert.ok(render(pinnedCny, tEn).includes('¥20.35'), `a pinned CNY view shows yuan even in the English UI: ${render(pinnedCny, tEn)}`)
}

// A configured holiday list removes the missing-calendar warning and reports
// per-source provenance (auto / manual / fixed anchors).
const holidayView = {
  ...view,
  pricing: { ...view.pricing, holidays: ['2026-10-19'], holidaysSource: 'auto', holidayProvenance: { auto: ['2026-10-19'], manual: [], fixed: [] } },
}
const holidayOutput = render(holidayView)
assert.ok(!holidayOutput.includes('暂无已知节假日'), 'no holiday warning once a calendar is configured')
assert.ok(holidayOutput.includes('自动 1 天'), `a provenance calendar reports its automatic size: ${holidayOutput}`)
assert.ok(holidayOutput.includes('手动 0 天'), 'the provenance line reports the manual count')
assert.ok(!holidayOutput.includes('固定锚点'), 'current calendars do not advertise estimates')

// Old snapshots identify estimates as historical data.
const fixedView = { ...view, pricing: { ...view.pricing, holidays: ['2027-01-01', '2026-10-19'], holidaysSource: 'auto', holidayProvenance: { auto: ['2026-10-19'], manual: [], fixed: ['2027-01-01'] } } }
assert.ok(render(fixedView).includes('旧版估算 1 天'), 'historical estimates remain inspectable')

// An older snapshot without provenance still reports the legacy source label.
const legacyHolidayPricing = { ...view.pricing, holidays: ['2026-10-19'], holidaysSource: 'auto' }
delete legacyHolidayPricing.holidayProvenance
assert.ok(render({ ...view, pricing: legacyHolidayPricing }).includes('自动获取 1 天'), 'a snapshot without provenance keeps the legacy automatic count')

// Local-only catalog reports the fallback source.
const localView = { ...view, pricing: { ...view.pricing, source: 'config', version: 'config' } }
const localOutput = render(localView)
assert.ok(localOutput.includes('本地后备费率'), 'a config card is labeled as fallback')
assert.ok(localOutput.includes('尚未成功读取官方价目表'), 'a bootstrap card explains that the official page has not been read')

// --- data-trust warnings: stale/degraded pricing and holiday state ---------
{
  assert.ok(!classNames(renderTree(view)).includes('dsh-tc-pillWarn'), 'a healthy status shows no pill warning dot')
  assert.ok(!classNames(renderTree(view)).includes('dsh-tc-badge'), 'a healthy hint shows no stale/degraded badge')
  assert.ok(!output.includes('陈旧'), `a healthy hint does not claim staleness: ${output}`)

  const stalePricing = { ...view, status: { ...view.status, pricing: { ...view.status.pricing, stale: true } } }
  const staleOutput = render(stalePricing)
  assert.ok(classNames(renderTree(stalePricing)).includes('dsh-tc-pillWarn'), 'a stale rate source shows the pill warning dot')
  assert.ok(classNames(renderTree(stalePricing)).includes('dsh-tc-badge'), 'a stale rate source shows a hint badge')
  assert.match(staleOutput, /费率数据已陈旧/, 'the hint explains that rate data is stale')

  const degradedPricing = { ...view, status: { ...view.status, pricing: { ...view.status.pricing, degraded: true, degradedReason: 'HTTP 503', stale: true } } }
  const degradedOutput = render(degradedPricing)
  assert.ok(classNames(renderTree(degradedPricing)).includes('dsh-tc-pillWarn'), 'a degraded rate source shows the pill warning dot')
  assert.match(degradedOutput, /费率抓取异常：HTTP 503/, 'the hint shows the degraded reason')
  assert.match(degradedOutput, /降级/, 'the hint badge says degraded')

  const failedHolidays = {
    ...view,
    status: {
      ...view.status,
      holidays: { ...view.status.holidays, error: 'ETIMEDOUT 2026', consecutiveFailures: 2, nextRetryAt: view.status.holidays.fetchedAt + 900_000, stale: true },
    },
  }
  const failedOutput = render(failedHolidays)
  assert.ok(classNames(renderTree(failedHolidays)).includes('dsh-tc-pillWarn'), 'a failing holiday source shows the pill warning dot')
  assert.match(failedOutput, /节假日获取失败：ETIMEDOUT 2026/, 'the hint shows the holiday failure reason')
  assert.match(failedOutput, /下次重试/, 'the hint shows the retry time')

  const staleHolidays = { ...view, status: { ...view.status, holidays: { ...view.status.holidays, fetchedAt: 1, stale: true } } }
  assert.ok(classNames(renderTree(staleHolidays)).includes('dsh-tc-pillWarn'), 'a stale holiday calendar shows the pill warning dot')
  assert.match(render(staleHolidays), /节假日日历已陈旧/, 'the hint labels a stale holiday calendar')

  // A Host without a web service has no live status: no warning, no status lines.
  const offlineView = { ...view, status: null }
  const offlineOutput = render(offlineView)
  assert.ok(!classNames(renderTree(offlineView)).includes('dsh-tc-pillWarn'), 'no status means no warning dot')
  assert.ok(!offlineOutput.includes('当前最新费率读取于'), 'no live rate line without a host status')

  // Every new string also renders in English without unresolved placeholders.
  const degradedEnglish = render(degradedPricing, tEn)
  assert.match(degradedEnglish, /Rate refresh failed: HTTP 503/)
  assert.match(degradedEnglish, /degraded/)
  assert.ok(!degradedEnglish.includes('{'), `no unresolved placeholders in the degraded English render: ${degradedEnglish}`)
}

console.log('client tests: all assertions passed')
console.log(`rendered: ${output.slice(0, 280)}…`)
