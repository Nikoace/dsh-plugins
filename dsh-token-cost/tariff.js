// DO NOT EDIT — generated copy of the canonical tariff rules.
// Edit shared/tariff/index.js, then run: node tools/sync-shared.mjs
/**
 * Canonical DeepSeek tariff + Chinese public-holiday rules.
 *
 * This module is the single source of truth for the peak/off-peak band used by
 * every plugin that displays or bills it:
 *
 * - `dsh-token-cost` (Host fold and Web UI),
 * - `dsh-sidebar-clock` (Web UI band badge and countdowns).
 *
 * It is deliberately dependency-free and side-effect-free so it can be
 * imported directly by the Host (`dsh-token-cost/tariff.js`) and *inlined*
 * into the single-file Web clients by `tools/sync-shared.mjs` (the client
 * module loader cannot resolve local imports). Generated copies carry a
 * "DO NOT EDIT" header; `node tools/sync-shared.mjs --check` fails when a copy
 * drifts from this file.
 *
 * Rule contract:
 * - Peak windows are UTC minutes of the day, `[start, end)`; they may wrap
 *   past midnight (`start > end`).
 * - Weekends are off-peak all day when `weekdaysOnly` is on.
 * - Chinese holidays are evaluated on the Beijing calendar (fixed UTC+8
 *   offset, no DST). Dates come from an automated source, a manual list, or
 *   the fixed statutory anchors (Jan 1 / May 1 / Oct 1) used for years whose
 *   arrangements are not published yet.
 *
 * Changing any published rule means changing this file (and bumping
 * `TARIFF_VERSION` when the *behaviour* changes), then regenerating the copies.
 */

/** Rule revision; bump on behaviour changes so snapshots/UI can report it. */
export const TARIFF_VERSION = 2

/** UTC peak windows: 01:00–04:00 and 06:00–10:00 (official rate card). */
export const PEAK_WINDOWS = [
  [60, 240],
  [360, 600],
]

/** Weekends are off-peak all day. */
export const WEEKDAYS_ONLY = true

/** Chinese holiday dates are evaluated on the Beijing calendar (UTC+8). */
export const HOLIDAY_OFFSET_MINUTES = 480

export const MINUTES_PER_DAY = 1440
export const MINUTE_MS = 60_000
export const DAY_MS = 24 * 60 * MINUTE_MS

/**
 * Fixed statutory anchors, used for years without a published arrangement
 * (and as the offline fallback). Each entry is `[MM-DD, display name, days]`,
 * where `days` is the length of the statutory block starting on that date:
 * 元旦 is one day, 劳动节 and 国庆节 are seven consecutive days, and 春节 is
 * seven days around the lunar New Year (which the fixed calendar cannot place,
 * so only 02-01 is approximated). These are deliberately *estimates* for
 * unpublished years: covering the whole block is much closer to the published
 * arrangement than charging every adjusted day off as peak.
 */
export const FIXED_HOLIDAYS = [
  ['01-01', '元旦', 1],
  ['02-01', '春节', 7],
  ['05-01', '劳动节', 5],
  ['10-01', '国庆节', 7],
]

/** Zero-pad a non-negative integer to two digits. */
export function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * `YYYY-MM-DD` of a moment in a fixed UTC offset.
 *
 * @param {number} timeMs - epoch milliseconds.
 * @param {number} [offsetMinutes] - fixed offset; defaults to Beijing (+480).
 * @returns {string} date key.
 */
export function dateKeyAt(timeMs, offsetMinutes = HOLIDAY_OFFSET_MINUTES) {
  return new Date(timeMs + offsetMinutes * MINUTE_MS).toISOString().slice(0, 10)
}

/**
 * `YYYY-MM-DD` of a moment on the Beijing calendar.
 *
 * @param {number} timeMs - epoch milliseconds.
 * @returns {string} date key.
 */
export function beijingDateKey(timeMs) {
  return dateKeyAt(timeMs, HOLIDAY_OFFSET_MINUTES)
}

/**
 * Weekday (0 = Sunday … 6 = Saturday) of a `YYYY-MM-DD` date key.
 *
 * Used so the weekday rule reads the same calendar date as the holiday rule.
 *
 * @param {string} key - `YYYY-MM-DD`.
 * @returns {number} weekday, or `-1` when the key is invalid.
 */
export function weekdayOfDateKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return -1
  const parsed = Date.parse(`${key}T00:00:00.000Z`)
  return Number.isFinite(parsed) ? new Date(parsed).getUTCDay() : -1
}

/** UTC minute of day (0..1439). */
export function utcMinuteOfDay(timeMs) {
  const minutes = Math.floor(timeMs / MINUTE_MS) % MINUTES_PER_DAY
  return (minutes + MINUTES_PER_DAY) % MINUTES_PER_DAY
}

/**
 * Whether a minute-of-day falls inside a `[start, end)` window (wrap-aware).
 *
 * @param {number} minute - minute of day.
 * @param {number[]} window - `[start, end)` minutes.
 * @returns {boolean} inside.
 */
export function inWindow(minute, window) {
  const start = window[0]
  const end = window[1]
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/**
 * Validate and copy a peak-window list.
 *
 * @param {unknown} value - candidate windows.
 * @returns {number[][] | null} normalized windows, or `null` when invalid.
 */
export function normalizePeakWindows(value) {
  if (!Array.isArray(value) || value.length === 0) return null
  const windows = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null
    const start = entry[0]
    const end = entry[1]
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null
    if (start < 0 || start >= MINUTES_PER_DAY || end < 0 || end > MINUTES_PER_DAY || start === end) return null
    windows.push([start, end])
  }
  return windows
}

/**
 * Whether a holiday calendar contains one date key.
 *
 * Accepts the shapes the plugins carry around: an array of `YYYY-MM-DD`
 * keys (Host snapshot), a `Set`, or a date-keyed map (Web clock).
 *
 * @param {unknown} holidays - calendar.
 * @param {string} key - `YYYY-MM-DD`.
 * @returns {boolean} present.
 */
export function hasHoliday(holidays, key) {
  if (holidays === undefined || holidays === null) return false
  if (Array.isArray(holidays)) return holidays.includes(key)
  if (holidays instanceof Set) return holidays.has(key)
  if (typeof holidays === 'object') return Object.hasOwn(holidays, key)
  return false
}

/**
 * The tariff band at one moment under a policy.
 *
 * The policy is a plain object so it can travel both in the Host's frozen
 * pricing snapshot and inside the Web clients:
 *
 * - `peakWindows` (default `PEAK_WINDOWS`),
 * - `weekdaysOnly` (default true),
 * - `offPeakEnabled` (default true; `false` means "all peak"),
 * - `holidayOffsetMinutes` (default +480),
 * - `holidays` (array / Set / date-keyed map; default empty).
 *
 * Missing windows means the source published none, so every moment is
 * off-peak; `offPeakEnabled: false` short-circuits to peak.
 *
 * @param {number} timeMs - epoch milliseconds.
 * @param {object} [policy] - band policy.
 * @returns {'peak' | 'offPeak'} the band.
 */
export function bandAt(timeMs, policy) {
  const p = policy ?? {}
  if (p.offPeakEnabled === false) return 'peak'
  const windows = Array.isArray(p.peakWindows) ? p.peakWindows : PEAK_WINDOWS
  if (windows.length === 0) return 'offPeak'
  const offset = typeof p.holidayOffsetMinutes === 'number' ? p.holidayOffsetMinutes : HOLIDAY_OFFSET_MINUTES
  const key = dateKeyAt(timeMs, offset)
  if (p.weekdaysOnly !== false) {
    // The weekday must come from the *same* calendar the holiday lookup uses,
    // otherwise the last hours of a Beijing Saturday (Friday 22:00–24:00 UTC)
    // are billed peak: UTC says Friday, Beijing says Saturday.
    if (weekdayOfDateKey(key) === 0 || weekdayOfDateKey(key) === 6) return 'offPeak'
  }
  if (hasHoliday(p.holidays, key)) return 'offPeak'
  return windows.some((window) => inWindow(utcMinuteOfDay(timeMs), window)) ? 'peak' : 'offPeak'
}

/**
 * The next moment the band changes (minute resolution), or `0` when the band
 * is stable for the whole scan window.
 *
 * The scan is bounded so a misconfigured all-off-peak policy cannot spin
 * forever; 10 days covers a peak window plus a holiday week with margin.
 *
 * @param {number} fromMs - epoch milliseconds.
 * @param {object} [policy] - band policy (see `bandAt`).
 * @param {number} [maxDays] - scan bound in days.
 * @returns {number} next switch epoch ms, or `0`.
 */
export function nextBandSwitch(fromMs, policy, maxDays = 10) {
  const band = bandAt(fromMs, policy)
  const limit = Math.max(1, Math.floor(maxDays)) * MINUTES_PER_DAY
  for (let delta = 1; delta <= limit; delta += 1) {
    const candidate = fromMs + delta * MINUTE_MS
    if (bandAt(candidate, policy) !== band) return candidate
  }
  return 0
}

/**
 * Beijing years a calendar must cover at `timeMs`: the current one and the
 * next one (so countdowns never fall off the end of the calendar).
 *
 * @param {number} timeMs - epoch milliseconds.
 * @param {number} [offsetMinutes] - fixed offset; defaults to Beijing (+480).
 * @returns {number[]} two ascending years.
 */
export function holidayYears(timeMs, offsetMinutes = HOLIDAY_OFFSET_MINUTES) {
  const year = new Date(timeMs + offsetMinutes * MINUTE_MS).getUTCFullYear()
  return [year, year + 1]
}

/**
 * Sorted fixed-anchor date keys for one or more years.
 *
 * A statutory block contributes every day it spans (`days` in
 * `FIXED_HOLIDAYS`); a block ending in the next month or year is resolved on
 * the real calendar, so 12-30 + 7 days still produces valid keys.
 *
 * @param {number[]} years - years.
 * @returns {string[]} `YYYY-MM-DD` keys.
 */
export function fixedHolidayDateKeys(years) {
  const keys = []
  for (const year of years) {
    for (const fixed of FIXED_HOLIDAYS) {
      const start = Date.parse(`${year}-${fixed[0]}T00:00:00.000Z`)
      if (!Number.isFinite(start)) continue
      const length = Number.isInteger(fixed[2]) && fixed[2] > 0 ? fixed[2] : 1
      for (let index = 0; index < length; index += 1) {
        keys.push(new Date(start + index * DAY_MS).toISOString().slice(0, 10))
      }
    }
  }
  return [...new Set(keys)].sort()
}

/**
 * Sorted fixed-anchor entries for one or more years, each with its display
 * name, so a calendar built from anchors can still label a date.
 *
 * @param {number[]} years - years.
 * @returns {Array<{ date: string, name: string }>} sorted entries.
 */
export function fixedHolidayEntries(years) {
  const byDate = new Map()
  for (const year of years) {
    for (const fixed of FIXED_HOLIDAYS) {
      const start = Date.parse(`${year}-${fixed[0]}T00:00:00.000Z`)
      if (!Number.isFinite(start)) continue
      const length = Number.isInteger(fixed[2]) && fixed[2] > 0 ? fixed[2] : 1
      for (let index = 0; index < length; index += 1) {
        const date = new Date(start + index * DAY_MS).toISOString().slice(0, 10)
        if (!byDate.has(date)) byDate.set(date, { date, name: fixed[1] })
      }
    }
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date))
}

/**
 * Build a named holiday calendar from entries.
 *
 * Entries are `{ date, name }` objects or plain `YYYY-MM-DD` strings. Fixed
 * statutory anchors are added for every requested year unless the calendar
 * already names that date.
 *
 * @param {Array<{date: string, name?: string} | string>} entries - calendar entries.
 * @param {number[]} years - years to fill with fixed anchors.
 * @returns {Record<string, string>} date key -> display name.
 */
export function holidayDatesForYears(entries, years) {
  const dates = {}
  for (const entry of entries ?? []) {
    const date = typeof entry === 'string' ? entry : entry === null || typeof entry !== 'object' ? undefined : entry.date
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const name = typeof entry === 'object' && entry !== null && typeof entry.name === 'string' ? entry.name : ''
    if (name !== '') dates[date] = name
    else if (dates[date] === undefined) dates[date] = ''
  }
  for (const anchor of fixedHolidayEntries(years ?? [])) {
    if (dates[anchor.date] === undefined) dates[anchor.date] = anchor.name
  }
  return dates
}

/**
 * Split a holiday calendar into provenance buckets (auto / manual / fixed).
 *
 * Every key appears in exactly one bucket; fixed anchors fill the years that
 * neither source published. The union of the buckets is the calendar used for
 * band decisions.
 *
 * @param {{ auto?: string[], manual?: string[], years?: number[] }} sources - calendar sources.
 * @returns {{ auto: string[], manual: string[], fixed: string[] }} sorted buckets.
 */
export function holidayProvenance(sources) {
  const manual = new Set()
  for (const key of sources?.manual ?? []) {
    if (typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key)) manual.add(key)
  }
  const auto = new Set()
  for (const key of sources?.auto ?? []) {
    if (typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) && !manual.has(key)) auto.add(key)
  }
  const fixed = new Set()
  for (const key of fixedHolidayDateKeys(sources?.years ?? [])) {
    if (!manual.has(key) && !auto.has(key)) fixed.add(key)
  }
  return { auto: [...auto].sort(), manual: [...manual].sort(), fixed: [...fixed].sort() }
}

/**
 * Sorted union of one provenance object.
 *
 * @param {{ auto?: string[], manual?: string[], fixed?: string[] }} provenance - buckets.
 * @returns {string[]} sorted date keys.
 */
export function provenanceDates(provenance) {
  const keys = new Set()
  for (const bucket of ['auto', 'manual', 'fixed']) {
    for (const key of provenance?.[bucket] ?? []) {
      if (typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key)) keys.add(key)
    }
  }
  return [...keys].sort()
}

/**
 * Parse one public-holiday JSON payload into `{ date, name }` entries.
 *
 * Accepted shapes, covering the common machine-readable sources:
 * - `["2026-10-01", ...]` or `{ dates: [...] }`;
 * - Nager.Date's `[{ date: "2026-10-01", localName }, ...]`;
 * - timor.tech's `{ holiday: { "10-01": { holiday: true, date, name } } }`
 *   (entries with `holiday: false` are makeup workdays and are skipped).
 *
 * @param {unknown} payload - parsed JSON body.
 * @param {number} year - requested year; entries outside it are ignored.
 * @returns {{ date: string, name: string }[]} sorted, de-duplicated entries.
 */
export function holidayEntriesFromPayload(payload, year) {
  const entries = []
  const push = (date, name) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return
    if (!date.startsWith(`${year}-`)) return
    entries.push({ date, name: typeof name === 'string' ? name : '' })
  }
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (typeof entry === 'string') push(entry, '')
      else if (entry !== null && typeof entry === 'object') push(entry.date, typeof entry.localName === 'string' ? entry.localName : entry.name)
    }
  } else if (payload !== null && typeof payload === 'object') {
    if (Array.isArray(payload.dates)) {
      for (const entry of payload.dates) {
        if (typeof entry === 'string') push(entry, '')
        else if (entry !== null && typeof entry === 'object') push(entry.date, entry.name)
      }
    } else if (payload.holiday !== null && typeof payload.holiday === 'object' && !Array.isArray(payload.holiday)) {
      for (const [key, entry] of Object.entries(payload.holiday)) {
        if (entry === null || typeof entry !== 'object' || entry.holiday !== true) continue
        const date = typeof entry.date === 'string' ? entry.date : /^\d{2}-\d{2}$/.test(key) ? `${year}-${key}` : undefined
        push(date, entry.name)
      }
    }
  }
  const byDate = new Map()
  for (const entry of entries) {
    const previous = byDate.get(entry.date)
    if (previous === undefined || (previous.name === '' && entry.name !== '')) byDate.set(entry.date, entry)
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date))
}

/**
 * Parse one public-holiday JSON payload into sorted `YYYY-MM-DD` keys.
 *
 * @param {unknown} payload - parsed JSON body.
 * @param {number} year - requested year; entries outside it are ignored.
 * @returns {string[]} sorted holiday keys.
 */
export function parseHolidayPayload(payload, year) {
  return holidayEntriesFromPayload(payload, year).map((entry) => entry.date)
}
