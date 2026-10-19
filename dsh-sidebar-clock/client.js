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
      'duration.days': '{days} d',
    }

    // -----------------------------------------------------------------------
    // Tariff policy — mirrors the published DeepSeek peak windows used by
    // `../dsh-token-cost` (UTC minutes, Monday–Friday, Chinese holidays off).
    // -----------------------------------------------------------------------

    /** UTC peak windows: 01:00–04:00 and 06:00–10:00. */
    const PEAK_WINDOWS = [
      [60, 240],
      [360, 600],
    ]
    /** Weekends are off-peak all day. */
    const WEEKDAYS_ONLY = true
    /** Chinese holiday dates are evaluated on the Beijing calendar. */
    const HOLIDAY_OFFSET_MINUTES = 480

    // -----------------------------------------------------------------------
    // Holiday calendar source — the same JSON mirror the reference plugin uses.
    // -----------------------------------------------------------------------

    const HOLIDAY_SOURCE = 'https://timor.tech/api/holiday/year/{year}'
    const HOLIDAY_REFRESH_MS = 6 * 60 * 60 * 1000
    const HOLIDAY_FETCH_TIMEOUT_MS = 15000
    const HOLIDAY_CACHE_KEY = 'dsh.sidebar-clock.holidays.v1'
    const HOLIDAY_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
    /** Account balance poll cadence; the Platform detail endpoint is not a stream. */
    const BALANCE_REFRESH_MS = 10 * 60 * 1000

    /** Fixed statutory anchors, used for years without a published arrangement. */
    const FIXED_HOLIDAYS = [
      ['01-01', '元旦'],
      ['05-01', '劳动节'],
      ['10-01', '国庆节'],
    ]

    const MINUTE_MS = 60 * 1000
    const DAY_MS = 24 * 60 * MINUTE_MS

    // -----------------------------------------------------------------------
    // Pure time / tariff / calendar helpers
    // -----------------------------------------------------------------------

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** `YYYY-MM-DD` of a moment on the Beijing calendar. */
    function beijingDateKey(timeMs) {
      return new Date(timeMs + HOLIDAY_OFFSET_MINUTES * MINUTE_MS).toISOString().slice(0, 10)
    }

    /** UTC minute of day. */
    function utcMinuteOfDay(timeMs) {
      return Math.floor(timeMs / MINUTE_MS) % 1440
    }

    /** Whether a minute-of-day falls inside a `[start, end)` window (wrap-aware). */
    function inWindow(minute, window) {
      const start = window[0]
      const end = window[1]
      return start < end ? minute >= start && minute < end : minute >= start || minute < end
    }

    /**
     * The tariff band at one moment under the published policy.
     *
     * @param {number} timeMs - epoch milliseconds.
     * @param {Record<string, string>} dates - holiday date keys -> display name.
     * @returns {'peak' | 'offPeak'} the band.
     */
    function bandAt(timeMs, dates) {
      if (WEEKDAYS_ONLY) {
        const weekday = new Date(timeMs).getUTCDay()
        if (weekday === 0 || weekday === 6) return 'offPeak'
      }
      if (dates !== undefined && dates[beijingDateKey(timeMs)] !== undefined) return 'offPeak'
      const minute = utcMinuteOfDay(timeMs)
      for (const window of PEAK_WINDOWS) {
        if (inWindow(minute, window)) return 'peak'
      }
      return 'offPeak'
    }

    /** The next moment the band changes (at minute resolution), or 0. */
    function nextBandSwitch(fromMs, dates) {
      const band = bandAt(fromMs, dates)
      const limit = 10 * 1440
      for (let delta = 1; delta <= limit; delta += 1) {
        const candidate = fromMs + delta * MINUTE_MS
        if (bandAt(candidate, dates) !== band) return candidate
      }
      return 0
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
        if (candidate >= todayKey) {
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

    /** Sorted `YYYY-MM-DD` holiday dates for one or more years. */
    function holidayDatesForYears(entries, years) {
      const dates = Object.create(null)
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.date !== 'string') continue
        if (entry.name !== undefined && entry.name !== '') dates[entry.date] = entry.name
        else if (dates[entry.date] === undefined) dates[entry.date] = ''
      }
      for (const year of years) {
        for (const fixed of FIXED_HOLIDAYS) {
          const key = year + '-' + fixed[0]
          if (dates[key] === undefined) dates[key] = fixed[1]
        }
      }
      return dates
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

    // -----------------------------------------------------------------------
    // Holiday calendar store (module-scoped; one fetch loop per page)
    // -----------------------------------------------------------------------

    /** Beijing year at `timeMs`. */
    function holidayYears(now) {
      const year = new Date(now + HOLIDAY_OFFSET_MINUTES * MINUTE_MS).getUTCFullYear()
      return [year, year + 1]
    }

    function fallbackHolidayState(now) {
      const dates = holidayDatesForYears([], holidayYears(now))
      return { dates, status: 'fallback', fetchedAt: 0 }
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
        if (parsed.dates === null || typeof parsed.dates !== 'object') return null
        const dates = holidayDatesForYears([], holidayYears(Date.now()))
        for (const key of Object.keys(parsed.dates)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
          if (typeof parsed.dates[key] !== 'string') continue
          dates[key] = parsed.dates[key]
        }
        const fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0
        if (fetchedAt === 0 || Date.now() - fetchedAt > HOLIDAY_CACHE_MAX_AGE_MS) return null
        return { dates, status: 'cache', fetchedAt }
      } catch {
        return null
      }
    }

    function writeHolidayCache(state) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(
          HOLIDAY_CACHE_KEY,
          JSON.stringify({ dates: state.dates, fetchedAt: state.fetchedAt }),
        )
      } catch {
        /* Storage may be unavailable or full; the in-memory calendar still works. */
      }
    }

    /** Fetch one year's calendar entries (`holiday: true` days only). */
    async function fetchHolidayYear(year) {
      const url = HOLIDAY_SOURCE.replaceAll('{year}', String(year))
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), HOLIDAY_FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const payload = await response.json()
        const entries = []
        const map = payload === null || typeof payload !== 'object' ? undefined : payload.holiday
        if (map !== null && typeof map === 'object') {
          for (const value of Object.values(map)) {
            if (value === null || typeof value !== 'object') continue
            if (value.holiday !== true) continue
            if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) continue
            entries.push({ date: value.date, name: typeof value.name === 'string' ? value.name : '' })
          }
        }
        return entries
      } finally {
        window.clearTimeout(timer)
      }
    }

    /**
     * Refresh the whole calendar (current + next Beijing year). Any single
     * source failure keeps the previous in-memory calendar rather than
     * replacing it with anchors only.
     */
    async function refreshHolidayCalendar(now) {
      const years = holidayYears(now)
      const results = await Promise.allSettled(years.map((year) => fetchHolidayYear(year)))
      const entries = []
      let fulfilled = 0
      for (const result of results) {
        if (result.status === 'fulfilled') {
          fulfilled += 1
          for (const entry of result.value) entries.push(entry)
        }
      }
      if (fulfilled === 0) throw new Error('holiday calendar unreachable')
      const dates = holidayDatesForYears(entries, years)
      const next = { dates, status: 'live', fetchedAt: Date.now() }
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
        holiday === null || holiday.today ? t('count.today') : t('count.suffix', { duration: formatDays(holiday.target - now, t) })

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

    // The 0.2.1-rc.2 shell has no top-card slot. This versioned adapter only
    // reads its local shell and inserts/removes our own empty portal container.
    // Do not rename or move React-owned nodes, or redeclare another entry's slots.
    function createTopCardHost(anchor) {
      const root = anchor?.closest('._2H3hWW_root')
      if (!root) return null
      const children = Array.from(root.children)
      const brand = children.find((node) => node.classList.contains('_2H3hWW_logoRow'))
      const button = children.find((node) => node.classList.contains('_2H3hWW_newSession'))
      if (!brand || !button || children.indexOf(brand) >= children.indexOf(button)) return null
      const host = root.ownerDocument.createElement('div')
      host.className = 'dsh-sc-host'
      host.dataset.sidebarClockHost = ''
      root.insertBefore(host, button)
      return host
    }

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
            refreshHolidayCalendar(Date.now()).then(
              (next) => {
                if (!disposed) setHolidayState(next)
              },
              (error) => {
                // Keep the cached/anchored calendar; the next tick retries.
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
