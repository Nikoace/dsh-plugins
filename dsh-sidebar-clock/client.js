/**
 * Sidebar clock: mounts through the official sidebar.footer.action list slot.
 * The stock sidebar keeps ownership of all navigation and child slots.
 * A React portal places only our card above New Session on the supported shell;
 * unknown shell layouts keep the card in its ordinary footer slot instead.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-clock',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const useSyncExternalStore = React.useSyncExternalStore

    /** Locale namespace and registration identity. */
    const NS = 'sidebarClock'
    const PLUGIN_ID = '@local/dsh-sidebar-clock'

    // -----------------------------------------------------------------------
    // Locale dictionaries (zh is the key-set source of truth)
    // -----------------------------------------------------------------------

    const zh = {
      'clock.aria': '当前时间 {time}，{band}时段；周末{weekend}；{holiday}；余额 {balance}',
      'clock.switch': '{time} 转{band}',
      'band.peak': '高峰',
      'band.offPeak': '低谷',
      'count.weekend': '周末',
      'count.holiday': '假期',
      'count.balance': '余额',
      'count.suffix': '{duration}后',
      'count.left': '剩{duration}',
      'count.today': '今天',
      'count.none': '暂无',
      'duration.days': '{days}天',
    }

    const en = {
      'clock.aria': 'Current time {time}, {band}; weekend {weekend}; {holiday}; balance {balance}',
      'clock.switch': '{time} → {band}',
      'band.peak': 'Peak',
      'band.offPeak': 'Off-peak',
      'count.weekend': 'Weekend',
      'count.holiday': 'Holiday',
      'count.balance': 'Balance',
      'count.suffix': 'in {duration}',
      'count.left': '{duration} left',
      'count.today': 'today',
      'count.none': 'none known',
      'duration.days': '{days} d',
    }

    // -----------------------------------------------------------------------
    // Tariff policy — the canonical rules (peak windows, Beijing holiday
    // calendar without estimates) live in `shared/tariff` and are inlined below by
    // `tools/sync-shared.mjs`. Never restate them in this file.
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Holiday calendar source — the same JSON mirror the reference plugin uses.
    // -----------------------------------------------------------------------

    const HOLIDAY_SOURCE = 'https://timor.tech/api/holiday/year/{year}'
    const HOLIDAY_REFRESH_MS = 6 * 60 * 60 * 1000
    const HOLIDAY_FETCH_TIMEOUT_MS = 15000
    // v1 mixed published dates with estimates; it cannot be safely reused.
    const HOLIDAY_CACHE_KEY = 'dsh.sidebar-clock.holidays.v2'
    /** Account balance poll cadence; the Platform detail endpoint is not a stream. */
    const BALANCE_REFRESH_MS = 10 * 60 * 1000

    // >>> clock:tariff-helpers
    // >>> generated:tariff (canonical rules; do not edit — run `node tools/sync-shared.mjs`)
    const Tariff = (() => {
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
       *   offset, no DST). Fetch only the current year. Dates come from a validated
       *   source or an explicit manual list; unavailable dates are never estimated.
       *
       * Changing any published rule means changing this file (and bumping
       * `TARIFF_VERSION` when the *behaviour* changes), then regenerating the copies.
       */

      /** Rule revision; bump on behaviour changes so snapshots/UI can report it. */
      const TARIFF_VERSION = 3

      /** UTC peak windows: 01:00–04:00 and 06:00–10:00 (official rate card). */
      const PEAK_WINDOWS = [
        [60, 240],
        [360, 600],
      ]

      /** Weekends are off-peak all day. */
      const WEEKDAYS_ONLY = true

      /** Chinese holiday dates are evaluated on the Beijing calendar (UTC+8). */
      const HOLIDAY_OFFSET_MINUTES = 480

      const MINUTES_PER_DAY = 1440
      const MINUTE_MS = 60_000
      const DAY_MS = 24 * 60 * MINUTE_MS

      /** Strict calendar date validation; Date.parse alone normalizes February 30. */
      function isHolidayDate(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
        const time = Date.parse(`${value}T00:00:00.000Z`)
        return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
      }

      /** Zero-pad a non-negative integer to two digits. */
      function pad2(value) {
        return String(value).padStart(2, '0')
      }

      /**
       * `YYYY-MM-DD` of a moment in a fixed UTC offset.
       *
       * @param {number} timeMs - epoch milliseconds.
       * @param {number} [offsetMinutes] - fixed offset; defaults to Beijing (+480).
       * @returns {string} date key.
       */
      function dateKeyAt(timeMs, offsetMinutes = HOLIDAY_OFFSET_MINUTES) {
        return new Date(timeMs + offsetMinutes * MINUTE_MS).toISOString().slice(0, 10)
      }

      /**
       * `YYYY-MM-DD` of a moment on the Beijing calendar.
       *
       * @param {number} timeMs - epoch milliseconds.
       * @returns {string} date key.
       */
      function beijingDateKey(timeMs) {
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
      function weekdayOfDateKey(key) {
        if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return -1
        const parsed = Date.parse(`${key}T00:00:00.000Z`)
        return Number.isFinite(parsed) ? new Date(parsed).getUTCDay() : -1
      }

      /** UTC minute of day (0..1439). */
      function utcMinuteOfDay(timeMs) {
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
      function inWindow(minute, window) {
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
      function normalizePeakWindows(value) {
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
      function hasHoliday(holidays, key) {
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
      function bandAt(timeMs, policy) {
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
      function nextBandSwitch(fromMs, policy, maxDays = 10) {
        const band = bandAt(fromMs, policy)
        const limit = Math.max(1, Math.floor(maxDays)) * MINUTES_PER_DAY
        for (let delta = 1; delta <= limit; delta += 1) {
          const candidate = fromMs + delta * MINUTE_MS
          if (bandAt(candidate, policy) !== band) return candidate
        }
        return 0
      }

      /**
       * The current calendar year in Beijing (or an explicitly configured offset).
       *
       * @param {number} timeMs - epoch milliseconds.
       * @param {number} [offsetMinutes] - fixed offset; defaults to Beijing (+480).
       * @returns {number[]} exactly one year.
       */
      function holidayYears(timeMs, offsetMinutes = HOLIDAY_OFFSET_MINUTES) {
        const year = new Date(timeMs + offsetMinutes * MINUTE_MS).getUTCFullYear()
        return [year]
      }

      /**
       * Build a named holiday calendar from entries.
       *
       * Only supplied, valid dates in the requested years are retained.
       *
       * @param {Array<{date: string, name?: string} | string>} entries - calendar entries.
       * @param {number[]} years - years to retain.
       * @returns {Record<string, string>} date key -> display name.
       */
      function holidayDatesForYears(entries, years) {
        const dates = {}
        for (const entry of entries ?? []) {
          const date = typeof entry === 'string' ? entry : entry === null || typeof entry !== 'object' ? undefined : entry.date
          if (!isHolidayDate(date) || !years?.includes(Number(date.slice(0, 4)))) continue
          const name = typeof entry === 'object' && entry !== null && typeof entry.name === 'string' ? entry.name : ''
          if (name !== '') dates[date] = name
          else if (dates[date] === undefined) dates[date] = ''
        }
        return dates
      }

      /**
       * Split a holiday calendar into provenance buckets (auto / manual / fixed).
       *
       * Every supplied key appears in exactly one bucket. `fixed` remains empty for
       * wire compatibility with older snapshots; new calendars never estimate dates.
       * When years are supplied, retain only those years.
       *
       * @param {{ auto?: string[], manual?: string[], years?: number[] }} sources - calendar sources.
       * @returns {{ auto: string[], manual: string[], fixed: string[] }} sorted buckets.
       */
      function holidayProvenance(sources) {
        const manual = new Set()
        const accepts = (key) => isHolidayDate(key) &&
          (!Array.isArray(sources?.years) || sources.years.includes(Number(key.slice(0, 4))))
        for (const key of sources?.manual ?? []) {
          if (accepts(key)) manual.add(key)
        }
        const auto = new Set()
        for (const key of sources?.auto ?? []) {
          if (accepts(key) && !manual.has(key)) auto.add(key)
        }
        return { auto: [...auto].sort(), manual: [...manual].sort(), fixed: [] }
      }

      /**
       * Sorted union of one provenance object.
       *
       * @param {{ auto?: string[], manual?: string[], fixed?: string[] }} provenance - buckets.
       * @returns {string[]} sorted date keys.
       */
      function provenanceDates(provenance) {
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
       * @throws {Error} for business errors, unknown shapes, or malformed entries.
       * Valid empty arrays/calendars are successful responses, not fetch failures.
       */
      function holidayEntriesFromPayload(payload, year) {
        const entries = []
        const push = (date, name) => {
          if (!isHolidayDate(date)) throw new Error('holiday calendar contains an invalid date')
          if (!date.startsWith(`${year}-`)) return
          entries.push({ date, name: typeof name === 'string' ? name : '' })
        }
        if (payload !== null && typeof payload === 'object' && Object.hasOwn(payload, 'code') && payload.code !== 0) {
          throw new Error('holiday source reported an unsuccessful response code')
        }
        if (Array.isArray(payload)) {
          for (const entry of payload) {
            if (typeof entry === 'string') push(entry, '')
            else if (entry !== null && typeof entry === 'object') push(entry.date, typeof entry.localName === 'string' ? entry.localName : entry.name)
            else throw new Error('holiday calendar contains an invalid entry')
          }
        } else if (payload !== null && typeof payload === 'object') {
          if (Array.isArray(payload.dates)) {
            for (const entry of payload.dates) {
              if (typeof entry === 'string') push(entry, '')
              else if (entry !== null && typeof entry === 'object') push(entry.date, entry.name)
              else throw new Error('holiday calendar contains an invalid entry')
            }
          } else if (payload.holiday !== null && typeof payload.holiday === 'object' && !Array.isArray(payload.holiday)) {
            for (const [key, entry] of Object.entries(payload.holiday)) {
              if (entry === null || typeof entry !== 'object' || typeof entry.holiday !== 'boolean') {
                throw new Error('holiday calendar contains an invalid entry')
              }
              const date = typeof entry.date === 'string' ? entry.date : /^\d{2}-\d{2}$/.test(key) ? `${year}-${key}` : undefined
              if (!isHolidayDate(date)) throw new Error('holiday calendar contains an invalid date')
              if (entry.holiday === false) continue
              push(date, entry.name)
            }
          } else throw new Error('holiday calendar payload shape is not recognized')
        } else throw new Error('holiday calendar payload shape is not recognized')
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
      function parseHolidayPayload(payload, year) {
        return holidayEntriesFromPayload(payload, year).map((entry) => entry.date)
      }

      return {
        TARIFF_VERSION,
        PEAK_WINDOWS,
        WEEKDAYS_ONLY,
        HOLIDAY_OFFSET_MINUTES,
        MINUTES_PER_DAY,
        MINUTE_MS,
        DAY_MS,
        isHolidayDate,
        pad2,
        dateKeyAt,
        beijingDateKey,
        weekdayOfDateKey,
        utcMinuteOfDay,
        inWindow,
        normalizePeakWindows,
        hasHoliday,
        bandAt,
        nextBandSwitch,
        holidayYears,
        holidayDatesForYears,
        holidayProvenance,
        provenanceDates,
        holidayEntriesFromPayload,
        parseHolidayPayload,
      }
    })()
    // <<< generated:tariff
    const MINUTE_MS = Tariff.MINUTE_MS
    const DAY_MS = Tariff.DAY_MS
    const HOLIDAY_OFFSET_MINUTES = Tariff.HOLIDAY_OFFSET_MINUTES
    const pad2 = Tariff.pad2
    const utcMinuteOfDay = Tariff.utcMinuteOfDay
    const inWindow = Tariff.inWindow

    /** The band policy the clock asks the canonical rules about. */
    function bandPolicy(dates) {
      return {
        peakWindows: Tariff.PEAK_WINDOWS,
        weekdaysOnly: Tariff.WEEKDAYS_ONLY,
        offPeakEnabled: true,
        holidayOffsetMinutes: Tariff.HOLIDAY_OFFSET_MINUTES,
        holidays: dates,
      }
    }

    /** `YYYY-MM-DD` of a moment on the Beijing calendar. */
    function beijingDateKey(timeMs) {
      return Tariff.beijingDateKey(timeMs)
    }

    /**
     * The tariff band at one moment (canonical rule; `dates` carries the
     * validated published calendar).
     *
     * @param {number} timeMs - epoch milliseconds.
     * @param {Record<string, string>} dates - holiday date keys -> display name.
     * @returns {'peak' | 'offPeak'} the band.
     */
    function bandAt(timeMs, dates) {
      return Tariff.bandAt(timeMs, bandPolicy(dates))
    }

    /** The next moment the band changes (at minute resolution), or 0. */
    function nextBandSwitch(fromMs, dates) {
      return Tariff.nextBandSwitch(fromMs, bandPolicy(dates), 10)
    }

    // Memoize the (bounded) switch scan to once per minute + calendar identity.
    let switchCache = { minute: -1, dates: null, value: 0 }
    function nextBandSwitchCached(now, dates) {
      const minute = Math.floor(now / MINUTE_MS)
      if (switchCache.minute === minute && switchCache.dates === dates) return switchCache.value
      const value = nextBandSwitch(minute * MINUTE_MS, dates)
      switchCache = { minute, dates, value }
      return value
    }

    /** The next weekend boundary: the coming Saturday, or Monday when in one. */
    function weekendBoundary(now) {
      const date = new Date(now)
      const year = date.getFullYear()
      const month = date.getMonth()
      const day = date.getDate()
      const weekday = date.getDay()
      if (weekday === 6) {
        return { active: true, target: new Date(year, month, day + 2).getTime() }
      }
      if (weekday === 0) {
        return { active: true, target: new Date(year, month, day + 1).getTime() }
      }
      return { active: false, target: new Date(year, month, day + (6 - weekday)).getTime() }
    }

    /** The next holiday on/after today (Beijing calendar). */
    function nextHoliday(now, dates) {
      const todayKey = beijingDateKey(now)
      const keys = Object.keys(dates).sort()
      let key
      for (const candidate of keys) {
        if (candidate >= todayKey && candidate.slice(0, 4) === todayKey.slice(0, 4)) {
          key = candidate
          break
        }
      }
      if (key === undefined) return null
      const parts = key.split('-')
      // The holiday begins at Beijing midnight, which is also the instant the
      // tariff band flips to off-peak; targeting local midnight would make the
      // countdown disagree with the badge in every non-UTC+8 zone.
      const target =
        Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) -
        HOLIDAY_OFFSET_MINUTES * MINUTE_MS
      return { key, name: dates[key], today: key === todayKey, target }
    }

    /** Sorted `YYYY-MM-DD` holiday dates for one or more years (canonical calendar). */
    function holidayDatesForYears(entries, years) {
      return Tariff.holidayDatesForYears(entries, years)
    }

    /** `HH:MM` of an instant in the browser's system time zone. */
    function clockAt(timeMs) {
      const date = new Date(timeMs)
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    /** Whole-day countdown for a positive span, rounded and floored at one day. */
    function formatDays(msLeft, t) {
      const days = Math.max(1, Math.round(Math.max(0, msLeft) / DAY_MS))
      return t('duration.days', { days })
    }

    /** The active UI locale id from the injected locale reader, or undefined. */
    function activeLocaleId(getLocale) {
      try {
        if (typeof getLocale !== 'function') return undefined
        const snapshot = getLocale()
        if (snapshot === null || typeof snapshot !== 'object') return undefined
        return typeof snapshot.active === 'string' && snapshot.active.length > 0 ? snapshot.active : undefined
      } catch {
        return undefined
      }
    }

    /** Short local date line in the UI language, e.g. `周一 10月19日` / `Mon October 19`. */
    function dateLine(now, localeId) {
      const locale =
        typeof localeId === 'string' && localeId.length > 0
          ? localeId
          : typeof navigator === 'undefined'
            ? undefined
            : navigator.language
      try {
        const date = new Date(now)
        const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date)
        const monthDay = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(date)
        return weekday + ' ' + monthDay
      } catch {
        const date = new Date(now)
        return date.getMonth() + 1 + '/' + date.getDate()
      }
    }

    // <<< clock:tariff-helpers

    // -----------------------------------------------------------------------
    // Holiday calendar store (module-scoped; one fetch loop per page)
    // -----------------------------------------------------------------------

    /** Current Beijing year only. */
    function holidayYears(now) {
      return Tariff.holidayYears(now)
    }

    function fallbackHolidayState(now) {
      const dates = holidayDatesForYears([], holidayYears(now))
      return { dates, year: holidayYears(now)[0], status: 'unavailable', fetchedAt: 0 }
    }

    let holidayState = fallbackHolidayState(Date.now())
    const holidayListeners = new Set()

    function getHolidayState() {
      return holidayState
    }

    function setHolidayState(next) {
      holidayState = next
      for (const listener of holidayListeners) listener()
    }

    function subscribeHolidays(listener) {
      holidayListeners.add(listener)
      return () => holidayListeners.delete(listener)
    }

    /** Restore the locally cached calendar (best effort). */
    function readHolidayCache() {
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(HOLIDAY_CACHE_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        if (parsed.dates === null || typeof parsed.dates !== 'object' || Array.isArray(parsed.dates)) return null
        const years = holidayYears(Date.now())
        if (parsed.year !== years[0]) return null
        const entries = []
        for (const key of Object.keys(parsed.dates)) {
          if (!Tariff.isHolidayDate(key)) continue
          if (typeof parsed.dates[key] !== 'string') continue
          entries.push({ date: key, name: parsed.dates[key] })
        }
        const dates = holidayDatesForYears(entries, years)
        const fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0
        if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || fetchedAt > Date.now()) return null
        return { dates, year: years[0], status: 'cache', fetchedAt }
      } catch {
        return null
      }
    }

    function writeHolidayCache(state) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(
          HOLIDAY_CACHE_KEY,
          JSON.stringify({ dates: state.dates, year: state.year, fetchedAt: state.fetchedAt }),
        )
      } catch {
        /* Storage may be unavailable or full; the in-memory calendar still works. */
      }
    }

    /** Fetch one year's calendar entries via the canonical payload parser. */
    async function fetchHolidayYear(year) {
      const url = HOLIDAY_SOURCE.replaceAll('{year}', String(year))
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), HOLIDAY_FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const payload = await response.json()
        return Tariff.holidayEntriesFromPayload(payload, year)
      } finally {
        window.clearTimeout(timer)
      }
    }

    /**
     * Fetch only this year's calendar. Failure leaves the last successful
     * in-memory and stored calendar untouched; no fallback dates are generated.
     */
    async function refreshHolidayCalendar(now) {
      const years = holidayYears(now)
      const entries = await fetchHolidayYear(years[0])
      // A request completing across New Year must not restore last year's UI.
      if (years[0] !== holidayYears(Date.now())[0]) throw new Error('holiday calendar year changed during refresh')
      const dates = holidayDatesForYears(entries, years)
      const next = { dates, year: years[0], status: 'live', fetchedAt: Date.now() }
      writeHolidayCache(next)
      return next
    }

    // -----------------------------------------------------------------------
    // Account balance (optional: the card still renders without an account)
    // -----------------------------------------------------------------------

    /**
     * The DSH client build version the Account Remote expects in its metadata.
     * The page boot manifest carries the release identity; the literal fallback
     * keeps the header semver-shaped for the rare page without a boot manifest.
     */
    function clientVersion() {
      try {
        const boot = typeof window === 'undefined' ? undefined : window.__DSH_BOOT__
        const release = boot === undefined || boot === null ? undefined : boot.release
        if (release !== undefined && release !== null && typeof release.version === 'string' && release.version.length > 0) {
          return release.version
        }
      } catch {
        /* fall through to the literal */
      }
      return '0.2.1-rc.2'
    }

    /** Balance snapshot: `{ status: 'loading' | 'ready' | 'empty' | 'unavailable', currency?, amount? }`. */
    let balanceState = { status: 'loading' }
    const balanceListeners = new Set()

    function getBalanceState() {
      return balanceState
    }

    function setBalanceState(next) {
      balanceState = next
      for (const listener of balanceListeners) listener()
    }

    function subscribeBalance(listener) {
      balanceListeners.add(listener)
      return () => balanceListeners.delete(listener)
    }

    /** Read the signed-in account's primary wallet (CNY preferred over USD). */
    async function readBalance(account, metadata) {
      const result = await account.getBalance(metadata)
      if (result === null || typeof result !== 'object' || result.ok !== true) return { status: 'unavailable' }
      const value = result.value
      if (value === null || typeof value !== 'object') return { status: 'empty' }
      if (value.status !== 'ready' || !Array.isArray(value.value)) return { status: 'unavailable' }
      const wallets = value.value.filter(
        (wallet) => wallet !== null && typeof wallet === 'object' && typeof wallet.balance === 'string',
      )
      const preferred = wallets.find((wallet) => wallet.currency === 'CNY') ?? wallets[0]
      if (preferred === undefined) return { status: 'empty' }
      return {
        status: 'ready',
        currency: preferred.currency === 'USD' ? 'USD' : 'CNY',
        amount: preferred.balance,
      }
    }

    /** Compact wallet text, e.g. `¥12.34`; an unavailable balance renders as an em dash. */
    function formatBalanceText(state, localeId) {
      if (state === undefined || state === null || state.status !== 'ready') return '—'
      const symbol = state.currency === 'USD' ? '$' : '¥'
      const amount = Number(state.amount)
      if (!Number.isFinite(amount)) return symbol + String(state.amount)
      try {
        return symbol + amount.toLocaleString(localeId, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      } catch {
        return symbol + amount.toFixed(2)
      }
    }

    /** Re-render on a slow tick so the clock and band stay current. */
    function useNow(intervalMs) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
        return () => window.clearInterval(timer)
      }, [intervalMs])
      return now
    }

    // -----------------------------------------------------------------------
    // The clock card
    // -----------------------------------------------------------------------

    /** One countdown pair: a short label and its value. */
    function CountItem({ label, value }) {
      return h(
        'span',
        { className: 'dsh-sc-count' },
        h('span', { className: 'dsh-sc-countLabel' }, label),
        h('span', { className: 'dsh-sc-countValue' }, value),
      )
    }

    /**
     * Contains card rendering errors within this plugin's additive footer entry.
     * The official sidebar and its navigation remain mounted.
     */
    class ClockBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[sidebar-clock] clock card failed to render', error)
        }
      }

      render() {
        if (this.state.failed) return null
        return this.props.children
      }
    }

    /**
     * The card itself. Reads the module calendar store and re-renders once per
     * second; every derived value is computed from `now`, never cached across
     * ticks except the bounded next-switch scan.
     */
    function ClockWidget({ t, getLocale }) {
      const now = useNow(1000)
      const localeId = activeLocaleId(getLocale)
      const calendar = useSyncExternalStore(subscribeHolidays, getHolidayState, getHolidayState)
      const balance = useSyncExternalStore(subscribeBalance, getBalanceState, getBalanceState)
      const dates = calendar === undefined || calendar === null ? EMPTY_DATES : calendar.dates
      const band = bandAt(now, dates)
      const bandLabel = t(band === 'peak' ? 'band.peak' : 'band.offPeak')
      const switchAt = nextBandSwitchCached(now, dates)
      const weekend = weekendBoundary(now)
      const holiday = nextHoliday(now, dates)
      const balanceText = formatBalanceText(balance, localeId)

      const weekendValue = weekend.active
        ? t('count.left', { duration: formatDays(Math.max(0, weekend.target - now), t) })
        : t('count.suffix', { duration: formatDays(Math.max(0, weekend.target - now), t) })

      const holidayLabel =
        holiday === null || holiday.name === '' ? t('count.holiday') : holiday.name
      const holidayValue =
        holiday === null ? t('count.none') : holiday.today ? t('count.today') : t('count.suffix', { duration: formatDays(holiday.target - now, t) })

      const aria = t('clock.aria', {
        time: clockAt(now),
        band: bandLabel,
        weekend: weekendValue,
        holiday: holidayLabel + ' ' + holidayValue,
        balance: balanceText,
      })

      return h(
        'div',
        {
          className: 'dsh-sc-clock',
          role: 'group',
          'aria-label': aria,
        },
        h(
          'div',
          { className: 'dsh-sc-clockTop' },
          h(
            'span',
            { className: 'dsh-sc-clockTime' },
            h('span', null, clockAt(now)),
            h('span', { className: 'dsh-sc-clockSeconds' }, ':' + pad2(new Date(now).getSeconds())),
          ),
          h(
            'span',
            {
              className: band === 'peak' ? 'dsh-sc-band dsh-sc-bandPeak' : 'dsh-sc-band dsh-sc-bandOffPeak',
            },
            h('span', { className: 'dsh-sc-bandDot', 'aria-hidden': true }),
            bandLabel,
          ),
        ),
        h(
          'div',
          { className: 'dsh-sc-clockMeta' },
          h('span', { className: 'dsh-sc-clockDate' }, dateLine(now, localeId)),
          switchAt === 0
            ? null
            : h(
                'span',
                { className: 'dsh-sc-clockSwitch' },
                t('clock.switch', {
                  time: clockAt(switchAt),
                  band: t(band === 'peak' ? 'band.offPeak' : 'band.peak'),
                }),
              ),
        ),
        h(
          'div',
          { className: 'dsh-sc-clockCounts' },
          h(CountItem, { label: t('count.weekend'), value: weekendValue }),
          h('span', { className: 'dsh-sc-countSep', 'aria-hidden': true }, '·'),
          h(CountItem, { label: holidayLabel, value: holidayValue }),
        ),
        h(
          'div',
          { className: 'dsh-sc-clockCounts' },
          h(CountItem, { label: t('count.balance'), value: balanceText }),
        ),
      )
    }

    const EMPTY_DATES = Object.freeze(Object.create(null))

    // -----------------------------------------------------------------------
    // Sidebar shell adapter (versioned; see docs/compatibility.md)
    //
    // The shell has no "below the brand row" slot, so the clock card is portaled
    // into our own empty container inserted right before New Session. Placement
    // depends on hashed CSS-module class names: treat SIDEBAR_SHELL as one
    // versioned unit and bump it as a group per DSH shell release — never chase
    // a single re-hashed class from an unrelated page change. Never rename,
    // move or remove React-owned nodes; only our own host is inserted/removed.
    // -----------------------------------------------------------------------
    // sidebar-shell-adapter:start — tests/sidebar-clock-adapter.test.cjs slices this region.

    /** Hashed-class map of the installed DSH sidebar shell (one versioned unit). */
    const SIDEBAR_SHELL = Object.freeze({
      dshVersion: '0.2.1-rc.2',
      root: '_2H3hWW_root',
      logoRow: '_2H3hWW_logoRow',
      newSession: '_2H3hWW_newSession',
    })

    /** Failure kinds already warned about; one warning per page load per kind. */
    const adapterWarnings = new Set()

    /**
     * Report an unrecognised shell structure once per failure kind. This is a
     * versioned-adapter mismatch, not an activation failure: when the plugin is
     * inactive the adapter never runs, so this warning is absent entirely.
     * Logging problems are swallowed because logging must never break the card.
     */
    function warnSidebarAdapter(kind, reason, shell) {
      try {
        if (adapterWarnings.has(kind)) return
        adapterWarnings.add(kind)
        if (typeof console === 'undefined' || typeof console.warn !== 'function') return
        console.warn(
          '[sidebar-clock] sidebar adapter: DSH ' +
            (shell && shell.dshVersion ? shell.dshVersion : SIDEBAR_SHELL.dshVersion) +
            ' sidebar structure unrecognised (' +
            reason +
            '). Keeping the card in the footer slot. This is an adapter/version mismatch, ' +
            'not a plugin-activation failure: if the card is missing everywhere, the plugin did not activate.',
        )
      } catch {
        /* logging must never break the card */
      }
    }

    /** Index of `node` among an array-like child list, or -1. */
    function childIndex(children, node) {
      if (!children || typeof children.length !== 'number') return -1
      for (let index = 0; index < children.length; index += 1) {
        if (children[index] === node) return index
      }
      return -1
    }

    /** The first direct child carrying `className`, or null. */
    function directChildByClass(children, className) {
      if (!children || typeof children.length !== 'number') return null
      for (let index = 0; index < children.length; index += 1) {
        const node = children[index]
        if (
          node &&
          node.classList &&
          typeof node.classList.contains === 'function' &&
          node.classList.contains(className)
        ) {
          return node
        }
      }
      return null
    }

    /** Whether `node` is the empty portal container this adapter inserts. */
    function isSidebarClockHost(node) {
      if (!node || !node.classList || typeof node.classList.contains !== 'function') return false
      if (!node.classList.contains('dsh-sc-host')) return false
      if (node.dataset && Object.prototype.hasOwnProperty.call(node.dataset, 'sidebarClockHost')) return true
      return typeof node.getAttribute === 'function' && node.getAttribute('data-sidebar-clock-host') !== null
    }

    /**
     * Resolve the sidebar root around our own hidden anchor. Reports why it could
     * not, so the caller can tell a missing shell from an anchor outside one.
     */
    function sidebarRootOf(anchor, shell) {
      if (anchor === null || typeof anchor !== 'object' || typeof anchor.closest !== 'function') {
        return { root: null, reason: 'anchor outside sidebar root', kind: 'anchor' }
      }
      let root
      try {
        root = anchor.closest('.' + shell.root)
      } catch {
        return { root: null, reason: 'anchor outside sidebar root', kind: 'anchor' }
      }
      if (root) {
        // `closest` guarantees ancestry, but a hostile/fake node could lie.
        if (root !== anchor && typeof root.contains === 'function' && !root.contains(anchor)) {
          return { root: null, reason: 'anchor outside sidebar root', kind: 'anchor' }
        }
        return { root, reason: '', kind: '' }
      }
      // No ancestor root: does the shell exist elsewhere in the page (so the
      // anchor is outside it), or is this an unrecognised shell entirely?
      try {
        const doc = anchor.ownerDocument
        if (doc && typeof doc.querySelector === 'function' && doc.querySelector('.' + shell.root)) {
          return { root: null, reason: 'anchor outside sidebar root', kind: 'anchor' }
        }
      } catch {
        /* fall through to the generic reason */
      }
      return { root: null, reason: 'root class not found', kind: 'root' }
    }

    /**
     * Insert or re-find our own empty portal container right before New Session.
     * Returns the container, or null when this shell is not recognised; never
     * throws, never moves/removes foreign nodes, and is idempotent about the
     * container it owns. The caller keeps the footer fallback when null.
     *
     * @param {unknown} anchor - our hidden footer-slot anchor.
     * @param {typeof SIDEBAR_SHELL} [shell] - class map override (tests only).
     * @returns {HTMLElement | null}
     */
    function createTopCardHost(anchor, shell = SIDEBAR_SHELL) {
      const map = shell && typeof shell === 'object' && shell.root ? shell : SIDEBAR_SHELL
      try {
        const located = sidebarRootOf(anchor, map)
        const root = located.root
        if (!root) {
          warnSidebarAdapter(located.kind, located.reason, map)
          return null
        }
        const children = root.children
        const logoRow = directChildByClass(children, map.logoRow)
        if (!logoRow) {
          warnSidebarAdapter('logoRow', 'logo row not found', map)
          return null
        }
        const newSession = directChildByClass(children, map.newSession)
        if (!newSession) {
          warnSidebarAdapter('newSession', 'new session button not found', map)
          return null
        }
        const brandIndex = childIndex(children, logoRow)
        const sessionIndex = childIndex(children, newSession)
        if (brandIndex < 0 || sessionIndex < 0 || brandIndex >= sessionIndex) {
          warnSidebarAdapter('order', 'order unexpected', map)
          return null
        }
        const doc =
          root.ownerDocument ||
          (anchor && anchor.ownerDocument) ||
          (typeof document === 'undefined' ? null : document)
        if (!doc || typeof doc.createElement !== 'function') {
          warnSidebarAdapter('document', 'owner document unavailable', map)
          return null
        }
        let host = null
        for (let index = 0; index < children.length; index += 1) {
          if (isSidebarClockHost(children[index])) {
            host = children[index]
            break
          }
        }
        if (!host) {
          host = doc.createElement('div')
          host.className = 'dsh-sc-host'
          // Mark the node as ours through both APIs so the lookup works whether a
          // stub DOM reflects dataset to attributes or only implements one of them.
          if (typeof host.setAttribute === 'function') host.setAttribute('data-sidebar-clock-host', '')
          if (host.dataset) host.dataset.sidebarClockHost = ''
        }
        if (childIndex(children, host) !== sessionIndex - 1) root.insertBefore(host, newSession)
        return host
      } catch (error) {
        let detail = 'unexpected error'
        try {
          detail = error && error.message ? String(error.message) : String(error)
        } catch {
          /* keep the generic detail */
        }
        warnSidebarAdapter('exception', 'adapter threw while reading the sidebar DOM: ' + detail, map)
        return null
      }
    }
    // sidebar-shell-adapter:end

    /** An ordinary additive slot occupant; collapse and unmount remove the portal. */
    function SidebarClock({ wide, t, getLocale }) {
      const anchor = React.useRef(null)
      const [host, setHost] = React.useState(null)
      React.useLayoutEffect(() => {
        if (!wide) return undefined
        const target = createTopCardHost(anchor.current)
        setHost(target)
        return () => {
          target?.remove()
          setHost(null)
        }
      }, [wide])

      const card = wide ? h(ClockBoundary, null, h(ClockWidget, { t, getLocale })) : null
      return h(
        React.Fragment,
        null,
        h('span', { ref: anchor, hidden: true, 'data-sidebar-clock-anchor': '' }),
        host && wide
          ? createPortal(card, host)
          : wide ? h('div', { className: 'dsh-sc-fallback' }, card) : null,
      )
    }

    const css = `
.dsh-sc-host{flex:none;min-width:0;-webkit-app-region:no-drag}
.dsh-sc-fallback{flex:1;min-width:0;width:100%;-webkit-app-region:no-drag}
.dsh-sc-clock{animation:dsh-sc-rail-fade-in .15s var(--ds-ease-in-out) backwards}
@keyframes dsh-sc-rail-fade-in{0%{opacity:0}}
.dsh-sc-clock{display:flex;flex-direction:column;gap:4px;min-width:0;margin:0 2px 10px;padding:8px 10px 9px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:default}
.dsh-sc-clockTop{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.dsh-sc-clockTime{display:inline-flex;align-items:baseline;gap:1px;color:var(--dsw-alias-label-primary);font-size:19px;font-weight:600;line-height:22px;font-variant-numeric:tabular-nums;letter-spacing:.01em;min-width:0}
.dsh-sc-clockSeconds{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsh-sc-band{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:11px;font-weight:500;line-height:16px}
.dsh-sc-bandDot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.dsh-sc-bandPeak{color:var(--dsw-alias-state-warn-primary)}
.dsh-sc-bandOffPeak{color:var(--dsw-alias-state-success-primary)}
.dsh-sc-clockMeta{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-sc-clockDate{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sc-clockSwitch{flex:none;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-sc-clockCounts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:11px;line-height:16px}
.dsh-sc-count{display:inline-flex;align-items:center;gap:4px;min-width:0}
.dsh-sc-countLabel{max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dsh-sc-countValue{white-space:nowrap;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dsh-sc-countSep{flex:none;color:var(--dsw-alias-border-l2)}
`

    // -----------------------------------------------------------------------
    // Plugin body
    // -----------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sidebar-clock: dictionaries')

        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const tag = document.createElement('style')
          tag.dataset.plugin = PLUGIN_ID
          tag.dataset.pluginCss = PLUGIN_ID + '/sidebar-clock.css'
          tag.textContent = css
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'sidebar-clock: styles')

        // Restore the cached calendar before the first card render.
        const cached = readHolidayCache()
        if (cached !== null) setHolidayState(cached)

        ctx.effect(() => {
          let disposed = false
          let timer
          const run = () => {
            if (disposed) return
            if (getHolidayState().year !== holidayYears(Date.now())[0]) setHolidayState(fallbackHolidayState(Date.now()))
            refreshHolidayCalendar(Date.now()).then(
              (next) => {
                if (!disposed) setHolidayState(next)
              },
              (error) => {
                // Keep the current year's last valid calendar; retry next tick.
                try {
                  ctx.logger?.warn?.('[sidebar-clock] holiday calendar refresh failed', error)
                } catch {
                  /* logging must never break the card */
                }
              },
            )
          }
          run()
          timer = window.setInterval(run, HOLIDAY_REFRESH_MS)
          return () => {
            disposed = true
            window.clearInterval(timer)
          }
        }, 'sidebar-clock: holiday refresh')

        // Account balance is optional: profiles without the Account controller
        // still render the card with an em dash for the balance.
        ctx.effect(() => {
          let disposed = false
          let timer
          let retry
          let misses = 0
          const scheduleRetry = () => {
            if (disposed || retry !== undefined || misses >= 12) return
            retry = window.setTimeout(() => {
              retry = undefined
              read()
            }, 5000)
          }
          const read = () => {
            if (disposed) return
            let account
            try {
              account = ctx.get('remote.account')
            } catch {
              account = undefined
            }
            if (account === undefined || account === null || typeof account.getBalance !== 'function') {
              // The Account Remote may mount a moment after this plugin; retry
              // quickly for the first minute, then only on the slow interval.
              misses += 1
              setBalanceState({ status: 'unavailable' })
              scheduleRetry()
              return
            }
            misses = 0
            let locale = 'en-US'
            try {
              locale = ctx.locale.getSnapshot().active
            } catch {
              /* keep the fallback locale */
            }
            const metadata = {
              version: clientVersion(),
              locale,
              timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
            }
            readBalance(account, metadata).then(
              (next) => {
                if (!disposed) setBalanceState(next)
              },
              (error) => {
                if (disposed) return
                if (getBalanceState().status !== 'ready') setBalanceState({ status: 'unavailable' })
                try {
                  ctx.logger?.warn?.('[sidebar-clock] account balance refresh failed', error)
                } catch {
                  /* logging must never break the card */
                }
              },
            )
          }
          read()
          timer = window.setInterval(read, BALANCE_REFRESH_MS)
          return () => {
            disposed = true
            window.clearInterval(timer)
            window.clearTimeout(retry)
          }
        }, 'sidebar-clock: balance refresh')

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: PLUGIN_ID,
              order: -100,
              locale: NS,
              inject: () => ({ getLocale: () => ctx.locale.getSnapshot() }),
            },
            SidebarClock,
          ),
        )
      },
    }
  },
})
