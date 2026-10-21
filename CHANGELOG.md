# Changelog

All notable changes to this repository are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the individual plugin bundles follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The repository itself is versioned as a set of plugin releases rather than as a
publishable package.

## [Unreleased]

### HTML preview

- Fixed `dsh-html-preview` 0.1.1 CSS fidelity: keep `>` child combinators and range
  media queries, preserve `id` attributes so `#id` CSS and aria references resolve,
  and support `var()` / `--*` custom properties. The CSS helpers moved to `core.js`
  and gained pure unit tests in `tests/html-preview-css.test.mjs`.
- Added `dsh-html-preview` 0.1.0: static HTML/CSS cards below final assistant replies,
  source/copy/expand controls, DOMPurify, restricted CSS and isolated iframe CSP.
- This release is preview-only: HTML remains in model history. The original pre-step
  filtering plan was invalid; see [context findings](docs/html-preview-context.md).
- Added deterministic offline client assembly and pinned sanitizer provenance/license.
  Live installation, visual checks and browser enforcement validation remain pending.

### Changed

- Holiday policy (2026-10-21): `dsh-token-cost` and `dsh-sidebar-clock` fetch only the current
  Beijing year's calendar, never estimate unpublished dates, and reject business errors or malformed
  calendars without replacing good data. The clock uses a current-year v2 cache and shows `暂无` /
  `none known` if no known holiday remains. Token-cost preserves billed checkpoint history and adds
  a policy boundary for subsequent requests. See [implementation notes](docs/holiday-policy-2026-10-21.md).

### Added

- `dsh-token-cost` 1.4.0: **CNY pricing from the zh-CN price page** (the page the account is billed
  from). The parser now understands both language copies (`pageVariant: 'zh' | 'en'`), reads their
  own row labels and currencies, converts the Beijing-time peak windows (09:00–12:00 / 14:00–18:00)
  back to the UTC windows, and **rejects a page that does not state its window zone** instead of
  silently reading Beijing time as UTC. `DEFAULT_RATE_CARD` and the bundle patch now carry the
  zh-CN rates (flash ¥2 / ¥0.04 / ¥8, v4-pro ¥9 / ¥0.3 / ¥27 per 1M).
- `dsh-token-cost`: a **price timeline** replaces the per-Session frozen card. Each request is priced
  by the rate epoch in force at its `step/start`, so a price change splits the conversation at the
  change instead of repricing history (or never picking the change up). The state keeps billed facts
  per (model, epoch); the wire value exposes `pricing.epochs` and `models[].epochs`, and the dialog
  lists every segment with the rates it charged.
- `dsh-token-cost`: **excluded providers** (`EXCLUDED_PROVIDERS`: `magpie`, `magpie-responses`,
  `openai-codex`). Their requests are counted as `excludedCalls` / `excludedTokens`, removed from
  `calls` / `tokens` / the amount, and labelled in the dialog, so a gateway that is billed elsewhere
  can no longer be priced from the DeepSeek card (and can no longer be silently folded into a total).
- `tests/fixtures/pricing-page-zh.html`: contract fixture for the zh-CN price table.
- `dsh-token-cost`: **the pill's currency follows the interface language**. Both official price-page
  copies are fetched and kept side by side (zh-CN = CNY, English = USD), and each currency's amount is
  computed from its own published table — verified against the real logs, the two totals imply the
  official 6.6667 ratio, so the dollar figure is published data rather than a conversion. A copy that
  disagrees on the peak windows (or fails to fetch) contributes no table, and a currency the epoch
  never published is reported as `unpricedByCurrency` instead of being billed at another currency's
  rate. `currency` in the config pins one currency and overrides the language (`pinnedCurrency`).
  New wire fields: `currencies`, `pinnedCurrency`, `unpricedByCurrency`, `amounts`, `bucketMicrosByCurrency`,
  `models[].byCurrency`, `subtree.amounts`.
- `dsh-token-cost`: **sub-agent totals**. The fold records the `subagent/catalog` child ids, the Host
  keeps each Session's own amount in a display-only cache, and the wire value gained
  `subtree = { micros, ownMicros, childrenMicros, childCount, unknownCount, calls }`. The pill shows
  the whole delegated tree; the dialog adds `含子会话 ¥5.68（自身 ¥2.75 + 3 个子 agent ¥2.94）` and
  discloses children whose amount is not known yet instead of counting them as free.

### Fixed

- `dsh-token-cost`: per-bucket rows are now the rounded integers the total is summed from, so
  `sum(bucketMicros) === micros` holds exactly per band, per model and per epoch (the per-epoch split
  exposed a one-micro drift).
- `dsh-token-cost`: a retried attempt starts a new request for band purposes
  (`llm/retry-started`), so a step that began in one band and retried in another is billed in both.
- `shared/tariff/index.js`: one canonical implementation of the DeepSeek peak windows, the
  Beijing holiday rule, and the fixed statutory anchors, shared by `dsh-token-cost` (Host and
  Web UI) and `dsh-sidebar-clock` (Web UI). `node tools/sync-shared.mjs` regenerates the Host ESM
  copy and the two inlined Web copies; `npm test` fails when a copy drifts
  (`tests/tariff-consistency.test.mjs`).
- `dsh-token-cost`: live `view.status` freshness/degradation state (`fetchedAt`, `attemptedAt`,
  `parserVersion`, `source`, `degradedReason`, `stale`, holiday failure/retry info) plus an amber
  pill indicator and a stale/degraded badge in the dialog hint; the frozen snapshot now records
  `parserVersion` and `holidayProvenance = { auto, manual, fixed }`.
- `dsh-token-cost`: fixtures for a price table whose `PEAK` / `OFF-PEAK` column groups are swapped
  (`tests/fixtures/pricing-page-reordered.html`, still parses to the same rates) and for a
  redesigned layout that must fail explicitly (`tests/fixtures/pricing-page-revamped.html`).
- `dsh-sidebar-clock`: versioned `SIDEBAR_SHELL` class map, a never-throwing
  `createTopCardHost(anchor, shell)`, one warning per page load and failure kind with the DSH
  version, and `tests/sidebar-clock-adapter.test.cjs` driving the real adapter source against a
  0.2.1-rc.2 sidebar fixture (`tests/fixtures/sidebar-shell-0.2.1-rc.2.html`).
- `docs/compatibility.md`: DSH shell/adapter compatibility matrix, class-map provenance, upgrade
  re-check commands, and the adapter-unrecognised vs plugin-inactive failure table.
- Repository guardrails: `.github/workflows/ci.yml` (windows-latest, Node 22.15 and 24),
  zero-dependency test runner (`npm test`), reproducible bundle packer (`npm run pack`),
  `LICENSE` (MIT), this changelog, and `engines.node >= 22.15`.
- New consistency/contract test files: `tests/tariff-consistency.test.mjs`,
  `tests/sidebar-clock-adapter.test.cjs`, and the P0-1/P0-2 host tests in `tests/host.test.mjs`.

### Changed

- `dsh-token-cost` 1.4.0: the default `pricingSource` is the zh-CN page and amounts are **CNY**;
  `exchangeRate` multiplies the card's own rates (1 = no conversion) instead of converting from USD.
  The wire value gained `pricing.epochs`, `pricing.pageVariant`, `models[].epochs`,
  `currencyMixed`, `excludedCalls`, and `excludedTokens`; the dialog gained a rate-timeline section,
  the per-model segment count, and the excluded-provider note.
- `dsh-token-cost` 1.3.0: holiday refresh and pricing refresh now run on independent schedules; the
  holiday calendar unions fetched dates, manual extras, and fixed anchors, and the frozen snapshot
  rebuilds the anchors for the session's own Beijing years. The client band/minutes-until-switch
  helpers delegate to the canonical rules (the client now scans with the same 10-day bound as the
  clock instead of 7 days).
- `dsh-sidebar-clock` 1.1.0: the clock's tariff/holiday helpers delegate to the canonical module;
  holiday payloads are parsed by the shared parser (timor / Nager / plain shapes).
- `README.md` and plugin READMEs describe the shared canonical rules, compatibility doc, pack
  workflow, and the corrected Node floor; `tests/sidebar-clock-installed.cjs` and the client
  harness now skip cleanly when `app.asar` is absent and centralize `DSH_ASAR`.

### Fixed

- `dsh-token-cost`: a totally failed holiday refresh no longer records a successful 24 h refresh;
  failures retry after 5 min → 15 min → 1 h (hourly while failing), and a success restores
  `holidayRefreshIntervalMs`. A slow holiday source no longer delays the pricing refresh.
- `dsh-token-cost`: an unrecognized or invalidated pricing page no longer silently keeps pricing
  old data; the last good card is kept, the live status is marked degraded with a reason, and the
  UI shows it. Parsing now validates its own output (prices, off-peak ≤ peak, windows, models) and
  accepts the reversed `PEAK … OFF-PEAK …` column order.
- `dsh-token-cost`: token-cost and the sidebar clock now agree on years without a published holiday
  arrangement (fixed anchors) and on the holiday payload shapes, instead of one billing peak while
  the other counts down to a holiday.
- `dsh-sidebar-clock`: a structural mismatch in the sidebar shell is logged once with the DSH
  version and the reason instead of silently falling back to the footer with no diagnostic.
