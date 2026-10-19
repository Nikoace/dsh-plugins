# Token Cost Meter (`@local/dsh-token-cost`)

A DSH Web UI plugin that prices the **current Session's** model usage in real time from the
**official DeepSeek price page**, separating the parts that change what you actually pay:

- **峰 / 谷 (peak / off-peak)** — the published UTC peak windows (01:00–04:00 and 06:00–10:00,
  Monday–Friday, Chinese public holidays excluded), applied with the per-model off-peak multiplier.
- **Cache buckets** — cache-miss input, cache-read input, and cache-write input are priced
  separately.
- **Output (and reasoning)** — output tokens are priced at the output rate; reasoning tokens are
  inside `outputTokens` on the shipped routes and are not billed twice by default.
- **Route / model** — each provider/model pair uses its own row of the fetched card, with an explicit
  fallback and an explicitly *unpriced* mode.
- **Discount visibility** — the dialog shows off-peak spend and the amount the off-peak window saved.

## Where the numbers come from

```
https://api-docs.deepseek.com/quick_start/pricing  (official, fetched on load + every 6h)
        │  parse model rows, cache-hit/miss/output peak prices, "off-peak is half",
        │  peak windows, "Monday through Friday"
        ▼
effective-dated catalog (in memory)  ──►  new Session freezes the active version
        │                                      │
        │                                      ▼
        │                              tokenCost projection state
        │                              (billed facts + frozen policy)
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
[gauge] 3 turns 5 steps · 40 tok/s   [database] 1.2M · 87%   [coin] $0.0341 · 谷
```

The pill and dialog reuse the shipped session-statistics controls' geometry and theme tokens
(`StatsPills.module.css` / `stat-dialog.module.css`: 14 px icon, 6 px gaps, `1px 8px` pill padding,
`--dsw-radius-sm` / `--dsw-radius-lg`, `--dsw-alias-label-tertiary`, elevated menu panel with
`--dsw-elevation-prominent`) and the same trigger-anchored placement and outside-click/Escape
dismissal, so they sit beside the existing statistics cells without a visual seam. Click the pill for
the breakdown; the band badge follows the wall clock (30 s tick) even when no request is running.
The dialog title carries a small **info button** for the pricing/calendar/freezing explanation; an
amber dot on it means the holiday calendar is empty, so those days would be charged as peak.

## Real-time value and effective dating

The value is a Host session projection (`tokenCost`), folded from the durable log:

- The fold records **billed facts** only: token buckets per band, per route, plus request counts.
- Each Session freezes the catalog version active at its **creation time** into its own state
  (full card, windows, holidays, display currency). A rate change therefore prices **new
  conversations** under the new rules and never rewrites an existing conversation; a restored
  checkpoint is self-describing and needs no network.
- A conversation created **before the first successful fetch** (for example, a conversation that
  already existed when the plugin was installed) freezes the bootstrap config card. Its info hint
  says the official card/calendar was not fetched yet and that new conversations will use it; start
  a new conversation to see the fetched data. This also keeps the money already shown in that
  conversation consistent.
- Money is computed in the view: integer micro-currency, `tokens × ratePerMillion`, scaled by
  `exchangeRate`, rounded once per band and model, with per-bucket rows kept exactly additive.

## Peak / off-peak policy

The catalog supplies:

- peak windows in **UTC minutes** (`01:00–04:00`, `06:00–10:00`);
- weekdays-only (`Monday through Friday`);
- off-peak multiplier per model (`0.5`, i.e. off-peak is half price).

The **Chinese public holiday calendar** is not on the pricing page and has no official
machine-readable API — the State Council publishes an annual prose notice. The plugin therefore
fetches a configurable JSON calendar (`holidaysSource`, default
[timor.tech](https://timor.tech/api/holiday/year/2026), which mirrors that notice: days off including
adjusted days, makeup workdays ignored), unions it with the manual `holidays` list, and uses the
Beijing date (`holidayOffsetMinutes`, default `480`) for the lookup. Alternative sources:

- [Nager.Date](https://date.nager.at/api/v3/PublicHolidays/2026/CN) — `PublicHolidays/{year}/CN`,
  statutory days only (it does not include every adjusted day off);
- any URL returning `["2026-10-01", ...]`, `{ "dates": [...] }`, Nager's `[{ "date": ... }]`, or
  timor's `{ "holiday": { "10-01": { "holiday": true } } }` shape;
- `holidaysSource: false` to stay fully offline and rely on the manual list.

The calendar is effective-dated like the rate card: a newly fetched calendar applies to conversations
created afterwards. When the frozen session calendar is empty the dialog's info button shows an amber
dot and the hint says holidays will be charged as peak.

`peakWindows`, `weekdaysOnly`, and `offPeakEnabled` can be overridden in config for a different
contract.

### A conversation that spans peak and off-peak

Pricing is **per model request**, not per conversation. Each request is classified by the
`step/start` timestamp that produced it: inside a peak window it is peak, otherwise it is off-peak.
Tokens, request counts, and cost accumulate in the two buckets independently, so a conversation that
crosses 04:00 UTC simply carries both bands; nothing is prorated or averaged:

```
03:59 UTC request: 1M input + 1M output -> peak  $1.50
04:01 UTC request: 1M input + 1M output -> off-peak $0.75
conversation total: $2.25   peak $1.50   off-peak $0.75   saved $0.75
```

Two deliberate choices:

- **Request start decides the band.** A request that starts at 03:59 and settles at 04:05 is priced
  entirely as peak; provider usage arrives at settlement, and the step start is the only timestamp
  attributable to the call.
- **Weekends and configured holidays are off-peak all day**, including a conversation that began on
  a weekday.

The dialog shows exactly this split: peak/off-peak spend, each band's token volume, the saved amount,
and the request counts; the per-model rows repeat the peak/off-peak cost split.

### Display time zone

Band classification is absolute (UTC windows), but the dialog shows the windows in the browser's
**system time zone** and names it in a "peak windows" row (for example
`10:00–13:00 / 15:00–19:00（Asia/Tokyo）`). A separate "rule basis" row keeps the UTC reference
(`UTC 01:00–04:00 / 06:00–10:00`) because weekday and Chinese-holiday rules are evaluated on
UTC/Beijing dates; the countdown target is also shown in the system time zone. A display offset is
taken at the current moment, so a dialog left open across a DST change may show the local clocks one
hour off until the next 30-second refresh.

## Configuration

The bundle patch writes the defaults. A row with the same id in the profile's own patch layer
(`~/.dsh/profiles/desktop/cordis.patch.yml`) replaces the complete `config`, so copy the whole block:

```yaml
- id: token-cost
  name: '@local/dsh-token-cost'
  config:
    pricingSource: https://api-docs.deepseek.com/quick_start/pricing  # false = offline
    refreshIntervalMs: 21600000
    fetchTimeoutMs: 15000
    currency: ''          # empty = catalog currency (USD); e.g. CNY
    symbol: ''            # empty = $ (or ¥ for CNY)
    exchangeRate: 1       # e.g. 7.2 to display CNY amounts
    offPeakEnabled: true
    reasoningBilling: included   # or separate
    holidaysSource: https://timor.tech/api/holiday/year/{year}  # false = offline
    holidayRefreshIntervalMs: 86400000
    holidays: []          # manual extras, unioned with the fetched calendar
    holidayOffsetMinutes: 480
    # peakWindows: [[60, 240], [360, 600]]   # optional override
    # weekdaysOnly: true
    rates:                # fallback only when the catalog cannot be fetched
      deepseek-flash:  { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2, offPeakMultiplier: 0.5 }
      deepseek-v4-pro: { input: 1.32, cacheRead: 0.044, cacheWrite: 1.32, output: 3.96, offPeakMultiplier: 0.5 }
      default:         { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2, offPeakMultiplier: 0.5 }
```

Lookup order: `"<provider>/<model>"`, then `"<model>"`, then `"default"`. Set an entry to `null` to
disable it. A `default` match is labeled *estimated*; no match is *unpriced* (cost 0), and both
counts are shown so a total is never silently wrong.

The shipped fallback values mirror the official page at the time of writing but are **not a quote**;
the fetched catalog is authoritative while it is reachable.

## Files

| File | Role |
|---|---|
| `index.js` | Host: pricing-page parser, effective-dated catalog, `tokenCost` projection, tariff fold, wire view |
| `client.js` | Client: dock pill, breakdown dialog, live band badge, zh/en dictionaries |
| `cordis.patch.yml` | Bundle patch inserting the Host row and its default config |
| `locale/{en,zh}.json` | Plugin-manager title/description |
| `icon.svg` | Plugin icon |

## Limits

- **Per request, not per streamed token.** Provider usage arrives when a request settles, so the pill
  updates at the end of each model request during a turn.
- **Rates repricing is conversation-scoped.** New conversations use the catalog version active at
  their creation; an open conversation keeps its frozen card. Editing the fallback config and
  reloading the plugin can reprice older checkpoints when they are re-folded, so prefer the fetched
  catalog for normal operation.
- **Holidays come from a configurable source.** The State Council notice is prose, so the default
  community JSON mirror can lag or be unavailable; point `holidaysSource` at another JSON source, add
  manual dates, or accept the amber-dot warning and peak pricing on those days. A newly fetched
  calendar affects conversations created afterwards.
- **The usage page is not readable.** `platform.deepseek.com/usage` needs the account session and a
  private API contract; it is the right place to **reconcile** totals, not a machine-readable rate
  source. Search & Fetch standalone API charges ($0.75/1,000 requests, free until 2026-11-01 for
  in-harness server-side calls) are not visible in token usage and are not included here.
- **Catalog layout is parsed, not versioned.** A redesign of the pricing page can make the parser
  reject the card; the plugin then keeps the previous card and logs a warning.
- **Fixed interpretation.** Peak windows are UTC and the holiday date uses a fixed offset; DST
  regions other than China's holiday calendar are not modeled.
- **Per Session.** There is no cross-session daily aggregate in this version.
