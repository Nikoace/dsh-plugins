/**
 * Host half of the token-cost plugin.
 *
 * Two layers:
 *
 * 1. **Pricing catalog** — the official DeepSeek pricing page
 *    (`https://api-docs.deepseek.com/quick_start/pricing`) is fetched on load
 *    and refreshed periodically. It supplies the per-model peak rates (cache
 *    hit / cache miss / output), the "off-peak is half of peak" multiplier,
 *    and the peak-hour windows (UTC, Monday–Friday, Chinese holidays excluded).
 *    The row config supplies fallbacks, display currency, and the holiday
 *    calendar.
 *
 * 2. **Per-session snapshot** — every new Session freezes the catalog version
 *    active at its creation time into its `tokenCost` projection state. A later
 *    rate change therefore prices **new conversations** under the new rules
 *    while existing conversations keep the card they started with, and a
 *    restored checkpoint stays self-describing. Requests are classified into
 *    peak/off-peak inside the fold, using the session's own frozen policy.
 *
 * The durable state keeps only billed facts (per-band, per-route token buckets
 * and counts) plus that frozen pricing snapshot. Money is computed in the wire
 * view: integer micro-currency in the display currency (`tokens * ratePerMillion`
 * is exactly micro-currency, scaled by `exchangeRate`).
 */

export const inject = ['sessionProjections']

/** Published machine-readable rate source. */
const OFFICIAL_PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing'

/** Official peak windows in UTC minutes: 01:00–04:00 and 06:00–10:00. */
const DEFAULT_PEAK_WINDOWS = [
  [60, 240],
  [360, 600],
]

/**
 * Official peak rates in USD per 1,000,000 tokens (the page lists the off-peak
 * half separately; the card stores peak values plus the multiplier).
 */
const DEFAULT_RATE_CARD = {
  'deepseek-flash': { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2, offPeakMultiplier: 0.5 },
  'deepseek-v4-pro': { input: 1.32, cacheRead: 0.044, cacheWrite: 1.32, output: 3.96, offPeakMultiplier: 0.5 },
  default: { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2, offPeakMultiplier: 0.5 },
}

const MIN_REFRESH_MS = 5 * 60_000
const MAX_REFRESH_MS = 24 * 60 * 60_000
const DEFAULT_REFRESH_MS = 6 * 60 * 60_000
const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const DEFAULT_HOLIDAY_SOURCE = 'https://timor.tech/api/holiday/year/{year}'
const DEFAULT_HOLIDAY_REFRESH_MS = 24 * 60 * 60_000
const MINUTES_PER_DAY = 24 * 60
const STATE_VERSION = 5

/** A schema face sufficient for the projection registry (it only calls `parse`). */
const passthroughSchema = { parse: (value) => value }

// ---------------------------------------------------------------------------
// Pricing page parsing
// ---------------------------------------------------------------------------

/**
 * Reduce an HTML document to one line of text for regex extraction.
 *
 * @param {string} content - response body.
 * @returns {string} tag-free, whitespace-collapsed text.
 */
function markupToText(content) {
  return content
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#36;/g, '$')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse `HH:MM` into minutes from midnight.
 *
 * @param {string} clock - `HH:MM` text.
 * @returns {number | null} minutes, or `null` when invalid.
 */
function clockToMinutes(clock) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/**
 * Parse the peak-hour windows from the page's prose.
 *
 * @param {string} text - tag-free page text.
 * @returns {number[][]} windows in UTC minutes; empty when the prose is absent.
 */
function parsePeakWindows(text) {
  const matches = [...text.matchAll(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g)]
  const windows = []
  for (const match of matches) {
    const start = clockToMinutes(match[1])
    const end = clockToMinutes(match[2])
    if (start === null || end === null || start === end) continue
    windows.push([start, end])
  }
  // The first pairs on the page are the peak windows; later times (if any)
  // belong to other prose. Two windows is the published shape.
  return windows.slice(0, 2)
}

/**
 * Parse the official pricing page into a rate card.
 *
 * The page renders a MODEL row followed by pricing rows:
 * `1M INPUT TOKENS (CACHE HIT) OFF-PEAK $a $b PEAK $c $d`, the same for
 * `(CACHE MISS)` and for `1M OUTPUT TOKENS`.
 *
 * @param {string} content - response body (HTML or text).
 * @returns {{ rates: Record<string, RateCard | null>, peakWindows: number[][], weekdaysOnly: boolean, currency: string, symbol: string, models: string[] } | null} parsed card, or `null` when the layout is unrecognized.
 */
function parsePricingPage(content) {
  if (typeof content !== 'string' || content.length === 0) return null
  const text = markupToText(content)

  const modelMatch = /MODEL\s+([A-Za-z0-9._-]+)\s*(?:\(\d+\))?\s+([A-Za-z0-9._-]+)\s+(?:BASE URL|MODEL VERSION)/.exec(text)
  if (modelMatch === null) return null
  const models = [modelMatch[1], modelMatch[2]]

  const rowPattern = (label) =>
    new RegExp(`${label}\\s+OFF-PEAK\\s*\\$?\\s*([\\d.]+)\\s*\\$?\\s*([\\d.]+)\\s*PEAK\\s*\\$?\\s*([\\d.]+)\\s*\\$?\\s*([\\d.]+)`, 'i')
  const hit = rowPattern('1M INPUT TOKENS\\s*\\(CACHE HIT\\)').exec(text)
  const miss = rowPattern('1M INPUT TOKENS\\s*\\(CACHE MISS\\)').exec(text)
  const output = rowPattern('1M OUTPUT TOKENS').exec(text)
  if (hit === null || miss === null || output === null) return null

  const toRates = (row, index) => {
    const offPeak = Number(row[index + 1])
    const peak = Number(row[index + 3])
    if (!Number.isFinite(offPeak) || !Number.isFinite(peak) || peak <= 0) return null
    return { offPeak, peak }
  }

  const rates = {}
  for (let index = 0; index < models.length; index += 1) {
    const hitPrice = toRates(hit, index)
    const missPrice = toRates(miss, index)
    const outputPrice = toRates(output, index)
    if (hitPrice === null || missPrice === null || outputPrice === null) return null
    const multiplier = Math.max(0, Math.min(10, hitPrice.offPeak / hitPrice.peak || 0.5))
    rates[models[index]] = {
      input: missPrice.peak,
      cacheRead: hitPrice.peak,
      cacheWrite: missPrice.peak,
      output: outputPrice.peak,
      offPeakMultiplier: multiplier,
    }
  }
  const primary = rates[models[0]]
  if (primary !== undefined && primary !== null) rates.default = { ...primary }

  const windows = parsePeakWindows(text)
  return {
    rates,
    peakWindows: windows.length > 0 ? windows : DEFAULT_PEAK_WINDOWS.map((window) => [...window]),
    weekdaysOnly: /Monday through Friday/i.test(text) || windows.length === 0,
    currency: /\$/.test(text) ? 'USD' : '',
    symbol: '$',
    models,
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Parse one public-holiday JSON payload into date keys.
 *
 * Accepted shapes, covering the common machine-readable sources:
 * - `["2026-10-01", ...]` or `{ dates: [...] }`;
 * - Nager.Date's `[{ date: "2026-10-01", ... }, ...]`;
 * - timor.tech's `{ holiday: { "10-01": { holiday: true, date: "2026-10-01" } } }`
 *   (entries with `holiday: false` are makeup workdays and are skipped).
 *
 * @param {unknown} payload - parsed JSON body.
 * @param {number} year - requested year; dates outside it are ignored.
 * @returns {string[]} sorted `YYYY-MM-DD` holiday keys.
 */
function parseHolidayPayload(payload, year) {
  const dates = []
  const push = (value) => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) dates.push(value)
  }
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (typeof entry === 'string') push(entry)
      else if (entry !== null && typeof entry === 'object') push(entry.date)
    }
  } else if (payload !== null && typeof payload === 'object') {
    if (Array.isArray(payload.dates)) {
      for (const entry of payload.dates) push(entry)
    } else if (payload.holiday !== null && typeof payload.holiday === 'object' && !Array.isArray(payload.holiday)) {
      for (const [key, entry] of Object.entries(payload.holiday)) {
        if (entry === null || typeof entry !== 'object' || entry.holiday !== true) continue
        if (typeof entry.date === 'string') push(entry.date)
        else if (/^\d{2}-\d{2}$/.test(key)) push(`${year}-${key}`)
      }
    }
  }
  const prefix = `${year}-`
  return [...new Set(dates)].filter((date) => date.startsWith(prefix)).sort()
}

/**
 * @param {unknown} value - candidate.
 * @param {number} fallback - default.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped number.
 */
function numberIn(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

/**
 * Backward-compatible conversion of a legacy single off-peak window into peak
 * windows, so an older row config keeps working.
 *
 * @param {number} start - off-peak start minute.
 * @param {number} end - off-peak end minute.
 * @returns {number[][]} complement as peak windows.
 */
function legacyPeakWindows(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return null
  const windows = []
  if (start < end) {
    if (start > 0) windows.push([0, start])
    if (end < MINUTES_PER_DAY) windows.push([end, MINUTES_PER_DAY])
  } else {
    windows.push([end, start])
  }
  return windows.length > 0 ? windows : null
}

/**
 * Validate and normalize configured peak windows.
 *
 * @param {unknown} value - `peakWindows` config value.
 * @returns {number[][] | null} windows, or `null` when absent/invalid.
 */
function normalizeWindows(value) {
  if (!Array.isArray(value) || value.length === 0) return null
  const windows = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null
    const [start, end] = entry
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null
    if (start < 0 || start >= MINUTES_PER_DAY || end < 0 || end > MINUTES_PER_DAY || start === end) return null
    windows.push([start, end])
  }
  return windows
}

/**
 * Validate configured holiday dates.
 *
 * @param {unknown} value - `holidays` config value.
 * @returns {string[]} sorted `YYYY-MM-DD` keys.
 */
function normalizeHolidays(value) {
  if (!Array.isArray(value)) return []
  const keys = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const match = /^\d{4}-\d{2}-\d{2}$/.exec(entry)
    if (match !== null) keys.push(entry)
  }
  return [...new Set(keys)].sort()
}

/**
 * Normalize one rate entry over a base.
 *
 * @param {object} value - user-provided fields.
 * @param {RateCard} base - fallback fields.
 * @returns {RateCard} complete rate card.
 */
function normalizeRate(value, base) {
  const pick = (name, fallback) => {
    const candidate = value[name]
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback
  }
  const input = pick('input', base.input)
  return {
    input,
    cacheRead: pick('cacheRead', base.cacheRead),
    cacheWrite: pick('cacheWrite', input),
    output: pick('output', base.output),
    offPeakMultiplier: Math.min(10, pick('offPeakMultiplier', base.offPeakMultiplier)),
  }
}

/**
 * Merge the configured fallback card over the built-in official one.
 *
 * @param {unknown} raw - the row's `rates` value.
 * @returns {Record<string, RateCard | null>} resolved rate card.
 */
function resolveRateCard(raw) {
  /** @type {Record<string, RateCard | null>} */
  const table = { ...DEFAULT_RATE_CARD }
  if (raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return table
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) {
      table[key] = null
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    table[key] = normalizeRate(value, table[key] ?? DEFAULT_RATE_CARD.default)
  }
  return table
}

/**
 * Resolve the effective plugin settings from the raw loader row config.
 *
 * @param {unknown} config - the row's `config` object.
 * @returns {PluginSettings} settings with defaults applied.
 */
function resolveSettings(config) {
  const c = typeof config === 'object' && config !== null && !Array.isArray(config) ? config : {}
  const stringField = (name) => (typeof c[name] === 'string' && c[name].length > 0 ? c[name] : '')
  const currency = stringField('currency')
  const symbol = stringField('symbol')
  const fallbackWindows =
    normalizeWindows(c.peakWindows) ??
    (Number.isInteger(c.offPeakStartMinute) ? legacyPeakWindows(c.offPeakStartMinute, Number.isInteger(c.offPeakEndMinute) ? c.offPeakEndMinute : 510) : null)
  const weekdaysOnly = typeof c.weekdaysOnly === 'boolean' ? c.weekdaysOnly : null
  const rates = resolveRateCard(c.rates)
  return {
    currency,
    symbol,
    exchangeRate: numberIn(c.exchangeRate, 1, 0.000001, 1000),
    reasoningBilling: c.reasoningBilling === 'separate' ? 'separate' : 'included',
    offPeakEnabled: c.offPeakEnabled !== false,
    pricingSource: c.pricingSource === false ? false : typeof c.pricingSource === 'string' && c.pricingSource.length > 0 ? c.pricingSource : OFFICIAL_PRICING_URL,
    refreshIntervalMs: numberIn(c.refreshIntervalMs, DEFAULT_REFRESH_MS, MIN_REFRESH_MS, MAX_REFRESH_MS),
    fetchTimeoutMs: numberIn(c.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS, 1000, 60_000),
    holidays: normalizeHolidays(c.holidays),
    holidaysSource:
      c.holidaysSource === false
        ? false
        : typeof c.holidaysSource === 'string' && c.holidaysSource.length > 0
          ? c.holidaysSource
          : DEFAULT_HOLIDAY_SOURCE,
    holidayRefreshIntervalMs: numberIn(c.holidayRefreshIntervalMs, DEFAULT_HOLIDAY_REFRESH_MS, MIN_REFRESH_MS, 7 * 24 * 60 * 60_000),
    holidayOffsetMinutes: numberIn(c.holidayOffsetMinutes, 480, -14 * 60, 14 * 60),
    peakWindowsOverride: fallbackWindows,
    weekdaysOnlyOverride: weekdaysOnly,
    fallbackCard: {
      rates,
      peakWindows: fallbackWindows ?? DEFAULT_PEAK_WINDOWS.map((window) => [...window]),
      weekdaysOnly: weekdaysOnly ?? true,
      currency: currency || 'USD',
      symbol: symbol || (currency === 'CNY' ? '¥' : '$'),
      holidays: normalizeHolidays(c.holidays),
      holidaysSource: normalizeHolidays(c.holidays).length > 0 ? 'manual' : 'none',
      source: 'config',
      version: 'config',
      effectiveFrom: 0,
      fetchedAt: null,
    },
  }
}

/**
 * Merge a catalog card with settings into the session's frozen pricing policy.
 *
 * @param {object} card - catalog card.
 * @param {PluginSettings} settings - plugin settings.
 * @returns {object} frozen pricing snapshot stored in projection state.
 */
function makePricingSnapshot(card, settings) {
  const currency = settings.currency || card.currency || 'USD'
  return {
    version: card.version,
    source: card.source,
    effectiveFrom: card.effectiveFrom,
    fetchedAt: card.fetchedAt,
    currency,
    symbol: settings.symbol || card.symbol || (currency === 'CNY' ? '¥' : '$'),
    exchangeRate: settings.exchangeRate,
    peakWindows: settings.peakWindowsOverride ?? card.peakWindows,
    weekdaysOnly: settings.weekdaysOnlyOverride ?? card.weekdaysOnly,
    offPeakEnabled: settings.offPeakEnabled,
    reasoningBilling: settings.reasoningBilling,
    holidays: (card.holidays ?? settings.holidays).slice(),
    holidaysSource: card.holidaysSource ?? (settings.holidays.length > 0 ? 'manual' : 'none'),
    autoRefresh: {
      pricing: settings.pricingSource !== false,
      holidays: settings.holidaysSource !== false,
    },
    holidayOffsetMinutes: settings.holidayOffsetMinutes,
    rates: card.rates,
  }
}

/**
 * Pick the catalog version active at a Session's creation time.
 *
 * @param {object[]} versions - catalog versions sorted by effectiveFrom.
 * @param {number} timeMs - Session creation time.
 * @returns {object} the applicable version.
 */
function resolvePricingAt(versions, timeMs) {
  let selected = versions[0]
  for (const version of versions) {
    if (version.effectiveFrom <= timeMs) selected = version
  }
  return selected
}

/**
 * Stable fingerprint of the priced parts of a catalog version.
 *
 * @param {object} card - catalog card.
 * @returns {string} fingerprint.
 */
function cardFingerprint(card) {
  const rates = Object.keys(card.rates)
    .sort()
    .map((key) => {
      const rate = card.rates[key]
      if (rate === null || rate === undefined) return `${key}:null`
      return `${key}:${rate.input},${rate.cacheRead},${rate.cacheWrite},${rate.output},${rate.offPeakMultiplier}`
    })
    .join('|')
  const windows = (card.peakWindows ?? []).map((window) => window.join('-')).join(',')
  const holidays = (card.holidays ?? []).slice().sort().join(',')
  return `${rates}|${windows}|${card.weekdaysOnly}|${holidays}`
}

/**
 * In-memory, effective-dated pricing catalog.
 *
 * The configured card is version `config` at `effectiveFrom: 0`; each fetched
 * card whose priced parts differ becomes a new version effective at its fetch
 * time. Sessions freeze the version active at their creation time, so a rate
 * change affects new conversations only.
 *
 * @param {PluginSettings} settings - resolved plugin settings.
 * @returns {{ versions: object[], ingest: (card: object, fetchedAt: number) => boolean, snapshotFor: (createdAt: number) => object }} catalog.
 */
function createPricingCatalog(settings) {
  const versions = [settings.fallbackCard]
  let nextVersion = 1

  const ingest = (card, fetchedAt) => {
    const latest = versions[versions.length - 1]
    if (cardFingerprint(latest) === cardFingerprint(card)) {
      // Same prices: keep the single version, but let new sessions report the
      // official source and its last successful read.
      if (latest.source === 'config' && typeof card.source === 'string') {
        latest.source = card.source
        latest.fetchedAt = fetchedAt
        if (typeof card.currency === 'string' && card.currency.length > 0) latest.currency = card.currency
        if (typeof card.symbol === 'string' && card.symbol.length > 0) latest.symbol = card.symbol
      }
      return false
    }
    versions.push({ ...card, version: `official-${nextVersion}`, effectiveFrom: fetchedAt, fetchedAt })
    nextVersion += 1
    return true
  }

  const snapshotFor = (createdAt) =>
    makePricingSnapshot(resolvePricingAt(versions, typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0), settings)

  return { versions, ingest, snapshotFor }
}

// ---------------------------------------------------------------------------
// Tariff policy
// ---------------------------------------------------------------------------

/**
 * Minutes from UTC midnight.
 *
 * @param {number} timeMs - epoch milliseconds.
 * @returns {number} minute of day.
 */
function utcMinuteOfDay(timeMs) {
  const minutes = Math.floor(timeMs / 60_000) % MINUTES_PER_DAY
  return (minutes + MINUTES_PER_DAY) % MINUTES_PER_DAY
}

/**
 * `YYYY-MM-DD` for a moment in a fixed offset (used for the Chinese holiday
 * calendar, whose dates are Beijing dates).
 *
 * @param {number} timeMs - epoch milliseconds.
 * @param {number} offsetMinutes - fixed offset.
 * @returns {string} date key.
 */
function dateKeyAt(timeMs, offsetMinutes) {
  return new Date(timeMs + offsetMinutes * 60_000).toISOString().slice(0, 10)
}

/**
 * Whether a UTC minute falls inside one window.
 *
 * @param {number} minute - minute of day.
 * @param {number[]} window - `[start, end)` minutes.
 * @returns {boolean} inside.
 */
function inWindow(minute, window) {
  const [start, end] = window
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/**
 * Classify one request time into a tariff band under a frozen policy.
 *
 * @param {number} timeMs - request start time.
 * @param {object} pricing - frozen session pricing snapshot.
 * @returns {'peak' | 'offPeak'} the band.
 */
function bandOf(timeMs, pricing) {
  if (pricing.offPeakEnabled === false) return 'peak'
  const windows = pricing.peakWindows ?? DEFAULT_PEAK_WINDOWS
  if (windows.length === 0) return 'offPeak'
  if (pricing.weekdaysOnly !== false) {
    const weekday = new Date(timeMs).getUTCDay()
    if (weekday === 0 || weekday === 6) return 'offPeak'
  }
  const holidays = pricing.holidays ?? []
  if (holidays.length > 0 && holidays.includes(dateKeyAt(timeMs, pricing.holidayOffsetMinutes ?? 480))) return 'offPeak'
  const minute = utcMinuteOfDay(timeMs)
  return windows.some((window) => inWindow(minute, window)) ? 'peak' : 'offPeak'
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** @returns {TokenBuckets} all-zero token buckets. */
function zeroTokens() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
}

/**
 * Normalize one provider usage sample.
 *
 * @param {object} usage - provider usage from a settlement.
 * @returns {TokenBuckets} non-negative integer buckets.
 */
function normalizeTokens(usage) {
  const read = (name) => {
    const value = usage[name]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
  }
  return {
    input: read('inputTokens'),
    cacheRead: read('cacheReadTokens'),
    cacheWrite: read('cacheWriteTokens'),
    output: read('outputTokens'),
    reasoning: read('reasoningTokens'),
  }
}

/** @param {TokenBuckets} tokens - buckets. @returns {number} prompt-side tokens. */
function promptTokens(tokens) {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite
}

/** @param {TokenBuckets} tokens - buckets. @returns {number} all billed tokens. */
function totalTokens(tokens) {
  return promptTokens(tokens) + tokens.output
}

/**
 * Find the rate card for one route.
 *
 * @param {Record<string, RateCard | null>} table - rate card.
 * @param {string} provider - provider id.
 * @param {string} model - model id.
 * @returns {{ rate: RateCard, matched: string, exact: boolean } | null} match.
 */
function findRate(table, provider, model) {
  for (const key of [`${provider}/${model}`, model]) {
    if (Object.hasOwn(table, key) && table[key] !== null && table[key] !== undefined) {
      return { rate: table[key], matched: key, exact: true }
    }
  }
  if (Object.hasOwn(table, 'default') && table.default !== null && table.default !== undefined) {
    return { rate: table.default, matched: 'default', exact: false }
  }
  return null
}

/**
 * Unrounded micro-currency parts for one token bucket set.
 *
 * @param {TokenBuckets} tokens - tokens to price.
 * @param {RateCard} rate - rate card.
 * @param {string} reasoningBilling - `included` or `separate`.
 * @returns {TokenBuckets} unrounded parts.
 */
function priceParts(tokens, rate, reasoningBilling) {
  return {
    input: tokens.input * rate.input,
    cacheRead: tokens.cacheRead * rate.cacheRead,
    cacheWrite: tokens.cacheWrite * rate.cacheWrite,
    output: tokens.output * rate.output,
    reasoning: reasoningBilling === 'separate' ? tokens.reasoning * rate.output : 0,
  }
}

/** @param {TokenBuckets} parts - parts. @returns {number} sum. */
function sumParts(parts) {
  return parts.input + parts.cacheRead + parts.cacheWrite + parts.output + parts.reasoning
}

/**
 * Round bucket parts so they stay exactly additive with their rounded total.
 *
 * @param {TokenBuckets} parts - unrounded bucket amounts.
 * @param {TokenBuckets} weights - amounts choosing where a remainder lands.
 * @returns {TokenBuckets} integer buckets.
 */
function roundParts(parts, weights) {
  const buckets = {
    input: Math.round(parts.input),
    cacheRead: Math.round(parts.cacheRead),
    cacheWrite: Math.round(parts.cacheWrite),
    output: Math.round(parts.output),
    reasoning: Math.round(parts.reasoning),
  }
  const remainder = Math.round(sumParts(parts)) - sumParts(buckets)
  if (remainder !== 0) {
    let largest = 'input'
    for (const name of ['cacheRead', 'cacheWrite', 'output', 'reasoning']) {
      if (weights[name] > weights[largest]) largest = name
    }
    buckets[largest] += remainder
  }
  return buckets
}

/**
 * Price one token bucket set inside one band (single-call formula).
 *
 * @param {TokenBuckets} tokens - buckets to price.
 * @param {RateCard} rate - rate card.
 * @param {object} pricing - frozen pricing snapshot.
 * @param {'peak' | 'offPeak'} band - band.
 * @returns {{ micros: number, savedMicros: number, buckets: TokenBuckets }} integer micro-currency.
 */
function priceTokens(tokens, rate, pricing, band) {
  const parts = priceParts(tokens, rate, pricing.reasoningBilling)
  const fx = pricing.exchangeRate ?? 1
  const multiplier = band === 'peak' || pricing.offPeakEnabled === false ? 1 : rate.offPeakMultiplier
  const baseMicros = Math.round(sumParts(parts) * fx)
  const micros = Math.round(sumParts(parts) * multiplier * fx)
  const buckets = roundParts(
    {
      input: parts.input * multiplier * fx,
      cacheRead: parts.cacheRead * multiplier * fx,
      cacheWrite: parts.cacheWrite * multiplier * fx,
      output: parts.output * multiplier * fx,
      reasoning: parts.reasoning * multiplier * fx,
    },
    parts,
  )
  return { micros, savedMicros: band === 'peak' ? 0 : Math.max(0, baseMicros - micros), buckets }
}

// ---------------------------------------------------------------------------
// Pricing fold: billed facts only
// ---------------------------------------------------------------------------

/** @param {TokenBuckets} tokens - tokens. @returns {TokenBuckets} a copy. */
function cloneTokens(tokens) {
  return { ...tokens }
}

/** @returns {{ calls: number, tokens: TokenBuckets }} an empty band cell. */
function emptyBand() {
  return { calls: 0, tokens: zeroTokens() }
}

/** @returns {ModelEntry} an empty per-model cell. */
function emptyModel(provider, model) {
  return { provider, model, calls: 0, tokens: zeroTokens(), peak: emptyBand(), offPeak: emptyBand() }
}

/**
 * @param {object} pricing - frozen pricing snapshot.
 * @returns {object} the projection's initial state.
 */
function initialState(pricing) {
  return {
    pricing,
    calls: 0,
    tokens: zeroTokens(),
    peak: emptyBand(),
    offPeak: emptyBand(),
    models: {},
    route: null,
    stepStartedAt: null,
    last: null,
  }
}

/**
 * Add (or remove, with `sign = -1`) one contribution from the state.
 *
 * @param {object} state - current fold state.
 * @param {object} contribution - contribution.
 * @param {1 | -1} sign - direction.
 * @returns {object} next state.
 */
function applyContribution(state, contribution, sign) {
  const tokens = cloneTokens(state.tokens)
  const peakTokens = cloneTokens(state.peak.tokens)
  const offPeakTokens = cloneTokens(state.offPeak.tokens)
  const band = contribution.band === 'offPeak' ? 'offPeak' : 'peak'
  for (const name of Object.keys(tokens)) {
    const value = contribution.tokens[name] ?? 0
    tokens[name] += sign * value
    if (band === 'offPeak') offPeakTokens[name] += sign * value
    else peakTokens[name] += sign * value
  }

  const models = { ...state.models }
  const key = contribution.modelKey
  const current = models[key] ?? emptyModel(contribution.provider ?? 'unknown', contribution.model ?? 'unknown')
  const nextModel = {
    ...current,
    tokens: cloneTokens(current.tokens),
    peak: { calls: current.peak.calls, tokens: cloneTokens(current.peak.tokens) },
    offPeak: { calls: current.offPeak.calls, tokens: cloneTokens(current.offPeak.tokens) },
  }
  nextModel.calls += sign
  for (const name of Object.keys(nextModel.tokens)) {
    const value = contribution.tokens[name] ?? 0
    nextModel.tokens[name] += sign * value
    if (band === 'offPeak') nextModel.offPeak.tokens[name] += sign * value
    else nextModel.peak.tokens[name] += sign * value
  }
  nextModel[band].calls += sign
  if (nextModel.calls <= 0) delete models[key]
  else models[key] = nextModel

  return {
    ...state,
    calls: state.calls + sign,
    tokens,
    peak: { calls: state.peak.calls + (band === 'peak' ? sign : 0), tokens: peakTokens },
    offPeak: { calls: state.offPeak.calls + (band === 'offPeak' ? sign : 0), tokens: offPeakTokens },
    models,
  }
}

/**
 * Build the raw contribution for one usage sample under the session policy.
 *
 * @param {TokenBuckets} tokens - sample buckets.
 * @param {object} state - fold state.
 * @param {object} event - settlement event.
 * @returns {object} contribution.
 */
function contributionOf(tokens, state, event) {
  const route = state.route ?? { provider: 'unknown', model: 'unknown' }
  const provider = typeof route.provider === 'string' ? route.provider : 'unknown'
  const model = typeof route.model === 'string' ? route.model : 'unknown'
  const stepStartedAt = state.stepStartedAt
  const sampleTime = typeof stepStartedAt === 'number' && Number.isFinite(stepStartedAt) ? stepStartedAt : event.time
  return {
    turn: event.data.turn,
    step: event.data.step,
    modelKey: `${provider}/${model}`,
    provider,
    model,
    band: bandOf(typeof sampleTime === 'number' && Number.isFinite(sampleTime) ? sampleTime : 0, state.pricing),
    tokens: cloneTokens(tokens),
  }
}

/** Compare two contributions for the replacement rule. */
function sameContribution(left, right) {
  return (
    left.modelKey === right.modelKey &&
    left.band === right.band &&
    left.tokens.input === right.tokens.input &&
    left.tokens.cacheRead === right.tokens.cacheRead &&
    left.tokens.cacheWrite === right.tokens.cacheWrite &&
    left.tokens.output === right.tokens.output &&
    left.tokens.reasoning === right.tokens.reasoning
  )
}

/**
 * Read the last usage sample embedded in one Assistant stream.
 *
 * @param {unknown} stream - durable stream records.
 * @returns {object | null} usage sample, or `null`.
 */
function lastUsageInStream(stream) {
  if (!Array.isArray(stream)) return null
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record !== null && typeof record === 'object' && record.type === 'chunk' && record.chunk !== null && typeof record.chunk === 'object' && record.chunk.type === 'usage') {
      const usage = record.chunk.usage
      if (usage !== null && typeof usage === 'object') return usage
    }
  }
  return null
}

/** @param {object} event - settlement event. @returns {object | null} usage. */
function usageOf(event) {
  if (event.type === 'assistant/message' && event.data.usage !== undefined && event.data.usage !== null) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null
  return lastUsageInStream(event.data.stream)
}

/**
 * Fold one event into the `tokenCost` state.
 *
 * @param {object} state - current state.
 * @param {object} event - durable session event.
 * @returns {object} next state.
 */
function foldEvent(state, event) {
  switch (event.type) {
    case 'request/header': {
      const config = event.data?.header?.config
      if (config === null || typeof config !== 'object') return state
      const provider = typeof config.provider === 'string' ? config.provider : state.route?.provider
      const model = typeof config.model === 'string' ? config.model : state.route?.model
      if (provider === state.route?.provider && model === state.route?.model) return state
      return { ...state, route: { provider: provider ?? 'unknown', model: model ?? 'unknown' } }
    }
    case 'request/context': {
      const provider = typeof event.data?.provider === 'string' ? event.data.provider : state.route?.provider
      const model = typeof event.data?.model === 'string' ? event.data.model : state.route?.model
      if (provider === state.route?.provider && model === state.route?.model) return state
      return { ...state, route: { provider: provider ?? 'unknown', model: model ?? 'unknown' } }
    }
    case 'step/start':
      return { ...state, stepStartedAt: event.time }
    case 'llm/retry-started':
      if (state.last === null || state.last.turn !== event.data?.turn || state.last.step !== event.data?.step) return state
      return { ...state, last: null }
    case 'assistant/message':
    case 'assistant/attempt': {
      const usage = usageOf(event)
      if (usage === null) return state
      const tokens = normalizeTokens(usage)
      if (totalTokens(tokens) === 0) return state
      const turn = event.data.turn
      const step = event.data.step
      const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null
      const contribution = contributionOf(tokens, state, event)
      if (previous !== null && sameContribution(previous, contribution)) return state
      let next = state
      if (previous !== null) next = applyContribution(next, previous, -1)
      next = applyContribution(next, contribution, 1)
      return { ...next, last: contribution }
    }
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Wire view
// ---------------------------------------------------------------------------

/**
 * Price one model entry under the session's frozen pricing.
 *
 * @param {ModelEntry} entry - billed facts.
 * @param {object} pricing - frozen pricing snapshot.
 * @returns {object} priced entry.
 */
function priceModel(entry, pricing) {
  const match = findRate(pricing.rates, entry.provider, entry.model)
  const base = {
    provider: entry.provider,
    model: entry.model,
    calls: entry.calls,
    tokens: cloneTokens(entry.tokens),
    peak: { calls: entry.peak.calls, micros: 0, tokens: cloneTokens(entry.peak.tokens) },
    offPeak: { calls: entry.offPeak.calls, micros: 0, tokens: cloneTokens(entry.offPeak.tokens) },
    micros: 0,
    savedMicros: 0,
    bucketMicros: zeroTokens(),
  }
  if (match === null) return { ...base, unpriced: true, estimated: false }

  const fx = pricing.exchangeRate ?? 1
  const multiplier = pricing.offPeakEnabled === false ? 1 : match.rate.offPeakMultiplier
  const peakParts = priceParts(entry.peak.tokens, match.rate, pricing.reasoningBilling)
  const offParts = priceParts(entry.offPeak.tokens, match.rate, pricing.reasoningBilling)
  const peakMicros = Math.round(sumParts(peakParts) * fx)
  const offBaseMicros = Math.round(sumParts(offParts) * fx)
  const offPeakMicros = Math.round(sumParts(offParts) * multiplier * fx)
  const bucketMicros = roundParts(
    {
      input: (peakParts.input + offParts.input * multiplier) * fx,
      cacheRead: (peakParts.cacheRead + offParts.cacheRead * multiplier) * fx,
      cacheWrite: (peakParts.cacheWrite + offParts.cacheWrite * multiplier) * fx,
      output: (peakParts.output + offParts.output * multiplier) * fx,
      reasoning: (peakParts.reasoning + offParts.reasoning * multiplier) * fx,
    },
    {
      input: peakParts.input + offParts.input,
      cacheRead: peakParts.cacheRead + offParts.cacheRead,
      cacheWrite: peakParts.cacheWrite + offParts.cacheWrite,
      output: peakParts.output + offParts.output,
      reasoning: peakParts.reasoning + offParts.reasoning,
    },
  )
  return {
    ...base,
    peak: { ...base.peak, micros: peakMicros },
    offPeak: { ...base.offPeak, micros: offPeakMicros },
    micros: peakMicros + offPeakMicros,
    savedMicros: Math.max(0, offBaseMicros - offPeakMicros),
    bucketMicros,
    unpriced: false,
    estimated: !match.exact,
  }
}

/**
 * Project the fold state into the client-visible value.
 *
 * @param {object} state - fold state.
 * @returns {object} the `tokenCost` wire value.
 */
function viewOf(state) {
  const pricing = state.pricing
  const priced = Object.values(state.models).map((entry) => priceModel(entry, pricing))
  priced.sort((left, right) => right.micros - left.micros || right.calls - left.calls || `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`))

  let micros = 0
  let peakMicros = 0
  let offPeakMicros = 0
  let savedMicros = 0
  let unpricedCalls = 0
  let estimatedCalls = 0
  const bucketMicros = zeroTokens()
  for (const entry of priced) {
    micros += entry.micros
    peakMicros += entry.peak.micros
    offPeakMicros += entry.offPeak.micros
    savedMicros += entry.savedMicros
    if (entry.unpriced) unpricedCalls += entry.calls
    if (entry.estimated) estimatedCalls += entry.calls
    for (const name of Object.keys(bucketMicros)) bucketMicros[name] += entry.bucketMicros[name]
  }

  return {
    currency: pricing.currency,
    symbol: pricing.symbol,
    calls: state.calls,
    unpricedCalls,
    estimatedCalls,
    micros,
    peakMicros,
    offPeakMicros,
    savedMicros,
    tokens: cloneTokens(state.tokens),
    bucketMicros,
    peak: { calls: state.peak.calls, micros: peakMicros, tokens: cloneTokens(state.peak.tokens) },
    offPeak: { calls: state.offPeak.calls, micros: offPeakMicros, tokens: cloneTokens(state.offPeak.tokens) },
    models: priced.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      calls: entry.calls,
      unpricedCalls: entry.unpriced ? entry.calls : 0,
      estimatedCalls: entry.estimated ? entry.calls : 0,
      micros: entry.micros,
      savedMicros: entry.savedMicros,
      tokens: entry.tokens,
      peak: entry.peak,
      offPeak: entry.offPeak,
    })),
    pricing: {
      version: pricing.version,
      source: pricing.source,
      effectiveFrom: pricing.effectiveFrom,
      fetchedAt: pricing.fetchedAt,
      currency: pricing.currency,
      symbol: pricing.symbol,
      exchangeRate: pricing.exchangeRate,
      peakWindows: pricing.peakWindows.map((window) => [...window]),
      weekdaysOnly: pricing.weekdaysOnly,
      offPeakEnabled: pricing.offPeakEnabled,
      reasoningBilling: pricing.reasoningBilling,
      holidays: [...(pricing.holidays ?? [])],
      holidaysSource: pricing.holidaysSource ?? 'none',
      autoRefresh: {
        pricing: pricing.autoRefresh?.pricing === true,
        holidays: pricing.autoRefresh?.holidays === true,
      },
      holidayOffsetMinutes: pricing.holidayOffsetMinutes,
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Register the `tokenCost` projection and keep the pricing catalog fresh.
 *
 * @param {object} ctx - Cordis context of the plugin row.
 * @param {unknown} config - the row's config.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const catalog = createPricingCatalog(settings)

  // Effective-dated catalog state: the last parsed card, the current holiday
  // calendar, and when that calendar was last fetched.
  let currentCard = settings.fallbackCard
  let holidaySet = new Set(settings.holidays)
  let holidayKind = settings.fallbackCard.holidaysSource
  let holidayFetchedAt = 0

  /** Publish one card plus the current holiday calendar as a catalog version. */
  const publishCard = (card, fetchedAt) => {
    currentCard = { ...card, holidays: [...holidaySet].sort(), holidaysSource: holidayKind }
    catalog.ingest(currentCard, fetchedAt)
  }

  ctx.sessionProjections.register({
    key: 'tokenCost',
    stateVersion: STATE_VERSION,
    stateSchema: passthroughSchema,
    init: (header) => initialState(catalog.snapshotFor(header?.createdAt)),
    apply: (state, event) => foldEvent(state, event),
    wire: {
      viewSchema: passthroughSchema,
      view: (state) => viewOf(state),
    },
  })

  ctx.effect(() => {
    const web = ctx.get('web')
    if (web === undefined) return undefined
    let disposed = false

    /** Fetch one public-holiday JSON source for the current and next year. */
    const refreshHolidays = async () => {
      if (settings.holidaysSource === false) return
      const now = Date.now()
      if (holidayFetchedAt !== 0 && now - holidayFetchedAt < settings.holidayRefreshIntervalMs) return
      const shiftedYear = new Date(now + settings.holidayOffsetMinutes * 60_000).getUTCFullYear()
      const years = settings.holidaysSource.includes('{year}') ? [shiftedYear, shiftedYear + 1] : [shiftedYear]
      const collected = new Set(settings.holidays)
      let auto = false
      for (const year of years) {
        const url = settings.holidaysSource.replaceAll('{year}', String(year))
        try {
          const result = await web.fetch({ url }, AbortSignal.timeout(settings.fetchTimeoutMs))
          if (disposed) return
          if (result === null || typeof result !== 'object' || result.statusCode < 200 || result.statusCode >= 300) continue
          const dates = parseHolidayPayload(JSON.parse(result.body?.content ?? ''), year)
          if (dates.length > 0) {
            auto = true
            for (const date of dates) collected.add(date)
          }
        } catch (error) {
          ctx.logger?.warn?.(`[token-cost] holiday refresh failed for ${year}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (disposed) return
      holidayFetchedAt = Date.now()
      const next = [...collected].sort()
      const changed = next.join(',') !== [...holidaySet].sort().join(',')
      if (!changed) return
      holidaySet = new Set(next)
      holidayKind = auto ? 'auto' : next.length > 0 ? 'manual' : 'none'
      publishCard(currentCard, Date.now())
    }

    /** Fetch the official pricing page and publish a new catalog version on change. */
    const refreshPricing = async () => {
      if (settings.pricingSource === false) return
      try {
        const result = await web.fetch({ url: settings.pricingSource }, AbortSignal.timeout(settings.fetchTimeoutMs))
        if (disposed) return
        if (result === null || typeof result !== 'object' || result.statusCode < 200 || result.statusCode >= 300) return
        const parsed = parsePricingPage(result.body?.content ?? '')
        if (parsed === null) {
          ctx.logger?.warn?.('[token-cost] pricing page layout was not recognized; keeping the current card')
          return
        }
        publishCard({ ...parsed, source: result.url ?? settings.pricingSource }, Date.now())
      } catch (error) {
        ctx.logger?.warn?.(`[token-cost] pricing refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const refresh = async () => {
      if (settings.holidaysSource !== false) await refreshHolidays()
      await refreshPricing()
    }
    void refresh()
    const timer = setInterval(() => void refresh(), settings.refreshIntervalMs)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, 'token-cost: pricing refresh')
}

/** Exported for tests and for documentation of the fold contract. */
export const internals = {
  OFFICIAL_PRICING_URL,
  DEFAULT_HOLIDAY_SOURCE,
  DEFAULT_RATE_CARD,
  DEFAULT_PEAK_WINDOWS,
  STATE_VERSION,
  parsePricingPage,
  parseHolidayPayload,
  markupToText,
  parsePeakWindows,
  resolveSettings,
  resolveRateCard,
  makePricingSnapshot,
  resolvePricingAt,
  createPricingCatalog,
  cardFingerprint,
  bandOf,
  priceTokens,
  priceModel,
  normalizeTokens,
  foldEvent,
  viewOf,
  initialState,
}

/**
 * @typedef {object} TokenBuckets
 * @property {number} input - uncached prompt tokens.
 * @property {number} cacheRead - cache-hit prompt tokens.
 * @property {number} cacheWrite - cache-write prompt tokens.
 * @property {number} output - output tokens.
 * @property {number} reasoning - reasoning tokens (billed inside output unless configured separately).
 */

/**
 * @typedef {object} RateCard
 * @property {number} input - peak currency per 1M cache-miss input tokens.
 * @property {number} cacheRead - peak currency per 1M cache-hit input tokens.
 * @property {number} cacheWrite - peak currency per 1M cache-write tokens.
 * @property {number} output - peak currency per 1M output tokens.
 * @property {number} offPeakMultiplier - multiplier inside off-peak hours.
 */

/**
 * @typedef {object} ModelEntry
 * @property {string} provider
 * @property {string} model
 * @property {number} calls
 * @property {TokenBuckets} tokens
 * @property {{ calls: number, tokens: TokenBuckets }} peak
 * @property {{ calls: number, tokens: TokenBuckets }} offPeak
 */

/**
 * @typedef {object} PluginSettings
 * @property {string} currency
 * @property {string} symbol
 * @property {number} exchangeRate
 * @property {'included' | 'separate'} reasoningBilling
 * @property {boolean} offPeakEnabled
 * @property {string | false} pricingSource
 * @property {number} refreshIntervalMs
 * @property {number} fetchTimeoutMs
 * @property {string[]} holidays
 * @property {number} holidayOffsetMinutes
 * @property {number[][] | null} peakWindowsOverride
 * @property {boolean | null} weekdaysOnlyOverride
 * @property {object} fallbackCard
 */
