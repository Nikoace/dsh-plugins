/**
 * Client half of the token-cost plugin.
 *
 * Adds one `conversation.composer.dock` cell (`cost`) beside the shipped
 * activity/usage cells. The value is the Host `tokenCost` session projection:
 * this module only formats it, derives the *current* band from the frozen
 * pricing policy carried in the value, and renders the breakdown dialog. It
 * folds no session events and performs no pricing, so reloads, forks, and
 * history paging cannot change a number.
 *
 * The pill and dialog copy the shipped session-statistics controls
 * (`StatsPills.module.css` and `stat-dialog.module.css`) class geometry, token
 * usage, and anchor/dismiss behavior, renamed under the plugin prefix.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-token-cost',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const NS = 'tokenCost'
    const PLUGIN_ID = '@local/dsh-token-cost'

    /** Viewport margin kept by the placement clamp (same as the shipped stat dialog). */
    const PANEL_MARGIN = 12
    /** Distance between the trigger's top edge and the panel's bottom. */
    const PANEL_GAP = 8
    /** Unplaced portal panel: hidden but laid out so the clamp measures real dimensions. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }

    const zh = {
      'currency.code': 'CNY',
      'pill.aria': '本次会话 token 费用 {cost}，当前{band}时段',
      'pill.ariaSubagents': '本次会话及其 {count} 个子 agent 合计 {cost}，当前{band}时段',
      'band.peak': '高峰',
      'band.offPeak': '低谷',
      'band.current': '当前时段：{band}',
      'section.band': '时段',
      'label.currentBand': '当前时段',
      'label.peakWindows': '高峰窗口',
      'label.ruleBasis': '判定基准',
      'window.local': '{windows}（{zone}）',
      'window.utc': 'UTC {windows}',
      'band.until': '{duration}后切换',
      'band.untilAt': '{duration}后切换（{time}）',
      'band.untilMinutes': '{minutes} 分钟',
      'band.untilHours': '{hours} 小时',
      'band.untilHoursMinutes': '{hours} 小时 {minutes} 分',
      'band.untilDays': '{days} 天',
      'band.untilDaysHours': '{days} 天 {hours} 小时',
      'dialog.title': 'Token 费用',
      'total': '总费用',
      'total.withSubagents': '含子会话',
      'subtree.value': '{cost}（自身 {own} + {count} 个子 agent {children}）',
      'subtree.valueUnknown': '{cost}（自身 {own} + {count} 个子 agent {children}，另 {unknown} 个子会话未取到金额）',
      'subtree.none': '本会话未派生子 agent。',
      'peakCost': '高峰费用',
      'offPeakCost': '低谷费用',
      'band.spend': '{cost} · {tokens} token',
      'saved': '低谷已节省',
      'calls': '计费请求',
      'callsValue': '{count} 次',
      'callsSplit': '高峰 {peak} 次 · 低谷 {offPeak} 次',
      'section.tokens': '计费 token',
      'token.input': '未缓存输入',
      'token.cacheRead': '缓存命中',
      'token.cacheWrite': '缓存写入',
      'token.output': '输出',
      'token.value': '{tokens} · {cost}',
      'section.models': '按模型',
      'model.value': '{cost} · {count} 次',
      'model.split': '高峰 {peak} · 低谷 {offPeak}',
      'note.estimated': '{count} 次请求无精确费率，按后备费率估算。',
      'note.unpriced': '{count} 次请求无匹配费率，未计入费用。',
      'note.excluded': '{count} 次请求来自不计价的服务（{providers}），未计入金额。',
      'note.reasoning': '推理 token 已包含在输出计费中。',
      'pricing.official': '费率来源：官方价目表',
      'pricing.config': '费率来源：本地后备费率',
      'pricing.updated': '读取于 {time}',
      'pricing.newSessions': '费率按请求发生时间取当时有效的价格；价格调整只影响调整之后的请求。',
      'pricing.timeline': '费率时间线：{count} 段',
      'pricing.timelineRow': '{from} 起 · 未缓存 {symbol}{input}/M · 缓存命中 {symbol}{cacheRead}/M · 输出 {symbol}{output}/M',
      'pricing.timelineRowOpen': '{from} 起（当前）· 未缓存 {symbol}{input}/M · 缓存命中 {symbol}{cacheRead}/M · 输出 {symbol}{output}/M',
      'pricing.excludedRoutes': '不计价：{providers}',
      'model.excluded': '{count} 次未计价',
      'model.epochs': '{count} 个费率时段',
      'pricing.holidaysMissing': '本年度暂无已知节假日；按周末和峰谷时段计费，不预估假期。',
      'pricing.configLate': '（尚未成功读取官方价目表，暂用本地后备费率）',
      'pricing.holidaysMissingLate': '本年度暂无已知节假日；按周末和峰谷时段计费，获取成功后自动更新，不预估假期。',
      'hint.show': '计价与费率说明',
      'hint.basis': '高峰按 UTC {windows} 判定；工作日与节假日按 UTC/北京日期判定。',
      'hint.holidaysAuto': '节假日日历：自动获取 {count} 天。',
      'hint.holidaysManual': '节假日日历：本地配置 {count} 天。',
      'pill.ariaWarning': '（数据可能陈旧或降级）',
      'status.staleBadge': '陈旧',
      'status.degradedBadge': '降级',
      'time.unknown': '未知',
      'hint.ratesFrozen': '本会话最早的一段费率生效于 {time}。',
      'hint.ratesFrozenNever': '本会话最初使用本地后备费率（当时尚未读取官方价目表）。',
      'hint.ratesLive': '当前最新费率读取于 {time}。',
      'hint.ratesNever': '当前尚未成功读取官方费率。',
      'hint.ratesDegraded': '费率抓取异常：{reason}；仍使用 {time} 的费率。',
      'hint.ratesStale': '费率数据已陈旧（最近成功读取 {time}）。',
      'hint.holidaysProvenance': '节假日日历：自动 {auto} 天 · 手动 {manual} 天。',
      'hint.holidaysProvenanceLegacy': '历史节假日日历：自动 {auto} 天 · 手动 {manual} 天 · 旧版估算 {fixed} 天。',
      'hint.holidaysFailed': '节假日获取失败：{reason}；下次重试 {time}。',
      'hint.holidaysFailedNoRetry': '节假日获取失败：{reason}。',
      'hint.holidaysStale': '节假日日历已陈旧（最近成功获取 {time}）。',
    }

    const en = {
      'currency.code': 'USD',
      'pill.aria': 'This session costs {cost}; current band: {band}',
      'pill.ariaSubagents': 'This session plus its {count} sub-agent(s) costs {cost}; current band: {band}',
      'band.peak': 'Peak',
      'band.offPeak': 'Off-peak',
      'band.current': 'Current band: {band}',
      'section.band': 'Tariff',
      'label.currentBand': 'Current band',
      'label.peakWindows': 'Peak windows',
      'label.ruleBasis': 'Rule basis',
      'window.local': '{windows} ({zone})',
      'window.utc': 'UTC {windows}',
      'band.until': 'switches in {duration}',
      'band.untilAt': 'switches in {duration} ({time})',
      'band.untilMinutes': '{minutes} min',
      'band.untilHours': '{hours} h',
      'band.untilHoursMinutes': '{hours} h {minutes} min',
      'band.untilDays': '{days} d',
      'band.untilDaysHours': '{days} d {hours} h',
      'dialog.title': 'Token cost',
      'total': 'Total',
      'total.withSubagents': 'With sub-agents',
      'subtree.value': '{cost} (own {own} + {count} sub-agent(s) {children})',
      'subtree.valueUnknown': '{cost} (own {own} + {count} sub-agent(s) {children}; {unknown} sub-session(s) have no amount yet)',
      'subtree.none': 'This session delegated to no sub-agents.',
      'peakCost': 'Peak spend',
      'offPeakCost': 'Off-peak spend',
      'band.spend': '{cost} · {tokens} tokens',
      'saved': 'Saved off-peak',
      'calls': 'Billed requests',
      'callsValue': '{count}',
      'callsSplit': '{peak} peak · {offPeak} off-peak',
      'section.tokens': 'Billed tokens',
      'token.input': 'Uncached input',
      'token.cacheRead': 'Cache read',
      'token.cacheWrite': 'Cache write',
      'token.output': 'Output',
      'token.value': '{tokens} · {cost}',
      'section.models': 'By model',
      'model.value': '{cost} · {count} requests',
      'model.split': 'Peak {peak} · Off-peak {offPeak}',
      'note.estimated': '{count} request(s) used the fallback rate card.',
      'note.unpriced': '{count} request(s) matched no rate and are excluded.',
      'note.excluded': '{count} request(s) came from services this meter does not price ({providers}) and are not in the amount.',
      'note.reasoning': 'Reasoning tokens are billed inside output tokens.',
      'pricing.official': 'Rates: official price page',
      'pricing.config': 'Rates: local fallback card',
      'pricing.updated': 'read {time}',
      'pricing.newSessions': 'Each request is priced by the rate in force when it ran; a price change only affects requests after it.',
      'pricing.timeline': 'Rate timeline: {count} segments',
      'pricing.timelineRow': 'from {from} · uncached {symbol}{input}/M · cache read {symbol}{cacheRead}/M · output {symbol}{output}/M',
      'pricing.timelineRowOpen': 'from {from} (current) · uncached {symbol}{input}/M · cache read {symbol}{cacheRead}/M · output {symbol}{output}/M',
      'pricing.excludedRoutes': 'Not priced: {providers}',
      'model.excluded': '{count} not priced',
      'model.epochs': '{count} rate segments',
      'pricing.holidaysMissing': 'No known holidays for this year; weekend and time-window rules apply. Holidays are not estimated.',
      'pricing.configLate': ' (the official price page has not been read yet, so the local fallback card is in use)',
      'pricing.holidaysMissingLate': 'No known holidays for this year; weekend and time-window rules apply until a successful refresh. Holidays are not estimated.',
      'hint.show': 'Pricing and rate details',
      'hint.basis': 'Peak uses UTC {windows}; weekday and holiday rules follow UTC/Beijing dates.',
      'hint.holidaysAuto': 'Holiday calendar: {count} days fetched automatically.',
      'hint.holidaysManual': 'Holiday calendar: {count} days configured locally.',
      'pill.ariaWarning': ' (data may be stale or degraded)',
      'status.staleBadge': 'stale',
      'status.degradedBadge': 'degraded',
      'time.unknown': 'unknown',
      'hint.ratesFrozen': 'This session\'s earliest rate segment took effect at {time}.',
      'hint.ratesFrozenNever': 'This session started on the local fallback card (the official price page had not been read yet).',
      'hint.ratesLive': 'The latest rates were read at {time}.',
      'hint.ratesNever': 'The official rates have not been fetched successfully yet.',
      'hint.ratesDegraded': 'Rate refresh failed: {reason}; still using the rates from {time}.',
      'hint.ratesStale': 'Rate data is stale (last successful read {time}).',
      'hint.holidaysProvenance': 'Holiday calendar: {auto} auto · {manual} manual (days).',
      'hint.holidaysProvenanceLegacy': 'Historical holiday calendar: {auto} auto · {manual} manual · {fixed} legacy estimates (days).',
      'hint.holidaysFailed': 'Holiday fetch failed: {reason}; retrying at {time}.',
      'hint.holidaysFailedNoRetry': 'Holiday fetch failed: {reason}.',
      'hint.holidaysStale': 'Holiday calendar is stale (last successful fetch {time}).',
    }

    // Geometry, colors, type, and elevation copied from the shipped
    // ui-chat `StatsPills.module.css` and `stat-dialog.module.css`.
    const css = `
.dsh-tc-anchor{min-width:0;display:inline-flex;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.dsh-tc-pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;max-width:100%;margin:0;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}
.dsh-tc-pill:hover,.dsh-tc-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-tc-pill svg{flex:none;width:14px;height:14px}
.dsh-tc-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsh-tc-sep{color:var(--dsw-alias-separator-primary,var(--dsw-alias-border-l1));margin:0 6px}
.dsh-tc-band{display:inline-flex;align-items:center;gap:4px}
.dsh-tc-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.dsh-tc-peak{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}
.dsh-tc-offPeak{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.dsh-tc-panel{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;padding:16px;border:0;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.18));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:default;outline:none}
.dsh-tc-title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}
.dsh-tc-titleLabel{display:inline-flex;align-items:center;gap:6px;min-width:0}
.dsh-tc-titleLabel svg{flex:none;width:14px;height:14px}
.dsh-tc-titleMain{display:flex;align-items:center;gap:2px;min-width:0}
.dsh-tc-hintButton{position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin:0;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-tc-hintButton:hover,.dsh-tc-hintButton[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-tc-hintButton svg{width:14px;height:14px}
.dsh-tc-hintWarn{position:absolute;top:1px;right:1px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-tertiary))}
.dsh-tc-hint{display:flex;flex-direction:column;gap:4px;padding:2px 0 8px;margin-bottom:2px;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.dsh-tc-hint p{margin:0}
.dsh-tc-pillWarn{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-tertiary))}
.dsh-tc-badge{display:inline-flex;align-items:center;margin-right:6px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary));font-size:11px;font-weight:500;line-height:16px}
.dsh-tc-titleValue{font-variant-numeric:tabular-nums}
.dsh-tc-titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
.dsh-tc-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary)}
.dsh-tc-details dt,.dsh-tc-details dd{min-width:0;margin:0}
.dsh-tc-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
.dsh-tc-section{grid-column:1/-1;margin-top:6px;color:var(--dsw-alias-label-tertiary)}
.dsh-tc-model{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 16px}
.dsh-tc-modelName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tc-modelMeta{grid-column:1/-1;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-tc-modelExcluded .dsh-tc-modelName,.dsh-tc-modelExcluded span{color:var(--dsw-alias-label-tertiary);opacity:.75}
.dsh-tc-note{margin:10px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
`

    /** A coin glyph with a small peak/off-peak accent. */
    function CostIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', {
          d: 'M5.6 4.9 8 7.6l2.4-2.7M8 7.6v4M5.9 8.6h4.2M5.9 10.4h4.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** A small information glyph for the explanation toggle. */
    function HintIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M8 7.2v4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 8, cy: 4.9, r: 0.9, fill: 'currentColor' }),
      )
    }

    /** Re-render on a slow tick so the band badge crosses a boundary. */
    function useNow(intervalMs) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
        return () => window.clearInterval(timer)
      }, [intervalMs])
      return now
    }

    // -----------------------------------------------------------------------
    // Tariff policy — the canonical rules (peak windows, Beijing holidays) live
    // in `shared/tariff` and are inlined below by `tools/sync-shared.mjs`.
    // Never restate them in this file.
    // -----------------------------------------------------------------------

    // >>> token-cost:tariff-helpers
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

    /** Band policy for a frozen pricing snapshot. */
    function bandPolicy(pricing) {
      return {
        peakWindows: Array.isArray(pricing.peakWindows) ? pricing.peakWindows : [],
        weekdaysOnly: pricing.weekdaysOnly,
        offPeakEnabled: pricing.offPeakEnabled,
        holidayOffsetMinutes:
          typeof pricing.holidayOffsetMinutes === 'number' ? pricing.holidayOffsetMinutes : Tariff.HOLIDAY_OFFSET_MINUTES,
        holidays: Array.isArray(pricing.holidays) ? pricing.holidays : [],
      }
    }

    /**
     * The band at one moment under the frozen policy (canonical rule, mirroring
     * the Host exactly: catalog UTC peak windows, weekdays-only, Beijing holidays).
     */
    function bandAt(pricing, timeMs) {
      if (pricing === undefined || pricing === null) return 'peak'
      return Tariff.bandAt(timeMs, bandPolicy(pricing))
    }

    /** Minutes until the current band changes (canonical bounded scan). */
    function minutesUntilSwitch(pricing, now) {
      if (pricing === undefined || pricing === null || pricing.offPeakEnabled === false) return null
      const switchAt = Tariff.nextBandSwitch(now, bandPolicy(pricing), 10)
      return switchAt === 0 ? null : Math.round((switchAt - now) / Tariff.MINUTE_MS)
    }
    // <<< token-cost:tariff-helpers

    /** `HH:MM` for a minute-of-day value. */
    function clockOf(minutes) {
      const hour = Math.floor(minutes / 60) % 24
      const minute = minutes % 60
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    }

    /** `HH:MM` of an instant in the system time zone. */
    function clockAt(timeMs) {
      const date = new Date(timeMs)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    /** `01:00–04:00 / 06:00–10:00` for the frozen peak windows (UTC). */
    function windowsText(pricing) {
      const windows = Array.isArray(pricing?.peakWindows) ? pricing.peakWindows : []
      return windows.map((window) => `${clockOf(window[0])}–${clockOf(window[1])}`).join(' / ')
    }

    /** The browser's system time zone name, for labelling local times. */
    function systemTimeZone() {
      try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
        return typeof zone === 'string' && zone.length > 0 ? zone : 'local'
      } catch {
        return 'local'
      }
    }

    /**
     * The frozen UTC peak windows rendered in the browser's system time zone.
     * The offset is taken at `now`, so a display across a DST change can shift
     * by an hour; the UTC reference note in the dialog stays authoritative.
     */
    function localWindowsText(pricing, now) {
      const windows = Array.isArray(pricing?.peakWindows) ? pricing.peakWindows : []
      const offset = -new Date(now).getTimezoneOffset()
      return windows
        .map((window) => `${clockOf((((window[0] + offset) % 1440) + 1440) % 1440)}–${clockOf((((window[1] + offset) % 1440) + 1440) % 1440)}`)
        .join(' / ')
    }

    /** Total billed tokens in one bucket set (reasoning is inside output). */
    function tokenTotal(tokens) {
      if (tokens === undefined || tokens === null) return 0
      return (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) + (tokens.output ?? 0)
    }

    /** Compact token counts (1.2k, 3.4M). */
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
      if (value < 1_000) return String(Math.round(value))
      if (value < 1_000_000) {
        const thousands = value / 1_000
        return `${thousands >= 100 ? Math.round(thousands) : thousands >= 10 ? thousands.toFixed(1) : thousands.toFixed(2)}k`
      }
      const millions = value / 1_000_000
      return `${millions >= 100 ? Math.round(millions) : millions >= 10 ? millions.toFixed(1) : millions.toFixed(2)}M`
    }

    /**
     * The currency this render should show, and its symbol.
     *
     * The choice follows the interface language: a Chinese UI shows the CNY
     * amount, an English UI the USD amount. Both come from the same published
     * price page pair, so neither is a conversion of the other. When the Host
     * could not fetch the other copy, the view only has one amount and that one
     * is shown under its own symbol — never relabelled as the missing currency.
     */
    function displayCurrency(view, t) {
      const available = Array.isArray(view?.currencies) && view.currencies.length > 0 ? view.currencies : [view?.currency]
      // An explicit `currency` in the row config pins the display regardless of
      // language; the Host advertises it as `pinnedCurrency`.
      const pinned = view?.pinnedCurrency
      if (typeof pinned === 'string' && available.includes(pinned)) return pinned
      const wanted = t('currency.code')
      if (typeof wanted === 'string' && available.includes(wanted)) return wanted
      return typeof view?.currency === 'string' && view.currency.length > 0 ? view.currency : 'CNY'
    }

    /** Symbol for a currency code (the Host's own symbol is the fallback). */
    function symbolOf(code, view) {
      if (code === 'CNY') return '¥'
      if (code === 'USD') return '$'
      return typeof view?.symbol === 'string' && view.symbol.length > 0 ? view.symbol : ''
    }

    /**
     * The amount to show for one money field, in the display currency.
     *
     * `view.amounts` carries one integer per currency the Session's epochs
     * published; the per-field helpers fall back to the primary `micros` when
     * that currency's table was never fetched.
     */
    function microsIn(view, currency, field) {
      if (field === 'micros' && view?.amounts !== null && typeof view?.amounts === 'object') {
        const value = view.amounts[currency]
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return typeof view?.[field] === 'number' ? view[field] : 0
    }

    /**
     * The per-bucket rows in the display currency.
     *
     * The Host sends one bucket set per published currency; a bucket set for a
     * currency the table never had falls back to the primary one.
     */
    function bucketsIn(view, currency) {
      const alternate = view?.bucketMicrosByCurrency
      const primary = view?.bucketMicros ?? {}
      if (currency !== view?.currency && alternate !== null && typeof alternate === 'object' && alternate[currency] !== null && typeof alternate[currency] === 'object') {
        return alternate[currency]
      }
      return primary
    }

    /** Adaptive currency text from integer micro-currency. */
    function formatMoney(micros, symbol) {
      const value = (typeof micros === 'number' && Number.isFinite(micros) ? micros : 0) / 1_000_000
      if (value <= 0) return `${symbol}0.00`
      if (value < 0.01) return `${symbol}${value.toFixed(4)}`
      if (value < 1) return `${symbol}${value.toFixed(3)}`
      if (value < 100) return `${symbol}${value.toFixed(2)}`
      return `${symbol}${value.toFixed(0)}`
    }

    /** Localized duration for the next tariff switch. */
    function formatDuration(minutes, t) {
      if (minutes === null) return null
      if (minutes < 60) return t('band.untilMinutes', { minutes })
      if (minutes < 1440) {
        const hours = Math.floor(minutes / 60)
        const rest = minutes % 60
        return rest === 0 ? t('band.untilHours', { hours }) : t('band.untilHoursMinutes', { hours, minutes: rest })
      }
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      return hours === 0 ? t('band.untilDays', { days }) : t('band.untilDaysHours', { days, hours })
    }

    /** Short source text: an official URL or the local fallback. */
    function sourceText(pricing) {
      const source = pricing?.source
      if (typeof source === 'string' && source.length > 0 && source !== 'config') return 'official'
      return 'config'
    }

    /**
     * Whether the live Host status says the displayed data may be stale or
     * degraded. `view.status` is live, not frozen, so it is absent when the Host
     * half runs without a web service.
     */
    function dataWarningOf(status) {
      if (status === null || status === undefined || typeof status !== 'object') return null
      const pricing = status.pricing ?? {}
      const holidays = status.holidays ?? {}
      if (pricing.degraded === true) return 'pricing'
      if (pricing.stale === true) return 'pricing'
      if (typeof holidays.error === 'string' && holidays.error.length > 0) return 'holidays'
      if (holidays.stale === true) return 'holidays'
      return null
    }

    /** The badge locale key for the current warning, or `null` when healthy. */
    function statusBadgeKeyOf(status) {
      if (status === null || status === undefined || typeof status !== 'object') return null
      const pricing = status.pricing ?? {}
      const holidays = status.holidays ?? {}
      const holidayFailed = typeof holidays.error === 'string' && holidays.error.length > 0
      if (pricing.degraded === true || holidayFailed) return 'status.degradedBadge'
      if (pricing.stale === true || holidays.stale === true) return 'status.staleBadge'
      return null
    }

    /** A localized timestamp for the hint lines, `unknown` when never fetched. */
    function hintTimeText(timeMs, t) {
      return typeof timeMs === 'number' && Number.isFinite(timeMs) && timeMs > 0 ? new Date(timeMs).toLocaleString() : t('time.unknown')
    }

    /**
     * Holiday counts per provenance source. Older Host snapshots only carry the
     * flat calendar plus a `holidaysSource` label, so fall back to that.
     */
    function holidayProvenanceOf(pricing) {
      const provenance = pricing?.holidayProvenance
      if (provenance !== null && provenance !== undefined && typeof provenance === 'object') {
        const count = (value) => (Array.isArray(value) ? value.length : 0)
        return { auto: count(provenance.auto), manual: count(provenance.manual), fixed: count(provenance.fixed), known: true }
      }
      const holidays = Array.isArray(pricing?.holidays) ? pricing.holidays.length : 0
      return {
        auto: pricing?.holidaysSource === 'auto' ? holidays : 0,
        manual: pricing?.holidaysSource === 'auto' ? 0 : holidays,
        fixed: 0,
        known: false,
      }
    }

    /** One definition row. */
    function Row({ label, value }) {
      return h(React.Fragment, null, h('dt', null, label), h('dd', null, value))
    }

    /** One token bucket row: tokens and its share of the session cost. */
    function TokenRow({ label, tokens, micros, symbol, t }) {
      if (!tokens) return null
      const value = micros > 0 ? t('token.value', { tokens: formatTokens(tokens), cost: formatMoney(micros, symbol) }) : formatTokens(tokens)
      return h(Row, { label, value })
    }

    /** The expandable breakdown; portaled like the shipped session-statistics dialog. */
    function CostDialog({ view, band, now, t, pos, panelRef, onClose }) {
      const [hintOpen, setHintOpen] = React.useState(false)
      const pricing = view.pricing ?? {}
      const bandLabel = t(band === 'offPeak' ? 'band.offPeak' : 'band.peak')
      const switchMinutes = minutesUntilSwitch(pricing, now)
      const duration = formatDuration(switchMinutes, t)
      const switchAt = switchMinutes === null ? null : clockAt(now + switchMinutes * 60_000)
      const untilText = duration === null ? null : switchAt === null ? t('band.until', { duration }) : t('band.untilAt', { duration, time: switchAt })
      // The displayed currency follows the interface language, and every amount
      // below is read from that currency's own published table.
      const currency = displayCurrency(view, t)
      const symbol = symbolOf(currency, view)
      const money = (field) => formatMoney(microsIn(view, currency, field), symbol)
      // The per-bucket rows follow the same currency as the totals.
      const buckets = bucketsIn(view, currency)
      const modelRows = Array.isArray(view.models) ? view.models : []
      // A task that ran through sub-agents costs far more than this Session's
      // own requests, so the headline is the whole tree; the breakdown keeps the
      // own/children split visible.
      const subtree = view.subtree ?? null
      // The tree's own share in the display currency: `amounts[currency]` is the
      // tree total, and the own part is this Session's own amount in that same
      // currency, so the two rows stay additive.
      const ownMicros = microsIn(view, currency, 'micros')
      const childCount = typeof subtree?.childCount === 'number' ? subtree.childCount : 0
      const unknownChildren = typeof subtree?.unknownCount === 'number' ? subtree.unknownCount : 0
      const subtreeMoney = (field) => {
        const alternate = subtree?.amounts
        const total =
          alternate !== null && typeof alternate === 'object' && typeof alternate[currency] === 'number'
            ? alternate[currency]
            : typeof subtree?.micros === 'number'
              ? subtree.micros
              : 0
        if (field === 'micros') return formatMoney(total, symbol)
        if (field === 'ownMicros') return formatMoney(ownMicros, symbol)
        return formatMoney(Math.max(0, total - ownMicros), symbol)
      }
      const subtreeText =
        subtree === null || childCount === 0
          ? null
          : unknownChildren > 0
            ? t('subtree.valueUnknown', {
                cost: subtreeMoney('micros'),
                own: subtreeMoney('ownMicros'),
                count: childCount,
                children: subtreeMoney('childrenMicros'),
                unknown: unknownChildren,
              })
            : t('subtree.value', {
                cost: subtreeMoney('micros'),
                own: subtreeMoney('ownMicros'),
                count: childCount,
                children: subtreeMoney('childrenMicros'),
              })
      const localWindows = localWindowsText(pricing, now)
      const utcWindows = windowsText(pricing)
      const official = sourceText(pricing) === 'official'
      const updated = typeof pricing.fetchedAt === 'number' && pricing.fetchedAt > 0 ? t('pricing.updated', { time: new Date(pricing.fetchedAt).toLocaleString() }) : null
      const holidayCount = Array.isArray(pricing.holidays) ? pricing.holidays.length : 0
      const autoPricing = pricing.autoRefresh?.pricing === true
      const autoHolidays = pricing.autoRefresh?.holidays === true
      const showHolidayWarning = pricing.weekdaysOnly !== false && holidayCount === 0
      const provenance = holidayProvenanceOf(pricing)
      const holidayLine = showHolidayWarning
        ? autoHolidays
          ? t('pricing.holidaysMissingLate')
          : t('pricing.holidaysMissing')
        : provenance.known
          ? t(provenance.fixed > 0 ? 'hint.holidaysProvenanceLegacy' : 'hint.holidaysProvenance', { auto: provenance.auto, manual: provenance.manual, fixed: provenance.fixed })
          : pricing.holidaysSource === 'auto'
            ? t('hint.holidaysAuto', { count: holidayCount })
            : t('hint.holidaysManual', { count: holidayCount })

      // Live data-trust lines: the rate timeline says what *this* session is
      // priced with, `view.status` says how current the Host's data is.
      const status = view.status ?? null
      const badgeKey = statusBadgeKeyOf(status)
      const statusLines = []
      const timeline = Array.isArray(pricing.epochs) ? pricing.epochs : []
      const excludedProviders = [...new Set(modelRows.filter((entry) => entry.excludedCalls > 0).map((entry) => entry.provider))]
      // The rate timeline as human lines: one per epoch, oldest first, showing
      // the rates that segment actually charged (the first model it priced).
      const timelineRows = timeline.map((epoch, index) => {
        const rates = epoch.rates ?? {}
        const first = Object.keys(rates)[0]
        const rate = first === undefined ? null : rates[first]
        const open = index === timeline.length - 1
        const params = {
          from: hintTimeText(epoch.effectiveFrom, t),
          symbol,
          input: rate === null ? '?' : String(rate.input),
          cacheRead: rate === null ? '?' : String(rate.cacheRead),
          output: rate === null ? '?' : String(rate.output),
        }
        return t(open ? 'pricing.timelineRowOpen' : 'pricing.timelineRow', params)
      })
      if (status !== null && status !== undefined) {
        const livePricing = status.pricing ?? {}
        const liveHolidays = status.holidays ?? {}
        // (a) the rate segment this session started on vs the live one.
        statusLines.push(
          timeline.length > 0 && typeof timeline[0].effectiveFrom === 'number' && timeline[0].effectiveFrom > 0
            ? t('hint.ratesFrozen', { time: hintTimeText(timeline[0].effectiveFrom, t) })
            : typeof pricing.fetchedAt === 'number' && pricing.fetchedAt > 0
              ? t('hint.ratesFrozen', { time: hintTimeText(pricing.fetchedAt, t) })
              : t('hint.ratesFrozenNever'),
        )
        if (livePricing.degraded === true) {
          statusLines.push(t('hint.ratesDegraded', { reason: String(livePricing.degradedReason ?? t('time.unknown')), time: hintTimeText(livePricing.fetchedAt, t) }))
        } else if (livePricing.stale === true) {
          statusLines.push(t('hint.ratesStale', { time: hintTimeText(livePricing.fetchedAt, t) }))
        } else if (typeof livePricing.fetchedAt === 'number' && livePricing.fetchedAt > 0) {
          statusLines.push(t('hint.ratesLive', { time: hintTimeText(livePricing.fetchedAt, t) }))
        } else {
          statusLines.push(t('hint.ratesNever'))
        }
        // (b) holiday refresh state, including the failure and retry time.
        const holidayError = typeof liveHolidays.error === 'string' && liveHolidays.error.length > 0 ? liveHolidays.error : null
        if (holidayError !== null) {
          const retryAt = typeof liveHolidays.nextRetryAt === 'number' && liveHolidays.nextRetryAt > 0 ? liveHolidays.nextRetryAt : null
          statusLines.push(
            retryAt === null
              ? t('hint.holidaysFailedNoRetry', { reason: holidayError })
              : t('hint.holidaysFailed', { reason: holidayError, time: hintTimeText(retryAt, t) }),
          )
        } else if (liveHolidays.stale === true) {
          statusLines.push(t('hint.holidaysStale', { time: hintTimeText(liveHolidays.fetchedAt, t) }))
        }
      }
      return h(
        'div',
        {
          ref: panelRef,
          className: 'dsh-tc-panel',
          role: 'dialog',
          'aria-label': t('dialog.title'),
          style: pos ?? MEASURE_STYLE,
          onKeyDown: (event) => {
            if (event.key === 'Escape') onClose()
          },
        },
        h(
          'div',
          { className: 'dsh-tc-title' },
          h(
            'span',
            { className: 'dsh-tc-titleMain' },
            h('span', { className: 'dsh-tc-titleLabel' }, h(CostIcon), t('dialog.title')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-tc-hintButton',
                'aria-label': t('hint.show'),
                'aria-expanded': hintOpen,
                title: t('hint.show'),
                onClick: () => setHintOpen((value) => !value),
              },
              h(HintIcon),
              showHolidayWarning ? h('span', { className: 'dsh-tc-hintWarn', 'aria-hidden': true }) : null,
            ),
          ),
          h('span', { className: 'dsh-tc-titleValue' }, subtree === null || childCount === 0 ? money('micros') : subtreeMoney('micros')),
        ),
        h('div', { className: 'dsh-tc-titleRule', 'aria-hidden': true }),
        hintOpen
          ? h(
              'div',
              { className: 'dsh-tc-hint' },
              badgeKey === null
                ? null
                : h('p', { className: 'dsh-tc-hintStatus' }, h('span', { className: 'dsh-tc-badge dsh-tc-badgeWarn' }, t(badgeKey))),
              h('p', null, `${t(official ? 'pricing.official' : 'pricing.config')}${updated === null ? '' : ` · ${updated}`}${!official && autoPricing ? t('pricing.configLate') : ''}`),
              ...statusLines.map((line, index) => h('p', { key: `status-${index}` }, line)),
              h('p', null, t('hint.basis', { windows: utcWindows })),
              timeline.length > 0 ? h('p', null, t('pricing.timeline', { count: timeline.length })) : null,
              ...timelineRows.map((row, index) => h('p', { key: `timeline-${index}` }, row)),
              excludedProviders.length > 0 ? h('p', null, t('pricing.excludedRoutes', { providers: excludedProviders.join(', ') })) : null,
              h('p', null, holidayLine),
              h('p', null, t('pricing.newSessions')),
              pricing.reasoningBilling === 'included' ? h('p', null, t('note.reasoning')) : null,
            )
          : null,
        h(
          'dl',
          { className: 'dsh-tc-details' },
          h(Row, { label: t('total'), value: money('micros') }),
          subtreeText === null ? null : h(Row, { label: t('total.withSubagents'), value: subtreeText }),
          h(Row, {
            label: t('peakCost'),
            value: t('band.spend', { cost: money('peakMicros'), tokens: formatTokens(tokenTotal(view.peak.tokens)) }),
          }),
          h(Row, {
            label: t('offPeakCost'),
            value: t('band.spend', { cost: money('offPeakMicros'), tokens: formatTokens(tokenTotal(view.offPeak.tokens)) }),
          }),
          view.savedMicros > 0 ? h(Row, { label: t('saved'), value: money('savedMicros') }) : null,
          h(Row, {
            label: t('calls'),
            value: `${t('callsValue', { count: view.calls })} · ${t('callsSplit', { peak: view.peak.calls, offPeak: view.offPeak.calls })}`,
          }),
          h('dt', { className: 'dsh-tc-section' }, t('section.tokens')),
          h(TokenRow, { label: t('token.input'), tokens: view.tokens.input, micros: buckets.input, symbol, t }),
          h(TokenRow, { label: t('token.cacheRead'), tokens: view.tokens.cacheRead, micros: buckets.cacheRead, symbol, t }),
          h(TokenRow, { label: t('token.cacheWrite'), tokens: view.tokens.cacheWrite, micros: buckets.cacheWrite, symbol, t }),
          h(TokenRow, { label: t('token.output'), tokens: view.tokens.output, micros: buckets.output, symbol, t }),
          h('dt', { className: 'dsh-tc-section' }, t('section.band')),
          h(Row, { label: t('label.currentBand'), value: `${bandLabel}${untilText === null ? '' : ` · ${untilText}`}` }),
          localWindows.length > 0 ? h(Row, { label: t('label.peakWindows'), value: t('window.local', { windows: localWindows, zone: systemTimeZone() }) }) : null,
          utcWindows.length > 0 ? h(Row, { label: t('label.ruleBasis'), value: t('window.utc', { windows: utcWindows }) }) : null,
          modelRows.length > 0 ? h('dt', { className: 'dsh-tc-section' }, t('section.models')) : null,
          ...modelRows.map((entry) => {
            const excluded = entry.excludedCalls > 0
            const segments = Array.isArray(entry.epochs) ? entry.epochs.length : 0
            // The model row is priced in its own currency; when it differs from
            // the display one, take this currency's slice of that row.
            const slice = currency === view.currency ? entry : entry.byCurrency?.[currency] ?? null
            const modelMicros = slice === null ? entry.micros : slice.micros
            const modelPeak = slice === null ? entry.peak.micros : slice.peakMicros
            const modelOffPeak = slice === null ? entry.offPeak.micros : slice.offPeakMicros
            const meta = excluded
              ? t('model.excluded', { count: entry.excludedCalls })
              : `${t('model.split', { peak: formatMoney(modelPeak, symbol), offPeak: formatMoney(modelOffPeak, symbol) })}${
                  segments > 1 ? ` · ${t('model.epochs', { count: segments })}` : ''
                }`
            return h(
              'div',
              { className: excluded ? 'dsh-tc-model dsh-tc-modelExcluded' : 'dsh-tc-model', key: `${entry.provider}/${entry.model}` },
              h('span', { className: 'dsh-tc-modelName', title: `${entry.provider}/${entry.model}` }, entry.model),
              h('span', null, t('model.value', { cost: excluded ? '—' : formatMoney(modelMicros, symbol), count: entry.calls })),
              h('span', { className: 'dsh-tc-modelMeta' }, meta),
            )
          }),
        ),
        view.estimatedCalls > 0 ? h('p', { className: 'dsh-tc-note' }, t('note.estimated', { count: view.estimatedCalls })) : null,
        view.unpricedCalls > 0 ? h('p', { className: 'dsh-tc-note' }, t('note.unpriced', { count: view.unpricedCalls })) : null,
        excludedProviders.length > 0
          ? h('p', { className: 'dsh-tc-note' }, t('note.excluded', { count: view.excludedCalls ?? 0, providers: excludedProviders.join(', ') }))
          : null,
      )
    }

    /**
     * The composer-dock cell: a pill with the session total and the live band,
     * plus its trigger-anchored breakdown dialog.
     */
    function CostPill(props) {
      const { useProjection, t } = props
      const view = useProjection('tokenCost')
      const now = useNow(30_000)
      const [open, setOpen] = React.useState(false)
      const [pos, setPos] = React.useState(null)
      const rootRef = React.useRef(null)
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) {
          setPos(null)
          return undefined
        }
        const measure = () => {
          const anchor = buttonRef.current
          const panel = panelRef.current
          if (anchor === null || panel === null) return
          const trigger = anchor.getBoundingClientRect()
          const rect = panel.getBoundingClientRect()
          const left = Math.min(
            Math.max(PANEL_MARGIN, trigger.left + trigger.width / 2 - rect.width / 2),
            window.innerWidth - rect.width - PANEL_MARGIN,
          )
          const above = trigger.top - PANEL_GAP
          if (above - rect.height >= PANEL_MARGIN) setPos({ left, bottom: window.innerHeight - above })
          else if (trigger.bottom + PANEL_GAP + rect.height <= window.innerHeight - PANEL_MARGIN) setPos({ left, top: trigger.bottom + PANEL_GAP })
          else setPos({ left, bottom: Math.max(PANEL_MARGIN, window.innerHeight - above) })
        }
        measure()
        window.addEventListener('resize', measure)
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
        if (observer !== null && panelRef.current !== null) observer.observe(panelRef.current)
        return () => {
          window.removeEventListener('resize', measure)
          if (observer !== null) observer.disconnect()
        }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onClick = (event) => {
          const target = event.target
          if (rootRef.current !== null && rootRef.current.contains(target)) return
          if (panelRef.current !== null && panelRef.current.contains(target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('click', onClick, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('click', onClick, true)
        }
      }, [open])

      if (view === undefined || view === null || view.calls === 0) return null

      const close = () => setOpen(false)
      const band = bandAt(view.pricing, now)
      const bandLabel = t(band === 'offPeak' ? 'band.offPeak' : 'band.peak')
      // The pill answers "what did this task cost", so it shows the whole tree
      // (own requests plus every delegated Session). The dialog keeps the split.
      // Its currency follows the interface language, like every other amount.
      const pillCurrency = displayCurrency(view, t)
      const pillSymbol = symbolOf(pillCurrency, view)
      const subtree = view.subtree ?? null
      const subtreeAmounts = subtree?.amounts
      const pillMicros =
        pillCurrency !== view.currency && subtreeAmounts !== null && typeof subtreeAmounts === 'object' && typeof subtreeAmounts[pillCurrency] === 'number'
          ? subtreeAmounts[pillCurrency]
          : typeof subtree?.micros === 'number'
            ? subtree.micros
            : microsIn(view, pillCurrency, 'micros')
      const childCount = typeof subtree?.childCount === 'number' ? subtree.childCount : 0
      const cost = formatMoney(pillMicros, pillSymbol)
      // A subtle amber dot makes a stale/degraded data source discoverable
      // without opening the dialog or reading logs.
      const warning = dataWarningOf(view.status ?? null)
      const warningSuffix = warning === null ? '' : t('pill.ariaWarning')
      const anchorElement = h(
        'span',
        { ref: rootRef, className: 'dsh-tc-anchor', 'data-composer-stat': 'cost' },
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: 'dsh-tc-pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': `${t(childCount > 0 ? 'pill.ariaSubagents' : 'pill.aria', { cost, band: bandLabel, count: childCount })}${warningSuffix}`,
            onClick: () => setOpen((value) => !value),
          },
          h(CostIcon),
          warning === null ? null : h('span', { className: 'dsh-tc-pillWarn', 'aria-hidden': true }),
          h('span', { className: 'dsh-tc-label' }, cost),
          h('span', { className: 'dsh-tc-sep', 'aria-hidden': true }, '·'),
          h('span', { className: band === 'offPeak' ? 'dsh-tc-band dsh-tc-offPeak' : 'dsh-tc-band dsh-tc-peak' }, h('span', { className: 'dsh-tc-dot', 'aria-hidden': true }), bandLabel),
        ),
      )
      if (!open) return anchorElement
      return h(
        React.Fragment,
        null,
        anchorElement,
        ReactDOM.createPortal(
          h(CostDialog, { view, band, now, t, pos, panelRef, onClose: close }),
          document.body,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'token-cost: dictionaries')
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const tag = document.createElement('style')
          tag.dataset.plugin = PLUGIN_ID
          tag.dataset.pluginCss = `${PLUGIN_ID}/token-cost.css`
          tag.textContent = css
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'token-cost: styles')
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'cost',
              order: 2,
              locale: NS,
            },
            CostPill,
          ),
        )
      },
    }
  },
})
