// Cross-implementation consistency test for the tariff / holiday rules.
//
// The canonical rules live in shared/tariff/index.js. Three consumers must
// agree with it at all times:
//
//   1. the generated Host ESM copy   (dsh-token-cost/tariff.js),
//   2. the Web UI copies inlined by  (dsh-token-cost/client.js,
//      tools/sync-shared.mjs)         dsh-sidebar-clock/client.js),
//   3. the thin per-plugin wrappers  (Host bandOf, clock bandAt, ...).
//
// This file is the "single source of truth" guard: fixed vectors on both sides
// of a boundary, weekends, Beijing holidays, cross-year dates, DST swap days,
// published vs unpublished years, and the holiday parsing shapes. It also runs
// `tools/sync-shared.mjs --check` so a hand-edit of a generated copy fails CI.
import assert from 'node:assert/strict'
import fs from 'node:fs'

import * as canonical from '../shared/tariff/index.js'
import * as hostTariff from '../dsh-token-cost/tariff.js'
import { checkSync } from '../tools/sync-shared.mjs'
import { internals } from '../dsh-token-cost/index.js'

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// Generated copies: existence, exported surface, constants
// ---------------------------------------------------------------------------

const GENERATED_START = '    // >>> generated:tariff'
const GENERATED_END = '    // <<< generated:tariff'

/**
 * Extract and evaluate the generated `Tariff` IIFE from a Web client.
 *
 * @param {string} relative - path relative to the test file.
 * @returns {object} the same surface as shared/tariff/index.js.
 */
function inlineTariff(relative) {
  const source = read(relative)
  const start = source.indexOf(GENERATED_START)
  assert.ok(start >= 0, `${relative}: generated tariff start marker missing (run node tools/sync-shared.mjs)`)
  const bodyStart = source.indexOf('\n', start) + 1
  const end = source.indexOf(GENERATED_END, bodyStart)
  assert.ok(end > bodyStart, `${relative}: generated tariff end marker missing (run node tools/sync-shared.mjs)`)
  const body = source.slice(bodyStart, end)
  return new Function(`${body}\nreturn Tariff`)()
}

const tokenCostClient = inlineTariff('../dsh-token-cost/client.js')
const sidebarClockClient = inlineTariff('../dsh-sidebar-clock/client.js')

const canonicalNames = Object.keys(canonical).sort()
const inlineNames = (tariff) => Object.keys(tariff).sort()

assert.deepEqual(inlineNames(tokenCostClient), canonicalNames, 'token-cost client copy exports the canonical surface')
assert.deepEqual(inlineNames(sidebarClockClient), canonicalNames, 'sidebar-clock client copy exports the canonical surface')
assert.deepEqual(Object.keys(hostTariff).sort(), canonicalNames, 'Host copy exports the canonical surface')

const CONSTANTS = [
  'TARIFF_VERSION',
  'PEAK_WINDOWS',
  'WEEKDAYS_ONLY',
  'HOLIDAY_OFFSET_MINUTES',
  'MINUTES_PER_DAY',
  'MINUTE_MS',
  'DAY_MS',
  'FIXED_HOLIDAYS',
]
for (const name of CONSTANTS) {
  assert.deepEqual(hostTariff[name], canonical[name], `Host copy constant ${name}`)
  assert.deepEqual(tokenCostClient[name], canonical[name], `token-cost client constant ${name}`)
  assert.deepEqual(sidebarClockClient[name], canonical[name], `sidebar-clock client constant ${name}`)
}

// `tools/sync-shared.mjs --check` regenerates every copy in memory and fails on
// drift, so a hand-edited generated block cannot silently diverge. It is
// imported rather than spawned because the sandbox rejects piped child stdio.
{
  const { ok, messages } = checkSync()
  assert.equal(ok, true, `generated tariff copies are in sync:\n${messages.join('\n')}`)
}

// ---------------------------------------------------------------------------
// The clock's extracted tariff helpers (the real Web-side implementation)
// ---------------------------------------------------------------------------

const CLOCK_START = '    // >>> clock:tariff-helpers'
const CLOCK_END = '    // <<< clock:tariff-helpers'
const clockHelpers = (() => {
  const source = read('../dsh-sidebar-clock/client.js')
  const start = source.indexOf(CLOCK_START)
  const end = source.indexOf(CLOCK_END, start)
  assert.ok(start >= 0 && end > start, 'sidebar-clock tariff helper markers missing')
  const body = source.slice(start + CLOCK_START.length, end)
  return new Function(
    `${body}\nreturn { bandAt, nextBandSwitch, holidayDatesForYears, nextHoliday, pad2, beijingDateKey, utcMinuteOfDay, inWindow }`,
  )()
})()

// ---------------------------------------------------------------------------
// Fixed vectors
// ---------------------------------------------------------------------------

/** @param {string} iso - ISO instant. */
const at = (iso) => Date.parse(iso)

const PEAK = '2026-10-19T02:00:00Z' // Monday, 01:00–04:00 UTC window
const VECTORS = [
  ['monday peak #1 start', '2026-10-19T01:00:00Z', 'peak'],
  ['monday peak #1 inside', '2026-10-19T02:30:00Z', 'peak'],
  ['monday peak #1 end', '2026-10-19T04:00:00Z', 'offPeak'],
  ['monday gap', '2026-10-19T05:00:00Z', 'offPeak'],
  ['monday peak #2 start', '2026-10-19T06:00:00Z', 'peak'],
  ['monday peak #2 end', '2026-10-19T10:00:00Z', 'offPeak'],
  ['friday peak', '2026-10-23T09:59:00Z', 'peak'],
  ['saturday all day', '2026-10-24T02:00:00Z', 'offPeak'],
  ['sunday all day', '2026-10-25T06:30:00Z', 'offPeak'],
  ['beijing holiday weekday', '2026-10-01T02:00:00Z', 'offPeak'],
  ['day after beijing holiday', '2026-10-09T02:00:00Z', 'peak'],
  ['cross-year: beijing new year', '2026-12-31T16:30:00Z', 'offPeak'],
  ['cross-year: first workday 2027', '2027-01-04T02:00:00Z', 'peak'],
  ['US spring-forward day (Sunday)', '2026-03-08T07:00:00Z', 'offPeak'],
  ['US first Monday after spring-forward', '2026-03-09T02:00:00Z', 'peak'],
  ['US fall-back day (Sunday)', '2026-11-01T06:30:00Z', 'offPeak'],
  ['EU spring-forward Sunday', '2026-03-29T01:30:00Z', 'offPeak'],
  ['EU first Monday after spring-forward', '2026-03-30T02:00:00Z', 'peak'],
]

/** A calendar with the seven-day National Day block plus a makeup-workday-shaped entry. */
const AUTO_DATES = [
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
]
const clockDates = canonical.holidayDatesForYears(AUTO_DATES.map((date) => ({ date })), [2026, 2027])
const hostProvenance = canonical.holidayProvenance({ auto: AUTO_DATES, years: [2026, 2027] })
const HOST_HOLIDAYS = canonical.provenanceDates(hostProvenance)

const hostPricing = {
  peakWindows: canonical.PEAK_WINDOWS,
  weekdaysOnly: canonical.WEEKDAYS_ONLY,
  offPeakEnabled: true,
  holidayOffsetMinutes: canonical.HOLIDAY_OFFSET_MINUTES,
  holidays: HOST_HOLIDAYS,
}
const canonicalPolicy = {
  peakWindows: canonical.PEAK_WINDOWS,
  weekdaysOnly: canonical.WEEKDAYS_ONLY,
  offPeakEnabled: true,
  holidayOffsetMinutes: canonical.HOLIDAY_OFFSET_MINUTES,
  holidays: HOST_HOLIDAYS,
}
const clockPolicy = {
  peakWindows: canonical.PEAK_WINDOWS,
  weekdaysOnly: canonical.WEEKDAYS_ONLY,
  offPeakEnabled: true,
  holidayOffsetMinutes: canonical.HOLIDAY_OFFSET_MINUTES,
  holidays: clockDates,
}

for (const [name, iso, expected] of VECTORS) {
  const timeMs = at(iso)
  const want = canonical.bandAt(timeMs, canonicalPolicy)
  assert.equal(want, expected, `canonical ${name}`)
  assert.equal(tokenCostClient.bandAt(timeMs, canonicalPolicy), want, `token-cost client copy ${name}`)
  assert.equal(sidebarClockClient.bandAt(timeMs, canonicalPolicy), want, `sidebar-clock client copy ${name}`)
  assert.equal(hostTariff.bandAt(timeMs, canonicalPolicy), want, `Host ESM copy ${name}`)
  assert.equal(internals.bandOf(timeMs, hostPricing), want, `Host bandOf agrees: ${name}`)
  assert.equal(clockHelpers.bandAt(timeMs, clockDates), want, `clock UI bandAt agrees: ${name}`)
}

// Off-peak disabled short-circuits to peak everywhere.
for (const [name, iso] of VECTORS) {
  const timeMs = at(iso)
  assert.equal(canonical.bandAt(timeMs, { ...canonicalPolicy, offPeakEnabled: false }), 'peak', `canonical off-peak disabled ${name}`)
  assert.equal(internals.bandOf(timeMs, { ...hostPricing, offPeakEnabled: false }), 'peak', `Host off-peak disabled ${name}`)
  assert.equal(tokenCostClient.bandAt(timeMs, { ...canonicalPolicy, offPeakEnabled: false }), 'peak', `client off-peak disabled ${name}`)
}

// Unpublished years: the fixed anchors fill the calendar for the Session's own
// Beijing years, so the clock and the Host agree instead of one billing peak.
{
  const years = [2028, 2029]
  const unpublishedProvenance = canonical.holidayProvenance({ years })
  const unpublishedHolidays = canonical.provenanceDates(unpublishedProvenance)
  const unpublishedPolicy = { ...canonicalPolicy, holidays: unpublishedHolidays }
  const clockDates2028 = canonical.holidayDatesForYears([], years)
  for (const [iso, expected] of [
    ['2028-05-01T02:00:00Z', 'offPeak'], // Monday, inside the estimated 劳动节 block
    ['2028-05-02T02:00:00Z', 'offPeak'], // the estimate spans the whole statutory block
    ['2028-05-08T02:00:00Z', 'peak'], // the week after the estimated block is a normal weekday
    ['2028-10-02T02:00:00Z', 'offPeak'], // National Day is estimated as a seven-day block
    ['2028-10-09T02:00:00Z', 'peak'], // the block ends on 10-07
    ['2028-10-01T02:00:00Z', 'offPeak'], // Sunday anyway, but the anchor is present
  ]) {
    const timeMs = at(iso)
    assert.equal(canonical.bandAt(timeMs, unpublishedPolicy), expected, `canonical unpublished-year ${iso}`)
    assert.equal(tokenCostClient.bandAt(timeMs, unpublishedPolicy), expected, `token-cost client unpublished-year ${iso}`)
    assert.equal(sidebarClockClient.bandAt(timeMs, unpublishedPolicy), expected, `sidebar-clock client unpublished-year ${iso}`)
    assert.equal(hostTariff.bandAt(timeMs, unpublishedPolicy), expected, `Host copy unpublished-year ${iso}`)
    assert.equal(internals.bandOf(timeMs, { ...hostPricing, holidays: unpublishedHolidays }), expected, `Host bandOf unpublished-year ${iso}`)
    assert.equal(clockHelpers.bandAt(timeMs, clockDates2028), expected, `clock UI unpublished-year ${iso}`)
  }
}

// A custom window set and `weekdaysOnly: false` behave identically.
{
  const custom = { peakWindows: [[0, 60], [600, 700]], weekdaysOnly: false, offPeakEnabled: true, holidays: [], holidayOffsetMinutes: 480 }
  for (const iso of ['2026-10-24T00:30:00Z', '2026-10-25T10:30:00Z', '2026-10-26T00:30:00Z', '2026-10-26T12:00:00Z']) {
    const timeMs = at(iso)
    assert.equal(internals.bandOf(timeMs, custom), canonical.bandAt(timeMs, custom), `custom windows Host ${iso}`)
    assert.equal(clockHelpers.bandAt(timeMs, {}), canonical.bandAt(timeMs, { ...canonicalPolicy, holidays: {} }), `custom-compatible clock ${iso}`)
  }
}

// ---------------------------------------------------------------------------
// Next switch: the clock scans with the canonical bound, the client wrapper agrees
// ---------------------------------------------------------------------------

for (const iso of ['2026-10-19T03:59:00Z', '2026-10-19T05:30:00Z', '2026-10-23T09:59:00Z', '2026-10-30T12:00:00Z', '2026-12-31T15:30:00Z']) {
  const timeMs = at(iso)
  const wanted = canonical.nextBandSwitch(timeMs, canonicalPolicy, 10)
  assert.equal(clockHelpers.nextBandSwitch(timeMs, clockDates), wanted, `clock nextBandSwitch agrees at ${iso}`)
  assert.ok(wanted > timeMs && wanted - timeMs <= 10 * canonical.DAY_MS, `next switch is inside the 10-day bound at ${iso}`)
  if (wanted !== 0) assert.notEqual(canonical.bandAt(wanted, canonicalPolicy), canonical.bandAt(timeMs, canonicalPolicy), `switch point changes the band at ${iso}`)
}

// ---------------------------------------------------------------------------
// Holiday calendar: names, anchors, provenance, unpublished years
// ---------------------------------------------------------------------------

// Fixed anchors fill years that no source published; published dates win.
{
  const dates = canonical.holidayDatesForYears([{ date: '2026-10-01', name: '国庆节' }], [2026, 2028])
  assert.equal(dates['2026-10-01'], '国庆节', 'published name wins over the fixed anchor')
  assert.equal(dates['2026-05-01'], '劳动节', 'manual/unpublished anchors are added')
  assert.equal(dates['2028-01-01'], '元旦', 'unpublished year gets anchors')
  assert.deepEqual(Object.keys(clockHelpers.holidayDatesForYears([{ date: '2026-10-01', name: '国庆节' }], [2026, 2028])).sort(), Object.keys(dates).sort(), 'clock calendar matches canonical')
}

// Provenance is a partition: every key in exactly one bucket, union = calendar.
{
  const manual = ['2026-02-17', '2026-10-01']
  const auto = ['2026-10-01', '2026-10-02', '2027-02-06']
  const provenance = canonical.holidayProvenance({ manual, auto, years: [2026, 2027] })
  for (const key of [...provenance.auto, ...provenance.manual, ...provenance.fixed]) {
    const buckets = ['auto', 'manual', 'fixed'].filter((bucket) => provenance[bucket].includes(key))
    assert.equal(buckets.length, 1, `${key} appears in exactly one provenance bucket (${buckets.join(',')})`)
  }
  assert.deepEqual(provenance.manual, [...manual].sort(), 'manual wins over auto for a shared date')
  assert.ok(provenance.auto.includes('2026-10-02'), 'auto keeps its unique dates')
  // The fixed bucket is every statutory anchor day that neither source published.
  const anchors = canonical.fixedHolidayDateKeys([2026, 2027])
  const published = new Set([...manual, ...auto])
  assert.deepEqual(provenance.fixed, anchors.filter((date) => !published.has(date)), 'fixed buckets cover only unpublished dates')
  assert.ok(provenance.fixed.includes('2026-10-03'), 'an unpublished day inside a statutory block is still estimated')
  assert.ok(!provenance.fixed.includes('2026-10-02'), 'a published day is not also a fixed anchor')
  assert.deepEqual(canonical.provenanceDates(provenance), [...new Set([...manual, ...auto, ...provenance.fixed])].sort(), 'union matches the calendar')
}

// The frozen Host snapshot for an unpublished year carries fixed anchors, so
// token-cost and the clock agree instead of one charging peak.
{
  const settings = internals.resolveSettings({ pricingSource: false })
  const catalog = internals.createPricingCatalog(settings)
  const snapshot2028 = catalog.snapshotFor(at('2028-06-01T00:00:00Z'))
  assert.ok(snapshot2028.holidays.includes('2028-05-01'), 'frozen snapshot carries the 2028 fixed anchor')
  const fixed = snapshot2028.holidayProvenance?.fixed ?? []
  assert.ok(fixed.includes('2028-05-01'), 'frozen snapshot reports the fixed provenance')
  assert.equal(internals.bandOf(at('2028-05-01T02:00:00Z'), snapshot2028), 'offPeak', 'Host treats an unpublished-year anchor as off-peak')
  assert.equal(internals.bandOf(at('2028-05-02T02:00:00Z'), snapshot2028), 'offPeak', 'Host covers the whole estimated statutory block')
  assert.equal(internals.bandOf(at('2028-05-08T02:00:00Z'), snapshot2028), 'peak', 'the week after the estimate stays peak')
  assert.equal(clockHelpers.bandAt(at('2028-05-01T02:00:00Z'), canonical.holidayDatesForYears([], [2028])), 'offPeak', 'clock agrees on unpublished-year anchors')
  assert.equal(clockHelpers.bandAt(at('2028-05-02T02:00:00Z'), canonical.holidayDatesForYears([], [2028])), 'offPeak', 'clock agrees on the estimated block')
  assert.equal(clockHelpers.bandAt(at('2028-05-08T02:00:00Z'), canonical.holidayDatesForYears([], [2028])), 'peak', 'clock still peaks the next week')
}

// The published calendar flows from the source payload into the same keys in
// every consumer (timor / Nager / plain shapes).
{
  const timor = { holiday: { '10-01': { holiday: true, date: '2026-10-01', name: '国庆节' }, '10-10': { holiday: false, date: '2026-10-10', name: '补班' } } }
  const nager = [{ date: '2026-10-01', localName: '国庆节' }]
  const plain = ['2026-10-01']
  const dates = ['2026-10-01']
  assert.deepEqual(internals.parseHolidayPayload(timor, 2026), dates, 'Host parses timor payloads')
  assert.deepEqual(internals.parseHolidayPayload(nager, 2026), dates, 'Host parses Nager payloads')
  assert.deepEqual(internals.parseHolidayPayload(plain, 2026), dates, 'Host parses plain arrays')
  assert.deepEqual(canonical.parseHolidayPayload(timor, 2026), dates, 'canonical parses timor payloads')
  assert.deepEqual(canonical.parseHolidayPayload(nager, 2026), dates, 'canonical parses Nager payloads')
  assert.deepEqual(canonical.parseHolidayPayload(plain, 2026), dates, 'canonical parses plain arrays')
  const entries = canonical.holidayEntriesFromPayload(timor, 2026)
  assert.deepEqual(entries, [{ date: '2026-10-01', name: '国庆节' }], 'timor names travel into the calendar')
  assert.equal(canonical.holidayDatesForYears(entries, [2026])['2026-10-01'], '国庆节', 'named calendar keeps the source name')
}

// ---------------------------------------------------------------------------
// The clock's countdown helpers follow the same rules
// ---------------------------------------------------------------------------

{
  const dates = canonical.holidayDatesForYears([], [2026, 2027])
  // 2026-10-01 is a Thursday: the next holiday on/after 2026-09-28 is National Day.
  const holiday = clockHelpers.nextHoliday(at('2026-09-28T02:00:00Z'), dates)
  assert.equal(holiday.key, '2026-10-01')
  assert.equal(holiday.today, false)
  // A day that is already a holiday reports `today`.
  const today = clockHelpers.nextHoliday(at('2026-10-01T02:00:00Z'), dates)
  assert.equal(today.today, true)
  // Off-peak decisions match a policy carrying the same date map.
  for (const [name, iso, expected] of VECTORS) {
    assert.equal(clockHelpers.bandAt(at(iso), dates), expected, `clock anchors agree: ${name}`)
  }
}

// The clock and the Host must not disagree on any vector from either side.
{
  const hostPricingFromClock = (dates) => ({
    peakWindows: canonical.PEAK_WINDOWS,
    weekdaysOnly: canonical.WEEKDAYS_ONLY,
    offPeakEnabled: true,
    holidayOffsetMinutes: canonical.HOLIDAY_OFFSET_MINUTES,
    holidays: Object.keys(dates),
  })
  for (const [name, iso] of VECTORS) {
    const timeMs = at(iso)
    assert.equal(
      internals.bandOf(timeMs, hostPricingFromClock(clockDates)),
      clockHelpers.bandAt(timeMs, clockDates),
      `Host and clock agree on ${name}`,
    )
  }
  assert.equal(internals.bandOf(at(PEAK), hostPricingFromClock(clockDates)), 'peak', 'control vector stays peak')
}

console.log('tariff consistency tests: all assertions passed')
