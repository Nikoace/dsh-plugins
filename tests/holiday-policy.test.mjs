import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import * as tariff from '../shared/tariff/index.js'
import { apply, internals as cost } from '../dsh-token-cost/index.js'

const NOW = Date.parse('2026-02-02T02:00:00Z')
const tick = () => new Promise((resolve) => setImmediate(resolve))
const timers = { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {} }

test('calendar requests cover only the current Beijing year, including New Year boundary', () => {
  assert.deepEqual(tariff.holidayYears(NOW), [2026])
  assert.deepEqual(tariff.holidayYears(Date.parse('2026-12-31T15:59:59Z')), [2026])
  assert.deepEqual(tariff.holidayYears(Date.parse('2026-12-31T16:00:00Z')), [2027])
})

test('missing calendar data never generates holiday estimates', () => {
  assert.deepEqual(tariff.holidayDatesForYears([], [2026]), {})
  assert.deepEqual(tariff.holidayProvenance({ years: [2026] }), { auto: [], manual: [], fixed: [] })
  const settings = cost.resolveSettings({ pricingSource: false, holidaysSource: false })
  const snapshot = cost.createPricingCatalog(settings).snapshotFor(NOW)
  assert.deepEqual(snapshot.holidays, [])
  assert.equal(cost.bandOf(NOW, snapshot), 'peak')
  assert.equal(cost.bandOf(Date.parse('2026-01-01T02:00:00Z'), snapshot), 'peak')
})

test('named calendar filters other years and keeps published names', () => {
  assert.deepEqual(tariff.holidayDatesForYears([
    { date: '2026-04-06', name: 'published fixture' },
    { date: '2027-01-01', name: 'next year' },
  ], [2026]), { '2026-04-06': 'published fixture' })
})

test('payload parser rejects business errors, unknown shapes and invalid dates', () => {
  for (const payload of [null, {}, { code: -1, holiday: {} }, { code: -1, dates: [] },
    { dates: ['2026-02-30'] }, { holiday: { '02-02': { date: '2026-02-02' } } }]) {
    assert.throws(() => tariff.holidayEntriesFromPayload(payload, 2026), /holiday|calendar|date|payload/i)
  }
  for (const payload of [[], { dates: [] }, { code: 0, holiday: {} }]) {
    assert.deepEqual(tariff.holidayEntriesFromPayload(payload, 2026), [])
  }
  assert.deepEqual(tariff.parseHolidayPayload({ code: 0, holiday: {
    '02-02': { date: '2026-02-02', holiday: false },
    '02-17': { date: '2026-02-17', holiday: true, name: 'published fixture' },
  } }, 2026), ['2026-02-17'])
})

test('Host fetches one year, keeps last good calendar on failure, accepts valid empty data', async () => {
  let now = NOW
  let payload = { dates: ['2026-04-06', '2027-01-01'] }
  const urls = []
  const cards = []
  const controller = cost.createRefreshController({
    settings: cost.resolveSettings({ pricingSource: false, holidaysSource: 'https://fixture.invalid/{year}' }),
    now: () => now, timers, onCard: (card) => cards.push(card),
    web: { fetch: async ({ url }) => { urls.push(url); return { statusCode: 200, body: { content: JSON.stringify(payload) } } } },
  })
  controller.start()
  await tick()
  assert.deepEqual(urls, ['https://fixture.invalid/2026'])
  assert.deepEqual(cards.at(-1).holidays, ['2026-04-06'])
  const lastGood = controller.status().holidays.fetchedAt
  payload = { code: -1, message: 'fixture failure' }
  now += 1000
  await controller.refreshHolidays()
  assert.deepEqual(cards.at(-1).holidays, ['2026-04-06'])
  assert.equal(controller.status().holidays.fetchedAt, lastGood)
  assert.ok(controller.status().holidays.error)
  assert.equal(controller.status().holidays.nextRetryAt, now + 5 * 60_000)
  payload = { dates: [] }
  now += 1000
  await controller.refreshHolidays()
  assert.deepEqual(cards.at(-1).holidays, [])
  assert.equal(controller.status().holidays.error, null)
  now = Date.parse('2026-12-31T16:00:00Z')
  payload = { dates: ['2027-02-08', '2028-01-01'] }
  await controller.refreshHolidays()
  assert.equal(urls.at(-1), 'https://fixture.invalid/2027')
  assert.deepEqual(cards.at(-1).holidays, ['2027-02-08'])
  controller.stop()
})

// Evaluate the real calendar code with a local clock/storage/fetch seam.
function clockHarness() {
  const source = fs.readFileSync(new URL('../dsh-sidebar-clock/client.js', import.meta.url), 'utf8')
  const begin = source.indexOf('    const HOLIDAY_SOURCE =')
  const end = source.indexOf('    function clientVersion()', begin)
  assert.ok(begin >= 0 && end > begin)
  const storage = new Map()
  let now = NOW
  let payload = { dates: ['2026-04-06', '2027-01-01'] }
  const urls = []
  class Clock extends Date { static now() { return now } }
  const api = new Function('window', 'fetch', 'localStorage', 'Date', source.slice(begin, end) + `
    return { refreshHolidayCalendar, readHolidayCache, writeHolidayCache, fallbackHolidayState,
      nextHoliday, setHolidayState, getHolidayState, cacheKey: HOLIDAY_CACHE_KEY };
  `)({ setTimeout, clearTimeout }, async (url) => {
    urls.push(url)
    return { ok: true, json: async () => payload }
  }, { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, Clock)
  return { api, storage, urls, setPayload: (value) => { payload = value }, setNow: (value) => { now = value } }
}

test('clock fetch and cache contain only confirmed current-year dates', async () => {
  const { api, storage, urls, setPayload, setNow } = clockHarness()
  assert.deepEqual(api.fallbackHolidayState(NOW).dates, {})
  const state = await api.refreshHolidayCalendar(NOW)
  api.setHolidayState(state)
  assert.deepEqual(urls, ['https://timor.tech/api/holiday/year/2026'])
  assert.deepEqual(state.dates, { '2026-04-06': '' })
  const saved = storage.get(api.cacheKey)
  setPayload({ code: -1 })
  await assert.rejects(api.refreshHolidayCalendar(NOW))
  assert.equal(storage.get(api.cacheKey), saved)
  assert.deepEqual(api.getHolidayState().dates, state.dates)
  assert.equal(api.nextHoliday(Date.parse('2026-12-01T02:00:00Z'), state.dates), null)
  assert.equal(api.nextHoliday(NOW, { '2027-01-01': 'next year' }), null)
  setNow(Date.parse('2026-12-31T16:00:00Z'))
  assert.equal(api.readHolidayCache(), null, 'last year cache is not current-year data')
})

test('clock does not restore legacy cache that may contain estimated dates', () => {
  const { api, storage } = clockHarness()
  storage.set('dsh.sidebar-clock.holidays.v1', JSON.stringify({ dates: { '2026-02-02': 'estimate' }, fetchedAt: NOW }))
  assert.equal(api.readHolidayCache(), null)
})

test('clock keeps confirmed cached dates throughout the same year', async () => {
  const { api, setNow } = clockHarness()
  const state = await api.refreshHolidayCalendar(NOW)
  setNow(Date.parse('2026-10-21T02:00:00Z'))
  assert.deepEqual(api.readHolidayCache()?.dates, state.dates)
})

test('a response arriving across Beijing New Year cannot publish the previous year', async () => {
  let now = Date.parse('2026-12-31T15:59:59Z')
  const cards = []
  let release
  const controller = cost.createRefreshController({
    settings: cost.resolveSettings({ pricingSource: false, holidaysSource: 'https://fixture.invalid/{year}' }),
    now: () => now, timers, onCard: (card) => cards.push(card),
    web: { fetch: () => new Promise((resolve) => { release = resolve }) },
  })
  controller.start()
  now += 1000
  release({ statusCode: 200, body: { content: JSON.stringify({ dates: ['2026-04-06'] }) } })
  await tick()
  assert.equal(cards.length, 0)
  assert.equal(controller.status().holidays.fetchedAt, 0)
  assert.match(controller.status().holidays.error, /year changed/)
  controller.stop()

  const { api, setNow, storage } = clockHarness()
  setNow(now - 1000)
  const pending = api.refreshHolidayCalendar(now - 1000)
  setNow(now)
  await assert.rejects(pending, /year changed/)
  assert.equal(storage.size, 0)
})

test('first successful empty calendar is published so restored dates can be cleared', async () => {
  const cards = []
  const controller = cost.createRefreshController({
    settings: cost.resolveSettings({ pricingSource: false, holidaysSource: 'https://fixture.invalid/{year}' }),
    now: () => NOW, timers, onCard: (card) => cards.push(card),
    web: { fetch: async () => ({ statusCode: 200, body: { content: '{"dates":[]}' } }) },
  })
  controller.start()
  await tick()
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0].holidays, [])
  controller.stop()
})

test('restored old epochs retain billed amounts, but future requests stop using estimates', () => {
  const realNow = Date.now
  let now = NOW
  Date.now = () => now
  try {
    let definition
    apply({ sessionProjections: { register: (value) => { definition = value } }, get: () => undefined, effect: (fn) => fn() },
      { pricingSource: false, holidaysSource: false })
    const settings = cost.resolveSettings({ pricingSource: false, holidaysSource: false })
    const oldEpoch = cost.createPricingCatalog(settings).snapshotFor(NOW)
    delete oldEpoch.holidayPolicyVersion
    oldEpoch.holidays = ['2026-02-02', '2026-04-06', '2027-01-01']
    oldEpoch.holidayProvenance = { fixed: ['2026-02-02', '2027-01-01'], auto: ['2026-04-06'], manual: [] }
    const event = (type, time, data) => ({ type, time, data })
    let oldState = cost.initialState([oldEpoch])
    oldState = cost.foldEvent(oldState, event('request/header', NOW - 2000, { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } }))
    oldState = cost.foldEvent(oldState, event('step/start', NOW - 2000, { turn: 1, step: 1 }))
    oldState = cost.foldEvent(oldState, event('assistant/message', NOW - 1000, { turn: 1, step: 1, usage: { inputTokens: 1_000_000 } }))
    const before = cost.viewOf(oldState).micros
    const checkpoint = structuredClone(oldState)
    assert.equal(definition.wire.view(oldState).micros, before)
    assert.deepEqual(oldState, checkpoint, 'view migration does not mutate the checkpoint')
    now += 1000
    let next = definition.apply(oldState, event('step/start', now, { turn: 2, step: 1 }))
    next = definition.apply(next, event('assistant/message', now + 1, { turn: 2, step: 1, usage: { inputTokens: 1_000_000 } }))
    const view = definition.wire.view(next)
    assert.equal(next.epochs.length, 2, 'migration appends one boundary, without duplicates on later events')
    assert.deepEqual(next.epochs.at(-1).rates, oldEpoch.rates, 'migration preserves the active rates')
    assert.equal(view.offPeak.calls, 1, 'old billed request stays in its original band')
    assert.equal(view.peak.calls, 1, 'new request no longer uses a fixed estimate')
    assert.deepEqual(view.pricing.holidays, ['2026-04-06'])
    assert.equal(view.pricing.holidayProvenance.fixed.length, 0)
    assert.equal(next.epochs[0].holidays.includes('2026-02-02'), true, 'historical policy remains inspectable')
  } finally { Date.now = realNow }
})
