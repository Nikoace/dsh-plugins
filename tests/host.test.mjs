// Node-only unit tests for the Host half. Not part of the installed bundle.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { apply, internals } from '../dsh-token-cost/index.js'

const {
  parsePricingPage,
  parseHolidayPayload,
  resolveSettings,
  createPricingCatalog,
  makePricingSnapshot,
  bandOf,
  priceTokens,
  priceModel,
  viewOf,
  foldEvent,
  syncEpochs,
  subtreeOf,
  fixedHolidayDateKeys,
  initialState,
  DEFAULT_RATE_CARD,
} = internals

const NOW = Date.parse('2026-10-19T02:00:00Z') // Monday, inside the 01:00–04:00 UTC peak window
const fixture = fs.readFileSync(new URL('./fixtures/pricing-page.html', import.meta.url), 'utf8')
const zhFixture = fs.readFileSync(new URL('./fixtures/pricing-page-zh.html', import.meta.url), 'utf8')
const reorderedFixture = fs.readFileSync(new URL('./fixtures/pricing-page-reordered.html', import.meta.url), 'utf8')
const revampedFixture = fs.readFileSync(new URL('./fixtures/pricing-page-revamped.html', import.meta.url), 'utf8')

/** A registration captured from apply() with no web service (offline card). */
function unit(config) {
  let definition
  const ctx = {
    sessionProjections: { register: (value) => ((definition = value), () => {}) },
    effect: (callback) => callback(),
    get: () => undefined,
    logger: {},
  }
  apply(ctx, config)
  return definition
}

/** Fold events through a definition created at one session time. */
function fold(definition, events, createdAt = 0) {
  let state = definition.init({ createdAt })
  for (const event of events) state = definition.apply(state, event)
  return state
}

function assistant(usage, options = {}) {
  return {
    type: options.attempt ? 'assistant/attempt' : 'assistant/message',
    seq: options.seq ?? 1,
    time: options.time ?? NOW,
    data: {
      turn: options.turn ?? 1,
      step: options.step ?? 1,
      ...(options.attempt
        ? { stream: [{ type: 'chunk', time: options.time ?? 0, chunk: { type: 'usage', usage } }] }
        : {
            message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
            stream: [],
            usage,
          }),
    },
  }
}

const header = (time = 0, provider = 'deepseek-account', model = 'deepseek-flash') => ({
  type: 'request/header',
  seq: 0,
  time,
  data: { header: { config: { provider, model } }, reason: 'initial' },
})

const stepStart = (time) => ({ type: 'step/start', seq: 1, time, data: { turn: 1, step: 1 } })

/** Sorted statutory anchor dates for the given years (from the canonical rules). */
const fixedAnchorsOf = (years) => fixedHolidayDateKeys(years)

// --- official pricing page parser ------------------------------------------
{
  // The English page (USD, UTC windows) still parses and keeps its own currency.
  const card = parsePricingPage(fixture)
  assert.ok(card !== null, 'the official page is recognized')
  assert.deepEqual(card.models, ['deepseek-flash', 'deepseek-v4-pro'])
  const flash = card.rates['deepseek-flash']
  assert.equal(flash.input, 0.3)
  assert.equal(flash.cacheRead, 0.006)
  assert.equal(flash.cacheWrite, 0.3)
  assert.equal(flash.output, 1.2)
  assert.equal(flash.offPeakMultiplier, 0.5)
  const pro = card.rates['deepseek-v4-pro']
  assert.equal(pro.input, 1.32)
  assert.equal(pro.cacheRead, 0.044)
  assert.equal(pro.output, 3.96)
  assert.deepEqual(card.peakWindows, [[60, 240], [360, 600]], '01:00–04:00 and 06:00–10:00 UTC')
  assert.equal(card.weekdaysOnly, true)
  assert.equal(card.currency, 'USD', 'the English page is denominated in USD')
  assert.equal(card.symbol, '$')
  assert.equal(card.pageVariant, 'en')
  assert.equal(parsePricingPage('<html><body>nothing here</body></html>'), null, 'unknown layout is rejected')

  // The zh-CN page is the default source: CNY, and its windows are Beijing time
  // (09:00–12:00 / 14:00–18:00) which must convert back to the same UTC windows.
  const cnyCard = parsePricingPage(zhFixture)
  assert.ok(cnyCard !== null, 'the zh-CN page is recognized')
  assert.deepEqual(cnyCard.models, ['deepseek-flash', 'deepseek-v4-pro'])
  assert.equal(cnyCard.currency, 'CNY')
  assert.equal(cnyCard.symbol, '¥')
  assert.equal(cnyCard.pageVariant, 'zh')
  assert.deepEqual(cnyCard.rates['deepseek-flash'], { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8, offPeakMultiplier: 0.5 })
  assert.deepEqual(cnyCard.rates['deepseek-v4-pro'], { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27, offPeakMultiplier: 0.5 })
  assert.deepEqual(cnyCard.peakWindows, [[60, 240], [360, 600]], 'Beijing 09:00–12:00 / 14:00–18:00 is UTC 01:00–04:00 / 06:00–10:00')
  assert.equal(cnyCard.weekdaysOnly, true)

  // The two copies describe the same tariff at the published exchange rate
  // (~7.1–7.3 CNY/USD); a mismatch would mean one of them was misread.
  const ratio = cnyCard.rates['deepseek-flash'].input / card.rates['deepseek-flash'].input
  assert.ok(ratio > 6 && ratio < 8, `CNY and USD copies stay proportional (got ${ratio})`)

  // A window stated in an unknown zone is rejected rather than silently read as UTC.
  const noZone = zhFixture.replace(/北京时间/g, '当地时间')
  assert.equal(parsePricingPage(noZone), null, 'a window without a recognized zone marker is rejected')
  const enNoZone = fixture.replace(/\bUTC\b/g, 'local time')
  assert.equal(parsePricingPage(enNoZone), null, 'the English page must state UTC too')
}

// --- holiday-calendar payloads --------------------------------------------
{
  // timor.tech shape: holiday:true are days off, holiday:false are makeup workdays.
  const timor = {
    code: 0,
    holiday: {
      '01-01': { holiday: true, name: '元旦', date: '2026-01-01' },
      '01-04': { holiday: false, name: '元旦后补班', date: '2026-01-04' },
      '02-15': { holiday: true, name: '春节', date: '2026-02-15' },
    },
  }
  assert.deepEqual(parseHolidayPayload(timor, 2026), ['2026-01-01', '2026-02-15'], 'makeup workdays are not holidays')

  // Nager.Date shape.
  const nager = [
    { date: '2026-10-01', localName: '国庆节' },
    { date: '2026-10-02', localName: '国庆节' },
  ]
  assert.deepEqual(parseHolidayPayload(nager, 2026), ['2026-10-01', '2026-10-02'])

  // Plain array / dates object, with out-of-year entries dropped.
  assert.deepEqual(parseHolidayPayload(['2026-05-01', '2027-01-01'], 2026), ['2026-05-01'])
  assert.deepEqual(parseHolidayPayload({ dates: ['2026-06-19'] }, 2026), ['2026-06-19'])
  assert.deepEqual(parseHolidayPayload({}, 2026), [])
}

// --- tariff policy ----------------------------------------------------------
const settings = resolveSettings({ pricingSource: false })
const catalog = createPricingCatalog(settings)
const pricing = catalog.snapshotFor(0)
const at = (iso) => Date.parse(iso)
assert.equal(pricing.offPeakEnabled, true)
assert.deepEqual(pricing.peakWindows, [[60, 240], [360, 600]])
assert.equal(bandOf(at('2026-10-19T02:00:00Z'), pricing), 'peak', 'Monday 02:00Z is peak')
assert.equal(bandOf(at('2026-10-19T04:00:00Z'), pricing), 'offPeak', '04:00Z ends the first peak window')
assert.equal(bandOf(at('2026-10-19T06:00:00Z'), pricing), 'peak', '06:00Z starts the second')
assert.equal(bandOf(at('2026-10-19T10:00:00Z'), pricing), 'offPeak', '10:00Z ends it')
assert.equal(bandOf(at('2026-10-19T05:00:00Z'), pricing), 'offPeak', 'the gap is off-peak')
assert.equal(bandOf(at('2026-10-17T02:00:00Z'), pricing), 'offPeak', 'Saturday is off-peak all day')
assert.equal(bandOf(at('2026-10-18T06:00:00Z'), pricing), 'offPeak', 'Sunday is off-peak all day')

const holidaySettings = resolveSettings({ pricingSource: false, holidays: ['2026-10-19'] })
const holidayPricing = createPricingCatalog(holidaySettings).snapshotFor(0)
assert.equal(bandOf(at('2026-10-19T02:00:00Z'), holidayPricing), 'offPeak', 'a configured Beijing holiday is off-peak')

const alwaysPeak = makePricingSnapshot(
  { ...settings.fallbackCard, peakWindows: [], weekdaysOnly: false },
  { ...settings, offPeakEnabled: false },
)
assert.equal(bandOf(at('2026-10-17T02:00:00Z'), alwaysPeak), 'peak', 'disabled off-peak is all peak')

const weekendPeak = makePricingSnapshot(
  { ...settings.fallbackCard, peakWindows: [[60, 240]], weekdaysOnly: false },
  settings,
)
assert.equal(bandOf(at('2026-10-17T02:00:00Z'), weekendPeak), 'peak', 'weekdaysOnly:false makes weekends peakable')

// --- pricing ---------------------------------------------------------------
// The built-in card mirrors the zh-CN page, i.e. CNY per 1M tokens.
const flash = DEFAULT_RATE_CARD['deepseek-flash']
assert.equal(flash.input, 2, 'flash cache-miss input is ¥2 / 1M')
assert.equal(flash.cacheRead, 0.04, 'flash cache-hit input is ¥0.04 / 1M')
assert.equal(flash.output, 8, 'flash output is ¥8 / 1M')
const peakPrice = priceTokens({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000, reasoning: 0 }, flash, pricing, 'peak')
// 2 + 0.04 + 8 = ¥10.04 -> 10_040_000 micro-CNY
assert.equal(peakPrice.micros, 10_040_000)
assert.equal(peakPrice.buckets.input, 2_000_000)
assert.equal(peakPrice.buckets.cacheRead, 40_000)
assert.equal(peakPrice.buckets.output, 8_000_000)
const bucketSum = (buckets) => buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output + buckets.reasoning
assert.equal(bucketSum(peakPrice.buckets), peakPrice.micros, 'per-bucket rows add up')

const offPrice = priceTokens({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000, reasoning: 0 }, flash, pricing, 'offPeak')
assert.equal(offPrice.micros, 5_020_000, 'off-peak is half')
assert.equal(offPrice.savedMicros, 5_020_000)
assert.equal(bucketSum(offPrice.buckets), offPrice.micros)

// `exchangeRate` is a display multiplier applied to the card's own currency.
const scaledPricing = makePricingSnapshot(settings.fallbackCard, { ...settings, exchangeRate: 2 })
const scaledPrice = priceTokens({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }, flash, scaledPricing, 'peak')
assert.equal(scaledPrice.micros, 4_000_000, '¥2 * exchangeRate 2 = 4_000_000 micros')
assert.equal(scaledPrice.micros, bucketSum(scaledPrice.buckets))

// --- one call priced end-to-end -------------------------------------------
{
  const def = unit({ pricingSource: false })
  const state = fold(def, [header(), stepStart(NOW), assistant({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 })], 0)
  const view = def.wire.view(state)
  assert.equal(view.calls, 1)
  assert.equal(view.micros, 10_040_000)
  assert.equal(view.currency, 'CNY', 'the meter is denominated in CNY')
  assert.equal(view.symbol, '¥')
  assert.equal(view.peakMicros, view.micros)
  assert.equal(view.offPeakMicros, 0)
  assert.equal(view.pricing.version, 'config')
  assert.deepEqual(view.pricing.peakWindows, [[60, 240], [360, 600]])
  assert.equal(view.models[0].model, 'deepseek-flash')
  assert.equal(view.micros, view.peakMicros + view.offPeakMicros)
  assert.equal(bucketSum(view.bucketMicros), view.micros)
}

// --- off-peak session ------------------------------------------------------
{
  const def = unit({ pricingSource: false })
  const off = at('2026-10-19T05:00:00Z')
  const view = def.wire.view(fold(def, [header(), stepStart(off), assistant({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, { time: off })], 0))
  assert.equal(view.offPeak.calls, 1)
  assert.equal(view.offPeakMicros, 5_000_000, '(2 + 8) / 2 CNY')
  assert.equal(view.savedMicros, 5_000_000)
}

// --- one conversation crossing a peak boundary -----------------------------
{
  const def = unit({ pricingSource: false })
  const peakTime = at('2026-10-19T03:59:00Z') // Monday, last minute of 01:00–04:00
  const offTime = at('2026-10-19T04:01:00Z') // first minutes of the off-peak gap
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
  const events = [
    header(),
    { type: 'step/start', seq: 1, time: peakTime, data: { turn: 1, step: 1 } },
    assistant(usage, { time: peakTime, seq: 2, step: 1 }),
    { type: 'step/end', seq: 3, time: peakTime, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 4, time: offTime, data: { turn: 1, step: 2 } },
    assistant(usage, { time: offTime, seq: 5, step: 2 }),
  ]
  const view = def.wire.view(fold(def, events, 0))
  assert.equal(view.calls, 2, 'two requests in one conversation')
  assert.equal(view.peak.calls, 1, 'the 03:59 request is peak')
  assert.equal(view.offPeak.calls, 1, 'the 04:01 request is off-peak')
  assert.equal(view.peakMicros, 10_000_000, 'peak request: 2 + 8 CNY')
  assert.equal(view.offPeakMicros, 5_000_000, 'off-peak request: half price')
  assert.equal(view.micros, 15_000_000, 'the conversation total is the sum of both bands')
  assert.equal(view.savedMicros, 5_000_000)
  assert.equal(view.peak.tokens.input, 1_000_000)
  assert.equal(view.offPeak.tokens.input, 1_000_000)
  assert.equal(view.tokens.input, 2_000_000)
  assert.equal(view.models[0].peak.micros, 10_000_000)
  assert.equal(view.models[0].offPeak.micros, 5_000_000)
}

// --- the request start time decides its band, not its settlement time -----
{
  const def = unit({ pricingSource: false })
  const started = at('2026-10-19T03:59:00Z')
  const settled = at('2026-10-19T04:05:00Z')
  const events = [
    header(),
    { type: 'step/start', seq: 1, time: started, data: { turn: 1, step: 1 } },
    assistant({ inputTokens: 1_000_000, outputTokens: 0 }, { time: settled, seq: 2 }),
  ]
  const view = def.wire.view(fold(def, events, 0))
  assert.equal(view.peak.calls, 1, 'a request that started in peak is priced as peak even if it settles after the boundary')
  assert.equal(view.offPeak.calls, 0)
}

// --- weekend/holiday crossing inside one conversation ----------------------
{
  const def = unit({ pricingSource: false })
  const friday = at('2026-10-23T09:59:00Z') // Friday, inside the second peak window
  const saturday = at('2026-10-24T02:00:00Z') // Saturday, off-peak all day
  const events = [
    header(),
    { type: 'step/start', seq: 1, time: friday, data: { turn: 1, step: 1 } },
    assistant({ inputTokens: 1_000_000, outputTokens: 0 }, { time: friday, seq: 2, step: 1 }),
    { type: 'step/start', seq: 3, time: saturday, data: { turn: 1, step: 2 } },
    assistant({ inputTokens: 1_000_000, outputTokens: 0 }, { time: saturday, seq: 4, step: 2 }),
  ]
  const view = def.wire.view(fold(def, events, 0))
  assert.equal(view.peak.calls, 1)
  assert.equal(view.offPeak.calls, 1)
  assert.equal(view.peakMicros, 2_000_000)
  assert.equal(view.offPeakMicros, 1_000_000)
}

// --- replacement and retry accounting --------------------------------------
{
  const def = unit({ pricingSource: false })
  const attempt = assistant({ inputTokens: 100, outputTokens: 50 }, { attempt: true, seq: 2 })
  const final = assistant({ inputTokens: 1_000, outputTokens: 500 }, { seq: 3 })
  const view = def.wire.view(fold(def, [header(), stepStart(NOW), attempt, final], 0))
  assert.equal(view.calls, 1, 'the final message replaces its attempt sample')
  assert.equal(view.tokens.input, 1_000)
}
{
  const def = unit({ pricingSource: false })
  const retry = { type: 'llm/retry-started', seq: 3, time: NOW, data: { turn: 1, step: 1 } }
  const attempt = assistant({ inputTokens: 100, outputTokens: 50 }, { attempt: true, seq: 2 })
  const final = assistant({ inputTokens: 1_000, outputTokens: 500 }, { seq: 4 })
  const view = def.wire.view(fold(def, [header(), stepStart(NOW), attempt, retry, final], 0))
  assert.equal(view.calls, 2, 'a retried attempt is billed as well')
  assert.equal(view.tokens.input, 1_100)
}

// --- replay equivalence ----------------------------------------------------
{
  const def = unit({ pricingSource: false })
  const events = [
    header(),
    stepStart(NOW),
    assistant({ inputTokens: 42, cacheReadTokens: 7, outputTokens: 9 }, { seq: 2 }),
    { type: 'step/end', seq: 3, time: NOW, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 4, time: NOW + 1, data: { turn: 1, step: 2 } },
    assistant({ inputTokens: 1_000, cacheReadTokens: 900_000, cacheWriteTokens: 10, outputTokens: 2_000 }, { seq: 5, step: 2 }),
  ]
  const incremental = fold(def, events, 0)
  const replayed = events.reduce((state, event) => def.apply(state, event), def.init({ createdAt: 0 }))
  assert.deepEqual(def.wire.view(incremental), def.wire.view(replayed))
  assert.equal(def.wire.view(incremental).calls, 2)
}

// --- unpriced and fallback-estimated routes --------------------------------
{
  const unpriced = unit({ pricingSource: false, rates: null })
  const view = unpriced.wire.view(fold(unpriced, [header(), stepStart(NOW), assistant({ inputTokens: 1_000, outputTokens: 1_000 })], 0))
  assert.equal(view.calls, 1)
  assert.equal(view.unpricedCalls, 1)
  assert.equal(view.micros, 0)

  const estimated = unit({ pricingSource: false, rates: { 'deepseek-flash': null } })
  const estimatedView = estimated.wire.view(fold(estimated, [header(), stepStart(NOW), assistant({ inputTokens: 1_000_000, outputTokens: 0 })], 0))
  assert.equal(estimatedView.estimatedCalls, 1)
  assert.equal(estimatedView.micros, 2_000_000, 'default card prices the estimated call')
}

// --- subtree total: a parent's pill includes its sub-agents ---------------
{
  const def = unit({ pricingSource: false })
  const childA = 'session-child-a'
  const childB = 'session-child-b'
  const grandchild = 'session-grandchild'
  const events = [
    header(0),
    // The parent records its delegation targets in its own log.
    { type: 'subagent/catalog', seq: 1, time: NOW, data: { version: 0, mode: 'continuable', label: 'a', childId: childA, childCreatedAt: NOW } },
    { type: 'subagent/catalog', seq: 2, time: NOW, data: { version: 0, mode: 'continuable', label: 'b', childId: childB, childCreatedAt: NOW } },
    { type: 'subagent/catalog', seq: 3, time: NOW, data: { version: 0, mode: 'continuable', label: 'b again', childId: childB, childCreatedAt: NOW } },
    stepStart(NOW),
    assistant({ inputTokens: 1_000_000, outputTokens: 0 }, { seq: 5 }),
  ]
  const state = fold(def, events, 0)
  assert.deepEqual(state.children, [childA, childB], 'child ids are deduped and kept in order')

  // Without a cache the children are unknown, never free.
  const bare = def.wire.view(state)
  assert.equal(bare.micros, 2_000_000, 'the own amount stays the parent\'s own')
  assert.equal(bare.subtree.ownMicros, 2_000_000)
  assert.equal(bare.subtree.childrenMicros, 0)
  assert.equal(bare.subtree.childCount, 0)
  assert.equal(bare.subtree.unknownCount, 2, 'two children with no cached amount are reported as unknown')
  assert.equal(bare.subtree.micros, 2_000_000, 'an unknown child is not silently counted as zero-cost')

  // A Host cache with the children's amounts makes the subtree total real.
  const cache = new Map([
    [childA, { own: 3_000_000, calls: 2, children: [] }],
    [childB, { own: 4_000_000, calls: 3, children: [grandchild] }],
    [grandchild, { own: 1_000_000, calls: 1, children: [] }],
  ])
  const withTree = viewOf(state, null, (id) => cache.get(id))
  assert.equal(withTree.subtree.ownMicros, 2_000_000)
  assert.equal(withTree.subtree.childrenMicros, 8_000_000, 'children plus grandchildren')
  assert.equal(withTree.subtree.micros, 10_000_000, 'own + the whole delegated tree')
  assert.equal(withTree.subtree.childCount, 3, 'every reachable descendant is counted once')
  assert.equal(withTree.subtree.unknownCount, 0)
  assert.equal(withTree.subtree.calls, 7, 'tool calls across the tree are additive')
  assert.equal(withTree.micros, 2_000_000, 'the plain own total is unchanged')

  // A cycle cannot loop forever.
  const cyclic = new Map([
    [childA, { own: 1_000_000, calls: 1, children: [childB] }],
    [childB, { own: 1_000_000, calls: 1, children: [childA] }],
  ])
  assert.equal(viewOf(state, null, (id) => cyclic.get(id)).subtree.micros, 4_000_000, 'a cyclic catalog is visited once per Session')
}

// --- the Host cache records each Session's own amount ---------------------
{
  let definition
  let changeListener
  const ctx = {
    sessionProjections: {
      register: (value) => ((definition = value), () => {}),
      onChanged: (listener) => ((changeListener = listener), () => {}),
    },
    effect: (callback) => callback(),
    get: () => undefined,
    logger: {},
  }
  apply(ctx, { pricingSource: false })
  assert.equal(typeof changeListener, 'function', 'apply() subscribes to the projection change feed')

  const parentHeader = { createdAt: NOW, id: 'session-parent' }
  const childHeader = { createdAt: NOW, id: 'session-child' }
  const childState = fold(definition, [
    header(),
    stepStart(NOW),
    assistant({ inputTokens: 1_000_000, outputTokens: 0 }, { seq: 2 }),
  ], NOW)
  const childView = { ...definition.wire.view(childState) }
  changeListener({ id: 'session-child' }, 'tokenCost', childView, 1)

  const parentState = fold(definition, [
    { type: 'subagent/catalog', seq: 0, time: NOW, data: { version: 0, mode: 'continuable', label: 'c', childId: 'session-child', childCreatedAt: NOW } },
    header(),
    stepStart(NOW),
    assistant({ inputTokens: 1_000_000, outputTokens: 0 }, { seq: 3 }),
  ], NOW)
  const parentView = definition.wire.view({ ...parentState, sessionId: 'session-parent' })
  assert.equal(parentView.micros, 2_000_000)
  assert.equal(parentView.subtree.childrenMicros, 2_000_000, 'the parent reads the child amount from the Host cache')
  assert.equal(parentView.subtree.micros, 4_000_000, 'the pill total covers the child')
  assert.equal(parentView.subtree.childCount, 1)

  // A fork/restore where the child never fired a change: its own view read
  // seeds the cache, so the parent is no longer short by that amount.
  const orphanState = fold(definition, [
    header(),
    stepStart(NOW),
    assistant({ inputTokens: 500_000, outputTokens: 0 }, { seq: 2 }),
  ], NOW)
  definition.wire.view({ ...orphanState, sessionId: 'session-late' })
  const lateParent = fold(definition, [
    { type: 'subagent/catalog', seq: 0, time: NOW, data: { version: 0, mode: 'continuable', label: 'l', childId: 'session-late', childCreatedAt: NOW } },
  ], NOW)
  assert.equal(
    definition.wire.view({ ...lateParent, sessionId: 'session-parent-2' }).subtree.childrenMicros,
    1_000_000,
    'a Session that only ever had its view read still contributes to its parent',
  )
}

// --- excluded gateway routes are out of scope, never $0 -------------------
{
  const def = unit({ pricingSource: false })
  const magpie = header(0, 'magpie', 'workbuddy/deepseek-v4.1-flash')
  const view = def.wire.view(
    fold(def, [magpie, stepStart(NOW), assistant({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, { seq: 2 })], 0),
  )
  assert.equal(view.excludedCalls, 1, 'a gateway route is counted as excluded')
  assert.equal(view.calls, 0, 'excluded calls are not billed calls')
  assert.equal(view.micros, 0, 'an excluded route contributes no money')
  assert.equal(view.unpricedCalls, 0, 'excluded is not "unpriced": it is deliberately out of scope')
  assert.equal(view.excludedTokens, 2_000_000, 'the skipped volume is reported')
  assert.equal(view.tokens.input, 0, 'excluded tokens leave the session totals')
  assert.equal(view.models[0].excludedCalls, 1)
  assert.equal(view.models[0].epochs[0].rateBasis, 'excluded')

  // A DeepSeek route in the same session is unaffected by the exclusion.
  const mixed = def.wire.view(
    fold(
      def,
      [
        magpie,
        stepStart(NOW),
        assistant({ inputTokens: 1_000_000, outputTokens: 0 }, { seq: 2 }),
        header(NOW, 'deepseek-account', 'deepseek-flash'),
        { type: 'step/start', seq: 4, time: NOW, data: { turn: 1, step: 2 } },
        assistant({ inputTokens: 1_000_000, outputTokens: 0 }, { seq: 5, step: 2 }),
      ],
      0,
    ),
  )
  assert.equal(mixed.calls, 1, 'only the DeepSeek request is billed')
  assert.equal(mixed.micros, 2_000_000, '¥2 for the DeepSeek 1M cache-miss input')
  assert.equal(mixed.excludedCalls, 1)
}

// --- reasoning billing switch ---------------------------------------------
{
  const def = unit({ pricingSource: false })
  const separate = unit({ pricingSource: false, reasoningBilling: 'separate' })
  const usage = { inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 1_000_000 }
  const a = def.wire.view(fold(def, [header(), stepStart(NOW), assistant(usage)], 0))
  const b = separate.wire.view(fold(separate, [header(), stepStart(NOW), assistant(usage)], 0))
  assert.equal(a.micros, 8_000_000, 'reasoning is inside output by default')
  assert.equal(b.micros, 16_000_000, 'separate reasoning adds output-rate cost')
}

// --- effective-dated catalog: a price change splits the timeline -----------
{
  const settings = resolveSettings({ pricingSource: false })
  const catalog = createPricingCatalog(settings)
  const t0 = Date.parse('2026-10-19T02:00:00Z') // Monday, inside the 01:00–04:00 UTC peak window
  const t1 = t0 + 30 * 60_000 // still inside the same peak window
  const before = catalog.snapshotFor(t0)
  assert.equal(before.version, 'config')
  const official = {
    ...settings.fallbackCard,
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    currency: 'CNY',
    symbol: '¥',
    rates: { 'deepseek-flash': { input: 4, cacheRead: 0.08, cacheWrite: 4, output: 16, offPeakMultiplier: 0.5 }, default: { input: 4, cacheRead: 0.08, cacheWrite: 4, output: 16, offPeakMultiplier: 0.5 } },
  }
  assert.equal(catalog.ingest(official, t1), true, 'a changed card becomes a new epoch')
  assert.equal(catalog.ingest(official, t1 + 1000), false, 'an unchanged card is not a new epoch')
  assert.equal(catalog.snapshotFor(t0).rates['deepseek-flash'].input, 2, 'a moment before the change keeps the old rate')
  assert.equal(catalog.snapshotFor(t1 + 1).version, 'official-1', 'a moment after the change uses the new epoch')
  assert.equal(catalog.snapshotFor(t1 + 1).rates['deepseek-flash'].input, 4)
  assert.equal(catalog.snapshotFor(t1 + 1).source, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing')

  // The timeline carries both epochs, each closed by the next one.
  const epochs = catalog.epochsFor(t0)
  assert.equal(epochs.length, 2)
  assert.equal(epochs[0].effectiveTo, t1, 'the old epoch ends where the new one starts')
  assert.equal(epochs[1].effectiveFrom, t1)
  assert.equal(epochs[1].effectiveTo, null, 'the newest epoch is open-ended')

  // One conversation that spans the change is billed at both rates, and the
  // split happens at the change, not at the conversation start.
  const def = unit({ pricingSource: false })
  let state = def.init({ createdAt: t0 })
  const events = [
    { ...header(t0), seq: 0 },
    { type: 'step/start', seq: 1, time: t0 + 10, data: { turn: 1, step: 1 } },
    assistant({ inputTokens: 1_000_000, outputTokens: 0 }, { time: t0 + 10, seq: 2, step: 1 }),
    { type: 'step/start', seq: 3, time: t1 + 10, data: { turn: 1, step: 2 } },
    assistant({ inputTokens: 1_000_000, outputTokens: 0 }, { time: t1 + 10, seq: 4, step: 2 }),
  ]
  state = syncEpochs(state, epochs)
  for (const event of events) state = def.apply(state, event)
  const view = def.wire.view(syncEpochs(state, epochs))
  assert.equal(view.calls, 2)
  assert.equal(view.micros, 6_000_000, '¥2/1M before the change + ¥4/1M after it')
  assert.equal(view.models[0].epochs.length, 2, 'the model row reports both rate epochs')
  assert.equal(view.models[0].epochs[0].micros, 2_000_000)
  assert.equal(view.models[0].epochs[1].micros, 4_000_000)
  assert.equal(view.pricing.epochs.length, 2, 'the wire value documents the timeline')
}

// --- an identical first fetch only upgrades the source label --------------
{
  const settings = resolveSettings({ pricingSource: false })
  const catalog = createPricingCatalog(settings)
  const same = { ...settings.fallbackCard, source: 'https://official/', currency: 'CNY', symbol: '¥' }
  assert.equal(catalog.ingest(same, 10_000), false)
  const snapshot = catalog.snapshotFor(1)
  assert.equal(snapshot.source, 'https://official/', 'new moments report the official source')
  assert.equal(snapshot.version, 'config')
}

// --- a holiday-calendar update is an effective-dated catalog version ------
{
  const settings = resolveSettings({ pricingSource: false })
  const catalog = createPricingCatalog(settings)
  const t0 = 1_000
  const t1 = 50_000
  const before = catalog.snapshotFor(t0)
  assert.deepEqual(before.holidays, [])
  assert.equal(bandOf(at('2026-10-19T02:00:00Z'), before), 'peak', 'no calendar yet: the holiday is peak')
  assert.equal(catalog.ingest({ ...settings.fallbackCard, holidays: ['2026-10-19'], holidaysSource: 'auto' }, t1), true)
  assert.deepEqual(catalog.snapshotFor(t0).holidays, [], 'a conversation created earlier keeps the empty calendar')
  const after = catalog.snapshotFor(t1 + 1)
  assert.deepEqual(after.holidays, ['2026-10-19'], 'a new conversation gets the fetched calendar')
  assert.equal(after.holidaysSource, 'auto')
  assert.equal(bandOf(at('2026-10-19T02:00:00Z'), after), 'offPeak', 'the fetched holiday is off-peak for new conversations')
}

// --- no money is persisted -------------------------------------------------
{
  const def = unit({ pricingSource: false })
  const state = fold(def, [header(), stepStart(NOW), assistant({ inputTokens: 1_000, outputTokens: 1_000 })], 0)
  assert.equal(JSON.stringify(state).includes('micros'), false, 'projection state keeps billed facts only')
  assert.ok(state.pricing.rates['deepseek-flash'], 'the rate epochs travel with the state')
}

// --- empty log -------------------------------------------------------------
{
  const def = unit({ pricingSource: false, holidaysSource: false })
  const view = def.wire.view(def.init({ createdAt: 0 }))
  assert.equal(view.calls, 0)
  assert.equal(view.micros, 0)
  assert.deepEqual(view.models, [])
  assert.equal(view.pricing.version, 'config')
  assert.deepEqual(view.pricing.autoRefresh, { pricing: false, holidays: false }, 'offline rows advertise no automatic refresh')
}

// ===========================================================================
// P0-1 / P0-2: refresh controller, retry/backoff, freshness, parser contracts
// ===========================================================================
const {
  PARSER_VERSION,
  HOLIDAY_RETRY_DELAYS_MS,
  createRefreshController,
  mergeHolidayCalendar,
  normalizeHolidayProvenance,
  holidaysKindOf,
  holidayRetryDelayMs,
} = internals

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Deterministic clock + timer set; `advance` runs due callbacks in order. */
function createFakeTimers(startMs) {
  const clock = { now: startMs }
  const tasks = new Map()
  let nextId = 1
  const add = (fn, delay, every) => {
    const id = nextId++
    const wait = Math.max(0, Number(delay) || 0)
    tasks.set(id, { fn, at: clock.now + wait, every })
    return id
  }
  const timers = {
    setTimeout: (fn, delay) => add(fn, delay, null),
    clearTimeout: (id) => {
      tasks.delete(id)
    },
    setInterval: (fn, delay) => add(fn, delay, Math.max(1, Number(delay) || 1)),
    clearInterval: (id) => {
      tasks.delete(id)
    },
  }
  const advance = async (ms) => {
    const target = clock.now + ms
    for (;;) {
      let due = null
      for (const [id, task] of tasks) {
        if (task.at <= target && (due === null || task.at < due.task.at)) due = { id, task }
      }
      if (due === null) break
      clock.now = due.task.at
      if (due.task.every === null) tasks.delete(due.id)
      else due.task.at += due.task.every
      due.task.fn()
      await flush()
    }
    clock.now = target
    await flush()
  }
  return { clock, timers, advance, pending: () => tasks.size }
}

// --- parser contract fixtures: reordered columns, redesign, sanity checks ---
{
  const canonical = parsePricingPage(fixture)
  assert.ok(canonical !== null)
  assert.equal(canonical.parserVersion, PARSER_VERSION, 'the parsed card records the parser version')

  const reordered = parsePricingPage(reorderedFixture)
  assert.ok(reordered !== null, 'a PEAK-before-OFF-PEAK column order still parses')
  assert.deepEqual(reordered.models, ['deepseek-flash', 'deepseek-v4-pro'])
  assert.deepEqual(reordered.rates['deepseek-flash'], canonical.rates['deepseek-flash'], 'model-to-column mapping survives reordered labels')
  assert.deepEqual(reordered.rates['deepseek-v4-pro'], canonical.rates['deepseek-v4-pro'])
  assert.equal(reordered.rates['deepseek-flash'].offPeakMultiplier, 0.5)
  assert.deepEqual(reordered.peakWindows, [[60, 240], [360, 600]])
  assert.equal(reordered.weekdaysOnly, true)
  assert.equal(reordered.currency, 'USD')

  assert.equal(parsePricingPage(revampedFixture), null, 'a redesigned pricing table fails explicitly instead of guessing')

  // Sanity checks: the parser validates its own output.
  const abovePeak = fixture.replace('$0.003', '$0.03')
  assert.equal(parsePricingPage(abovePeak), null, 'an off-peak price above its peak price is rejected')
  const oneModel = fixture.replace('<td>deepseek-v4-pro</td>', '<td>deepseek-flash</td>')
  assert.equal(parsePricingPage(oneModel), null, 'two distinct model columns are required')
  assert.equal(parsePricingPage(''), null)
  assert.equal(parsePricingPage(null), null)
}

// --- holiday merge helper: sorted union + disjoint provenance --------------
{
  const merged = mergeHolidayCalendar({
    manual: ['2026-10-01', '2026-05-01'],
    auto: ['2026-10-01', '2026-10-02', '2026-01-01'],
    fixed: ['2026-01-01', '2026-05-01', '2027-10-01'],
  })
  assert.deepEqual(merged.holidays, ['2026-01-01', '2026-05-01', '2026-10-01', '2026-10-02', '2027-10-01'])
  assert.deepEqual(merged.holidayProvenance.manual, ['2026-05-01', '2026-10-01'], 'manual dates win attribution')
  assert.deepEqual(merged.holidayProvenance.auto, ['2026-01-01', '2026-10-02'], 'auto dates excluded from manual/fixed')
  assert.deepEqual(merged.holidayProvenance.fixed, ['2027-10-01'], 'fixed anchors fill only dates no published source covers')
  const attributed = merged.holidayProvenance.auto.length + merged.holidayProvenance.manual.length + merged.holidayProvenance.fixed.length
  assert.equal(attributed, merged.holidays.length, 'provenance counts add up to the union size')
  assert.deepEqual(mergeHolidayCalendar({}).holidays, [])
  assert.deepEqual(mergeHolidayCalendar({ manual: ['bad', '2026-10-01', '2026-10-01'] }).holidays, ['2026-10-01'], 'invalid entries are dropped, duplicates deduped')

  assert.deepEqual(normalizeHolidayProvenance({ holidays: ['2026-10-01'], holidaysSource: 'auto' }), { auto: ['2026-10-01'], manual: [], fixed: [] })
  assert.deepEqual(normalizeHolidayProvenance({}), { auto: [], manual: [], fixed: [] })
  assert.equal(holidaysKindOf({ auto: ['2026-10-01'], manual: [], fixed: [] }), 'auto')
  assert.equal(holidaysKindOf({ auto: [], manual: ['2026-10-01'], fixed: [] }), 'manual')
  assert.equal(holidaysKindOf({ auto: [], manual: [], fixed: ['2027-01-01'] }), 'fixed', 'a fixed-only calendar reports its own kind')
  assert.equal(holidaysKindOf({ auto: [], manual: [], fixed: [] }), 'none')

  assert.deepEqual(HOLIDAY_RETRY_DELAYS_MS, [5 * 60_000, 15 * 60_000, 60 * 60_000])
  assert.equal(holidayRetryDelayMs(1), 5 * 60_000)
  assert.equal(holidayRetryDelayMs(2), 15 * 60_000)
  assert.equal(holidayRetryDelayMs(3), 60 * 60_000)
  assert.equal(holidayRetryDelayMs(9), 60 * 60_000)
}

// --- P0-1: a totally failed holiday refresh is not a success; short backoff,
//          then the configured 24h interval after one success -----------------
{
  const start = Date.parse('2026-10-19T02:00:00Z')
  const { clock, timers, advance } = createFakeTimers(start)
  const pricingUrl = 'https://pricing.test/page'
  const cards = []
  const statuses = []
  const warnings = []
  const holidayUrls = []
  let holidayResponds = false
  const web = {
    fetch: async ({ url }) => {
      if (url === pricingUrl) return { statusCode: 200, url, body: { content: fixture } }
      holidayUrls.push(url)
      if (!holidayResponds) return { statusCode: 503, url, body: { content: '' } }
      const year = /\/year\/(\d{4})$/.exec(url)[1]
      return { statusCode: 200, url, body: { content: JSON.stringify({ holiday: { '10-01': { holiday: true, date: `${year}-10-01` } } }) } }
    },
  }
  const settings = resolveSettings({ pricingSource: pricingUrl })
  const controller = createRefreshController({
    web,
    settings,
    logger: { warn: (message) => warnings.push(message) },
    now: () => clock.now,
    timers,
    onCard: (card) => cards.push(card),
    onStatus: (status) => statuses.push(status),
  })
  controller.start()
  await advance(0)

  let status = controller.status()
  assert.equal(status.pricing.fetchedAt, start, 'the pricing fetch runs immediately and independently')
  assert.equal(status.pricing.stale, false)
  assert.equal(status.pricing.parserVersion, 1)
  assert.equal(status.holidays.fetchedAt, 0, 'a total holiday failure is not recorded as a successful refresh')
  assert.equal(status.holidays.consecutiveFailures, 1)
  assert.match(status.holidays.error, /HTTP 503/)
  assert.equal(status.holidays.nextRetryAt, start + 5 * 60_000, 'the first failure retries after 5 minutes')
  assert.equal(status.holidays.stale, true, 'never fetched while auto refresh is enabled is stale')
  assert.equal(holidayUrls.length, 2, 'both requested years were attempted')
  assert.ok(statuses.length >= 1, 'the controller reports live status')
  assert.ok(warnings.some((message) => message.includes('holiday refresh failed')))

  await advance(5 * 60_000)
  status = controller.status()
  assert.equal(status.holidays.consecutiveFailures, 2, 'the 5-minute retry ran')
  assert.equal(status.holidays.nextRetryAt, clock.now + 15 * 60_000, 'the second failure retries after 15 minutes')

  await advance(15 * 60_000)
  status = controller.status()
  assert.equal(status.holidays.consecutiveFailures, 3)
  assert.equal(status.holidays.nextRetryAt, clock.now + 60 * 60_000, 'the third failure backs off to 1 hour')

  await advance(60 * 60_000)
  status = controller.status()
  assert.equal(status.holidays.consecutiveFailures, 4, 'it stays on the hourly retry while failing')
  assert.equal(status.holidays.nextRetryAt, clock.now + 60 * 60_000)

  const beforeSuccess = clock.now
  holidayResponds = true
  await advance(60 * 60_000)
  status = controller.status()
  assert.equal(status.holidays.fetchedAt, beforeSuccess + 60 * 60_000, 'a success marks the holiday refresh time')
  assert.equal(status.holidays.consecutiveFailures, 0)
  assert.equal(status.holidays.error, null)
  assert.equal(status.holidays.nextRetryAt, status.holidays.fetchedAt + 24 * 60 * 60_000, 'a success returns to the 24h interval')

  const holidayCard = cards[cards.length - 1]
  // The fetched National Day dates win; every other statutory block is filled
  // from the canonical fixed anchors (元旦 1 day, 春节 7, 劳动节 5, 国庆节 7).
  assert.deepEqual(
    holidayCard.holidays,
    [...new Set([...fixedAnchorsOf([2026, 2027]), '2026-10-01', '2027-10-01'])].sort(),
    'the fetched calendar plus the 2026/2027 statutory anchors',
  )
  assert.equal(holidayCard.holidaysSource, 'auto')
  assert.deepEqual(holidayCard.holidayProvenance.auto, ['2026-10-01', '2027-10-01'])
  assert.deepEqual(holidayCard.holidayProvenance.manual, [])
  assert.deepEqual(
    holidayCard.holidayProvenance.fixed,
    fixedAnchorsOf([2026, 2027]).filter((date) => date !== '2026-10-01' && date !== '2027-10-01'),
    'a published National Day date is not also a fixed anchor',
  )
  const attributed = holidayCard.holidayProvenance.auto.length + holidayCard.holidayProvenance.manual.length + holidayCard.holidayProvenance.fixed.length
  assert.equal(attributed, holidayCard.holidays.length, 'provenance counts add up to the union size')
  assert.equal(holidayCard.parserVersion, 1, 'the holiday publish keeps the parsed pricing card')

  const callsAfterSuccess = holidayUrls.length
  await advance(24 * 60 * 60_000 - 1)
  assert.equal(holidayUrls.length, callsAfterSuccess, 'no holiday retry before the normal interval')
  await advance(2)
  assert.ok(holidayUrls.length > callsAfterSuccess, 'the 24h interval is restored after a success')
  controller.stop()
}

// --- P0-1: a slow holiday source does not delay the pricing refresh --------
{
  const start = Date.parse('2026-10-19T02:00:00Z')
  const { clock, timers } = createFakeTimers(start)
  const pricingUrl = 'https://pricing.test/page'
  const cards = []
  const holidayUrls = []
  const web = {
    fetch: ({ url }) => {
      if (url === pricingUrl) return Promise.resolve({ statusCode: 200, url, body: { content: fixture } })
      holidayUrls.push(url)
      return new Promise(() => {}) // a holiday source that never settles
    },
  }
  const controller = createRefreshController({
    web,
    settings: resolveSettings({ pricingSource: pricingUrl }),
    logger: {},
    now: () => clock.now,
    timers,
    onCard: (card) => cards.push(card),
  })
  controller.start()
  await flush()
  await flush()
  const status = controller.status()
  assert.equal(status.pricing.fetchedAt, start, 'the pricing refresh completed while the holiday fetch is still pending')
  assert.equal(status.pricing.degraded, false)
  assert.equal(status.holidays.attemptedAt, start, 'the holiday fetch started immediately, in parallel')
  assert.equal(status.holidays.fetchedAt, 0)
  assert.equal(status.holidays.error, null)
  assert.ok(holidayUrls.length > 0)
  assert.equal(cards.length, 1, 'the pricing card was published without waiting for holidays')
  assert.deepEqual(
    cards[0].holidays,
    fixedAnchorsOf([2026, 2027]),
    'the pricing publish already carries the statutory anchors (the auto calendar is still pending)',
  )
  assert.equal(cards[0].parserVersion, 1)
  controller.stop()
}

// --- P0-2: degradation is explicit, a failed parse never replaces the card,
//          and staleness is computed live from the last success ---------------
{
  const start = Date.parse('2026-10-19T02:00:00Z')
  const { clock, timers, advance } = createFakeTimers(start)
  const pricingUrl = 'https://pricing.test/page'
  const cards = []
  const warnings = []
  let responseBody = '<html><body><h1>Models &amp; Pricing</h1><p>We redesigned this page.</p></body></html>'
  const web = { fetch: async ({ url }) => ({ statusCode: 200, url, body: { content: responseBody } }) }
  const settings = resolveSettings({ pricingSource: pricingUrl, holidaysSource: false })
  const controller = createRefreshController({
    web,
    settings,
    logger: { warn: (message) => warnings.push(message) },
    now: () => clock.now,
    timers,
    onCard: (card) => cards.push(card),
  })
  controller.start()
  await advance(0)

  let status = controller.status()
  assert.equal(status.pricing.fetchedAt, 0)
  assert.equal(status.pricing.degraded, true, 'an unrecognized layout is reported as degraded')
  assert.equal(status.pricing.degradedReason, 'pricing page layout was not recognized by parser v1')
  assert.equal(status.pricing.stale, true, 'never fetched with auto refresh enabled is stale')
  assert.equal(status.pricing.parserVersion, null)
  assert.equal(cards.length, 0, 'a failed parse never overwrites the current card')
  assert.equal(status.holidays.stale, false, 'a disabled holiday source is never stale')
  assert.ok(warnings.some((message) => message.includes('degraded')))

  // A successful fetch records freshness and the parser version.
  responseBody = fixture
  await advance(settings.refreshIntervalMs)
  status = controller.status()
  assert.equal(status.pricing.degraded, false)
  assert.equal(status.pricing.degradedReason, null)
  assert.equal(status.pricing.parserVersion, 1)
  assert.equal(status.pricing.fetchedAt, start + settings.refreshIntervalMs)
  assert.equal(status.pricing.stale, false)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].source, pricingUrl)

  // Later failures keep the last good card and its last success time; two missed
  // refresh intervals make the data stale.
  const lastFetchedAt = status.pricing.fetchedAt
  web.fetch = async ({ url }) => ({ statusCode: 503, url, body: { content: '' } })
  await advance(2 * settings.refreshIntervalMs + 1)
  status = controller.status()
  assert.equal(status.pricing.fetchedAt, lastFetchedAt, 'a failed refresh never moves the last success time')
  assert.equal(status.pricing.degraded, true)
  assert.match(status.pricing.degradedReason, /HTTP 503/)
  assert.equal(status.pricing.stale, true, 'older than two refresh intervals is stale')
  assert.equal(cards.length, 1, 'the good card is still the current one')
  controller.stop()
}

// --- network errors become explicit reasons, never unhandled rejections ----
{
  const start = Date.parse('2026-10-19T02:00:00Z')
  const { clock, timers, advance } = createFakeTimers(start)
  const pricingUrl = 'https://pricing.test/page'
  const web = {
    fetch: async () => {
      throw new Error('socket hang up')
    },
  }
  const controller = createRefreshController({
    web,
    settings: resolveSettings({ pricingSource: pricingUrl }),
    logger: {},
    now: () => clock.now,
    timers,
  })
  controller.start()
  await advance(0)
  const status = controller.status()
  assert.equal(status.pricing.degraded, true)
  assert.equal(status.pricing.degradedReason, 'fetch failed: socket hang up')
  assert.equal(status.pricing.fetchedAt, 0)
  assert.equal(status.holidays.consecutiveFailures, 1)
  assert.match(status.holidays.error, /socket hang up/)
  assert.equal(status.holidays.fetchedAt, 0)
  controller.stop()
}

// --- frozen snapshot carries parserVersion and holiday provenance ----------
{
  const start = Date.parse('2026-10-19T02:00:00Z')
  const { clock, timers } = createFakeTimers(start)
  const pricingUrl = 'https://pricing.test/page'
  const settings = resolveSettings({ pricingSource: pricingUrl, holidays: ['2026-05-01'] })
  const catalog = createPricingCatalog(settings)
  const web = {
    fetch: async ({ url }) => {
      if (url === pricingUrl) return { statusCode: 200, url, body: { content: fixture } }
      const year = /\/year\/(\d{4})$/.exec(url)[1]
      return { statusCode: 200, url, body: { content: JSON.stringify({ holiday: { '10-01': { holiday: true, date: `${year}-10-01` } } }) } }
    },
  }
  const controller = createRefreshController({
    web,
    settings,
    logger: {},
    now: () => clock.now,
    timers,
    onCard: (card) => catalog.ingest(card, card.fetchedAt),
  })
  controller.start()
  await flush()
  await flush()

  const snapshot = catalog.snapshotFor(clock.now)
  assert.equal(snapshot.parserVersion, 1, 'the pricing snapshot records its parser version')
  const expectedProvenance = {
    auto: ['2026-10-01', '2027-10-01'],
    manual: ['2026-05-01'],
    fixed: fixedAnchorsOf([2026, 2027]).filter((date) => date !== '2026-10-01' && date !== '2027-10-01' && date !== '2026-05-01'),
  }
  assert.deepEqual(snapshot.holidayProvenance, expectedProvenance)
  assert.deepEqual(
    snapshot.holidays,
    [...expectedProvenance.auto, ...expectedProvenance.manual, ...expectedProvenance.fixed].sort(),
    'holidays stays the sorted union array including the fixed anchors',
  )
  assert.equal(snapshot.holidaysSource, 'auto')
  assert.ok(snapshot.holidayProvenance.fixed.includes('2026-05-01') === false, 'a manual date is not also a fixed anchor')

  const state = initialState(snapshot)
  const view = viewOf(state, { ...controller.status(), catalogVersion: 'official-1' })
  assert.deepEqual(view.pricing.holidayProvenance, snapshot.holidayProvenance)
  assert.equal(view.pricing.parserVersion, 1)
  assert.equal(view.status.catalogVersion, 'official-1')
  assert.equal(view.status.pricing.parserVersion, 1)
  assert.equal(view.status.pricing.stale, false)
  assert.equal(view.status.holidays.error, null)

  // Older frozen states lack the new fields: the view must tolerate them.
  const legacy = { ...state, pricing: { ...snapshot } }
  delete legacy.pricing.holidayProvenance
  delete legacy.pricing.parserVersion
  const legacyView = viewOf(legacy)
  assert.equal(legacyView.status, null, 'a view without a live Host status keeps status null')
  assert.equal(legacyView.pricing.parserVersion, null)
  assert.deepEqual(legacyView.pricing.holidayProvenance, {
    auto: snapshot.holidays,
    manual: [],
    fixed: [],
  }, 'older states derive provenance from holidaysSource')
  assert.equal(bandOf(at('2026-10-01T02:00:00Z'), legacy.pricing), 'offPeak', 'bandOf keeps working on the legacy union array')
  controller.stop()
}

// --- apply() wires the controller with real globals and exposes view.status -
{
  const pricingUrl = 'https://apply.test/pricing'
  const holidaySource = 'https://apply.test/holiday/{year}'
  const web = {
    fetch: async ({ url }) => {
      if (url === pricingUrl) return { statusCode: 200, url, body: { content: fixture } }
      const year = /\/(\d{4})$/.exec(url)[1]
      return { statusCode: 200, url, body: { content: JSON.stringify({ holiday: { '10-01': { holiday: true, date: `${year}-10-01` } } }) } }
    },
  }
  let definition
  let cleanup
  const ctx = {
    sessionProjections: { register: (value) => ((definition = value), () => {}) },
    effect: (callback) => ((cleanup = callback()), undefined),
    get: (name) => (name === 'web' ? web : undefined),
    logger: { warn: () => {} },
  }
  apply(ctx, { pricingSource: pricingUrl, holidaysSource: holidaySource })
  assert.equal(typeof cleanup, 'function', 'the refresh effect returns a cleanup')
  await flush()
  await flush()

  const state = definition.init({ createdAt: Date.now() })
  const view = definition.wire.view(state)
  assert.ok(view.status !== null, 'a row with a web service exposes the live status')
  assert.equal(view.status.pricing.parserVersion, 1)
  assert.equal(view.status.pricing.degraded, false)
  assert.equal(view.status.pricing.stale, false)
  assert.equal(typeof view.status.catalogVersion, 'string')
  assert.ok(view.status.holidays.fetchedAt > 0, 'the holiday refresh succeeded')
  const beijingYear = new Date(Date.now() + 480 * 60_000).getUTCFullYear()
  assert.equal(view.pricing.holidayProvenance.auto.includes(`${beijingYear}-10-01`), true)
  assert.deepEqual(
    view.pricing.holidayProvenance.fixed,
    fixedAnchorsOf([beijingYear, beijingYear + 1]).filter((date) => !date.endsWith('-10-01')),
    'the published National Day dates win; the other statutory anchors stay fixed',
  )
  cleanup()
}

console.log('host tests: all assertions passed')
