# DSH Plugins

Two Web UI plugins and one Host-side tool plugin for **DeepSeek Harness** (DSH), plus the notes
and offline test harnesses used to build them.

| Plugin | Version | What it does |
|---|---|---|
| [`dsh-sidebar-clock`](dsh-sidebar-clock/README.md) | 1.1.0 | One card at the top of the sidebar: local clock, live deepseek peak/off-peak band, countdowns to the next weekend and the next Chinese public holiday, and the signed-in account balance. |
| [`dsh-token-cost`](dsh-token-cost/README.md) | 1.4.0 | Prices the current Session in real time in CNY from the official DeepSeek rate card, with each request priced at the rate in force when it ran (a price change splits the timeline instead of freezing the conversation), separating peak/off-peak, cache-hit/cache-miss/cache-write input and output, a per-request breakdown dialog with the rate timeline and a sub-agent total, live staleness/degradation status, a holiday calendar with fixed-anchor fallback, and a separate report of excluded gateways (magpie/codex) that are billed elsewhere. |
| [`dsh-github`](dsh-github/README.md) | 1.1.0 | Adds model-facing GitHub tools (repository search and metadata, issues, pull requests and diffs, commits, files) plus a Settings → GitHub page for the token, default repository, and write policy; writes stay opt-in and approval-gated by default. |

The two UI plugins are additive: they register into official slots (`sidebar.footer.action`,
`conversation.composer.dock`) and never replace the stock sidebar or composer. `dsh-github` is
Host-only: it registers `github_*` tools on `ctx.tools` and has no UI surface.

## Repository layout

```
dsh-plugins/
├─ .github/workflows/ci.yml # CI: npm test on windows-latest, Node 22.15 and 24
├─ dsh-sidebar-clock/     # bundle: index.js (host), client.js (web UI), patch, locale, icon
├─ dsh-token-cost/        # bundle: host-side pricing/projection + client pill and dialog
├─ dsh-github/            # Host-only bundle: github_* tools over the GitHub REST API
├─ docs/
│  ├─ compatibility.md                 # DSH shell/adapter compatibility matrix and upgrade checklist
│  ├─ dsh-plugin-learnings.md          # platform notes: sidebar slot topology, slot API, debugging
│  ├─ github-integration-analysis.md   # GitHub integration scope, safety model, alternatives
│  └─ plugin-reflections.md             # current-state review and prioritized optimization directions
├─ shared/tariff/          # canonical peak/off-peak + Chinese holiday rules (single source)
├─ tests/                 # offline harnesses (Node; github-tools uses a mock fetch layer)
│  └─ fixtures/
├─ tools/                 # asar reader, session-log inspection, test runner, packer, tariff sync
├─ CHANGELOG.md           # Keep a Changelog; per-release notes live here
├─ LICENSE                # MIT
├─ package.json           # npm test / npm run pack / npm run sync:shared
└─ README.md
```

The peak/off-peak band and the Chinese holiday calendar are one canonical module,
`shared/tariff/index.js`. `dsh-token-cost` imports a generated Host copy and both
UI clients carry a generated inline copy (`node tools/sync-shared.mjs` regenerates
them; `npm test` fails when a copy drifts). This keeps the clock and the cost
meter from disagreeing about peak windows, holiday parsing, or unpublished years.

## Requirements

- DSH desktop **0.2.1-rc.2** (the sidebar adapter and the client slot names target that shell;
  `dsh-github` targets the same Host `ctx.tools` contract). The versioned sidebar adapter and the
  per-DSH-release upgrade checklist are in [docs/compatibility.md](docs/compatibility.md).
- Node.js **>= 22.15** to run the tests (no dependencies to install). The replay harness
  (`tests/replay.test.mjs`) uses `zlib.zstdDecompressSync`, which was added in Node 22.15
  ([Node zlib docs](https://nodejs.org/docs/latest-v22.x/api/zlib.html)); on an older Node the
  replay would throw instead of skipping, so 22.15 is the hard floor. CI covers Node 22.15 and 24.

## Installation

Each plugin is a DSH bundle: a `package.json` declaring `dsh.bundle.patch` plus a
`cordis.patch.yml` that inserts the bundle's row.

Install a bundle with the plugin manager (`plugin_manager install_bundle` with the
plugin directory as target — a directory target is recorded as a `link:` dependency
in the active profile), then enable it. The row and its defaults land in the profile's
`~/.dsh/profiles/<profile>/cordis.patch.yml`; add a row with the same `id` there to
override the config.

## Pack and upgrade

`npm run pack` builds redistributable archives without any dependencies (`tools/pack.mjs`):

```
dist/
├─ dsh-sidebar-clock-1.1.0.zip
├─ dsh-sidebar-clock-1.1.0.zip.sha256
├─ dsh-token-cost-1.4.0.zip
├─ dsh-token-cost-1.4.0.zip.sha256
├─ dsh-github-1.1.0.zip
└─ dsh-github-1.1.0.zip.sha256
```

Each archive contains exactly the bundle's `package.json` `files` entries plus `package.json`, so
the bundle's own `README.md` is included but the repository-level `LICENSE` and `CHANGELOG.md` are
not (they are root-only; keep them next to the archive when redistributing). Entries are stored
uncompressed with fixed timestamps, so packing unchanged sources reproduces byte-identical archives
and checksums.

To upgrade an installed bundle: unpack the new archive into a stable directory, then reinstall that
directory with the plugin manager (or repoint the profile's `link:` entry), and reload DSH. Read
[CHANGELOG.md](CHANGELOG.md) first for behavior changes. The `.sha256` file uses the `sha256sum`
format, so it can be checked with either tool:

```powershell
Get-FileHash dist/dsh-token-cost-1.4.0.zip -Algorithm SHA256
Get-Content dist/dsh-token-cost-1.4.0.zip.sha256
```

## Tests

One command runs every offline harness (no dependencies to install):

```powershell
npm test
```

`tools/run-tests.mjs` discovers the top-level scripts in `tests/` (`*.test.mjs`, `*.test.cjs`,
`*-logic.cjs`, `*-harness.cjs`, `*-smoke.mjs`), runs each in its own Node process, prints PASS/FAIL
and a summary, and exits nonzero if any harness fails. Helper modules — for example
`tests/sidebar-clock-installed.cjs`, which is required by the client harness — are not run as
separate tests; they are exercised through the harness that requires them. Individual scripts can
still be run directly and are filtered by name, e.g. `node tools/run-tests.mjs github`.

CI runs the same command on `windows-latest` with Node 22.15 and 24
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

The GitHub harnesses are dependency-free and use mocked GitHub/settings layers, so they run without
a token or network access. The client harness (and the helper it requires) reads SlotCore and the
official sidebar from the installed app archive
(`resources/app.asar`; the default points at the DSH desktop install). Point them elsewhere with the
`DSH_ASAR` environment variable. When the archive is missing they print
`SKIP: DSH app.asar not found (set DSH_ASAR or install DSH desktop)` and exit 0, so CI and machines
without the DSH desktop stay green; when the archive exists but its pinned SlotCore markers moved,
they fail loudly and ask for the test adapter to be refreshed.

## Notes

`docs/dsh-plugin-learnings.md` records the constraints that shaped the two UI plugins: why the
clock renders through a portal instead of replacing the sidebar, what `SlotCore` rejects and
why, and how to debug a client half that stays inactive.
`docs/github-integration-analysis.md` records the GitHub integration scope: the read/write split,
why a Host tool plugin was chosen over an MCP bundle or a UI panel, the approval and token model,
and the non-goals.
`docs/plugin-reflections.md` reviews all three plugins against their current code and tests, lists
the structural risks (shell coupling, duplicated tariff logic, external data contracts), and sets a
prioritized P0/P1/P2 optimization direction with acceptance criteria.

## 中文简介

这个仓库包含三个 DeepSeek Harness 插件：侧边栏时钟卡片（时间、峰谷时段、周末与节假日
倒计时、账户余额）、Token 费用计量（按官方价目实时计费，区分峰谷与缓存桶），以及
GitHub 集成（在会话中搜索仓库与代码、阅读 Issue/PR/diff/提交/文件，可在设置页配置
令牌、默认仓库与写入策略，写入默认逐次审批，关闭审批后可直接新建 Issue、评论和 PR）。`docs/` 下是功能分析与
插件开发笔记，`tests/` 是可离线运行的验证脚本。安装方式见上方 *Installation*；测试用
`npm test` 一键运行，`npm run pack` 生成带 sha256 的分发归档。

## License

[MIT](LICENSE). The vendored `cosmokit` / `schemastery` copies in `dsh-github/vendor/` keep their
own MIT licenses (`LICENSE-cosmokit`, `LICENSE-schemastery`). Release notes are recorded in
[CHANGELOG.md](CHANGELOG.md).
