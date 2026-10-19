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
      'pill.aria': '本次会话 token 费用 {cost}，当前{band}时段',
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
      'note.reasoning': '推理 token 已包含在输出计费中。',
      'pricing.official': '费率来源：官方价目表',
      'pricing.config': '费率来源：本地后备费率',
      'pricing.updated': '读取于 {time}',
      'pricing.newSessions': '本会话费率在创建时冻结；新会话自动采用最新费率。',
      'pricing.holidaysMissing': '节假日日历：未配置，节假日将按高峰计费。',
      'pricing.configLate': '（本会话创建时尚未获取官方价目表；新会话将使用官方数据）',
      'pricing.holidaysMissingLate': '节假日日历：本会话创建时未获取（节假日按高峰计）；新会话会自动获取。',
      'hint.show': '计价与费率说明',
      'hint.basis': '高峰按 UTC {windows} 判定；工作日与节假日按 UTC/北京日期判定。',
      'hint.holidaysAuto': '节假日日历：自动获取 {count} 天。',
      'hint.holidaysManual': '节假日日历：本地配置 {count} 天。',
    }

    const en = {
      'pill.aria': 'This session costs {cost}; current band: {band}',
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
      'note.reasoning': 'Reasoning tokens are billed inside output tokens.',
      'pricing.official': 'Rates: official price page',
      'pricing.config': 'Rates: local fallback card',
      'pricing.updated': 'read {time}',
      'pricing.newSessions': 'This session froze its rates at creation; new sessions use the latest.',
      'pricing.holidaysMissing': 'Holiday calendar: not configured; holidays are charged as peak.',
      'pricing.configLate': ' (the official price page was not fetched yet when this session started; new sessions will use it)',
      'pricing.holidaysMissingLate': 'Holiday calendar: not fetched when this session started (holidays are charged as peak); new sessions fetch it automatically.',
      'hint.show': 'Pricing and rate details',
      'hint.basis': 'Peak uses UTC {windows}; weekday and holiday rules follow UTC/Beijing dates.',
      'hint.holidaysAuto': 'Holiday calendar: {count} days fetched automatically.',
      'hint.holidaysManual': 'Holiday calendar: {count} days configured locally.',
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
.dsh-tc-titleValue{font-variant-numeric:tabular-nums}
.dsh-tc-titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
.dsh-tc-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary)}
.dsh-tc-details dt,.dsh-tc-details dd{min-width:0;margin:0}
.dsh-tc-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
.dsh-tc-section{grid-column:1/-1;margin-top:6px;color:var(--dsw-alias-label-tertiary)}
.dsh-tc-model{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 16px}
.dsh-tc-modelName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tc-modelMeta{grid-column:1/-1;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
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

    /** Whether a UTC minute falls inside one window. */
    function inWindow(minute, window) {
      const [start, end] = window
      return start < end ? minute >= start && minute < end : minute >= start || minute < end
    }

    /** `YYYY-MM-DD` for a moment in a fixed offset (the holiday calendar's dates). */
    function dateKeyAt(timeMs, offsetMinutes) {
      return new Date(timeMs + offsetMinutes * 60_000).toISOString().slice(0, 10)
    }

    /**
     * The band at one moment under the frozen policy, mirroring the Host:
     * catalog UTC peak windows, weekdays-only, Chinese holidays in Beijing dates.
     */
    function bandAt(pricing, timeMs) {
      if (pricing === undefined || pricing === null || pricing.offPeakEnabled === false) return 'peak'
      const windows = Array.isArray(pricing.peakWindows) ? pricing.peakWindows : []
      if (windows.length === 0) return 'offPeak'
      if (pricing.weekdaysOnly !== false) {
        const weekday = new Date(timeMs).getUTCDay()
        if (weekday === 0 || weekday === 6) return 'offPeak'
      }
      const holidays = Array.isArray(pricing.holidays) ? pricing.holidays : []
      if (holidays.length > 0 && holidays.includes(dateKeyAt(timeMs, pricing.holidayOffsetMinutes ?? 480))) return 'offPeak'
      const minute = Math.floor(timeMs / 60_000) % 1440
      const normalized = (minute + 1440) % 1440
      return windows.some((window) => inWindow(normalized, window)) ? 'peak' : 'offPeak'
    }

    /** Minutes until the current band changes (scans at most one week). */
    function minutesUntilSwitch(pricing, now) {
      if (pricing === undefined || pricing === null || pricing.offPeakEnabled === false) return null
      const current = bandAt(pricing, now)
      for (let delta = 1; delta <= 7 * 1440; delta += 1) {
        if (bandAt(pricing, now + delta * 60_000) !== current) return delta
      }
      return null
    }

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
      const symbol = view.symbol
      const modelRows = Array.isArray(view.models) ? view.models : []
      const localWindows = localWindowsText(pricing, now)
      const utcWindows = windowsText(pricing)
      const official = sourceText(pricing) === 'official'
      const updated = typeof pricing.fetchedAt === 'number' ? t('pricing.updated', { time: new Date(pricing.fetchedAt).toLocaleString() }) : null
      const holidayCount = Array.isArray(pricing.holidays) ? pricing.holidays.length : 0
      const autoPricing = pricing.autoRefresh?.pricing === true
      const autoHolidays = pricing.autoRefresh?.holidays === true
      const showHolidayWarning = pricing.weekdaysOnly !== false && holidayCount === 0
      const holidayLine = showHolidayWarning
        ? autoHolidays
          ? t('pricing.holidaysMissingLate')
          : t('pricing.holidaysMissing')
        : pricing.holidaysSource === 'auto'
          ? t('hint.holidaysAuto', { count: holidayCount })
          : t('hint.holidaysManual', { count: holidayCount })
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
          h('span', { className: 'dsh-tc-titleValue' }, formatMoney(view.micros, symbol)),
        ),
        h('div', { className: 'dsh-tc-titleRule', 'aria-hidden': true }),
        hintOpen
          ? h(
              'div',
              { className: 'dsh-tc-hint' },
              h('p', null, `${t(official ? 'pricing.official' : 'pricing.config')}${updated === null ? '' : ` · ${updated}`}${!official && autoPricing ? t('pricing.configLate') : ''}`),
              h('p', null, t('hint.basis', { windows: utcWindows })),
              h('p', null, holidayLine),
              h('p', null, t('pricing.newSessions')),
              pricing.reasoningBilling === 'included' ? h('p', null, t('note.reasoning')) : null,
            )
          : null,
        h(
          'dl',
          { className: 'dsh-tc-details' },
          h(Row, { label: t('total'), value: formatMoney(view.micros, symbol) }),
          h(Row, {
            label: t('peakCost'),
            value: t('band.spend', { cost: formatMoney(view.peakMicros, symbol), tokens: formatTokens(tokenTotal(view.peak.tokens)) }),
          }),
          h(Row, {
            label: t('offPeakCost'),
            value: t('band.spend', { cost: formatMoney(view.offPeakMicros, symbol), tokens: formatTokens(tokenTotal(view.offPeak.tokens)) }),
          }),
          view.savedMicros > 0 ? h(Row, { label: t('saved'), value: formatMoney(view.savedMicros, symbol) }) : null,
          h(Row, {
            label: t('calls'),
            value: `${t('callsValue', { count: view.calls })} · ${t('callsSplit', { peak: view.peak.calls, offPeak: view.offPeak.calls })}`,
          }),
          h('dt', { className: 'dsh-tc-section' }, t('section.tokens')),
          h(TokenRow, { label: t('token.input'), tokens: view.tokens.input, micros: view.bucketMicros?.input ?? 0, symbol, t }),
          h(TokenRow, { label: t('token.cacheRead'), tokens: view.tokens.cacheRead, micros: view.bucketMicros?.cacheRead ?? 0, symbol, t }),
          h(TokenRow, { label: t('token.cacheWrite'), tokens: view.tokens.cacheWrite, micros: view.bucketMicros?.cacheWrite ?? 0, symbol, t }),
          h(TokenRow, { label: t('token.output'), tokens: view.tokens.output, micros: view.bucketMicros?.output ?? 0, symbol, t }),
          h('dt', { className: 'dsh-tc-section' }, t('section.band')),
          h(Row, { label: t('label.currentBand'), value: `${bandLabel}${untilText === null ? '' : ` · ${untilText}`}` }),
          localWindows.length > 0 ? h(Row, { label: t('label.peakWindows'), value: t('window.local', { windows: localWindows, zone: systemTimeZone() }) }) : null,
          utcWindows.length > 0 ? h(Row, { label: t('label.ruleBasis'), value: t('window.utc', { windows: utcWindows }) }) : null,
          modelRows.length > 0 ? h('dt', { className: 'dsh-tc-section' }, t('section.models')) : null,
          ...modelRows.map((entry) =>
            h(
              'div',
              { className: 'dsh-tc-model', key: `${entry.provider}/${entry.model}` },
              h('span', { className: 'dsh-tc-modelName', title: `${entry.provider}/${entry.model}` }, entry.model),
              h('span', null, t('model.value', { cost: formatMoney(entry.micros, symbol), count: entry.calls })),
              h('span', { className: 'dsh-tc-modelMeta' }, t('model.split', { peak: formatMoney(entry.peak.micros, symbol), offPeak: formatMoney(entry.offPeak.micros, symbol) })),
            ),
          ),
        ),
        view.estimatedCalls > 0 ? h('p', { className: 'dsh-tc-note' }, t('note.estimated', { count: view.estimatedCalls })) : null,
        view.unpricedCalls > 0 ? h('p', { className: 'dsh-tc-note' }, t('note.unpriced', { count: view.unpricedCalls })) : null,
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
      const cost = formatMoney(view.micros, view.symbol)
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
            'aria-label': t('pill.aria', { cost, band: bandLabel }),
            onClick: () => setOpen((value) => !value),
          },
          h(CostIcon),
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
