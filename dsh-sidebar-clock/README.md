# Sidebar Clock (`@local/dsh-sidebar-clock`)

A DSH Web UI plugin that puts one information card at the top of the sidebar —
between the brand row and the **New Session** button:

```
┌───────────────────────────────────┐
│ 🐟 DeepSeek Harness          ⇤   │  brand row
├───────────────────────────────────┤
│ 15:24:39                     ● 高峰 │  clock card
│ 周一 10月19日        15:00 转低谷   │
│ 周末 2天3小时后  ·  元旦 74天后      │
├───────────────────────────────────┤
│ + 新会话                           │  New Session
│ …                                  │
```

The card shows:

- **the local wall clock** (seconds tick once per second);
- **the DeepSeek tariff band** — 高峰 / 低谷 — derived exactly like
  [`../dsh-token-cost`](../dsh-token-cost/README.md): the published UTC peak windows
  `01:00–04:00` and `06:00–10:00`, Monday–Friday only, and Chinese public
  holidays treated as off-peak for the whole day. The meta line names the next
  switch (for example `15:00 转低谷`);
- **the countdown to the next weekend** — the coming Saturday 00:00 in the
  browser's local time, or the remaining days of the current weekend while one
  is in progress (it ends Monday 00:00); shown in whole days;
- **the countdown to the next Chinese public holiday**, with the holiday's name
  (`元旦`, `国庆节`, …), also in whole days;
- **the account balance** of the signed-in DeepSeek account (`¥12.34` / `$5.00`),
  or `—` when the account is signed out or the profile has no Account Remote.

The card is a compact status surface: it shows only the current state and has
no hover tooltip or expandable detail.

## Where it appears

The plugin registers one additive entry in the official
`sidebar.footer.action` list. It does not replace `sidebar` or declare any of
the official sidebar's child slots. The stock sidebar owns brand rendering,
New Session, panel selection, workspace browsing, shortcuts and collapse behavior.

On the supported 0.2.1-rc.2 shell, a small versioned DOM adapter finds the brand
row and New Session button in the same sidebar, inserts its own empty container
before New Session, and renders the clock there through a React portal. It never
moves or rewrites the stock sidebar's nodes. Collapsing or disabling the plugin
removes its container; re-expanding mounts it again. If the known shell structure
is absent, the clock stays in the footer slot and the adapter logs one
`[sidebar-clock] sidebar adapter: …` warning per failure kind, including the DSH
version it was built for — a warning means "adapter/version mismatch", while a
missing card with no warning means the plugin did not activate. A clock error only
hides the card. The versioned class map and the upgrade re-check checklist live in
[`../docs/compatibility.md`](../docs/compatibility.md).

Why not replace the sidebar column itself: `sidebar` is a single slot, and a
competing occupant cannot inherit or re-declare its child slots (SlotCore rejects
that with `slot "sidebar.brand.mark" is already declared`). The platform
constraints and the adapter approach are written down in
[`../docs/dsh-plugin-learnings.md`](../docs/dsh-plugin-learnings.md).

## How the numbers are derived

| Value | Source |
|---|---|
| Time / date | `Date` and `Intl.DateTimeFormat` in the browser's local time zone |
| Peak / off-peak | The canonical rules in `shared/tariff/index.js` (published UTC windows, weekdays only, Chinese holidays off-peak all day), inlined into `client.js` by `tools/sync-shared.mjs` |
| Weekend countdown | Local Saturday 00:00 (Monday 00:00 while in a weekend), rounded to whole days |
| Holiday countdown | Confirmed dates from the [timor.tech](https://timor.tech/api/holiday/year/2026) calendar for the current Beijing year only; rounded to whole days; shows `暂无` / `none known` when no current-year holiday remains |
| Balance | The Account Remote (`ctx.remote.account.getBalance`) for the signed-in account; polled every 10 minutes, CNY wallet preferred over USD |

The peak/off-peak windows and the Beijing holiday rule are
defined in `shared/tariff/index.js`, the single source
of truth shared with `dsh-token-cost`, and this file carries a generated copy
between `generated:tariff` markers. Edit the canonical module, run
`node tools/sync-shared.mjs`, and the clock and the cost meter can never drift
apart on holiday parsing or generate estimates for unpublished dates.

The holiday countdown targets **Beijing midnight**, the same instant the band
flips to off-peak, so the countdown and the badge never disagree in another
time zone.

The calendar is fetched by the browser every 6 hours for the **current Beijing year only** and
cached in `localStorage` (`dsh.sidebar-clock.holidays.v2`). Failures keep the last successfully
validated current-year calendar; the cache remains usable throughout that year. Legacy v1 caches
are ignored because their dates may contain estimates. With no usable calendar the map stays empty,
the countdown shows `暂无` / `none known`, and the band follows normal weekend/time-window rules.
No holiday dates or holiday lengths are generated locally. Business errors, invalid shapes and
invalid dates are treated as failures; valid empty calendars clear old automatic dates. A request
finishing across New Year cannot restore the previous year's calendar. This bundle fetches directly
in the browser, so the endpoint must allow the page origin through CORS; the Host half is a no-op
inventory row.

## Configuration

The tariff rules are canonical (`shared/tariff/index.js`, generated copy inlined
in `client.js`); the calendar source and the balance cadence are module
constants in `client.js` (`HOLIDAY_SOURCE`, `HOLIDAY_REFRESH_MS`,
`BALANCE_REFRESH_MS`): edit the canonical module (then run
`node tools/sync-shared.mjs`) or these client constants and reinstall to change
them. There is no Host config because the tree of UI features this version
exposes is intentionally one card.

## Files

| File | Role |
|---|---|
| `index.js` | Host half (no-op; the bundle's inventory row) |
| `client.js` | Client half: the clock card, additive footer entry, and top-position portal |
| `cordis.patch.yml` | Bundle patch inserting the row |
| `locale/{en,zh}.json` | Plugin-manager title/description |
| `icon.svg` | Plugin icon |

## Limits

- **Versioned placement adapter** — the top position recognizes the installed
  0.2.1-rc.2 sidebar classes. A redesign may place the card in the footer until
  the adapter is updated. Disabling the clock removes only its own entry and DOM.
- **Calendar scope and publication lag** — only the current year's known dates are used. The card
  does not fetch next year or estimate unpublished holidays; with no remaining known date it shows
  `暂无` / `none known`.
- **Display offsets** — the local windows and the clock use the browser's
  current UTC offset, so a card left open across a DST change can show the
  local clock one hour off until the next render tick.
- **Balance is polled, not streamed** — the Account detail endpoint is read every
  10 minutes; a fresh spend can take up to that long to appear. Profiles without
  the Account Remote (or a signed-out account) show `—`.
- **No per-day aggregates** — the card is a status surface, not a usage report;
  the reference plugin keeps the billing detail.

## Verification

Requires Node.js ≥ 22.15 (the repository floor; see `../package.json`).

From the parent `dsh-plugins` directory:

```powershell
node tests/sidebar-clock-adapter.test.cjs
node tests/sidebar-clock-logic.cjs
node tests/sidebar-clock-client-harness.cjs
```

`tests/sidebar-clock-adapter.test.cjs` is fully offline: it slices the real
adapter region out of `client.js` between the `sidebar-shell-adapter:start/end`
markers and runs it against a minimal DOM stub plus
`tests/fixtures/sidebar-shell-0.2.1-rc.2.html`, covering the happy path, missing
root / brand row / New Session, reversed order, an anchor outside the root,
one-warning-per-kind, and hostile DOM. The fixture and the versioned class map
`SIDEBAR_SHELL` are validated against the installed shell by the checklist in
[`../docs/compatibility.md`](../docs/compatibility.md).

The client harness reads SlotCore and the official sidebar directly from the
installed app archive (override its path with `DSH_ASAR`). It verifies coexistence,
the rejected duplicate-declaration attempt, and unload/reload without losing any
child slot.
