# DSH Plugins

Two Web UI plugins for **DeepSeek Harness** (DSH), plus the notes and offline test
harnesses used to build them.

| Plugin | Version | What it does |
|---|---|---|
| [`dsh-sidebar-clock`](dsh-sidebar-clock/README.md) | 1.0.1 | One card at the top of the sidebar: local clock, live deepseek peak/off-peak band, countdowns to the next weekend and the next Chinese public holiday, and the signed-in account balance. |
| [`dsh-token-cost`](dsh-token-cost/README.md) | 1.2.0 | Prices the current Session in real time from the official DeepSeek rate card, separating peak/off-peak, cache-hit/cache-miss/cache-write input and output, with a per-request breakdown dialog. |

Both are additive: they register into official slots (`sidebar.footer.action`,
`conversation.composer.dock`) and never replace the stock sidebar or composer.

## Repository layout

```
dsh-plugins/
├─ dsh-sidebar-clock/     # bundle: index.js (host), client.js (web UI), patch, locale, icon
├─ dsh-token-cost/        # bundle: host-side pricing/projection + client pill and dialog
├─ docs/
│  └─ dsh-plugin-learnings.md   # platform notes: sidebar slot topology, slot API, debugging
├─ tests/                 # offline harnesses (Node, run against the installed app archive)
│  └─ fixtures/
└─ tools/                 # asar extraction and session-log inspection helpers
```

## Requirements

- DSH desktop **0.2.1-rc.2** (the sidebar adapter and the client slot names target that shell).
- Node.js 20+ to run the tests (no dependencies to install).

## Installation

Each plugin is a DSH bundle: a `package.json` declaring `dsh.bundle.patch` plus a
`cordis.patch.yml` that inserts the bundle's row.

Install a bundle with the plugin manager (`plugin_manager install_bundle` with the
plugin directory as target — a directory target is recorded as a `link:` dependency
in the active profile), then enable it. The row and its defaults land in the profile's
`~/.dsh/profiles/<profile>/cordis.patch.yml`; add a row with the same `id` there to
override the config.

## Tests

Run from this directory:

```powershell
node tests/sidebar-clock-logic.cjs          # tariff bands, weekend/holiday countdowns
node tests/sidebar-clock-client-harness.cjs # slot coexistence + unload/reload
node tests/sidebar-clock-installed.cjs      # registration semantics against the real SlotCore
node tests/host.test.mjs                    # token-cost pricing, effective dating, projection fold
node tests/client-smoke.mjs                 # renders the client halves in a DOM harness
node tests/replay.test.mjs                  # replays a recorded session log
```

The harnesses read SlotCore and the official sidebar from the installed app archive
(`resources/app.asar`); point them elsewhere with the `DSH_ASAR` environment variable.

## Notes

`docs/dsh-plugin-learnings.md` records the constraints that shaped the code: why the
clock renders through a portal instead of replacing the sidebar, what `SlotCore`
rejects and why, and how to debug a client half that stays inactive.

## 中文简介

这个仓库包含两个 DeepSeek Harness Web UI 插件：侧边栏时钟卡片（时间、峰谷时段、
周末与节假日倒计时、账户余额）和 Token 费用计量（按官方价目实时计费，区分峰谷与
缓存桶）。`docs/` 下是插件开发过程中整理的平台笔记，`tests/` 是可离线运行的
验证脚本。安装方式见上方 *Installation*。

## License

No license has been declared for this repository yet.
