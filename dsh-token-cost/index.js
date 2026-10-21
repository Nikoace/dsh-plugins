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

// Canonical tariff / holiday rules. The generated copy `./tariff.js` is kept in
// sync with `shared/tariff/index.js` by `tools/sync-shared.mjs`; never restate
// these rules in this file.
import {
  PEAK_WINDOWS as CANONICAL_PEAK_WINDOWS,
  MINUTES_PER_DAY,
  bandAt as canonicalBandAt,
  TARIFF_VERSION,
  isHolidayDate,
  holidayProvenance,
  holidayYears,
  parseHolidayPayload,
  provenanceDates,
} from './tariff.js'

/**
 * Published machine-readable rate sources.
 *
 * The zh-CN page is denominated in **CNY** and states the peak windows in
 * Beijing time; the English page carries the same rates in **USD** with the
 * windows in UTC. Both are fetched and kept side by side, so the display can
 * follow the interface language without inventing an exchange rate: each amount
 * is computed from that currency's own published price. A page is never priced
 * in the other copy's currency — the parser records which copy it read
 * (`pageVariant`) and which currency the numbers are in.
 */
const OFFICIAL_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
const OFFICIAL_PRICING_URL_EN = 'https://api-docs.deepseek.com/quick_start/pricing'

/** Currency each published copy is denominated in. */
const CURRENCY_OF_VARIANT = { zh: 'CNY', en: 'USD' }

/** Display symbol per currency. */
const SYMBOL_OF_CURRENCY = { CNY: '¥', USD: '$' }

/** Official peak windows in UTC minutes: 01:00–04:00 and 06:00–10:00. */
const DEFAULT_PEAK_WINDOWS = CANONICAL_PEAK_WINDOWS

/**
 * Official peak rates per 1,000,000 tokens, mirrored from both published copies
 * (the page lists the off-peak half separately; a card stores peak values plus
 * the multiplier). Used only when a copy cannot be fetched, and as the first
 * epoch of the price timeline when a Session has no earlier card.
 */
const DEFAULT_RATE_CARDS = {
  CNY: {
    'deepseek-flash': { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8, offPeakMultiplier: 0.5 },
    'deepseek-v4-pro': { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27, offPeakMultiplier: 0.5 },
    default: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8, offPeakMultiplier: 0.5 },
  },
  USD: {
    'deepseek-flash': { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2, offPeakMultiplier: 0.5 },
    'deepseek-v4-pro': { input: 1.32, cacheRead: 0.044, cacheWrite: 1.32, output: 3.96, offPeakMultiplier: 0.5 },
    default: { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2, offPeakMultiplier: 0.5 },
  },
}

/** The primary card: the currency a Session displays by default. */
const DEFAULT_RATE_CARD = DEFAULT_RATE_CARDS.CNY

/**
 * Copy variants of the pricing page.
 *
 * Each variant supplies its own row labels, currency, and the time zone its peak
 * windows are stated in. Reading a Beijing-time window as UTC would move every
 * band decision by eight hours, so a window without a recognizable zone marker
 * is rejected instead of assumed.
 */
const PRICING_PAGE_VARIANTS = {
  zh: {
    model: /模型\s+([A-Za-z0-9._-]+)\s*(?:[（(]\d+[）)])?\s+([A-Za-z0-9._-]+)\s+(?:BASE URL|模型版本)/,
    hit: '百万\\s*tokens\\s*输入\\s*[（(]\\s*缓存命中\\s*[）)]',
    miss: '百万\\s*tokens\\s*输入\\s*[（(]\\s*缓存未命中\\s*[）)]',
    output: '百万\\s*tokens\\s*输出',
    peak: '高峰时段',
    offPeak: '空闲时段',
    weekday: /周一至周五/,
    zone: /北京时间|北京時間/,
    zoneOffsetMinutes: 480,
    currency: 'CNY',
    symbol: '¥',
  },
  en: {
    model: /MODEL\s+([A-Za-z0-9._-]+)\s*(?:\(\d+\))?\s+([A-Za-z0-9._-]+)\s+(?:BASE URL|MODEL VERSION)/,
    hit: '1M INPUT TOKENS\\s*\\(CACHE HIT\\)',
    miss: '1M INPUT TOKENS\\s*\\(CACHE MISS\\)',
    output: '1M OUTPUT TOKENS',
    peak: 'PEAK',
    offPeak: 'OFF-PEAK',
    weekday: /Monday through Friday/i,
    zone: /\bUTC\b/,
    zoneOffsetMinutes: 0,
    currency: 'USD',
    symbol: '$',
  },
}

/**
 * Providers that bill through the DeepSeek account and therefore use the
 * fetched DeepSeek card. `findRate` falls back to `default` only for these;
 * every other provider stays *unpriced* instead of being silently priced as a
 * DeepSeek model (a foreign gateway or another vendor's model has no
 * relationship to the DeepSeek price page).
 */
const KNOWN_DEEPSEEK_PROVIDERS = ['deepseek-account', 'deepseek', 'deepseek-anthropic', 'deepseek-platform']

/**
 * Model-id aliases, applied before the rate lookup.
 *
 * DSH routes reach this plugin as `<provider>/<model>`. The official page names
 * `deepseek-flash` / `deepseek-v4-pro`, while a gateway route may embed a vendor
 * prefix, and the page documents `deepseek-v4-flash` as a legacy alias. Matching
 * on the documented families keeps such a route on the same row as the official
 * card instead of collapsing it onto the generic `default` row, which would
 * mislabel it "estimated" and would become wrong as soon as the rows diverge.
 */
const MODEL_ALIASES = [
  { pattern: /(?:^|[^a-z0-9])deepseek-v4-pro(?:$|[^a-z0-9])/, model: 'deepseek-v4-pro' },
  { pattern: /(?:^|[^a-z0-9])deepseek-(?:v4(?:\.1)?-)?flash(?:$|[^a-z0-9])/, model: 'deepseek-flash' },
]

/**
 * Providers whose spend this meter deliberately does **not** price.
 *
 * `magpie` is a local gateway: its requests are billed by the gateway's own
 * account, not by the DeepSeek account this price page describes, so pricing
 * them from the DeepSeek card would be a made-up number. Excluded routes are
 * counted and reported as *excluded* (never as $0 spend that looks free), and
 * they never contribute to the total. Excluding by provider also skips the
 * model-family alias, which would otherwise map
 * `magpie/workbuddy/deepseek-v4.1-flash` onto the DeepSeek Flash row.
 */
const EXCLUDED_PROVIDERS = ['magpie', 'magpie-responses', 'openai-codex']

const MIN_REFRESH_MS = 5 * 60_000
const MAX_REFRESH_MS = 24 * 60 * 60_000
const DEFAULT_REFRESH_MS = 6 * 60 * 60_000
const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const DEFAULT_HOLIDAY_SOURCE = 'https://timor.tech/api/holiday/year/{year}'
const DEFAULT_HOLIDAY_REFRESH_MS = 24 * 60 * 60_000
const STATE_VERSION = 5

/**
 * Version of the pricing-page parser. Bump it whenever the accepted layout or
 * the extracted semantics change, so a frozen session can report which parser
 * understood its card.
 */
const PARSER_VERSION = 1

/**
 * Holiday-refresh backoff: after 1, 2, then 3+ consecutive total failures.
 * A success returns to `settings.holidayRefreshIntervalMs`.
 */
const HOLIDAY_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000]

/**
 * Legacy/test timestamps such as 0 have no meaningful calendar year, so only
 * real snapshot timestamps constrain explicitly supplied calendar dates.
 * `init` normally carries a real `createdAt`; tests/legacy states may pass 0.
 */
const MIN_CALENDAR_TIME_MS = Date.UTC(2020, 0, 1)

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
 * @param {number} [zoneOffsetMinutes] - minutes east of UTC that the page states
 *   its windows in (Beijing +480, the English page 0).
 * @returns {number[][]} windows in UTC minutes; empty when the prose is absent.
 */
function parsePeakWindows(text, zoneOffsetMinutes = 0) {
  const matches = [...text.matchAll(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g)]
  const toUtc = (minutes) => ((minutes - zoneOffsetMinutes) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const windows = []
  for (const match of matches) {
    const start = clockToMinutes(match[1])
    const end = clockToMinutes(match[2])
    if (start === null || end === null || start === end) continue
    windows.push([toUtc(start), toUtc(end)])
  }
  // The first pairs on the page are the peak windows; later times (if any)
  // belong to other prose. Two windows is the published shape.
  return windows.slice(0, 2)
}

/**
 * Parse one pricing row and keep the model-to-column mapping correct.
 *
 * The page renders `LABEL OFF-PEAK a b PEAK c d` per price group (or, on the
 * zh-CN copy, `LABEL 空闲时段 a b 高峰时段 c d`), but the label rows may be
 * reordered. The first price of a label belongs to the first model column, so
 * swapping the label order must swap which pair is peak rather than which model
 * is which.
 *
 * @param {string} text - tag-free page text.
 * @param {string} label - regex source for the row label.
 * @param {{ peak: string, offPeak: string }} labels - the variant's peak labels.
 * @param {string} [pricePattern] - regex source for one price cell.
 * @returns {{ peak: number[], offPeak: number[] } | null} per-model-column prices.
 */
function parseModelPricingRow(text, label, labels, pricePattern = '\\$?\\s*([\\d.]+)') {
  const cell = pricePattern
  const pattern = new RegExp(
    `${label}\\s*(${labels.offPeak}|${labels.peak})\\s*${cell}\\s*${cell}\\s*(${labels.offPeak}|${labels.peak})\\s*${cell}\\s*${cell}`,
    'i',
  )
  const match = pattern.exec(text)
  if (match === null) return null
  const isPeak = (value) => new RegExp(`^(?:${labels.peak})$`, 'i').test(String(value))
  const firstLabel = String(match[1])
  const secondLabel = String(match[4])
  if (isPeak(firstLabel) === isPeak(secondLabel)) return null
  const firstValues = [Number(match[2]), Number(match[3])]
  const secondValues = [Number(match[5]), Number(match[6])]
  return isPeak(firstLabel) ? { peak: firstValues, offPeak: secondValues } : { peak: secondValues, offPeak: firstValues }
}

/**
 * @param {unknown} value - candidate price.
 * @returns {boolean} whether it is a non-negative finite number.
 */
function isNonNegativePrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * @param {number} offPeak - off-peak price.
 * @param {number} peak - peak price.
 * @returns {boolean} whether one price group is sane.
 */
function isSanePricePair(offPeak, peak) {
  return isNonNegativePrice(offPeak) && isNonNegativePrice(peak) && peak > 0 && offPeak <= peak
}

/**
 * @param {unknown} windows - candidate peak windows.
 * @returns {boolean} whether they are usable `[start, end)` minute pairs.
 */
function isSanePeakWindows(windows) {
  if (!Array.isArray(windows)) return false
  for (const window of windows) {
    if (!Array.isArray(window) || window.length !== 2) return false
    const [start, end] = window
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false
    if (start < 0 || end < 0 || start > MINUTES_PER_DAY || end > MINUTES_PER_DAY) return false
    if (start === end) return false
  }
  return true
}

/**
 * Parse one copy of the official pricing page into a rate card.
 *
 * A page renders a MODEL row followed by three price groups (cache hit, cache
 * miss, output), each labelled with its peak and off-peak price per model
 * column. A redesign must fail explicitly (`null`), never return a
 * half-understood card: the output is validated for exactly two models with
 * three price groups each, non-negative finite prices, off-peak <= peak per
 * group, and peak windows inside a day.
 *
 * Both language copies are accepted, each with its own currency and the time
 * zone its windows are stated in; `pageVariant` records which one produced the
 * card so a USD card is never mistaken for a CNY one. The zone marker is
 * required — reading a Beijing window as UTC would shift every band by 8 hours.
 *
 * @param {string} content - response body (HTML or text).
 * @returns {{ rates: Record<string, RateCard | null>, peakWindows: number[][], weekdaysOnly: boolean, currency: string, symbol: string, models: string[], pageVariant: 'zh' | 'en', parserVersion: number } | null} parsed card, or `null` when the layout is unrecognized or fails validation.
 */
function parsePricingPage(content) {
  if (typeof content !== 'string' || content.length === 0) return null
  const text = markupToText(content)

  for (const [name, variant] of Object.entries(PRICING_PAGE_VARIANTS)) {
    const modelMatch = variant.model.exec(text)
    if (modelMatch === null) continue
    const models = [modelMatch[1], modelMatch[2]]
    if (models.length !== 2 || models[0] === models[1]) continue

    // A price cell is `¥2`, `2元`, or `$1.32`; the unit suffix is optional and
    // consumed by the cell pattern so the next number is not misread.
    const unit = variant.currency === 'CNY' ? '(?:元)?' : ''
    const pricePattern = `(?:[¥$]\\s*)?([\\d.]+)\\s*${unit}`
    const labels = { peak: variant.peak, offPeak: variant.offPeak }
    const hit = parseModelPricingRow(text, variant.hit, labels, pricePattern)
    const miss = parseModelPricingRow(text, variant.miss, labels, pricePattern)
    const output = parseModelPricingRow(text, variant.output, labels, pricePattern)
    if (hit === null || miss === null || output === null) continue

    const rates = {}
    let sane = true
    for (let index = 0; index < models.length; index += 1) {
      const hitPeak = hit.peak[index]
      const hitOffPeak = hit.offPeak[index]
      const missPeak = miss.peak[index]
      const missOffPeak = miss.offPeak[index]
      const outputPeak = output.peak[index]
      const outputOffPeak = output.offPeak[index]
      if (!isSanePricePair(hitOffPeak, hitPeak) || !isSanePricePair(missOffPeak, missPeak) || !isSanePricePair(outputOffPeak, outputPeak)) {
        sane = false
        break
      }
      rates[models[index]] = {
        input: missPeak,
        cacheRead: hitPeak,
        cacheWrite: missPeak,
        output: outputPeak,
        offPeakMultiplier: Math.max(0, Math.min(1, hitOffPeak / hitPeak)),
      }
    }
    if (!sane) continue
    const primary = rates[models[0]]
    if (primary !== undefined && primary !== null) rates.default = { ...primary }

    // The window zone must be stated. Without it the numbers are ambiguous and
    // a silent guess would move every peak/off-peak boundary.
    if (!variant.zone.test(text)) continue
    const windows = parsePeakWindows(text, variant.zoneOffsetMinutes)
    if (windows.length === 0) continue
    if (!isSanePeakWindows(windows)) continue
    return {
      rates,
      peakWindows: windows,
      weekdaysOnly: variant.weekday.test(text),
      currency: variant.currency,
      symbol: variant.symbol,
      models,
      pageVariant: name,
      parserVersion: PARSER_VERSION,
    }
  }
  return null
}

/**
 * Merge the two published copies into one dual-currency card.
 *
 * Each copy contributes the same model rows priced in its own currency, so the
 * result carries both instead of converting one into the other. The peak windows
 * are normalized to UTC by each parser, so the two copies must agree on them —
 * a disagreement means one of them was misread, and that copy is dropped rather
 * than silently overriding the other.
 *
 * @param {object | null} primary - card from the primary source.
 * @param {object | null} secondary - card from the other copy.
 * @returns {object | null} a card with `rates` (primary currency) plus `ratesByCurrency`.
 */
function mergeCurrencyCards(primary, secondary) {
  if (primary === null && secondary === null) return null
  const first = primary ?? secondary
  const second = secondary ?? primary
  const ratesByCurrency = { [String(first.currency)]: first.rates }
  // Only trust the second copy when it describes the same tariff: same model
  // columns and the same normalized peak windows.
  const compatible =
    first !== second &&
    second !== null &&
    first.currency !== second.currency &&
    Array.isArray(second.models) &&
    JSON.stringify(first.models) === JSON.stringify(second.models) &&
    JSON.stringify(first.peakWindows) === JSON.stringify(second.peakWindows)
  if (compatible) ratesByCurrency[String(second.currency)] = second.rates
  return {
    ...first,
    rates: first.rates,
    ratesByCurrency,
    pageVariants: [...new Set([first, ...(compatible ? [second] : [])].map((card) => card.pageVariant).filter((value) => typeof value === 'string'))],
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Normalize a list of `YYYY-MM-DD` date keys: drop invalid entries, dedupe, sort.
 *
 * @param {unknown} value - candidate list.
 * @returns {string[]} sorted unique date keys.
 */
function holidayDateList(value) {
  if (!Array.isArray(value)) return []
  const keys = []
  for (const entry of value) {
    if (isHolidayDate(entry)) keys.push(entry)
  }
  return [...new Set(keys)].sort()
}

/**
 * Merge the holiday sources into the sorted union plus its provenance.
 *
 * This is the single seam for holiday policy: the Host refresh controller calls
 * it with the validated (`auto`) calendar, configured (`manual`) extras, and
 * the current calendar year. Missing dates are never generated.
 *
 * @param {{ manual?: unknown, auto?: unknown, years?: number[] }} sources - date lists and optional year filter.
 * @returns {{ holidays: string[], holidayProvenance: { auto: string[], manual: string[], fixed: string[] } }} merged calendar.
 */
function mergeHolidayCalendar(sources) {
  const manual = holidayDateList(sources?.manual)
  const auto = holidayDateList(sources?.auto)
  const years = Array.isArray(sources?.years) ? sources.years.filter((year) => Number.isInteger(year)) : undefined
  const provenance = holidayProvenance({ manual, auto, years })
  return { holidays: provenanceDates(provenance), holidayProvenance: provenance }
}

/**
 * The legacy single-value label for which source supplied the calendar.
 *
 * @param {{ auto: string[], manual: string[], fixed: string[] }} provenance - merged provenance.
 * @returns {'auto' | 'manual' | 'fixed' | 'none'} calendar kind.
 */
function holidaysKindOf(provenance) {
  if (provenance.auto.length > 0) return 'auto'
  if (provenance.manual.length > 0) return 'manual'
  if (provenance.fixed.length > 0) return 'fixed'
  return 'none'
}

/**
 * Read provenance from a pricing snapshot/card, tolerating older states that
 * only kept a flat date list and a `holidaysSource` label.
 *
 * @param {object | null | undefined} pricing - pricing snapshot or catalog card.
 * @returns {{ auto: string[], manual: string[], fixed: string[] }} provenance arrays.
 */
function normalizeHolidayProvenance(pricing) {
  const provenance = pricing?.holidayProvenance
  if (provenance !== null && typeof provenance === 'object') {
    return {
      auto: holidayDateList(provenance.auto),
      manual: holidayDateList(provenance.manual),
      fixed: holidayDateList(provenance.fixed),
    }
  }
  const holidays = holidayDateList(pricing?.holidays)
  const source = pricing?.holidaysSource
  return {
    auto: source === 'auto' ? holidays : [],
    manual: source === 'manual' ? holidays : [],
    fixed: source === 'fixed' ? holidays : [],
  }
}

/**
 * @param {number} consecutiveFailures - failures in a row, 1-based.
 * @returns {number} delay before the next holiday attempt.
 */
function holidayRetryDelayMs(consecutiveFailures) {
  const index = Math.max(0, Math.min(HOLIDAY_RETRY_DELAYS_MS.length - 1, (typeof consecutiveFailures === 'number' ? consecutiveFailures : 1) - 1))
  return HOLIDAY_RETRY_DELAYS_MS[index]
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
      // The configured card is one currency; the fetched catalog adds the other
      // copy's table so a display can follow the interface language.
      ratesByCurrency: { [currency || 'CNY']: rates },
      peakWindows: fallbackWindows ?? DEFAULT_PEAK_WINDOWS.map((window) => [...window]),
      weekdaysOnly: weekdaysOnly ?? true,
      currency: currency || 'CNY',
      symbol: symbol || (currency === 'USD' ? '$' : '¥'),
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
 * Merge a catalog card with settings into one **rate epoch**.
 *
 * An epoch is a priced rate card together with the interval it was in force.
 * Instead of freezing one card per Session (which would charge a conversation
 * created yesterday every request it makes today at yesterday's prices), the
 * projection keeps an ordered list of epochs and classifies every request by its
 * own start time, so a price change splits the timeline and each request is
 * charged at the price that applied when it ran.
 *
 * The calendar contains only supplied dates for the card's year. A card keeps
 * its own year when replayed later; no future dates or estimates are generated.
 *
 * @param {object} card - catalog card.
 * @param {PluginSettings} settings - plugin settings.
 * @param {number} [createdAt] - Session creation time for a configured card.
 * @returns {object} pricing snapshot stored in projection state.
 */
function makePricingSnapshot(card, settings, createdAt) {
  const currency = settings.currency || card.currency || 'CNY'
  const calendarTime = card.fetchedAt > 0 ? card.fetchedAt : createdAt
  const years = Number.isInteger(card.holidayYear) ? [card.holidayYear] :
    typeof calendarTime === 'number' && Number.isFinite(calendarTime) && calendarTime >= MIN_CALENDAR_TIME_MS
      ? holidayYears(calendarTime, settings.holidayOffsetMinutes)
      : undefined
  const seed = normalizeHolidayProvenance(card)
  const provenance = holidayProvenance({
    manual: holidayDateList([...seed.manual, ...settings.holidays]),
    auto: seed.auto,
    years,
  })
  return {
    version: card.version,
    source: card.source,
    effectiveFrom: card.effectiveFrom,
    /** End of this epoch's validity; `null` means "still current". */
    effectiveTo: null,
    fetchedAt: card.fetchedAt,
    currency,
    symbol: settings.symbol || card.symbol || (currency === 'USD' ? '$' : '¥'),
    exchangeRate: settings.exchangeRate,
    peakWindows: settings.peakWindowsOverride ?? card.peakWindows,
    weekdaysOnly: settings.weekdaysOnlyOverride ?? card.weekdaysOnly,
    offPeakEnabled: settings.offPeakEnabled,
    reasoningBilling: settings.reasoningBilling,
    holidays: provenanceDates(provenance),
    holidaysSource: holidaysKindOf(provenance),
    holidayProvenance: provenance,
    holidayPolicyVersion: TARIFF_VERSION,
    parserVersion: typeof card.parserVersion === 'number' && Number.isFinite(card.parserVersion) ? card.parserVersion : null,
    pageVariant: typeof card.pageVariant === 'string' ? card.pageVariant : null,
    autoRefresh: {
      pricing: settings.pricingSource !== false,
      holidays: settings.holidaysSource !== false,
    },
    holidayOffsetMinutes: settings.holidayOffsetMinutes,
    rates: card.rates,
    /**
     * Every published currency's table for this epoch: `{ CNY: {...}, USD: {...} }`.
     * A display picks the table of the currency it shows, so both amounts come
     * from published prices and neither is a conversion of the other.
     */
    ratesByCurrency: (() => {
      const tables = card.ratesByCurrency !== null && typeof card.ratesByCurrency === 'object' ? card.ratesByCurrency : { [currency]: card.rates }
      // A configured `currency` override adds one table only when the catalog has
      // no table of its own; the catalog's own tables always win.
      const merged = { ...tables }
      if (merged[currency] === undefined) merged[currency] = card.rates
      return merged
    })(),
  }
}

/**
 * Pick the catalog epoch active at one moment.
 *
 * Epochs are ordered by `effectiveFrom` and each one is closed by the next
 * epoch's start (`effectiveTo`), so the answer is "the last epoch that started
 * at or before `timeMs`". A moment before the first epoch (a Session that began
 * before the plugin ever fetched a card) stays on that first epoch.
 *
 * @param {object[]} versions - catalog epochs sorted by effectiveFrom.
 * @param {number} timeMs - request start time.
 * @returns {object} the epoch in force at `timeMs`.
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
  const tableOf = (table) =>
    Object.keys(table)
      .sort()
      .map((key) => {
        const rate = table[key]
        if (rate === null || rate === undefined) return `${key}:null`
        return `${key}:${rate.input},${rate.cacheRead},${rate.cacheWrite},${rate.output},${rate.offPeakMultiplier}`
      })
      .join('|')
  // Every currency table is part of the priced identity: a card that only gains
  // the other copy's table changes what the display can show, so it must become
  // a new epoch instead of being folded into "metadata only".
  const byCurrency = card.ratesByCurrency !== null && typeof card.ratesByCurrency === 'object' ? card.ratesByCurrency : null
  const rates =
    byCurrency === null
      ? tableOf(card.rates)
      : Object.keys(byCurrency)
          .sort()
          .map((code) => `${code}=${tableOf(byCurrency[code] ?? {})}`)
          .join('~')
  const windows = (card.peakWindows ?? []).map((window) => window.join('-')).join(',')
  const holidays = (card.holidays ?? []).slice().sort().join(',')
  return `${rates}|${windows}|${card.weekdaysOnly}|${holidays}`
}

/**
 * In-memory, effective-dated pricing catalog.
 *
 * The configured card is version `config` at `effectiveFrom: 0`; each fetched
 * card whose priced parts differ becomes a new version effective at its fetch
 * time. Sessions do **not** freeze one version: they carry the whole timeline as
 * epochs and price each request by the epoch that was in force when it started,
 * so a rate change splits the conversation at the moment the price changed
 * instead of silently repricing (or failing to reprice) history.
 *
 * @param {PluginSettings} settings - resolved plugin settings.
 * @returns {{ versions: object[], ingest: (card: object, fetchedAt: number) => boolean, snapshotFor: (timeMs: number) => object, epochsFor: (createdAt: number) => object[] }} catalog.
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
      // Metadata that does not change the priced fingerprint still travels with
      // the version, so a snapshot describes its own card accurately.
      if (typeof card.parserVersion === 'number') latest.parserVersion = card.parserVersion
      if (typeof card.pageVariant === 'string') latest.pageVariant = card.pageVariant
      if (Array.isArray(card.pageVariants)) latest.pageVariants = [...card.pageVariants]
      if (typeof card.holidaysSource === 'string') latest.holidaysSource = card.holidaysSource
      if (card.holidayProvenance !== null && typeof card.holidayProvenance === 'object') latest.holidayProvenance = card.holidayProvenance
      return false
    }
    versions.push({ ...card, version: `official-${nextVersion}`, effectiveFrom: fetchedAt, fetchedAt })
    nextVersion += 1
    return true
  }

  /**
   * The rate timeline as a Session sees it: one snapshot per epoch, each closed
   * by the next epoch's start. A Session created before the first fetch still
   * gets that first epoch as its opening rate rather than an empty timeline.
   */
  const epochsFor = (createdAt) => {
    const snapshots = versions.map((version) => makePricingSnapshot(version, settings, createdAt))
    for (let index = 0; index < snapshots.length - 1; index += 1) {
      snapshots[index].effectiveTo = snapshots[index + 1].effectiveFrom
    }
    return snapshots
  }

  const snapshotFor = (timeMs) =>
    makePricingSnapshot(
      resolvePricingAt(versions, typeof timeMs === 'number' && Number.isFinite(timeMs) ? timeMs : 0),
      settings,
      timeMs,
    )

  return { versions, ingest, snapshotFor, epochsFor }
}

// ---------------------------------------------------------------------------
// Tariff policy — canonical (shared/tariff), never restated here
// ---------------------------------------------------------------------------

/**
 * Classify one request time into a tariff band under a frozen policy.
 *
 * An empty calendar grants no holiday exemption; weekend and time-window
 * rules still apply. Historical epochs retain their recorded policy.
 *
 * @param {number} timeMs - request start time.
 * @param {object} pricing - frozen session pricing snapshot.
 * @returns {'peak' | 'offPeak'} the band.
 */
function bandOf(timeMs, pricing) {
  const peakWindows = Array.isArray(pricing.peakWindows) ? pricing.peakWindows : DEFAULT_PEAK_WINDOWS
  const weekdaysOnly = pricing.weekdaysOnly
  return canonicalBandAt(timeMs, {
    peakWindows,
    weekdaysOnly,
    offPeakEnabled: pricing.offPeakEnabled,
    holidayOffsetMinutes: pricing.holidayOffsetMinutes,
    holidays: pricing.holidays,
  })
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
 * The official model a route's model id belongs to, when it names one.
 *
 * @param {string} model - route model id, possibly prefixed by a gateway.
 * @returns {string | null} official model name, or `null` when unrecognized.
 */
function officialModelOf(model) {
  const value = typeof model === 'string' ? model.toLowerCase() : ''
  if (value.length === 0) return null
  for (const alias of MODEL_ALIASES) {
    if (alias.pattern.test(value)) return alias.model
  }
  return null
}

/**
 * Whether a route is outside this meter's scope.
 *
 * @param {string} provider - provider id.
 * @returns {boolean} excluded.
 */
function isExcludedRoute(provider) {
  return EXCLUDED_PROVIDERS.includes(String(provider))
}

/**
 * Find the rate card for one route.
 *
 * Lookup order:
 * 1. the exact `"<provider>/<model>"` key (also `<model>` alone), which always
 *    wins because it is what the operator configured;
 * 2. the official model *family* the id names (`MODEL_ALIASES`), so a gateway
 *    route whose id names a DeepSeek model is priced from that model's row
 *    rather than the generic `default` row;
 * 3. `default`, but only for a known DeepSeek provider.
 *
 * An excluded provider (`EXCLUDED_PROVIDERS`) is reported as `excluded` — it is
 * billed somewhere else and must never be priced from this page. Any other
 * foreign route that names no DeepSeek family stays **unpriced** instead of
 * being silently priced as a DeepSeek model, which would be a made-up number.
 *
 * `basis` tells the view how much to trust the match: `exact` (configured key),
 * `family` (official row reached through an alias) or `default` (guess).
 *
 * @param {Record<string, RateCard | null>} table - rate card.
 * @param {string} provider - provider id.
 * @param {string} model - model id.
 * @returns {{ rate: RateCard, matched: string, basis: 'exact' | 'family' | 'default', exact: boolean } | { excluded: true } | null} match.
 */
function findRate(table, provider, model) {
  if (isExcludedRoute(provider)) return { excluded: true }
  const lookup = (key) => (Object.hasOwn(table, key) && table[key] !== null && table[key] !== undefined ? table[key] : null)
  const direct = lookup(`${provider}/${model}`)
  if (direct !== null) return { rate: direct, matched: `${provider}/${model}`, basis: 'exact', exact: true }
  const byModel = lookup(model)
  if (byModel !== null) return { rate: byModel, matched: model, basis: 'exact', exact: true }
  const official = officialModelOf(model)
  const deepseekProvider = KNOWN_DEEPSEEK_PROVIDERS.includes(String(provider))
  if (official !== null) {
    const family = lookup(official)
    if (family !== null) {
      // A DeepSeek provider's own route is an exact match once the family is
      // known; a third-party gateway is only an estimate of the same model.
      return { rate: family, matched: official, basis: 'family', exact: deepseekProvider }
    }
  }
  if (!deepseekProvider) return null
  const fallback = lookup('default')
  return fallback === null ? null : { rate: fallback, matched: 'default', basis: 'default', exact: false }
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
 * Both bands are rounded into integer bucket rows first and the total is their
 * sum, so `sum(buckets) === micros` holds exactly — the rows a dialog shows can
 * never drift from the total by a rounding unit.
 *
 * @param {TokenBuckets} tokens - buckets to price.
 * @param {RateCard} rate - rate card.
 * @param {object} pricing - rate epoch.
 * @param {'peak' | 'offPeak'} band - band.
 * @returns {{ micros: number, savedMicros: number, buckets: TokenBuckets }} integer micro-currency.
 */
function priceTokens(tokens, rate, pricing, band) {
  const parts = priceParts(tokens, rate, pricing.reasoningBilling)
  const fx = pricing.exchangeRate ?? 1
  const multiplier = band === 'peak' || pricing.offPeakEnabled === false ? 1 : rate.offPeakMultiplier
  const scaled = {
    input: parts.input * multiplier * fx,
    cacheRead: parts.cacheRead * multiplier * fx,
    cacheWrite: parts.cacheWrite * multiplier * fx,
    output: parts.output * multiplier * fx,
    reasoning: parts.reasoning * multiplier * fx,
  }
  const buckets = roundParts(scaled, parts)
  const micros = sumParts(buckets)
  const baseMicros = Math.round(sumParts(parts) * fx)
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
  return { provider, model, calls: 0, tokens: zeroTokens(), peak: emptyBand(), offPeak: emptyBand(), epochs: {} }
}

/** @param {object[]} epochs - rate epochs. @returns {object[]} a deep-enough copy. */
function cloneEpochs(epochs) {
  return epochs.map((epoch) => ({ ...epoch }))
}

/**
 * @param {object[]} epochs - the rate timeline at Session init.
 * @param {string | null} [sessionId] - this Session's id, so a computed view can
 *   register its own amount for a parent's subtree total.
 * @returns {object} the projection's initial state.
 */
function initialState(epochs, sessionId = null) {
  const list = Array.isArray(epochs) ? cloneEpochs(epochs) : [epochs]
  return {
    epochs: list,
    pricing: list[list.length - 1],
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    calls: 0,
    tokens: zeroTokens(),
    peak: emptyBand(),
    offPeak: emptyBand(),
    models: {},
    route: null,
    stepStartedAt: null,
    attemptStartedAt: null,
    last: null,
    // Session ids this Session delegated to (`subagent/catalog`), in order.
    children: [],
  }
}

/**
 * Merge the Host catalog into a Session's rate timeline.
 *
 * The catalog is live (a refresh can add an epoch at any time) while the fold
 * state is durable, so the timeline is reconciled on every event: epochs the
 * state has never seen are appended, and the epoch before each new one is
 * closed at the new `effectiveFrom`. Billed facts are untouched — they are keyed
 * by epoch, so appending an epoch can only affect *future* requests.
 *
 * @param {object} state - fold state.
 * @param {object[]} epochs - the Host catalog's epochs (`createPricingCatalog`).
 * @returns {object} the same state, or a new one when the timeline grew.
 */
function syncEpochs(state, epochs) {
  if (!Array.isArray(epochs) || epochs.length === 0) return state
  const known = state.epochs ?? []
  const seen = new Set(known.map((epoch) => epoch.effectiveFrom))
  const added = epochs.filter((epoch) => !seen.has(epoch.effectiveFrom))
  if (added.length === 0) return state
  const merged = cloneEpochs(known)
  for (const epoch of added) {
    // Keep the timeline sorted and close the preceding epoch.
    let index = merged.length
    while (index > 0 && merged[index - 1].effectiveFrom > epoch.effectiveFrom) index -= 1
    merged.splice(index, 0, { ...epoch })
    if (index > 0) merged[index - 1] = { ...merged[index - 1], effectiveTo: epoch.effectiveFrom }
    if (index + 1 < merged.length) merged[index] = { ...merged[index], effectiveTo: merged[index + 1].effectiveFrom }
  }
  const latest = merged[merged.length - 1]
  const current = state.pricing
  const pricing = current !== undefined && current !== null && typeof current.effectiveFrom === 'number' && current.effectiveFrom > latest.effectiveFrom ? current : latest
  return { ...state, epochs: merged, pricing }
}

/**
 * Append a calendar-policy boundary to legacy checkpoints, retaining their
 * rates and billed bands. Do not bump stateVersion and force a full reprice.
 * The activation timestamp is stable across view reads in this process.
 */
function upgradeHolidayPolicy(state, activatedAt, settings) {
  const current = epochAt(state, activatedAt)
  if (current?.holidayPolicyVersion >= TARIFF_VERSION) return state
  const seed = normalizeHolidayProvenance(current)
  const calendar = mergeHolidayCalendar({
    auto: seed.auto,
    manual: [...seed.manual, ...settings.holidays],
    years: holidayYears(activatedAt, settings.holidayOffsetMinutes),
  })
  return syncEpochs(state, [{
    ...current,
    ...calendar,
    holidaysSource: holidaysKindOf(calendar.holidayProvenance),
    holidayPolicyVersion: TARIFF_VERSION,
    version: `${current.version}:holidays-v${TARIFF_VERSION}`,
    effectiveFrom: activatedAt,
    effectiveTo: null,
  }])
}

/**
 * The rate epoch in force at one moment.
 *
 * @param {object} state - fold state.
 * @param {number} timeMs - request start time.
 * @returns {object} the epoch.
 */
function epochAt(state, timeMs) {
  const epochs = Array.isArray(state.epochs) && state.epochs.length > 0 ? state.epochs : [state.pricing]
  return resolvePricingAt(epochs, typeof timeMs === 'number' && Number.isFinite(timeMs) ? timeMs : 0)
}

/**
 * Add (or remove, with `sign = -1`) one contribution from the state.
 *
 * The same facts are kept three ways so the view never has to re-fold: the whole
 * Session, each model, and each (model, rate epoch) — the last one is what lets
 * one conversation be priced at two different rate cards without prorating.
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

  const epochKey = String(contribution.epoch)
  const models = { ...state.models }
  const key = contribution.modelKey
  const current = models[key] ?? emptyModel(contribution.provider ?? 'unknown', contribution.model ?? 'unknown')
  const currentEpoch = current.epochs[epochKey] ?? emptyModel(contribution.provider ?? 'unknown', contribution.model ?? 'unknown')
  const nextEpoch = {
    ...currentEpoch,
    tokens: cloneTokens(currentEpoch.tokens),
    peak: { calls: currentEpoch.peak.calls, tokens: cloneTokens(currentEpoch.peak.tokens) },
    offPeak: { calls: currentEpoch.offPeak.calls, tokens: cloneTokens(currentEpoch.offPeak.tokens) },
  }
  nextEpoch.calls += sign
  for (const name of Object.keys(nextEpoch.tokens)) {
    const value = contribution.tokens[name] ?? 0
    nextEpoch.tokens[name] += sign * value
    if (band === 'offPeak') nextEpoch.offPeak.tokens[name] += sign * value
    else nextEpoch.peak.tokens[name] += sign * value
  }
  nextEpoch[band].calls += sign
  // The epoch cell is a leaf: its own per-epoch split stays empty so a view can
  // never recurse into it.
  nextEpoch.epochs = {}

  const nextModel = {
    ...current,
    calls: current.calls + sign,
    tokens: cloneTokens(current.tokens),
    peak: { calls: current.peak.calls, tokens: cloneTokens(current.peak.tokens) },
    offPeak: { calls: current.offPeak.calls, tokens: cloneTokens(current.offPeak.tokens) },
    epochs: { ...current.epochs },
  }
  for (const name of Object.keys(nextModel.tokens)) {
    const value = contribution.tokens[name] ?? 0
    nextModel.tokens[name] += sign * value
    if (band === 'offPeak') nextModel.offPeak.tokens[name] += sign * value
    else nextModel.peak.tokens[name] += sign * value
  }
  nextModel[band].calls += sign
  if (nextEpoch.calls <= 0) delete nextModel.epochs[epochKey]
  else nextModel.epochs[epochKey] = nextEpoch
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
 * Build the raw contribution for one usage sample under the Session policy.
 *
 * The band and the rate epoch both come from the **request start** time, so a
 * request is priced by when it ran, not by when it settled or when the Session
 * was created.
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
  const time = typeof sampleTime === 'number' && Number.isFinite(sampleTime) ? sampleTime : 0
  const epoch = epochAt(state, time)
  return {
    turn: event.data.turn,
    step: event.data.step,
    modelKey: `${provider}/${model}`,
    provider,
    model,
    epoch: typeof epoch.effectiveFrom === 'number' ? epoch.effectiveFrom : 0,
    band: bandOf(time, epoch),
    tokens: cloneTokens(tokens),
  }
}

/** Compare two contributions for the replacement rule. */
function sameContribution(left, right) {
  return (
    left.modelKey === right.modelKey &&
    left.epoch === right.epoch &&
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
 * @param {object[]} [epochs] - the live rate timeline, when the Host has one.
 * @returns {object} next state.
 */
function foldEvent(state, event, epochs) {
  const synced = epochs === undefined ? state : syncEpochs(state, epochs)
  switch (event.type) {
    case 'request/header': {
      const config = event.data?.header?.config
      if (config === null || typeof config !== 'object') return synced
      const provider = typeof config.provider === 'string' ? config.provider : synced.route?.provider
      const model = typeof config.model === 'string' ? config.model : synced.route?.model
      if (provider === synced.route?.provider && model === synced.route?.model) return synced
      return { ...synced, route: { provider: provider ?? 'unknown', model: model ?? 'unknown' } }
    }
    case 'request/context': {
      const provider = typeof event.data?.provider === 'string' ? event.data.provider : synced.route?.provider
      const model = typeof event.data?.model === 'string' ? event.data.model : synced.route?.model
      if (provider === synced.route?.provider && model === synced.route?.model) return synced
      return { ...synced, route: { provider: provider ?? 'unknown', model: model ?? 'unknown' } }
    }
    case 'step/start':
      return { ...synced, stepStartedAt: event.time, attemptStartedAt: null }
    case 'llm/retry-started':
      // A retry is a new request: it gets its own start time, so a step that
      // began inside one band and retried inside another is billed in both.
      if (synced.last === null || synced.last.turn !== event.data?.turn || synced.last.step !== event.data?.step) {
        return { ...synced, attemptStartedAt: event.time }
      }
      return { ...synced, attemptStartedAt: event.time, last: null }
    case 'subagent/catalog': {
      // Durable, ordered child registration: the parent's own log records the
      // ids of the Sessions it delegated to, which is what lets the view report
      // a whole-tree total without loading child sessions during the fold.
      const childId = event.data?.childId
      if (typeof childId !== 'string' || childId.length === 0) return synced
      const children = synced.children ?? []
      if (children.includes(childId)) return synced
      return { ...synced, children: [...children, childId] }
    }
    case 'assistant/message':
    case 'assistant/attempt': {
      const usage = usageOf(event)
      if (usage === null) return synced
      const tokens = normalizeTokens(usage)
      if (totalTokens(tokens) === 0) return synced
      const turn = event.data.turn
      const step = event.data.step
      const previous = synced.last !== null && synced.last.turn === turn && synced.last.step === step ? synced.last : null
      const contribution = contributionOf(tokens, synced, event)
      if (previous !== null && sameContribution(previous, contribution)) return synced
      let next = synced
      if (previous !== null) next = applyContribution(next, previous, -1)
      next = applyContribution(next, contribution, 1)
      return { ...next, last: contribution }
    }
    default:
      return synced
  }
}

// ---------------------------------------------------------------------------
// Wire view
// ---------------------------------------------------------------------------

/**
 * Price one model entry under one rate epoch.
 *
 * @param {ModelEntry} entry - billed facts for that epoch.
 * @param {object} pricing - the rate epoch they were billed under.
 * @returns {object} priced entry.
 */
function priceModel(entry, pricing, currency = null) {
  // Each published copy prices the same tokens in its own currency, so the
  // display currency selects a rate table rather than converting one amount.
  const table =
    currency !== null && pricing.ratesByCurrency !== null && typeof pricing.ratesByCurrency === 'object' && pricing.ratesByCurrency[currency] !== undefined
      ? pricing.ratesByCurrency[currency]
      : pricing.rates
  const match = findRate(table, entry.provider, entry.model)
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
  // An excluded route is out of scope, not a $0 price: it keeps its token facts
  // (so the dialog can say what was skipped) but contributes no money.
  if (match !== null && match.excluded === true) return { ...base, excluded: true, unpriced: false, estimated: false }
  if (match === null) return { ...base, excluded: false, unpriced: true, estimated: false }

  const fx = pricing.exchangeRate ?? 1
  const multiplier = pricing.offPeakEnabled === false ? 1 : match.rate.offPeakMultiplier
  const peakParts = priceParts(entry.peak.tokens, match.rate, pricing.reasoningBilling)
  const offParts = priceParts(entry.offPeak.tokens, match.rate, pricing.reasoningBilling)
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
  // Derive the band totals from the rounded rows so the displayed rows, the
  // band subtotals and the row total are one consistent set of integers.
  const peakMicros = roundParts(
    {
      input: peakParts.input * fx,
      cacheRead: peakParts.cacheRead * fx,
      cacheWrite: peakParts.cacheWrite * fx,
      output: peakParts.output * fx,
      reasoning: peakParts.reasoning * fx,
    },
    peakParts,
  )
  const offBaseMicros = Math.round(sumParts(offParts) * fx)
  return {
    ...base,
    peak: { ...base.peak, micros: sumParts(peakMicros) },
    offPeak: { ...base.offPeak, micros: sumParts(bucketMicros) - sumParts(peakMicros) },
    micros: sumParts(bucketMicros),
    savedMicros: Math.max(0, offBaseMicros - (sumParts(bucketMicros) - sumParts(peakMicros))),
    bucketMicros,
    excluded: false,
    unpriced: false,
    estimated: !match.exact,
  }
}

/**
 * Sum a Session's own money plus every descendant Session's, from a lookup table.
 *
 * Delegated Sessions are separate Sessions with their own logs, so a parent's
 * own fold never sees their usage. The table is the Host's cache of each
 * Session's own wire amount (`own`), keyed by id; it also carries each entry's
 * own children so a grandchild is reachable without loading anything in the
 * fold. Missing entries (a child that was never folded in this process, e.g. a
 * restored history) are counted as absent rather than as zero-cost, so the
 * caller can report the difference instead of silently under-reporting.
 *
 * @param {object} state - fold state (its `children` are the direct children).
 * @param {(id: string) => {own: Record<string, number>, calls: number, children: string[]} | undefined} lookup - the Host cache reader.
 * @param {string} currency - which per-currency amount to add.
 * @returns {{ total: number, own: number, children: number, childCount: number, unknown: number, calls: number }} subtree money.
 */
function subtreeOf(state, lookup, currency = null) {
  const own = 0
  const direct = Array.isArray(state.children) ? state.children : []
  const seen = new Set()
  let descendants = 0
  let childCount = 0
  let calls = 0
  let unknown = 0
  const stack = direct.map((id) => ({ id, depth: 1 }))
  while (stack.length > 0) {
    const { id } = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const entry = typeof lookup === 'function' ? lookup(id) : undefined
    if (entry === undefined || entry === null) {
      unknown += 1
      continue
    }
    childCount += 1
    // A cached entry carries one amount per published currency. A child that has
    // no amount in the displayed currency is *unknown* for this currency, not a
    // free child: counting it as 0 would understate a USD total that the cache
    // only knows in CNY.
    const byCurrency = entry.own !== null && typeof entry.own === 'object' ? entry.own : {}
    const amount = currency !== null ? byCurrency[currency] : undefined
    if (!Number.isFinite(amount)) {
      unknown += 1
      // Still walk its descendants: a grandchild may have the currency.
      for (const grandchild of Array.isArray(entry.children) ? entry.children : []) stack.push({ id: grandchild })
      continue
    }
    descendants += amount
    calls += Number.isFinite(entry.calls) ? entry.calls : 0
    for (const grandchild of Array.isArray(entry.children) ? entry.children : []) stack.push({ id: grandchild })
  }
  return { own, children: descendants, childCount, unknown, calls }
}

/**
 * Project the fold state into the client-visible value.
 *
 * Every request is priced by the epoch that was in force when it started, so a
 * conversation that spans a price change reports the true sum of what each of
 * its requests cost. The wire value stays one total plus one total per model;
 * `pricing.epochs` documents the timeline, and each model row carries the
 * per-epoch split so a mixed row can show why it is not `tokens × rate`.
 *
 * The Session's own amount is `micros`; `subtree` adds the money of every
 * Session it delegated to, which is what the pill shows, because a task that ran
 * through sub-agents costs far more than the parent's own requests.
 *
 * @param {object} state - fold state.
 * @param {object | null} [status] - live Host state (freshness, degradation). It is
 *   deliberately **not** part of the billed facts: the epochs say what this
 *   session is priced with, `status` says how current the Host's data is.
 * @param {(id: string) => object | undefined} [lookup] - Host cache of other
 *   Sessions' own amounts, used for the subtree total.
 * @returns {object} the `tokenCost` wire value.
 */
function viewOf(state, status = null, lookup = undefined, currency = null, pinnedCurrency = null) {
  const epochs = Array.isArray(state.epochs) && state.epochs.length > 0 ? state.epochs : [state.pricing]
  const current = state.pricing ?? epochs[epochs.length - 1]
  // The currency this view is priced in: the requested one when the *current*
  // epoch has a published table for it, otherwise the epoch's own currency.
  // Reporting the fallback (rather than pricing CNY numbers under a `$` sign)
  // keeps a missing table visible instead of silently mislabeling the amount.
  const available = current.ratesByCurrency !== null && typeof current.ratesByCurrency === 'object' ? Object.keys(current.ratesByCurrency) : [current.currency]
  const shown = typeof currency === 'string' && currency.length > 0 && available.includes(currency) ? currency : current.currency
  const symbol = SYMBOL_OF_CURRENCY[shown] ?? current.symbol
  /** Whether one epoch can be priced in `shown` at all. */
  const epochHasCurrency = (epoch) => {
    const tables = epoch.ratesByCurrency
    if (tables === null || tables === undefined) return epoch.currency === shown
    return tables[shown] !== undefined
  }
  let unpricedByCurrency = 0

  const priced = Object.values(state.models).map((entry) => {
    // One model row can span epochs; price each slice under its own epoch and
    // then add them, which is exactly what the provider would have charged. An
    // epoch that never published this currency is counted as unpriced rather
    // than billed at another currency's rate.
    const slices = Object.entries(entry.epochs ?? {}).map(([epochKey, epochEntry]) => {
      const epoch = epochs.find((candidate) => String(candidate.effectiveFrom) === epochKey) ?? current
      if (!epochHasCurrency(epoch)) {
        unpricedByCurrency += epochEntry.calls
        return { epoch, entry: epochEntry, priced: null }
      }
      return { epoch, entry: epochEntry, priced: priceModel(epochEntry, epoch, shown) }
    })
    if (slices.length === 0) {
      if (!epochHasCurrency(current)) return { ...priceModel(entry, current, shown), epochs: [], unpriced: true, micros: 0, bucketMicros: zeroTokens() }
      return { ...priceModel(entry, current, shown), epochs: [] }
    }
    const pricedParts = slices.map((slice) => slice.priced).filter((part) => part !== null)
    const total = {
      provider: entry.provider,
      model: entry.model,
      calls: entry.calls,
      tokens: cloneTokens(entry.tokens),
      micros: 0,
      savedMicros: 0,
      excluded: false,
      unpriced: false,
      estimated: false,
    }
    const bucketMicros = zeroTokens()
    const peakTokens = zeroTokens()
    const offPeakTokens = zeroTokens()
    let peakCalls = 0
    let offPeakCalls = 0
    let peakMicros = 0
    let offPeakMicros = 0
    for (const part of pricedParts) {
      total.micros += part.micros
      total.savedMicros += part.savedMicros
      peakMicros += part.peak.micros
      offPeakMicros += part.offPeak.micros
      peakCalls += part.peak.calls
      offPeakCalls += part.offPeak.calls
      total.excluded = total.excluded || part.excluded === true
      total.unpriced = total.unpriced || part.unpriced === true
      total.estimated = total.estimated || part.estimated === true
      for (const name of Object.keys(bucketMicros)) {
        bucketMicros[name] += part.bucketMicros[name]
        peakTokens[name] += part.peak.tokens[name] ?? 0
        offPeakTokens[name] += part.offPeak.tokens[name] ?? 0
      }
    }
    return {
      ...total,
      peak: { calls: peakCalls, micros: peakMicros, tokens: peakTokens },
      offPeak: { calls: offPeakCalls, micros: offPeakMicros, tokens: offPeakTokens },
      bucketMicros,
      epochs: slices.map((slice) => ({
        effectiveFrom: slice.epoch.effectiveFrom,
        effectiveTo: slice.epoch.effectiveTo ?? null,
        version: slice.epoch.version,
        currency: slice.epoch.currency,
        symbol: slice.epoch.symbol,
        rateBasis: (() => {
          if (slice.priced === null) return 'unpriced'
          const table = slice.epoch.ratesByCurrency?.[shown] ?? slice.epoch.rates
          const match = findRate(table, entry.provider, entry.model)
          if (match === null) return 'unpriced'
          if (match.excluded === true) return 'excluded'
          return match.exact ? 'exact' : match.basis
        })(),
        calls: slice.entry.calls,
        tokens: slice.entry.tokens,
        micros: slice.priced === null ? 0 : slice.priced.micros,
        savedMicros: slice.priced === null ? 0 : slice.priced.savedMicros,
      })),
    }
  })
  priced.sort((left, right) => right.micros - left.micros || right.calls - left.calls || `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`))

  let micros = 0
  let peakMicros = 0
  let offPeakMicros = 0
  let savedMicros = 0
  let unpricedCalls = 0
  let estimatedCalls = 0
  let excludedCalls = 0
  let excludedTokens = 0
  const bucketMicros = zeroTokens()
  for (const entry of priced) {
    micros += entry.micros
    peakMicros += entry.peak.micros
    offPeakMicros += entry.offPeak.micros
    savedMicros += entry.savedMicros
    if (entry.unpriced) unpricedCalls += entry.calls
    if (entry.estimated) estimatedCalls += entry.calls
    if (entry.excluded) {
      excludedCalls += entry.calls
      excludedTokens += totalTokens(entry.tokens)
      continue
    }
    for (const name of Object.keys(bucketMicros)) bucketMicros[name] += entry.bucketMicros[name]
  }

  // Excluded routes are removed from the money and the token totals: showing
  // gateway traffic inside a DeepSeek bill would silently inflate both.
  const tokens = cloneTokens(state.tokens)
  const peakTokens = cloneTokens(state.peak.tokens)
  const offPeakTokens = cloneTokens(state.offPeak.tokens)
  let peakCalls = state.peak.calls
  let offPeakCalls = state.offPeak.calls
  if (excludedCalls > 0) {
    for (const entry of priced) {
      if (!entry.excluded) continue
      for (const name of Object.keys(tokens)) {
        tokens[name] -= entry.tokens[name] ?? 0
        peakTokens[name] -= entry.peak.tokens[name] ?? 0
        offPeakTokens[name] -= entry.offPeak.tokens[name] ?? 0
      }
      peakCalls -= entry.peak.calls
      offPeakCalls -= entry.offPeak.calls
    }
  }
  const billedCalls = state.calls - excludedCalls

  // The totals are in the currency this view was priced in. A timeline that
  // crossed a currency is priced per epoch from that epoch's own table, so the
  // total stays exact; `currencyMixed` records that the segments differed.
  const currencies = new Set(epochs.filter((epoch) => epoch.currency).map((epoch) => epoch.currency))
  // Delegated Sessions bill separately, so the parent's own fold cannot see
  // them. `subtree` adds what the Host cache knows about them; `unknownCount`
  // says how many children had no cached amount (so the total is a lower bound).
  const subtree = subtreeOf(state, lookup, shown)
  return {
    currency: shown,
    symbol,
    /** Every currency this view has a published table for. */
    currencies: available,
    /** Set when the row config pins a currency, so the UI does not follow its language. */
    pinnedCurrency: typeof pinnedCurrency === 'string' && available.includes(pinnedCurrency) ? pinnedCurrency : null,
    currencyMixed: currencies.size > 1,
    /** Requests whose epoch never published this currency (so they are not in the amount). */
    unpricedByCurrency,
    status,
    calls: billedCalls,
    excludedCalls,
    excludedTokens,
    unpricedCalls,
    estimatedCalls,
    micros,
    peakMicros,
    offPeakMicros,
    savedMicros,
    subtree: {
      micros: micros + subtree.children,
      ownMicros: micros,
      childrenMicros: subtree.children,
      childCount: subtree.childCount,
      unknownCount: subtree.unknown,
      calls: billedCalls + subtree.calls,
    },
    tokens,
    bucketMicros,
    peak: { calls: peakCalls, micros: peakMicros, tokens: peakTokens },
    offPeak: { calls: offPeakCalls, micros: offPeakMicros, tokens: offPeakTokens },
    models: priced.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      calls: entry.calls,
      excludedCalls: entry.excluded ? entry.calls : 0,
      unpricedCalls: entry.unpriced ? entry.calls : 0,
      estimatedCalls: entry.estimated ? entry.calls : 0,
      micros: entry.micros,
      savedMicros: entry.savedMicros,
      tokens: entry.tokens,
      peak: entry.peak,
      offPeak: entry.offPeak,
      epochs: entry.epochs,
    })),
    pricing: {
      version: current.version,
      source: current.source,
      effectiveFrom: current.effectiveFrom,
      fetchedAt: current.fetchedAt,
      currency: shown,
      symbol,
      /** Currencies with a published table for this epoch. */
      currencies: available,
      exchangeRate: current.exchangeRate,
      peakWindows: current.peakWindows.map((window) => [...window]),
      weekdaysOnly: current.weekdaysOnly,
      offPeakEnabled: current.offPeakEnabled,
      reasoningBilling: current.reasoningBilling,
      holidays: [...(current.holidays ?? [])],
      holidaysSource: current.holidaysSource ?? 'none',
      holidayProvenance: normalizeHolidayProvenance(current),
      parserVersion: typeof current.parserVersion === 'number' && Number.isFinite(current.parserVersion) ? current.parserVersion : null,
      pageVariant: typeof current.pageVariant === 'string' ? current.pageVariant : null,
      autoRefresh: {
        pricing: current.autoRefresh?.pricing === true,
        holidays: current.autoRefresh?.holidays === true,
      },
      holidayOffsetMinutes: current.holidayOffsetMinutes,
      epochs: epochs.map((epoch) => ({
        version: epoch.version,
        effectiveFrom: epoch.effectiveFrom,
        effectiveTo: epoch.effectiveTo ?? null,
        fetchedAt: epoch.fetchedAt,
        currency: epoch.currency,
        symbol: epoch.symbol,
        source: epoch.source,
        pageVariant: typeof epoch.pageVariant === 'string' ? epoch.pageVariant : null,
        // Peak rates per 1M tokens in the displayed currency, so the dialog can
        // show what each segment charged without a second Host read.
        rates: Object.fromEntries(
          Object.entries(epoch.ratesByCurrency?.[shown] ?? epoch.rates ?? {})
            .filter(([, rate]) => rate !== null && rate !== undefined)
            .map(([key, rate]) => [key, { input: rate.input, cacheRead: rate.cacheRead, cacheWrite: rate.cacheWrite, output: rate.output }]),
        ),
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// Refresh controller
// ---------------------------------------------------------------------------

/** @param {unknown} result - a `web.fetch` result. @returns {number | null} status code. */
function responseStatusCode(result) {
  const statusCode = result !== null && typeof result === 'object' ? result.statusCode : undefined
  return typeof statusCode === 'number' && Number.isFinite(statusCode) ? statusCode : null
}

/** @param {unknown} result - a `web.fetch` result. @returns {boolean} whether it is 2xx. */
function isSuccessfulResponse(result) {
  const statusCode = responseStatusCode(result)
  return statusCode !== null && statusCode >= 200 && statusCode < 300
}

/** @param {unknown} result - a `web.fetch` result. @returns {string} response text. */
function responseContent(result) {
  const content = result !== null && typeof result === 'object' ? result.body?.content : undefined
  return typeof content === 'string' ? content : ''
}

/**
 * @param {unknown} timeoutMs - fetch timeout.
 * @returns {AbortSignal | undefined} a timeout signal when the runtime has one.
 */
function fetchSignal(timeoutMs) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && typeof timeoutMs === 'number' && timeoutMs > 0) {
      return AbortSignal.timeout(timeoutMs)
    }
  } catch {
    // Fall through: fetching without a signal is better than not fetching.
  }
  return undefined
}

/** @param {unknown} error - anything thrown. @returns {string} a human-readable message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Independent refresh loops for the two external data sources.
 *
 * The two sources are scheduled independently: a slow or failing holiday source
 * must never delay the pricing refresh, and vice versa. The controller keeps the
 * last *good* card for each source, so a failed attempt only changes the live
 * status (freshness/degradation), never the frozen catalog. Holiday refreshes
 * that fail completely are retried with a short backoff (5 min, 15 min, then
 * hourly) instead of being recorded as a successful 24 h refresh; a success
 * returns to `settings.holidayRefreshIntervalMs`.
 *
 * All I/O is injected so tests never touch the network or real timers:
 * `{ web, settings, logger, now, timers, onCard, onStatus, disposed }`, where
 * `timers` is `{ setTimeout, clearTimeout, setInterval, clearInterval }`,
 * `now` returns epoch milliseconds, and `disposed` is either a predicate or a
 * boolean. `onCard(card)` receives the full effective catalog card (prices,
 * holiday union, provenance, `fetchedAt`); `onStatus(status)` receives the live
 * `view.status` payload (without `catalogVersion`, which only the Host view
 * knows).
 *
 * @param {object} [options] - injected dependencies, see above.
 * @returns {{ start: () => void, stop: () => void, status: () => object, refreshPricing: () => Promise<void>, refreshHolidays: () => Promise<void>, retryDelayMs: (consecutiveFailures: number) => number }} controller.
 */
function createRefreshController(options = {}) {
  const settings = typeof options.settings === 'object' && options.settings !== null ? options.settings : {}
  const web = options.web
  const logger = options.logger ?? {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timers = options.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval }
  const onCard = typeof options.onCard === 'function' ? options.onCard : () => {}
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {}
  const disposedOption = options.disposed
  const isDisposed = () => (typeof disposedOption === 'function' ? disposedOption() === true : disposedOption === true)

  const pricingEnabled = settings.pricingSource !== false
  const holidaysEnabled = settings.holidaysSource !== false
  const pricingInterval = numberIn(settings.refreshIntervalMs, DEFAULT_REFRESH_MS, MIN_REFRESH_MS, MAX_REFRESH_MS)
  const holidayInterval = numberIn(settings.holidayRefreshIntervalMs, DEFAULT_HOLIDAY_REFRESH_MS, MIN_REFRESH_MS, 7 * 24 * 60 * 60_000)
  const holidaysSource = typeof settings.holidaysSource === 'string' ? settings.holidaysSource : ''
  const manualHolidays = holidayDateList(settings.holidays)
  const holidayOffsetMinutes = numberIn(settings.holidayOffsetMinutes, 480, -14 * 60, 14 * 60)
  const canFetch = web !== null && typeof web === 'object' && typeof web.fetch === 'function'

  /** The last *successfully parsed* pricing card; failed parses never replace it. */
  let pricingCard = settings.fallbackCard
  /** The last successfully fetched `auto` holiday dates (kept across failures). */
  let autoHolidays = []
  /** Only the current calendar year is fetched and published. */
  const calendarYears = (timeMs) => holidayYears(timeMs, holidayOffsetMinutes)
  /**
   * Identity of a published calendar: the union *and* the provenance, because a
   * date can change between manual and automatic without changing the union.
   */
  const calendarKeyOf = (merged) =>
    [
      merged.holidays.join(','),
      merged.holidayProvenance.auto.join(','),
      merged.holidayProvenance.manual.join(','),
      merged.holidayProvenance.fixed.join(','),
    ].join('|')
  let emittedHolidayKey = calendarKeyOf(mergeHolidayCalendar({ manual: manualHolidays, auto: [], years: calendarYears(now()) }))
  let running = false
  let pricingTimer = null
  let holidayTimer = null
  let pricingInFlight = false
  let holidayInFlight = false

  const pricingStatus = {
    fetchedAt: 0,
    attemptedAt: 0,
    parserVersion: null,
    source: pricingEnabled ? settings.pricingSource : null,
    degraded: false,
    degradedReason: null,
  }
  const holidayStatus = {
    fetchedAt: 0,
    attemptedAt: 0,
    source: holidaysEnabled ? holidaysSource : null,
    error: null,
    consecutiveFailures: 0,
    nextRetryAt: 0,
  }

  /** Logging must never break a refresh loop. */
  const warn = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      // Ignore a throwing logger.
    }
  }

  /**
   * `stale` = never fetched while automatic refresh is enabled, or older than
   * two refresh intervals.
   */
  const staleOf = (fetchedAt, intervalMs, enabled) => {
    if (enabled !== true) return false
    if (!(typeof fetchedAt === 'number') || fetchedAt <= 0) return true
    return now() - fetchedAt > 2 * intervalMs
  }

  /** The live Host status carried in `view.status` (not frozen per session). */
  const status = () => ({
    catalogVersion: null,
    pricing: {
      fetchedAt: pricingStatus.fetchedAt,
      attemptedAt: pricingStatus.attemptedAt,
      parserVersion: pricingStatus.parserVersion,
      source: pricingStatus.source,
      degraded: pricingStatus.degraded,
      degradedReason: pricingStatus.degradedReason,
      stale: staleOf(pricingStatus.fetchedAt, pricingInterval, pricingEnabled),
      refreshIntervalMs: pricingInterval,
    },
    holidays: {
      fetchedAt: holidayStatus.fetchedAt,
      attemptedAt: holidayStatus.attemptedAt,
      source: holidayStatus.source,
      error: holidayStatus.error,
      stale: staleOf(holidayStatus.fetchedAt, holidayInterval, holidaysEnabled),
      consecutiveFailures: holidayStatus.consecutiveFailures,
      nextRetryAt: holidayStatus.nextRetryAt,
      refreshIntervalMs: holidayInterval,
    },
  })

  const notifyStatus = () => {
    if (isDisposed()) return
    try {
      onStatus(status())
    } catch (error) {
      warn(`[token-cost] status listener failed: ${messageOf(error)}`)
    }
  }

  /**
   * Publish the current card plus the merged holiday calendar.
   *
   * @param {number} fetchedAt - effective time for the version.
   * @param {boolean} force - publish even when the holiday union did not change
   *   (a successful pricing fetch always refreshes the source/fetchedAt labels).
   */
  const publish = (fetchedAt, force) => {
    if (isDisposed()) return
    const merged = mergeHolidayCalendar({ manual: manualHolidays, auto: autoHolidays, years: calendarYears(fetchedAt) })
    const key = calendarKeyOf(merged)
    if (force !== true && key === emittedHolidayKey) return
    emittedHolidayKey = key
    const card = {
      ...pricingCard,
      holidays: merged.holidays,
      holidaysSource: holidaysKindOf(merged.holidayProvenance),
      holidayProvenance: merged.holidayProvenance,
      holidayYear: calendarYears(fetchedAt)[0],
      fetchedAt,
    }
    try {
      onCard(card)
    } catch (error) {
      warn(`[token-cost] catalog listener failed: ${messageOf(error)}`)
    }
  }

  /** Mark the pricing source degraded without losing the last good card. */
  const degradePricing = (reason) => {
    pricingStatus.degraded = true
    pricingStatus.degradedReason = reason
    warn(`[token-cost] pricing refresh degraded: ${reason}; keeping the current card`)
  }

  /**
   * The URL of the same page in the other language, when the configured source
   * is one of the two official copies. Any other source has no counterpart, so
   * it alone supplies the card.
   */
  const counterpartUrl = (url) => {
    const value = String(url)
    if (value === OFFICIAL_PRICING_URL) return OFFICIAL_PRICING_URL_EN
    if (value === OFFICIAL_PRICING_URL_EN) return OFFICIAL_PRICING_URL
    if (value.includes('/zh-cn/quick_start/pricing')) return OFFICIAL_PRICING_URL_EN
    if (/\/quick_start\/pricing\/?$/.test(value)) return OFFICIAL_PRICING_URL
    return null
  }

  /**
   * Fetch the configured price page and, when it is an official copy, the other
   * language copy too, then merge them into one dual-currency card.
   *
   * The configured page decides the primary currency; the counterpart only adds
   * its own table. A counterpart failure is not a degradation — the primary
   * amount is still exact, the secondary display just falls back to the primary
   * currency.
   *
   * @returns {Promise<object | null>} the merged card, or `null` when the primary page was unusable.
   */
  const fetchPricingCards = async () => {
    const primaryUrl = settings.pricingSource
    const secondaryUrl = counterpartUrl(primaryUrl)
    /** Fetch one page; `null` means "no usable card", with `reason` filled in. */
    const outcome = { reason: null }
    const fetchOne = async (url) => {
      try {
        const result = await web.fetch({ url }, fetchSignal(settings.fetchTimeoutMs))
        if (isDisposed()) return null
        if (!isSuccessfulResponse(result)) {
          const statusCode = responseStatusCode(result)
          outcome.reason = `HTTP ${statusCode === null ? 'no response' : statusCode}`
          return null
        }
        const parsed = parsePricingPage(responseContent(result))
        if (parsed === null) outcome.reason = `pricing page layout was not recognized by parser v${PARSER_VERSION}`
        return parsed
      } catch (error) {
        outcome.reason = `fetch failed: ${messageOf(error)}`
        return null
      }
    }
    const primary = await fetchOne(primaryUrl)
    if (isDisposed()) return null
    if (primary === null) {
      degradePricing(outcome.reason ?? `pricing page layout was not recognized by parser v${PARSER_VERSION}`)
      return null
    }
    const secondary = secondaryUrl === null ? null : await fetchOne(secondaryUrl)
    if (isDisposed()) return null
    const merged = mergeCurrencyCards(primary, secondary)
    if (merged === null) return null
    return { ...merged, source: typeof primaryUrl === 'string' ? primaryUrl : settings.pricingSource }
  }

  /** Fetch the official pricing page(s); record freshness or degradation. */
  const runPricing = async () => {
    if (!pricingEnabled || !canFetch || pricingInFlight || isDisposed()) return
    pricingInFlight = true
    pricingStatus.attemptedAt = now()
    try {
      const parsed = await fetchPricingCards()
      if (isDisposed() || parsed === null) return
      const fetchedAt = now()
      pricingStatus.fetchedAt = fetchedAt
      pricingStatus.parserVersion = parsed.parserVersion
      pricingStatus.source = typeof parsed.source === 'string' && parsed.source.length > 0 ? parsed.source : settings.pricingSource
      pricingStatus.degraded = false
      pricingStatus.degradedReason = null
      pricingCard = { ...parsed, source: pricingStatus.source }
      publish(fetchedAt, true)
    } catch (error) {
      if (!isDisposed()) degradePricing(`fetch failed: ${messageOf(error)}`)
    } finally {
      pricingInFlight = false
      notifyStatus()
    }
  }

  /** Fetch only the current year's calendar; failures keep the last good data. */
  const runHolidays = async () => {
    if (!holidaysEnabled || !canFetch || holidayInFlight || !running || isDisposed()) return
    holidayInFlight = true
    const attemptedAt = now()
    holidayStatus.attemptedAt = attemptedAt
    const year = calendarYears(attemptedAt)[0]
    try {
      let dates
      try {
        const url = holidaysSource.replaceAll('{year}', String(year))
        const result = await web.fetch({ url }, fetchSignal(settings.fetchTimeoutMs))
        if (isDisposed()) return
        if (!isSuccessfulResponse(result)) {
          const statusCode = responseStatusCode(result)
          throw new Error(`HTTP ${statusCode === null ? 'no response' : statusCode}`)
        }
        let payload
        try {
          payload = JSON.parse(responseContent(result))
        } catch (error) {
          throw new Error(`invalid JSON (${messageOf(error)})`)
        }
        dates = parseHolidayPayload(payload, year)
        if (calendarYears(now())[0] !== year) throw new Error('holiday calendar year changed during refresh')
      } catch (error) {
        if (isDisposed()) return
        holidayStatus.consecutiveFailures += 1
        holidayStatus.error = `${year}: ${messageOf(error)}`
        const retryDelay = holidayRetryDelayMs(holidayStatus.consecutiveFailures)
        holidayStatus.nextRetryAt = now() + retryDelay
        warn(`[token-cost] holiday refresh failed (${holidayStatus.consecutiveFailures} in a row): ${holidayStatus.error}; retrying in ${Math.round(retryDelay / 60_000)} min`)
        scheduleHolidays(retryDelay)
        return
      }
      // Only a validated response is successful, including a valid empty list.
      const firstSuccess = holidayStatus.fetchedAt === 0
      holidayStatus.fetchedAt = now()
      holidayStatus.consecutiveFailures = 0
      holidayStatus.error = null
      autoHolidays = dates
      holidayStatus.nextRetryAt = holidayStatus.fetchedAt + holidayInterval
      publish(holidayStatus.fetchedAt, firstSuccess)
      scheduleHolidays(holidayInterval)
    } finally {
      holidayInFlight = false
      notifyStatus()
    }
  }

  /**
   * Schedule the next holiday attempt (variable delay: backoff or the normal
   * interval). A plain `setInterval` cannot express that, hence the timeout chain.
   */
  const scheduleHolidays = (delayMs) => {
    if (!holidaysEnabled || !running || isDisposed()) return
    if (holidayTimer !== null) {
      timers.clearTimeout?.(holidayTimer)
      holidayTimer = null
    }
    holidayTimer = timers.setTimeout(() => {
      holidayTimer = null
      void runHolidays()
    }, Math.max(0, delayMs))
  }

  /** Start both loops; each source's initial fetch is immediate and independent. */
  const start = () => {
    if (running || isDisposed()) return
    running = true
    if (pricingEnabled && canFetch) {
      void runPricing()
      pricingTimer = timers.setInterval(() => void runPricing(), pricingInterval)
    }
    if (holidaysEnabled && canFetch) void runHolidays()
  }

  /** Stop both loops and cancel pending timers. Safe to call twice. */
  const stop = () => {
    running = false
    if (pricingTimer !== null) {
      timers.clearInterval?.(pricingTimer)
      pricingTimer = null
    }
    if (holidayTimer !== null) {
      timers.clearTimeout?.(holidayTimer)
      holidayTimer = null
    }
  }

  return { start, stop, status, refreshPricing: runPricing, refreshHolidays: runHolidays, retryDelayMs: holidayRetryDelayMs }
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
  const activatedAt = Date.now()
  const catalog = createPricingCatalog(settings)
  /** The live refresh controller, read by `wire.view` for `view.status`. */
  const live = { controller: null }
  /** Bumped whenever a refresh adds an epoch, so views refold the timeline. */
  const catalogEpochs = () => catalog.epochsFor(Date.now())
  const catalogVersionLabel = () => {
    const versions = catalog.versions
    const latest = versions[versions.length - 1]
    return latest !== undefined && typeof latest.version === 'string' ? latest.version : 'config'
  }

  /**
   * Own amount per Session, for the subtree total.
   *
   * A parent can never see a delegated Session's usage in its own fold, so the
   * Host keeps each Session's own wire amount here and the parent's view adds
   * them up. Entries are written whenever a Session's `tokenCost` changes and
   * are read synchronously in `view`, which is why this is a plain map rather
   * than an await: `view` must stay synchronous.
   *
   * The map is display-only. It is never persisted, and a miss (a child from a
   * previous process, or one that has not folded yet) is reported as
   * `subtree.unknownCount` instead of being treated as free.
   */
  const ownAmounts = new Map()
  /**
   * Record one Session's own amount per published currency.
   *
   * A parent sums its children in whichever currency it displays, so the cache
   * keeps one amount per currency rather than one amount plus a conversion.
   */
  const rememberOwn = (sessionId, view) => {
    if (typeof sessionId !== 'string' || view === null || view === undefined || typeof view !== 'object') return
    const children = Array.isArray(view.children) ? view.children : []
    const own = {}
    for (const [code, amount] of Object.entries(view.amounts ?? {})) {
      if (Number.isFinite(amount)) own[code] = amount
    }
    if (Object.keys(own).length === 0 && Number.isFinite(view.micros)) own[view.currency ?? 'CNY'] = view.micros
    const entry = {
      own,
      calls: Number.isFinite(view.calls) ? view.calls : 0,
      children,
    }
    const previous = ownAmounts.get(sessionId)
    // Idempotent: a view read must not churn the cache (or the change feed).
    const sameOwn = previous !== undefined && Object.keys(own).length === Object.keys(previous.own).length && Object.keys(own).every((code) => previous.own[code] === own[code])
    if (previous !== undefined && sameOwn && previous.calls === entry.calls && previous.children.length === children.length && previous.children.every((id, index) => id === children[index])) return
    ownAmounts.set(sessionId, entry)
  }
  live.ownAmounts = ownAmounts

  ctx.sessionProjections.register({
    key: 'tokenCost',
    stateVersion: STATE_VERSION,
    stateSchema: passthroughSchema,
    // A Session opens with the timeline known now; later fetches are merged by
    // `foldEvent`, so a price change only affects requests after it arrived.
    init: (header) => initialState(catalog.epochsFor(header?.createdAt), header?.id ?? null),
    apply: (state, event) => foldEvent(upgradeHolidayPolicy(state, activatedAt, settings), event, catalogEpochs()),
    wire: {
      viewSchema: passthroughSchema,
      view: (state) => {
        const synced = syncEpochs(upgradeHolidayPolicy(state, activatedAt, settings), catalogEpochs())
        const status = live.controller === null ? null : { ...live.controller.status(), catalogVersion: catalogVersionLabel() }
        const lookup = (id) => ownAmounts.get(id)
        // Price once per currency this Session's timeline actually has a table
        // for, so the client can follow the interface language without a second
        // Host round trip or an invented exchange rate.
        const codes = (() => {
          const present = new Set()
          for (const epoch of synced.epochs ?? [synced.pricing]) {
            for (const code of Object.keys(epoch?.ratesByCurrency ?? {})) present.add(code)
          }
          if (present.size === 0 && typeof synced.pricing?.currency === 'string') present.add(synced.pricing.currency)
          // The display currency leads so `viewOf` prices it by default.
          const preferred = synced.pricing?.currency
          const ordered = [...present]
          return preferred !== undefined && present.has(preferred) ? [preferred, ...ordered.filter((code) => code !== preferred)] : ordered
        })()
        const primary = codes[0] ?? synced.pricing?.currency ?? 'CNY'
        const pinned = settings.currency.length > 0 ? settings.currency : null
        const value = viewOf(synced, status, lookup, primary, pinned)
        const amounts = { [primary]: value.micros }
        const subtreeAmounts = { [primary]: value.subtree.micros }
        const bucketAmounts = { [primary]: value.bucketMicros }
        const modelAmounts = { [primary]: value.models }
        for (const code of codes.slice(1)) {
          const alternate = viewOf(synced, status, lookup, code)
          // An epoch without this currency's table prices in its own currency, so
          // the alternate view would be a mislabeled copy — skip it instead.
          if (alternate.currency !== code) continue
          amounts[code] = alternate.micros
          subtreeAmounts[code] = alternate.subtree.micros
          bucketAmounts[code] = alternate.bucketMicros
          modelAmounts[code] = alternate.models
        }
        // Per-model amounts in every currency, so a model row can be shown in the
        // display currency without re-pricing it in the client.
        const byCurrency = {}
        for (const code of Object.keys(modelAmounts)) {
          if (code === primary) continue
          for (const [index, row] of (modelAmounts[code] ?? []).entries()) {
            const target = value.models[index]
            if (target === undefined || target.provider !== row.provider || target.model !== row.model) continue
            byCurrency[`${row.provider}/${row.model}`] = byCurrency[`${row.provider}/${row.model}`] ?? {}
            byCurrency[`${row.provider}/${row.model}`][code] = {
              micros: row.micros,
              peakMicros: row.peak.micros,
              offPeakMicros: row.offPeak.micros,
            }
          }
        }
        // `state.children` is what a parent reports; keep it on the wire so the
        // cache updater can record the delegation edges without a second fold.
        const children = Array.isArray(state.children) ? [...state.children] : []
        // Opportunistically seed this Session's own entry: a Session whose
        // change feed never fired for this process (a restored history) would
        // otherwise be an unknown child in its parent's subtree total. Only a
        // changed entry writes, so the view stays idempotent.
        rememberOwn(state.sessionId, { ...value, amounts, children })
        return {
          ...value,
          amounts,
          bucketMicrosByCurrency: bucketAmounts,
          models: value.models.map((row) => {
            const alternate = byCurrency[`${row.provider}/${row.model}`]
            return alternate === undefined ? row : { ...row, byCurrency: alternate }
          }),
          subtree: { ...value.subtree, amounts: subtreeAmounts },
          children,
        }
      },
    },
  })

  // Keep the per-Session amount cache current: every committed `tokenCost`
  // change refreshes that Session's entry, so a parent's subtree total follows
  // its children without the parent's own log changing. Optional: a Host
  // composition without the change feed (or a test double) still works, and
  // then the cache is seeded lazily by `view` reads instead.
  ctx.effect(() => {
    const projections = ctx.sessionProjections
    if (typeof projections?.onChanged !== 'function') return undefined
    return projections.onChanged((session, key, value) => {
      if (key !== 'tokenCost') return
      const sessionId = session !== null && typeof session === 'object' && session.id !== undefined ? String(session.id) : null
      rememberOwn(sessionId, value)
    })
  }, 'token-cost: subtree amounts')

  ctx.effect(() => {
    const web = ctx.get('web')
    if (web === undefined) return undefined
    let disposed = false
    const controller = createRefreshController({
      web,
      settings,
      logger: ctx.logger,
      now: () => Date.now(),
      timers: { setTimeout, clearTimeout, setInterval, clearInterval },
      onCard: (card) => catalog.ingest(card, typeof card.fetchedAt === 'number' ? card.fetchedAt : Date.now()),
      onStatus: () => {},
      disposed: () => disposed,
    })
    live.controller = controller
    controller.start()
    return () => {
      disposed = true
      controller.stop()
    }
  }, 'token-cost: pricing refresh')
}

/** Exported for tests and for documentation of the fold contract. */
export const internals = {
  OFFICIAL_PRICING_URL,
  OFFICIAL_PRICING_URL_EN,
  PRICING_PAGE_VARIANTS,
  DEFAULT_HOLIDAY_SOURCE,
  DEFAULT_RATE_CARD,
  DEFAULT_RATE_CARDS,
  DEFAULT_PEAK_WINDOWS,
  STATE_VERSION,
  PARSER_VERSION,
  HOLIDAY_RETRY_DELAYS_MS,
  parsePricingPage,
  parseModelPricingRow,
  mergeCurrencyCards,
  parseHolidayPayload,
  markupToText,
  parsePeakWindows,
  resolveSettings,
  resolveRateCard,
  makePricingSnapshot,
  resolvePricingAt,
  createPricingCatalog,
  cardFingerprint,
  holidayDateList,
  mergeHolidayCalendar,
  holidaysKindOf,
  normalizeHolidayProvenance,
  holidayRetryDelayMs,
  createRefreshController,
  bandOf,
  epochAt,
  syncEpochs,
  subtreeOf,
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
 * One rate epoch: a priced card plus the interval it was in force
 * (`effectiveFrom` inclusive, `effectiveTo` exclusive; `null` = still current).
 *
 * @typedef {object} RateEpoch
 * @property {string} version
 * @property {number} effectiveFrom
 * @property {number | null} effectiveTo
 * @property {number | null} fetchedAt
 * @property {string} currency
 * @property {string} symbol
 * @property {number} exchangeRate
 * @property {number[][]} peakWindows
 * @property {boolean} weekdaysOnly
 * @property {boolean} offPeakEnabled
 * @property {'included' | 'separate'} reasoningBilling
 * @property {string[]} holidays
 * @property {number} holidayOffsetMinutes
 * @property {Record<string, RateCard | null>} rates
 */

/**
 * @typedef {object} ModelEntry
 * @property {string} provider
 * @property {string} model
 * @property {number} calls
 * @property {TokenBuckets} tokens
 * @property {{ calls: number, tokens: TokenBuckets }} peak
 * @property {{ calls: number, tokens: TokenBuckets }} offPeak
 * @property {Record<string, ModelEntry>} epochs - the same facts split by rate epoch.
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
