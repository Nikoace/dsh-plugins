'use strict'
// Local verification harness for the sidebar-clock pure helpers.
// It extracts the marked tariff-helper region from client.js (the inlined
// canonical rules from `tools/sync-shared.mjs` plus the clock's own wrappers)
// and evaluates it in a sandbox, then exercises the same scenarios the widget
// renders.
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '..', 'dsh-sidebar-clock', 'client.js'), 'utf8')
const startMarker = '    // >>> clock:tariff-helpers'
const endMarker = '    // <<< clock:tariff-helpers'
const start = source.indexOf(startMarker)
const end = source.indexOf(endMarker)
if (start < 0 || end < 0 || end <= start) throw new Error('helper section markers not found')
const body = source.slice(start + startMarker.length, end)
const factory = new Function(
  `${body}\nreturn { pad2, beijingDateKey, utcMinuteOfDay, inWindow, bandAt, nextBandSwitch, nextBandSwitchCached, weekendBoundary, nextHoliday, holidayDatesForYears, clockAt, formatDays, activeLocaleId, dateLine }`,
)
const lib = factory()

// The balance helpers sit outside the pure time section; extract them too so
// the Account Remote result handling and wallet formatting are covered offline.
const balanceStart = source.indexOf('    function clientVersion() {')
const balanceEnd = source.indexOf('    /** Re-render on a slow tick')
if (balanceStart < 0 || balanceEnd < 0 || balanceEnd <= balanceStart) {
  throw new Error('balance section markers not found')
}
const balanceFactory = new Function(
  `${source.slice(balanceStart, balanceEnd)}\nreturn { clientVersion, readBalance, formatBalanceText }`,
)
const balanceLib = balanceFactory()

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log('ok   ' + name + ' = ' + a)
  } else {
    failures += 1
    console.log('FAIL ' + name + ': got ' + a + ', expected ' + e)
  }
}

const t = (key, params) => {
  if (params === undefined) return key
  return key + ':' + JSON.stringify(params)
}

// 2026-10-19T06:14:35Z is Monday 06:14 UTC -> inside the second peak window.
const mondayPeak = Date.UTC(2026, 9, 19, 6, 14, 35)
check('bandAt monday 06:14Z', lib.bandAt(mondayPeak, {}), 'peak')
// 04:30 UTC is between the two windows -> off-peak.
check('bandAt monday 04:30Z', lib.bandAt(Date.UTC(2026, 9, 19, 4, 30), {}), 'offPeak')
// Saturday is off-peak regardless of the clock.
check('bandAt saturday 06:14Z', lib.bandAt(Date.UTC(2026, 9, 17, 6, 14), {}), 'offPeak')
// A fixed anchor holiday on a Monday makes the whole day off-peak.
const nationalDay = Date.UTC(2026, 9, 1, 2, 0, 0) // Thursday
check('bandAt holiday', lib.bandAt(nationalDay, { '2026-10-01': '国庆节' }), 'offPeak')
// 2026-10-19 06:14Z is peak; the band ends at 10:00 UTC, i.e. 3h46m later.
check('nextBandSwitch minutes', Math.round((lib.nextBandSwitch(mondayPeak, {}) - mondayPeak) / 60000), 226)
check(
  'nextBandSwitchCached rounds to the minute',
  lib.nextBandSwitchCached(mondayPeak, {}),
  lib.nextBandSwitch(Math.floor(mondayPeak / 60000) * 60000, {}),
)

// Weekend boundary: Friday -> Saturday 00:00 local; Saturday -> Monday 00:00;
// Sunday -> Monday 00:00.
const friday = new Date(2026, 9, 16, 15, 0, 0).getTime()
check('weekend friday active', lib.weekendBoundary(friday).active, false)
check('weekend friday target', new Date(lib.weekendBoundary(friday).target).getDay(), 6)
const saturday = new Date(2026, 9, 17, 10, 0, 0).getTime()
check('weekend saturday active', lib.weekendBoundary(saturday).active, true)
check('weekend saturday target day', new Date(lib.weekendBoundary(saturday).target).getDay(), 1)
const sunday = new Date(2026, 9, 18, 10, 0, 0).getTime()
check('weekend sunday target day', new Date(lib.weekendBoundary(sunday).target).getDay(), 1)

// Holiday selection: union of fetched entries and fixed anchors for years
// without published data.
const dates = lib.holidayDatesForYears(
  [
    { date: '2026-10-01', name: '国庆节' },
    { date: '2027-01-01', name: '' },
  ],
  [2026, 2027],
)
check('holiday anchors 2027-05-01', dates['2027-05-01'], '劳动节')
check('holiday fetched name kept', dates['2026-10-01'], '国庆节')
check('holiday next after Oct 19', lib.nextHoliday(Date.UTC(2026, 9, 19, 6, 0), dates).key, '2027-01-01')
check('holiday next is today', lib.nextHoliday(Date.UTC(2026, 9, 1, 6, 0), dates).today, true)
// The holiday target is Beijing midnight (same instant the band flips).
check(
  'holiday target is Beijing midnight',
  lib.nextHoliday(Date.UTC(2026, 9, 19, 6, 0), dates).target,
  Date.UTC(2027, 0, 1) - 480 * 60000,
)
// Beijing date boundary: 2026-09-30T17:00Z is 2026-10-01 in Beijing.
check('beijing date at 17:00Z', lib.beijingDateKey(Date.UTC(2026, 8, 30, 17, 0)), '2026-10-01')
check('band at Beijing holiday boundary', lib.bandAt(Date.UTC(2026, 8, 30, 17, 0), dates), 'offPeak')

// Formatting: the countdown is whole days only.
check('formatDays 4d7h', lib.formatDays((4 * 1440 + 420) * 60000, t), 'duration.days:{"days":4}')
check('formatDays sub-day floors at 1', lib.formatDays(3 * 3600000, t), 'duration.days:{"days":1}')
check('formatDays 73d8h', lib.formatDays((73 * 1440 + 480) * 60000, t), 'duration.days:{"days":73}')
// The active UI locale comes from the injected locale reader when present.
check('activeLocaleId snapshot', lib.activeLocaleId(() => ({ active: 'zh-CN' })), 'zh-CN')
check('activeLocaleId missing reader', lib.activeLocaleId(undefined), undefined)
check(
  'activeLocaleId throwing reader',
  lib.activeLocaleId(() => {
    throw new Error('boom')
  }),
  undefined,
)
// The date line must follow the DSH UI locale, not the browser language.
const oct19 = new Date(2026, 9, 19, 12, 0, 0).getTime()
check('dateLine zh-CN', lib.dateLine(oct19, 'zh-CN'), '周一 10月19日')
check('dateLine en-US', lib.dateLine(oct19, 'en-US'), 'Mon October 19')

// Locale dictionaries must have identical key sets.
const dict = (name) => {
  const match = source.match(new RegExp('const ' + name + ' = \\{([\\s\\S]*?)\\n    \\}'))
  if (!match) throw new Error('dictionary ' + name + ' not found')
  return [...match[1].matchAll(/'([^']+)':/g)].map((m) => m[1])
}
const zhKeys = dict('zh')
const enKeys = dict('en')
check('zh/en key parity', zhKeys.slice().sort(), enKeys.slice().sort())
check('dictionary count', zhKeys.length, 11)

// Balance: Account Remote result handling and wallet formatting.
check('clientVersion fallback', balanceLib.clientVersion(), '0.2.1-rc.2')
check('formatBalanceText CNY', balanceLib.formatBalanceText({ status: 'ready', currency: 'CNY', amount: '12.34' }, 'zh-CN'), '¥12.34')
check('formatBalanceText USD grouped', balanceLib.formatBalanceText({ status: 'ready', currency: 'USD', amount: '1234.5' }, 'en-US'), '$1,234.50')
check('formatBalanceText unavailable', balanceLib.formatBalanceText({ status: 'unavailable' }, 'zh-CN'), '—')

async function checkBalanceReads() {
  const wallet = (currency, balance) => ({ currency, balance })
  const read = (value) => balanceLib.readBalance({ getBalance: async () => value }, {})
  check(
    'readBalance prefers CNY',
    await read({ ok: true, value: { status: 'ready', value: [wallet('USD', '5.00'), wallet('CNY', '9.99')], bonusWallets: [] } }),
    { status: 'ready', currency: 'CNY', amount: '9.99' },
  )
  check(
    'readBalance falls back to USD',
    await read({ ok: true, value: { status: 'ready', value: [wallet('USD', '5.00')], bonusWallets: [] } }),
    { status: 'ready', currency: 'USD', amount: '5.00' },
  )
  check('readBalance signed out', await read({ ok: true, value: null }), { status: 'empty' })
  check('readBalance failed detail', await read({ ok: true, value: { status: 'failed' } }), { status: 'unavailable' })
  check('readBalance remote error', await read({ ok: false }), { status: 'unavailable' })
}

checkBalanceReads().then(
  () => {
    if (failures > 0) {
      console.error(failures + ' check(s) failed')
      process.exit(1)
    }
    console.log('all checks passed')
  },
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
