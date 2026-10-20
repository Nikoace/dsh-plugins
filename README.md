# DSH Plugins

Two Web UI plugins and one Host-side tool plugin for **DeepSeek Harness** (DSH), plus the notes
and offline test harnesses used to build them.

| Plugin | Version | What it does |
|---|---|---|
| [`dsh-sidebar-clock`](dsh-sidebar-clock/README.md) | 1.0.1 | One card at the top of the sidebar: local clock, live deepseek peak/off-peak band, countdowns to the next weekend and the next Chinese public holiday, and the signed-in account balance. |
| [`dsh-token-cost`](dsh-token-cost/README.md) | 1.2.0 | Prices the current Session in real time from the official DeepSeek rate card, separating peak/off-peak, cache-hit/cache-miss/cache-write input and output, with a per-request breakdown dialog. |
| [`dsh-github`](dsh-github/README.md) | 1.1.0 | Adds model-facing GitHub tools (repository search and metadata, issues, pull requests and diffs, commits, files) plus a Settings → GitHub page for the token, default repository, and write policy; writes stay opt-in and approval-gated. |

The two UI plugins are additive: they register into official slots (`sidebar.footer.action`,
`conversation.composer.dock`) and never replace the stock sidebar or composer. `dsh-github` is
Host-only: it registers `github_*` tools on `ctx.tools` and has no UI surface.

## Repository layout

```
dsh-plugins/
├─ dsh-sidebar-clock/     # bundle: index.js (host), client.js (web UI), patch, locale, icon
├─ dsh-token-cost/        # bundle: host-side pricing/projection + client pill and dialog
├─ dsh-github/            # Host-only bundle: github_* tools over the GitHub REST API
├─ docs/
│  ├─ dsh-plugin-learnings.md          # platform notes: sidebar slot topology, slot API, debugging
│  └─ github-integration-analysis.md   # GitHub integration scope, safety model, alternatives
├─ tests/                 # offline harnesses (Node; github-tools uses a mock fetch layer)
│  └─ fixtures/
└─ tools/                 # asar extraction and session-log inspection helpers
```

## Requirements

- DSH desktop **0.2.1-rc.2** (the sidebar adapter and the client slot names target that shell;
  `dsh-github` targets the same Host `ctx.tools` contract).
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
node tests/github-tools.test.mjs            # GitHub tools: HTTP, rendering, writes, cache, config
node tests/github-settings-client.test.mjs  # GitHub Settings page: loader artifact + slot wiring
node tests/github-token-help.test.mjs       # GitHub Settings: token creation links + scope guidance
```

The harnesses read SlotCore and the official sidebar from the installed app archive
(`resources/app.asar`); point them elsewhere with the `DSH_ASAR` environment variable.
The three GitHub harnesses are dependency-free and use mocked GitHub/settings layers, so they
run without a token or network access.

## Notes

`docs/dsh-plugin-learnings.md` records the constraints that shaped the two UI plugins: why the
clock renders through a portal instead of replacing the sidebar, what `SlotCore` rejects and
why, and how to debug a client half that stays inactive.
`docs/github-integration-analysis.md` records the GitHub integration scope: the read/write split,
why a Host tool plugin was chosen over an MCP bundle or a UI panel, the approval and token model,
and the non-goals.

## 中文简介

这个仓库包含三个 DeepSeek Harness 插件：侧边栏时钟卡片（时间、峰谷时段、周末与节假日
倒计时、账户余额）、Token 费用计量（按官方价目实时计费，区分峰谷与缓存桶），以及
GitHub 集成（在会话中搜索仓库与代码、阅读 Issue/PR/diff/提交/文件，可在设置页配置
令牌、默认仓库与写入策略，写入经审批新建 Issue、评论和 PR）。`docs/` 下是功能分析与
插件开发笔记，`tests/` 是可离线运行的验证脚本。安装方式见上方 *Installation*。

## License

No license has been declared for this repository yet.
