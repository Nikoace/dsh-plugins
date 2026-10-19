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
is absent, the clock stays in the footer slot. A clock error only hides the card.

Why not replace the sidebar column itself: `sidebar` is a single slot, and a
competing occupant cannot inherit or re-declare its child slots (SlotCore rejects
that with `slot "sidebar.brand.mark" is already declared`). The platform
constraints and the adapter approach are written down in
[`../docs/dsh-plugin-learnings.md`](../docs/dsh-plugin-learnings.md).

## How the numbers are derived

| Value | Source |
|---|---|
| Time / date | `Date` and `Intl.DateTimeFormat` in the browser's local time zone |
| Peak / off-peak | Published UTC windows, weekdays only, holidays off-peak all day |
| Weekend countdown | Local Saturday 00:00 (Monday 00:00 while in a weekend), rounded to whole days |
| Holiday countdown | [timor.tech](https://timor.tech/api/holiday/year/2026) calendar (the same JSON mirror the reference plugin uses), unioned with the fixed statutory anchors 元旦 01-01 / 劳动节 05-01 / 国庆节 10-01 for years whose arrangement is not published yet; rounded to whole days |
| Balance | The Account Remote (`ctx.remote.account.getBalance`) for the signed-in account; polled every 10 minutes, CNY wallet preferred over USD |

The holiday countdown targets **Beijing midnight**, the same instant the band
flips to off-peak, so the countdown and the badge never disagree in another
time zone.

The calendar is fetched by the browser every 6 hours for the current and next
Beijing year, cached in `localStorage` (`dsh.sidebar-clock.holidays.v1`), and
falls back to the cache and then to the statutory anchors when the network is
unavailable (the failure is logged). The endpoint reflects the page origin's
`Access-Control-Allow-Origin`, so no Host proxy is needed; this bundle's Host
half is a no-op inventory row. If a future deployment blocks the direct fetch,
the card keeps working from the cached/anchored calendar but adjusted days
(春节 / 清明 / 端午 / 中秋) stay absent until a source is reachable.

## Configuration

The tariff policy, calendar source, and balance cadence are module constants in
`client.js` (`PEAK_WINDOWS`, `WEEKDAYS_ONLY`, `HOLIDAY_SOURCE`,
`HOLIDAY_REFRESH_MS`, `FIXED_HOLIDAYS`, `BALANCE_REFRESH_MS`): edit and reinstall
to change them. There is no Host config because the tree of UI features this
version exposes is intentionally one card.

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
- **Calendar publication lag** — the next year's adjusted days are published
  once a year; until then that year only has the fixed statutory anchors.
- **Display offsets** — the local windows and the clock use the browser's
  current UTC offset, so a card left open across a DST change can show the
  local clock one hour off until the next render tick.
- **Balance is polled, not streamed** — the Account detail endpoint is read every
  10 minutes; a fresh spend can take up to that long to appear. Profiles without
  the Account Remote (or a signed-out account) show `—`.
- **No per-day aggregates** — the card is a status surface, not a usage report;
  the reference plugin keeps the billing detail.

## Verification

From the parent `dsh-plugins` directory:

```powershell
node tests/sidebar-clock-logic.cjs
node tests/sidebar-clock-client-harness.cjs
```

The client harness reads SlotCore and the official sidebar directly from the
installed app archive (override its path with `DSH_ASAR`). It verifies coexistence,
the rejected duplicate-declaration attempt, and unload/reload without losing any
child slot.
