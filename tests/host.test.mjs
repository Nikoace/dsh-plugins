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
  initialState,
  DEFAULT_RATE_CARD,
} = internals

const NOW = Date.parse('2026-10-19T02:00:00Z') // Monday, inside the 01:00–04:00 UTC peak window
const fixture = fs.readFileSync(new URL('./fixtures/pricing-page.html', import.meta.url), 'utf8')

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

// --- official pricing page parser ------------------------------------------
{
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
  assert.equal(card.currency, 'USD')
  assert.equal(parsePricingPage('<html><body>nothing here</body></html>'), null, 'unknown layout is rejected')
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
const flash = DEFAULT_RATE_CARD['deepseek-flash']
const peakPrice = priceTokens({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000, reasoning: 0 }, flash, pricing, 'peak')
// 0.3 + 0.006 + 1.2 = 1.506 USD -> 1_506_000 micro-USD
assert.equal(peakPrice.micros, 1_506_000)
assert.equal(peakPrice.buckets.input, 300_000)
assert.equal(peakPrice.buckets.cacheRead, 6_000)
assert.equal(peakPrice.buckets.output, 1_200_000)
const bucketSum = (buckets) => buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output + buckets.reasoning
assert.equal(bucketSum(peakPrice.buckets), peakPrice.micros, 'per-bucket rows add up')

const offPrice = priceTokens({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000, reasoning: 0 }, flash, pricing, 'offPeak')
assert.equal(offPrice.micros, 753_000, 'off-peak is half')
assert.equal(offPrice.savedMicros, 753_000)
assert.equal(bucketSum(offPrice.buckets), offPrice.micros)

const cnyPricing = makePricingSnapshot(settings.fallbackCard, { ...settings, currency: 'CNY', symbol: '¥', exchangeRate: 7.2 })
const cnyPrice = priceTokens({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }, flash, cnyPricing, 'peak')
assert.equal(cnyPrice.micros, 2_160_000, '0.3 USD * 7.2 CNY/USD = CNY 2.16')
assert.equal(cnyPrice.micros, bucketSum(cnyPrice.buckets))

// --- one call priced end-to-end -------------------------------------------
{
  const def = unit({ pricingSource: false })
  const state = fold(def, [header(), stepStart(NOW), assistant({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 })], 0)
  const view = def.wire.view(state)
  assert.equal(view.calls, 1)
  assert.equal(view.micros, 1_506_000)
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
  assert.equal(view.offPeakMicros, 750_000, '(0.3 + 1.2) / 2 USD')
  assert.equal(view.savedMicros, 750_000)
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
  assert.equal(view.peakMicros, 1_500_000, 'peak request: 0.3 + 1.2 USD')
  assert.equal(view.offPeakMicros, 750_000, 'off-peak request: half price')
  assert.equal(view.micros, 2_250_000, 'the conversation total is the sum of both bands')
  assert.equal(view.savedMicros, 750_000)
  assert.equal(view.peak.tokens.input, 1_000_000)
  assert.equal(view.offPeak.tokens.input, 1_000_000)
  assert.equal(view.tokens.input, 2_000_000)
  assert.equal(view.models[0].peak.micros, 1_500_000)
  assert.equal(view.models[0].offPeak.micros, 750_000)
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
  assert.equal(view.peakMicros, 300_000)
  assert.equal(view.offPeakMicros, 150_000)
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
  assert.equal(estimatedView.micros, 300_000, 'default card prices the estimated call')
}

// --- per-model route pricing ----------------------------------------------
{
  const def = unit({ pricingSource: false })
  const state = fold(def, [header(0, 'deepseek-account', 'deepseek-v4-pro'), stepStart(NOW), assistant({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, { seq: 2 })], 0)
  const view = def.wire.view(state)
  assert.equal(view.models[0].model, 'deepseek-v4-pro')
  assert.equal(view.micros, 5_280_000, 'v4-pro peak: 1.32 + 3.96 USD')
}

// --- reasoning billing switch ---------------------------------------------
{
  const def = unit({ pricingSource: false })
  const separate = unit({ pricingSource: false, reasoningBilling: 'separate' })
  const usage = { inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 1_000_000 }
  const a = def.wire.view(fold(def, [header(), stepStart(NOW), assistant(usage)], 0))
  const b = separate.wire.view(fold(separate, [header(), stepStart(NOW), assistant(usage)], 0))
  assert.equal(a.micros, 1_200_000, 'reasoning is inside output by default')
  assert.equal(b.micros, 2_400_000, 'separate reasoning adds output-rate cost')
}

// --- effective-dated catalog: old sessions keep their card ----------------
{
  const settings = resolveSettings({ pricingSource: false })
  const catalog = createPricingCatalog(settings)
  const t0 = 1_000
  const t1 = 50_000
  const before = catalog.snapshotFor(t0)
  assert.equal(before.version, 'config')
  const official = {
    ...settings.fallbackCard,
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    currency: 'USD',
    symbol: '$',
    rates: { 'deepseek-flash': { input: 0.6, cacheRead: 0.012, cacheWrite: 0.6, output: 2.4, offPeakMultiplier: 0.5 }, default: { input: 0.6, cacheRead: 0.012, cacheWrite: 0.6, output: 2.4, offPeakMultiplier: 0.5 } },
  }
  assert.equal(catalog.ingest(official, t1), true, 'a changed card becomes a new version')
  assert.equal(catalog.ingest(official, t1 + 1000), false, 'an unchanged card is not a new version')
  assert.equal(catalog.snapshotFor(t0).version, 'config', 'a conversation created before the change keeps its card')
  assert.equal(catalog.snapshotFor(t0).rates['deepseek-flash'].input, 0.3)
  assert.equal(catalog.snapshotFor(t1 + 1).version, 'official-1', 'a new conversation uses the new card')
  assert.equal(catalog.snapshotFor(t1 + 1).rates['deepseek-flash'].input, 0.6)
  assert.equal(catalog.snapshotFor(t1 + 1).source, 'https://api-docs.deepseek.com/quick_start/pricing')

  // The two states price the same facts differently, as each session froze its
  // own card.
  const entry = { provider: 'deepseek-account', model: 'deepseek-flash', calls: 1, tokens: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }, peak: { calls: 1, tokens: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 } }, offPeak: { calls: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 } } }
  assert.equal(priceModel(entry, catalog.snapshotFor(t0)).micros, 300_000)
  assert.equal(priceModel(entry, catalog.snapshotFor(t1 + 1)).micros, 600_000)
}

// --- an identical first fetch only upgrades the source label --------------
{
  const settings = resolveSettings({ pricingSource: false })
  const catalog = createPricingCatalog(settings)
  const same = { ...settings.fallbackCard, source: 'https://official/', currency: 'USD', symbol: '$' }
  assert.equal(catalog.ingest(same, 10_000), false)
  const snapshot = catalog.snapshotFor(1)
  assert.equal(snapshot.source, 'https://official/', 'new sessions report the official source')
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
  assert.ok(state.pricing.rates['deepseek-flash'], 'the frozen card travels with the state')
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

console.log('host tests: all assertions passed')
