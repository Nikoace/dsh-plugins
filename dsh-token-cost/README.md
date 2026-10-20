# Token Cost Meter (`@local/dsh-token-cost`)

A DSH Web UI plugin that prices the **current Session's** model usage in real time from the
**official DeepSeek price page**, separating the parts that change what you actually pay:

- **Currency** — the zh-CN page is the default source, so amounts are in **CNY (¥)**, the currency
  the account is billed in. Point `pricingSource` at the English page for USD; the parser reads
  either copy and records which one it used (`pageVariant`).
- **峰 / 谷 (peak / off-peak)** — the published peak windows, given on the zh-CN page in Beijing
  time (09:00–12:00 / 14:00–18:00) and normalized to UTC 01:00–04:00 / 06:00–10:00, Monday–Friday,
  Chinese public holidays excluded, applied with the per-model off-peak multiplier.
- **Cache buckets** — cache-miss input, cache-read input, and cache-write input are priced
  separately.
- **Output (and reasoning)** — output tokens are priced at the output rate; reasoning tokens are
  inside `outputTokens` on the shipped routes and are not billed twice by default.
- **Route / model** — each provider/model pair uses its own row of the fetched card, with an explicit
  fallback and an explicitly *unpriced* mode. Routes whose spend is billed elsewhere
  (`EXCLUDED_PROVIDERS`, currently the `magpie` gateway and `openai-codex`) are **out of scope**:
  they are counted and reported as excluded, never priced from the DeepSeek card and never mixed
  into the amount.
- **Rate timeline** — each request is priced by the rate **in force when it started**. A price
  change splits the timeline instead of freezing a whole conversation on one card, so history stays
  reproducible and a long conversation still tracks today's price.
- **Discount visibility** — the dialog shows off-peak spend and the amount the off-peak window saved.

## Where the numbers come from

```
https://api-docs.deepseek.com/zh-cn/quick_start/pricing  (official, fetched on load + every 6h)
        │  parse model rows, cache-hit/miss/output peak prices, "空闲时段是高峰的一半",
        │  Beijing-time windows converted to UTC, "周一至周五"
        ▼
effective-dated catalog (in memory)  ──►  every Session carries the epoch timeline
        │                                      │  (each epoch closed by the next one)
        │                                      ▼
        │                              tokenCost projection state
        │                              (billed facts per epoch + the timeline)
        ▼                                      │
  config fallback card                         ▼
  (offline / source disabled)          composer.dock cost pill + dialog
```

`platform.deepseek.com/usage` is the account's **usage** page (authenticated, not a machine-readable
price source); the plugin cannot read it without a private Platform API contract. The public pricing
page is the machine-readable source of the same rates, so that is what the plugin fetches. The usage
page remains the source of truth for **reconciliation** — see the limits.

## Where it appears

A new cell in `conversation.composer.dock` beside the shipped activity and usage cells (id `cost`,
order `2`):

```
[gauge] 3 turns 5 steps · 40 tok/s   [database] 1.2M · 87%   [coin] ¥0.24 · 谷
```

The pill and dialog reuse the shipped session-statistics controls' geometry and theme tokens
(`StatsPills.module.css` / `stat-dialog.module.css`: 14 px icon, 6 px gaps, `1px 8px` pill padding,
`--dsw-radius-sm` / `--dsw-radius-lg`, `--dsw-alias-label-tertiary`, elevated menu panel with
`--dsw-elevation-prominent`) and the same trigger-anchored placement and outside-click/Escape
dismissal, so they sit beside the existing statistics cells without a visual seam. Click the pill for
the breakdown; the band badge follows the wall clock (30 s tick) even when no request is running.
The dialog title carries a small **info button** for the pricing/calendar/time-line explanation; an
amber dot on it means the holiday calendar is empty, so those days would be charged as peak. A second
amber dot on the pill itself means the Host's data is stale or degraded — see *Data trust* below.

## Real-time value and effective dating

The value is a Host session projection (`tokenCost`), folded from the durable log:

- The fold records **billed facts** only: token buckets per band, per route, and per rate epoch, plus
  request counts.
- Pricing is **per request, not per conversation**. Every request is classified by the
  `step/start` timestamp that produced it — that timestamp picks both the peak/off-peak band **and**
  the rate epoch in force at that moment. A price change therefore **splits the timeline**: requests
  before it keep the old rates, requests after it use the new ones, and the conversation total is the
  sum of what each request would actually have cost. Nothing is prorated or averaged, and history is
  still reproducible because the epochs it used are stored in the state.
- The epoch list is reconciled on every event, so a refresh that adds an epoch only affects requests
  after it arrived; a restored checkpoint is self-describing and needs no network.
- A conversation created **before the first successful fetch** opens on the bootstrap config card as
  its first epoch. Once the official card arrives it becomes a new epoch, so later requests are priced
  from it while the earlier ones keep the fallback rates. The info hint says which segment each part
  came from.
- Money is computed in the view: integer micro-currency, `tokens × ratePerMillion`, scaled by
  `exchangeRate`, and the displayed per-bucket rows are **the rounded integers the total is summed
  from** — `sum(buckets) === micros` holds exactly per band, per model and per epoch.

## Peak / off-peak policy

The catalog supplies:

- peak windows normalized to **UTC minutes** (`01:00–04:00`, `06:00–10:00`). The zh-CN page states
  them in Beijing time (09:00–12:00 / 14:00–18:00); the parser converts and requires the page to name
  its zone, so a window of unknown zone is rejected instead of being silently read as UTC;
- weekdays-only (`周一至周五` / `Monday through Friday`);
- off-peak multiplier per model (`0.5`, i.e. off-peak is half price).

The **Chinese public holiday calendar** is not on the pricing page and has no official
machine-readable API — the State Council publishes an annual prose notice. The plugin therefore
fetches a configurable JSON calendar (`holidaysSource`, default
[timor.tech](https://timor.tech/api/holiday/year/2026), which mirrors that notice: days off including
adjusted days, makeup workdays ignored), unions it with the manual `holidays` list and the fixed
statutory anchors (元旦 / 春节 / 劳动节 / 国庆节, each covering its whole statutory block), and uses
the Beijing date (`holidayOffsetMinutes`, default `480`) for the lookup. The anchors cover years whose
arrangement is not published yet, so the cost meter applies the same estimate as the sidebar clock
instead of silently charging peak. Alternative sources:

- [Nager.Date](https://date.nager.at/api/v3/PublicHolidays/2026/CN) — `PublicHolidays/{year}/CN`,
  statutory days only (it does not include every adjusted day off);
- any URL returning `["2026-10-01", ...]`, `{ "dates": [...] }`, Nager's `[{ "date": ... }]`, or
  timor's `{ "holiday": { "10-01": { "holiday": true } } }` shape;
- `holidaysSource: false` to stay fully offline and rely on the manual list plus the anchors.

The calendar is effective-dated like the rates: it is part of each epoch, so a newly fetched calendar
applies to requests after the fetch. The snapshot records `holidayProvenance = { auto, manual, fixed }`,
so the dialog can say which dates are published data, manual entries, or anchor estimates; the live
status additionally reports staleness and the last refresh failure.

`peakWindows`, `weekdaysOnly`, and `offPeakEnabled` can be overridden in config for a different
contract. The band rules themselves — peak windows, the Beijing holiday rule, and the anchors — are
the canonical `shared/tariff/index.js`, shared with `dsh-sidebar-clock`; this bundle carries a
generated Host copy (`tariff.js`) and an inlined client copy, refreshed by
`node tools/sync-shared.mjs`.

### A conversation that spans peak and off-peak

Pricing is **per model request**, not per conversation. Each request is classified by the
`step/start` timestamp that produced it: inside a peak window it is peak, otherwise it is off-peak.
Tokens, request counts, and cost accumulate in the two buckets independently, so a conversation that
crosses 04:00 UTC simply carries both bands; nothing is prorated or averaged:

```
03:59 UTC request: 1M input + 1M output -> peak     ¥10.00
04:01 UTC request: 1M input + 1M output -> off-peak ¥ 5.00
conversation total: ¥15.00   peak ¥10.00   off-peak ¥5.00   saved ¥5.00
```

Two deliberate choices:

- **Request start decides the band.** A request that starts at 03:59 and settles at 04:05 is priced
  entirely as peak; provider usage arrives at settlement, and the step start is the only timestamp
  attributable to the call. A retried attempt gets its own start time (`llm/retry-started`), so an
  attempt that begins in the next band is billed there.
- **Weekends and configured holidays are off-peak all day**, including a conversation that began on
  a weekday.

The dialog shows exactly this split: peak/off-peak spend, each band's token volume, the saved amount,
and the request counts; the per-model rows repeat the peak/off-peak cost split and add the segment
count when a row spans more than one rate epoch.

### A conversation that spans a price change

The same rule applies to rates: each request is charged at the price in force when it started. A
conversation does not need to be restarted after a rate update, and its earlier requests are not
repriced:

```
¥2/1M epoch   10:00 request: 1M cache-miss input -> ¥2
¥4/1M epoch   14:00 request: 1M cache-miss input -> ¥4
conversation total: ¥6   (2 rate segments)
```

The info hint lists every segment with its `effectiveFrom` time and the rates it charged, so a total
that is not `tokens × one rate` is explained rather than surprising.

### Display time zone

Band classification is absolute (UTC windows), but the dialog shows the windows in the browser's
**system time zone** and names it in a "peak windows" row (for example
`10:00–13:00 / 15:00–19:00（Asia/Tokyo）`). A separate "rule basis" row keeps the UTC reference
(`UTC 01:00–04:00 / 06:00–10:00`) because the published page states Beijing time; the countdown
target is also shown in the system time zone. A display offset is taken at the current moment, so a
dialog left open across a DST change may show the local clocks one hour off until the next
30-second refresh.

## Data trust: refresh, staleness, provenance

The two remote sources — the price page and the holiday calendar — refresh on **independent**
schedules, so a slow or failing holiday source can never delay a rate update (both start immediately
at load; the price page then follows `refreshIntervalMs`).

What a successful refresh means:

- **Pricing.** A fetch only counts as successful when it is 2xx *and* the page passes the parser's
  own validation: a recognized language copy, a stated window zone, two distinct model columns, three
  price groups, non-negative finite prices, off-peak ≤ peak per group, and peak windows inside a day.
  Either `OFF-PEAK … PEAK …` or the reverse label order is accepted (the price columns stay bound to
  their models). A redesign therefore fails **explicitly**: the last good card is kept, the status is
  marked `degraded` with a human-readable reason, and the UI shows it instead of silently pricing
  with old data. The card records `parserVersion` and `pageVariant` (`zh` = CNY, `en` = USD).
- **Holidays.** The success timestamp moves only when at least one requested year was fetched *and*
  parsed. A total failure keeps the previous calendar and retries after **5 min → 15 min → 1 h**,
  staying hourly while it keeps failing; a success returns to `holidayRefreshIntervalMs` (default
  24 h). Partial failures keep the previous dates for the failed year.

The wire value separates billed facts from live freshness:

- `view.pricing` describes the **current** epoch (what new requests are priced with) and carries the
  whole `epochs` timeline — each with its `effectiveFrom`/`effectiveTo`, currency and rates — plus
  `parserVersion`, `pageVariant`, and `holidayProvenance = { auto, manual, fixed }`; `holidays`
  remains the sorted union array. The fixed anchors are rebuilt for the session's own Beijing years
  even when the epoch was fetched earlier, so a session created in an unpublished year still agrees
  with the clock.
- `view.status` is **live Host state**, not part of the billed facts: `pricing` (`fetchedAt`,
  `attemptedAt`, `parserVersion`, `source`, `degraded`, `degradedReason`, `stale`,
  `refreshIntervalMs`) and `holidays` (`fetchedAt`, `attemptedAt`, `source`, `error`, `stale`,
  `consecutiveFailures`, `nextRetryAt`, `refreshIntervalMs`), plus `catalogVersion`. `stale` means
  "never fetched while automatic refresh is enabled, or older than two refresh intervals". It exists
  for display only and never rewrites a billed fact.
- `view.models[].epochs` is the per-model, per-epoch split: calls, tokens, money and the `rateBasis`
  that priced it (`exact` / `family` / `default` / `unpriced` / `excluded`).
- `view.excludedCalls` / `excludedTokens` report traffic that is deliberately out of scope; those
  requests and their tokens are removed from `view.calls` and `view.tokens`, so the amount and the
  token rows always describe the same set of requests.

The UI surfaces this without reading logs: a small amber dot on the pill when pricing is stale or
degraded, or when holidays are stale or failing; the info hint adds a `stale`/`degraded` badge, the
rate timeline, the excluded providers, and lines for the current rate read time, the holiday
calendar's per-source counts (auto/manual/fixed anchors), and the last failure with its next retry
time.

## Configuration

The bundle patch writes the defaults. A row with the same id in the profile's own patch layer
(`~/.dsh/profiles/desktop/cordis.patch.yml`) replaces the complete `config`, so copy the whole block:

```yaml
- id: token-cost
  name: '@local/dsh-token-cost'
  config:
    # zh-CN copy (CNY). Use .../quick_start/pricing for the USD copy. false = offline.
    pricingSource: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
    refreshIntervalMs: 21600000
    fetchTimeoutMs: 15000
    currency: ''          # empty = the catalog currency (CNY, USD from the English copy)
    symbol: ''            # empty = ¥ for CNY, $ for USD
    exchangeRate: 1       # multiplies the card's own rates; 1 = no conversion
    offPeakEnabled: true
    reasoningBilling: included   # or separate
    holidaysSource: https://timor.tech/api/holiday/year/{year}  # false = offline
    holidayRefreshIntervalMs: 86400000
    holidays: []          # manual extras, unioned with the fetched calendar
    holidayOffsetMinutes: 480
    # peakWindows: [[60, 240], [360, 600]]   # optional override
    # weekdaysOnly: true
    rates:                # fallback only when the catalog cannot be fetched (CNY)
      deepseek-flash:  { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8, offPeakMultiplier: 0.5 }
      deepseek-v4-pro: { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27, offPeakMultiplier: 0.5 }
      default:         { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8, offPeakMultiplier: 0.5 }
```

Lookup order: `"<provider>/<model>"`, then `"<model>"`, then the model family named by the id, then
`"default"` — the last only for a known DeepSeek provider. Set an entry to `null` to disable it. A
`default` match is labeled *estimated*; no match is *unpriced* (cost 0). A provider listed in
`EXCLUDED_PROVIDERS` (`magpie`, `magpie-responses`, `openai-codex`) is *excluded*: it is billed
elsewhere, so it is reported separately and never priced from this page. All three counts are shown
so a total is never silently wrong.

The shipped fallback values mirror the official zh-CN page at the time of writing but are **not a
quote**; the fetched catalog is authoritative while it is reachable.

## Files

| File | Role |
|---|---|
| `index.js` | Host: pricing-page parser (zh/en), effective-dated epoch timeline, `tokenCost` projection, tariff fold, wire view |
| `tariff.js` | **Generated** Host copy of `shared/tariff/index.js` (do not edit; run `node tools/sync-shared.mjs`) |
| `client.js` | Client: dock pill, breakdown dialog, rate timeline, live band badge, zh/en dictionaries |
| `cordis.patch.yml` | Bundle patch inserting the Host row and its default config |
| `locale/{en,zh}.json` | Plugin-manager title/description |
| `icon.svg` | Plugin icon |

## Limits

- **Per request, not per streamed token.** Provider usage arrives when a request settles, so the pill
  updates at the end of each model request during a turn.
- **Rates are per request epoch.** A refresh that changes prices adds an epoch; requests after it use
  the new rates and earlier ones keep theirs. Editing the fallback config and reloading the plugin
  re-folds sessions, so the fallback epoch can change on a reload — prefer the fetched catalog.
- **Only the DeepSeek account is priced.** Gateway routes (`magpie`, `openai-codex`) and any other
  provider without a DeepSeek model family stay out of the amount; they are counted as excluded.
- **Holidays come from a configurable source.** The State Council notice is prose, so the default
  community JSON mirror can lag or be unavailable; point `holidaysSource` at another JSON source, add
  manual dates, or accept the amber-dot warning and peak pricing on those days. A failed refresh is
  retried with a short backoff (5 min → 15 min → hourly) and reported in the info hint with its next
  retry time, so a startup network glitch no longer silences holiday updates for a day. A newly
  fetched calendar becomes part of the epoch that fetched it.
- **The usage page is not readable.** `platform.deepseek.com/usage` needs the account session and a
  private API contract; it is the right place to **reconcile** totals, not a machine-readable rate
  source. Search & Fetch standalone API charges (¥5/1,000 requests, free until 2026-11-01 for
  in-harness server-side calls) are not visible in token usage and are not included here.
- **Catalog layout is parsed, not versioned.** The parser validates its own output (`parserVersion`
  and `pageVariant` are recorded on the card and the wire value); a redesign makes it return `null`,
  so the plugin keeps the last good card, marks the live status degraded with a reason, and shows the
  amber pill/hint warning. Contract fixtures cover the zh-CN page, the English page, a
  reordered-column variant, and a redesigned layout that must fail explicitly.
- **Fixed interpretation.** Peak windows are UTC and the holiday date uses a fixed offset; DST
  regions other than China's holiday calendar are not modeled. A window whose zone the page does not
  state is rejected rather than guessed.
- **Per Session.** There is no cross-session daily aggregate in this version.
