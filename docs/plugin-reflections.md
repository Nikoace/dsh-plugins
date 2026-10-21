# DSH 插件：现状思考与优化方向

> 记录时间：2026-10-19
> 覆盖插件：`dsh-sidebar-clock` 1.0.1、`dsh-token-cost` 1.2.0、`dsh-github` 1.1.0
> 方法：通读三个插件的源码、README 与 `docs/`，并运行仓库内全部 8 个离线验证脚本（结果见附录 A）。
> 范围：只讨论这三个本地插件，不讨论 DSH 本体；"应该做什么"以个人日常使用和长期可维护性为前提。

## 0. 结论先行

1. 三个插件已经越过"能跑"阶段：功能边界清楚，安全默认值合理，离线测试覆盖了大部分逻辑。下一阶段真正稀缺的不是功能，而是**可信度、可升级性、可维护性**。
2. 最大的风险不在插件内部算法，而在三处边界：
   - **DSH 外壳结构**：侧边栏顶部位置只能靠哈希类名 DOM 适配；
   - **外部数据契约**：官方价目页是给人看的 HTML，节假日源是第三方 JSON；
   - **跨插件重复的领域逻辑**：费率时段与节假日规则被抄成了三份，已经出现行为分叉。
3. 建议下一阶段**先不扩功能**，集中做五件事：修掉节假日刷新失败不重试的缺陷、建立费率逻辑的单一事实源、让数据源降级在 UI 上可见、给 DOM 适配器补契约测试、补 CI 与 Node 版本声明。GitHub v2 与跨会话统计往后放。

| 优先级 | 方向 | 一句话理由 |
|---|---|---|
| P0 | 修数据静默失效 | 计费/时间显示错一次，插件就失去信任 |
| P0 | 费率与节假日单一事实源 | 同一规则三份实现，已经不一致 |
| P0 | 外部数据契约 + 过期可见 | 价目页改版时用户应知道自己在看旧价 |
| P0 | 侧边栏适配器测试与失效可观测 | 唯一的高风险 DOM hack，目前零测试 |
| P0 | CI、Node 版本、发布清单 | 现在的"全绿"依赖本机环境 |
| P1 | 测试边界从"代码切片"改为模块 | 现有测试会被一次重构静默绕过 |
| P1 | 投影状态版本与迁移策略 | `stateVersion` 已到 5，但没有迁移测试 |
| P1 | 客户端细节：定时器 / 可访问性 / locale | 不影响正确性，影响长期体验 |
| P1 | GitHub v2（按使用证据） | 先把"可观测"和"写入验证"补上 |
| P2 | 上游插槽、发布工程、跨会话分析 | 收益大但不紧急，取决于是否对外分发 |

## 1. 现状基线

### 1.1 三个插件

| 插件 | 形态 | 关键机制 | 强项 | 薄弱点 |
|---|---|---|---|---|
| `dsh-sidebar-clock` | Web UI，加法条目 + Portal | 注册 `sidebar.footer.action`，再用版本化 DOM 适配把卡片插到品牌行与新会话之间；失败退回 footer | 错误边界、缓存兜底、可选 Remote 处理、6 小时日历刷新 | 哈希类名适配零测试；每秒整卡重渲染；未发布年份用固定锚点，与 token-cost 行为不一致 |
| `dsh-token-cost` | Host 投影 + Web UI | 抓官方价目页解析成生效日期目录；会话创建时冻结快照；按请求折叠峰谷/缓存桶 | 冻结语义、整数微货币、显式"估算/未定价"计数、离线回放测试 | 价目页正则解析；节假日失败被当成"已刷新"；会话级冻结导致旧会话显示旧价；无跨会话汇总 |
| `dsh-github` | Host 工具 + 设置页 | 13 个 `github_*` 工具；凭证服务存 token；默认只读、写入逐次审批；ETag 缓存 | 安全模型完整、错误不回显 token、82 个离线用例 | 无 GraphQL/OAuth；缓存仅进程内；真实写入与设置页视觉未验证；fine-grained PAT 通常不返回 `x-oauth-scopes`，scope 展示为空 |

### 1.2 工程基线

- 插件 JS 共 12 个文件、约 5,700 行（不含 `vendor/` 与测试）；三个 bundle 都保持运行时零依赖。
- 8 个离线脚本全部通过；GitHub Host 用例 82 个，其余为断言式脚本。
- **缺失的工程护栏**：没有 `.github/`（CI）、没有 `LICENSE`、没有 `CHANGELOG`、没有 lint/typecheck 配置、没有 DSH 版本兼容矩阵、没有打包脚本。
- **测试环境绑定**：`tests/sidebar-clock-installed.cjs` 默认读取 `D:/software/.../app.asar`，并从 `index-CN7NIWNw.js` 里截取 SlotCore；DSH 换个补丁版本就可能失败，尽管 SlotCore 的契约没变。
- **Node 版本声明不准确**：README 写 "Node.js 20+"，但 `tests/replay.test.mjs` 使用 `zlib.zstdDecompressSync`，该 API 从 Node **22.15.0** 才提供（[Node zlib 文档](https://nodejs.org/docs/latest-v22.x/api/zlib.html)）。Node 20 上 replay 测试会直接抛错，而不是跳过。

## 2. 做对了什么（应保持）

- **只做加法，不接管官方 UI**：两个 UI 插件都注册官方可加席位，不替换 sidebar/composer，不给升级制造第二套分支。
- **Host/Client 分工明确**：网络、密钥、抓取在 Host；浏览器侧只做展示和轻交互。GitHub token 不落在客户端存储或配置里。
- **计费的冻结语义**：费率与日历按会话创建时间冻结，历史会话不被重定价。这是记账类工具最该坚持的性质。
- **失败关闭（fail closed）**：GitHub 写入默认关闭，审批不可用就拒绝；比"默认能写、出事再关"安全得多。
- **零运行时依赖**：三个 bundle 都能直接以目录安装，不需要 `npm install`；vendored 代码附了 MIT 许可证。
- **离线优先的验证**：mock fetch、真实 SlotCore、真实 session 日志回放——不依赖网络和 token，这点很难得。
- **把平台的坑写进文档**：`docs/dsh-plugin-learnings.md` 记录了 SlotCore 语义、激活排错、locale 陷阱，是后续插件最有价值的资产之一。
- **局部错误隔离**：时钟有 `ClockBoundary`，刷新失败只记录日志不炸 UI；样式标签与定时器都有 `ctx.effect` 释放。

## 3. 结构性矛盾

### 3.1 "固定位置"与"官方插槽"的冲突

`sidebar` 是 single slot，子槽所有权不可继承；官方没有"品牌行下方"的可加席位。想在固定像素位置放卡片，只剩两条路：整壳替换（升级即坏）或"官方席位 + DOM 适配"。当前选了后者，这是对的取舍，但代价被低估了：

- 适配依赖 `_2H3hWW_root` / `_2H3hWW_logoRow` / `_2H3hWW_newSession` 三个哈希类名，以及"footer 条目仍在 sidebar 根内"这个隐含前提；
- 把非 React 节点插进 React 管理的子节点列表，理论上可能被后续 reconciliation 移除；目前靠 `wide` 变化重挂载，缺少"节点被移除后自愈"的验证；
- 现有 `sidebar-clock-client-harness.cjs` 只验证 slot 注册/释放，`createPortal` 和 `createElement` 都是 stub，**适配器本身一行都没测**。

思考：这个 hack 应该是全仓库**唯一**的 DOM 侵入点。既然保留它，就要把它当成一个独立的小模块对待：有输入（DOM）→ 输出（host 或 null）的纯函数、有 fixture、有明确日志，而不是散在组件 effect 里。长期则推动上游增加一个官方 header 槽（见 §4 P2）。

### 3.2 同一份领域知识被抄了三遍

费率/节假日规则目前的位置：

| 知识 | `sidebar-clock/client.js` | `token-cost/index.js` | `token-cost/client.js` |
|---|---|---|---|
| 峰时窗口 | `PEAK_WINDOWS` | `DEFAULT_PEAK_WINDOWS` | 来自 Host 的 `pricing.peakWindows` |
| 仅工作日 | `WEEKDAYS_ONLY` | `weekdaysOnly` | `pricing.weekdaysOnly` |
| 北京偏移 | `HOLIDAY_OFFSET_MINUTES` | `holidayOffsetMinutes`（可配） | `pricing.holidayOffsetMinutes ?? 480` |
| 节假日源 | `HOLIDAY_SOURCE`（浏览器直连） | `DEFAULT_HOLIDAY_SOURCE`（Host 抓取） | — |
| 固定锚点 | `FIXED_HOLIDAYS` | **无** | **无** |
| 判定函数 | `bandAt(timeMs, dates)` | `bandAt(timeMs, pricing)` | `bandAt(pricing, timeMs)` |
| 下一次切换 | 最多扫 10 天，按分钟缓存 | — | 最多扫 7 天，每次渲染重扫 |

后果不是理论上的：

- **未发布年份的行为不同**：2027 年安排发布前，时钟仍会把元旦/劳动节/国庆当作假期倒计时（固定锚点），token-cost 却因日历为空而按高峰计费。用户会同时看到"假期快到了"和"现在按高峰收费"。
- **刷新策略不同**：时钟要求当前/下一年至少一个成功，失败后 6 小时再试；token-cost 把失败也记为"已刷新"，下一次重试要等 24 小时。
- **解析范围不同**：时钟只认 timor 的 `{holiday:{...}}`；token-cost 还认数组、`{dates:[]}`、Nager 形状。换一个节假日源，两边表现不同。
- **扫描上限 10 天 vs 7 天**属于隐含假设，当前窗口下不会出错，但修改规则时容易踩到。

这类"同一事实、多份实现"是最典型的腐化起点。它不会一次坏掉，而是每次改规则时坏一点。

### 3.3 外部数据源是"没有版本号的契约"

- `dsh-token-cost` 用正则从 tag-stripped 文本里抓 `MODEL`、`1M INPUT TOKENS (CACHE HIT)`、`OFF-PEAK`/`PEAK`，并把页面上**前两个** `HH:MM - HH:MM` 当作峰时窗口。任何措辞、大小写、单位或版式变化都会让解析返回 `null`；此时保留旧卡、只打一条 `logger.warn`。用户能看到的唯一线索是详情里上一次更新时间——没有"这可能是旧价"的明确提示。
- 节假日来自第三方镜像（默认 timor.tech）。它是社区维护的，可能滞后、改结构或不可达；State Council 的原文是散文，没有官方机器接口。这个现实无法消除，只能管理。
- `tests/fixtures/pricing-page.html` 只有一份页面快照，不能证明"页面改版时解析器会明确失败"，也不能证明失败后 UI 的降级路径。

思考：把外部源当**集成**而不是"读一个 URL"。集成需要：契约样本、显式失败、陈旧可见、可替换源、以及"当前数据来自哪里"的可追溯性。

### 3.4 冻结语义正确，但会显得"过期"

按会话创建时间冻结费率/日历，保证了历史金额可复现，这是对的。代价是：

- 安装插件前就存在的会话会冻结 bootstrap 卡，提示"新会话才用官方价"；日历为空时用 amber 点警告"节假日按高峰计"。
- 价目页涨价后，旧会话继续显示旧价，用户可能误以为总额算错了。
- `stateVersion` 已经是 5，`stateSchema` 却是 `passthrough`，也没有任何迁移测试。折叠字段一旦变化，旧会话状态如何解释、是否需要迁移，目前没有测试覆盖，取决于宿主对 `stateVersion` 不匹配的处理。

建议不是取消冻结，而是**把冻结讲清楚**：在详情里同时显示"本会话冻结于哪个版本/何时抓取"和"当前目录已更新到哪个版本"，并提供"新会话将使用新价"的对比提示（只读对比，不改写旧会话）。

### 3.5 测试很强，但测的是"代码切片"

`tests/sidebar-clock-logic.cjs` 用字符串标记从 `client.js` 里切出纯函数段，再用 `new Function` 求值；`tests/client-smoke.mjs` 用 stub React 和 stub DOM 渲染。这个办法在"零依赖 + 单文件客户端 bundle"约束下很聪明，但：

- 改一个缩进、挪一段注释，测试可能因为找不到 marker 直接报错（好事），也可能因为 marker 还在却漏测新增分支（坏事）；
- stub React 的 `useState` 被定制成"总是打开对话框"，无法覆盖关闭、焦点、定位等真实行为；
- 侧边栏 DOM 适配器没有测试，正是 stub 覆盖不到的地方。

方向不是"引入 Playwright 全家桶"，而是把边界前移：纯逻辑放到真正可 import 的模块，客户端 bundle 由脚本生成；DOM 适配器单独用捕获的 outerHTML fixture 测。这样测试对象从"源码文本"变成"模块契约"。

### 3.6 三个客户端各写一套 UI / 本地化约定

三个 `client.js` 都自己注册样式与 zh/en 字典，两个 UI 客户端各自实现 `useNow`、各自处理 locale。当前规模下这不值得抽组件库，但已经出现具体的不一致：

- 时钟用 DSH locale 快照格式化日期（文档里专门记录过"UI 语言 ≠ 浏览器语言"的坑）；
- token-cost 详情里的"读取于 …"用 `toLocaleString()`，取的是浏览器 locale，不是 DSH locale；
- token-cost 的 `minutesUntilSwitch` 每次渲染最多扫描 10,080 分钟，时钟对同类计算做了按分钟缓存；
- 对话框没有焦点管理：打开后不聚焦面板，关闭后不把焦点还给触发按钮，也没有 Tab 焦点约束。

这些都可以用一份"客户端插件约定"清单约束，而不必建共享组件库。

## 4. 优化方向

### P0：先做（1–2 个迭代，低风险、直接提升可信度）

#### P0-1 修复数据静默失效

**问题**：`token-cost/index.js` 的 `refreshHolidays()` 在两个年份都抓取失败（网络错误、非 2xx、JSON 解析失败）后，仍会执行 `holidayFetchedAt = Date.now()`。下一次重试要等 `holidayRefreshIntervalMs`（默认 24 小时）。也就是说，启动时的一次网络抖动会让当天剩余时间都按"无节假日"计费，直到插件重载。时钟的实现反而更稳：`Promise.allSettled` 后要求至少一个年份成功，否则抛错，6 小时后再试。

**做法**：

1. 只在至少一个年份成功时更新 `holidayFetchedAt`；全失败时保持旧值或记录失败时间。
2. 增加短退避：失败后 5 分钟 → 15 分钟 → 1 小时重试，成功后回到 24 小时。
3. 把"节假日数据状态"（成功时间、来源、失败原因）放进投影的 pricing 快照，供 UI 显示。
4. 让价目刷新与节假日刷新解耦：当前 `refresh()` 先 `await refreshHolidays()` 再 `await refreshPricing()`；节假日源慢（两个 15 秒超时）会推迟价目更新。改为并行或各自独立定时器。

**验收**：用 mock fetch 模拟"两次都失败 → 短期重试成功"，断言价目更新不被节假日阻塞、失败不会被当成成功；UI 能显示节假日数据陈旧。

#### P0-2 外部契约测试与"陈旧可见"

**问题**：解析失败时只保留旧卡并打日志，用户无法区分"当前价"和"很久以前的价"。

**做法**：

1. 给解析器补 2–3 份页面 fixture（当前版、字段顺序变化版、彻底改版版），断言：要么解析出预期值，要么明确返回 `null`，且所有价格通过健全性检查（非负、off-peak ≤ peak、窗口在 0–1440、恰好两个模型六组价格）。
2. 在 catalog 快照里写 `parserVersion`、`fetchedAt`、`sourceUrl`、`degradedReason`；UI 在"读取于 …"之外显示 `stale` 徽标（例如超过 2 个刷新周期）。
3. 节假日源支持"主源 + 备用源 + 手动列表"，并在每个日期上保留 provenance（auto/manual/fixed）。先明确一个产品决策：未发布年份是否统一使用固定锚点（建议统一，见 P0-3）。
4. 把"空日历按高峰计费"的 amber 提示扩展为统一的"数据陈旧/降级"提示，避免用户只看到金额、看不到前提。

**验收**：改版 fixture 下解析器失败但不崩溃、旧卡有明确陈旧提示；节假日全失败时 UI 显示"按手动/固定锚点"而不是静默按高峰。

#### P0-3 建立费率/节假日单一事实源

**问题**：见 §3.2，三份实现已经分叉。

**分两步走**：

1. **先加一致性测试（半天）**：用固定向量（工作日峰/谷、周末、北京节假日、UTC 与 JST 两种时区、跨年、DST 边界）分别调用时钟与 token-cost 的判定逻辑，断言结果一致；同时断言常量和源解析形状一致。这一步不改代码，先让分叉可见。
2. **再抽 canonical 模块（2–3 天）**：`shared/tariff/` 放纯函数：`bandAt`、`nextBandSwitch`、`holidayDateKeys`、`holidayDatesForYears`、默认常量。用 `tools/sync-shared.mjs` 生成带 "DO NOT EDIT" 头的副本，分别注入 Host ESM 模块与两个 `client.js`（客户端 loader 不能 import 本地文件，所以生成/内联是必须的）。测试直接 import canonical；CI 校验生成副本的哈希。

**为什么不直接做 npm workspace 包**：三个 bundle 的价值之一是"目录安装、零依赖"；引入包依赖会破坏单独安装和 `files` 清单，反而增加发布复杂度。生成副本 + 哈希校验是当前形态下成本最低的方案。

**验收**：一致性测试覆盖固定向量并通过；任何一份副本与 canonical 不一致时 CI 失败；未发布年份的降级行为在时钟与 token-cost 中统一并有测试。

#### P0-4 侧边栏适配器测试与失效可观测

**问题**：唯一的高风险 DOM hack 零测试；`createTopCardHost` 失败时静默退回 footer。

**做法**：

1. 从 0.2.1-rc.2 侧边栏捕获一份最小 outerHTML fixture（含 root/logoRow/newSession 三层），测 `createTopCardHost` 的 happy path、结构缺失、顺序颠倒、footer anchor 不在 root 内四种情况；断言只插入/移除自己的节点。
2. 适配器按 shell 版本维护一份类名映射，找不到时打一次 `console.warn`（带 DSH 版本），并保留 footer 降级。
3. 先写测试再决定是否需要 `MutationObserver` 自愈；如果 React 重渲染确实会移除 host，再增加"host 断开后重插"的最小逻辑，避免无依据的防御代码。
4. 把"DSH 升级后适配器检查清单"写进 `docs/compatibility.md`。

**验收**：fixture 测试覆盖四种结构；模拟结构变化时函数返回 `null` 且不抛错；页面升级后可从日志判断是"结构不认识"还是"插件没激活"。

#### P0-5 工程护栏：CI、Node 版本、发布清单

**做法**：

1. 加 GitHub Actions（`windows-latest`，Node 22.15 与 24），跑 8 个脚本；asar 相关测试在文件不存在时**明确 skip**（打印原因），其他测试失败即红。
2. 修正版本声明：README/`engines` 从 "Node 20+" 改为 "Node ≥ 22.15"（或给 replay 测试加 zstd 不可用时的 skip，并说明原因）。
3. 加 `LICENSE`（若打算分发，建议 MIT）、`CHANGELOG.md`、根 `package.json` 的 `scripts.test` 一键跑全部；补一份 `docs/compatibility.md`（DSH 版本、适配器版本、已知破坏点）。
4. 加 `tools/pack.mjs`：为每个 bundle 生成 zip + sha256，README 写明安装/升级步骤；避免"从工作区 link 安装"成为唯一路径。
5. 把 `tests/sidebar-clock-installed.cjs` 的硬编码路径与哈希资源名收进一处配置，或提供 `DSH_ASAR` 缺失时的 skip，保证换机器/换版本时错误信息可读。

### P1：结构改善（有明确收益，但不阻塞日常使用）

1. **测试边界从"代码切片"改为模块**：把纯逻辑放入可 import 的源文件，客户端 bundle 由 `tools/build-client.mjs` 拼接生成并加 header；测试直接 import 源文件。保留零依赖核心测试，DOM/浏览器相关测试允许可选 devDependency（未安装时 skip）。
2. **投影状态版本与迁移策略**：`STATE_VERSION = 5` 且 schema 为 passthrough。补一条"旧版本状态 + 新折叠逻辑"的测试，明确不兼容时是重放、重置还是只读；把"历史会话不重定价"写进测试而不是只写在 README。
3. **客户端细节**：
   - 时钟：秒级刷新不可避免，但可把秒数拆成子组件，避免整卡每秒重算；页面隐藏时暂停刷新。
   - token-cost：用窗口边界直接算下一次切换，替代每次渲染最多 10,080 次 `bandAt`；页面隐藏时暂停。
   - 可访问性：对话框打开时聚焦面板/首个可交互元素，关闭后焦点回到 pill，Tab 焦点不逃逸；保留 `role="dialog"`，必要时补 `aria-modal`。
   - locale：详情里的时间戳改用 DSH locale 快照；金额格式若未来支持更多语言，统一走 `Intl.NumberFormat`。
4. **GitHub v2（按使用证据排期）**：设置页实时显示认证身份/剩余额度 + "测试连接"；写操作审计日志（本地、不含 token）；ETag 缓存跨重启持久化；fine-grained PAT 的 scope 为空时明确说明"GitHub 不返回 scope"，不要显示成"无权限"；至少做一次人工真实写入验证。
5. **文档模板化**：把"新插件检查清单"（最小 inject、`ctx.effect` 释放、locale 注册、样式清理、错误边界、可选服务用 `ctx.get`）写成 `docs/plugin-checklist.md`；给两个分析文档补 ADR 式"决策/后果"小节，避免它们随时间变成历史快照。

### P2：战略项（取决于是否对外分发、是否值得投入）

- **推动上游插槽**：向 DSH 提"品牌行下方/侧边栏 header 可加席位"的需求。成功则删掉 DOM 适配器，这是收益最大的一次性改进。
- **发布工程**：版本号、兼容矩阵、包名（`@local/` 改为可发布 scope）、截图/演示、安装文档、安全披露渠道。若只自用，可只做打包与回滚。
- **跨会话用量洞察**：每日/每月汇总、预算提醒、CSV 导出。建议做成独立插件或独立投影，不要塞进 `token-cost` 的会话投影，否则冻结语义和聚合语义会互相污染。
- **GitHub 更深能力**：GraphQL、review/行内评论、Actions/check 状态、OAuth/device flow。每一项都要先回答"是否真的在日常会话里用"。
- **共享 UI 约定**：若插件数量继续增长，再考虑共享 CSS token/字典校验工具；三个插件时建组件库属于过度设计。

## 5. 不建议做的事

- **整壳替换 sidebar/composer**：升级必坏，且会把"插件问题"变成"界面问题"。
- **为了共享逻辑引入完整构建链/运行时依赖**：先用生成脚本 + 一致性测试；等第四个插件出现再评估。
- **把 token 写进 profile patch 作为推荐路径**：凭证服务已经是对的默认；明文 token 只应作为临时调试选项，并在文档里标红。
- **默认打开 GitHub 写入**：写操作的默认值应该是关，审批不可用就失败。
- **先做跨会话数据库/图表**：在"单会话金额是否可信"解决之前，聚合只会放大错误。
- **频繁追哈希类名更新**：适配器应按 DSH 版本成组更新，而不是每次页面小改就改代码。
- **让节假日第三方源成为唯一权威**：保留手动列表、固定锚点和离线路径。
- **自动重定价历史会话**：破坏可复现性；要做也只能做"只读对比"。

## 6. 建议的迭代顺序

| 迭代 | 内容 | 完成标准 |
|---|---|---|
| 1 | P0-1 数据静默失效、P0-2 陈旧可见 | 失败会重试；旧数据有明确提示；相关 mock 测试通过 |
| 2 | P0-3 一致性测试 → canonical 模块 | 固定向量全绿；副本哈希校验进 CI |
| 3 | P0-4 适配器 fixture、P0-5 CI/Node/打包 | 结构变化可测；`npm test` 一键跑；Node 22.15 上全绿 |
| 4 | P1-1 测试边界、P1-2 状态迁移 | 纯逻辑可 import；旧状态有明确行为测试 |
| 5 | P1-3 客户端细节、P1-4 GitHub v2 | 键盘可完成开关对话框；写入有审计与一次真实验证 |

## 7. 需要先决定的开放问题

1. **这个仓库是自用还是对外分发？** 决定 P0-5/P2 的投入。自用可以只做 CI + 打包；分发还需要许可证、兼容矩阵、安全披露与视觉验证。
2. **时钟的"顶部固定位置"值不值这个适配成本？** 如果不值，退回 footer 可以删掉整个 DOM hack，升级成本立刻下降。
3. **未发布年份统一用固定锚点，还是统一按高峰？** 必须两个插件一致；建议统一用固定锚点并明确标注"预估"。
4. **token-cost 是否要跨会话统计？** 要的话建议独立插件，保持会话投影只做可复现的单会话账本。
5. **GitHub 写入是否进入日常流程？** 如果没有真实写入需求，优先补只读可观测性，而不是 GraphQL/review。

## 附录 A：验证基线（2026-10-19，Windows，Node v25.2.1）

```text
node tests/sidebar-clock-logic.cjs           exit 0  all checks passed
node tests/sidebar-clock-client-harness.cjs  exit 0  3 轮激活/卸载均保留官方 sidebar 与 7 个子槽
node tests/sidebar-clock-installed.cjs       exit 0  （helper，无输出）
node tests/host.test.mjs                     exit 0  host tests: all assertions passed
node tests/client-smoke.mjs                  exit 0  client tests: all assertions passed
node tests/replay.test.mjs                   exit 0  真实 session 日志回放通过
node tests/github-tools.test.mjs             exit 0  82 passed, 0 failed
node tests/github-settings-client.test.mjs   exit 0  1 passed, 0 failed
```

注意：`sidebar-clock-client-harness` 与 `sidebar-clock-installed` 依赖本机 `app.asar` 的版本化资源名；换机器或升级 DSH 后需按错误信息更新测试适配器。

## 附录 B：P0 落地状态（2026-10-20）

本轮按 §4 的 P0 全部落地（对应 §6 的迭代 1–3），P1/P2 未动；版本随之升级：
`dsh-sidebar-clock` 1.0.1 → **1.1.0**，`dsh-token-cost` 1.2.0 → **1.3.0**，`dsh-github` 保持 1.1.0。

| 方向 | 状态 | 落地 | 验证 |
|---|---|---|---|
| P0-1 数据静默失效 | ✅ | `createRefreshController`：价目/节假日独立调度；节假日全失败不记成功，5 → 15 → 60 分钟后小时级重试，成功后回 24 h；价目失败只降级、不覆盖旧卡 | `tests/host.test.mjs`（伪时钟 + mock fetch） |
| P0-2 外部契约与陈旧可见 | ✅ | 解析器自校验 + 接受反向列序；三份价目页 fixture；`parserVersion`/`holidayProvenance` 进冻结快照；`view.status` 实时暴露 stale/degraded；Pill 琥珀点 + 详情 stale 徽标、冻结 vs 当前读取时间、节假日来源/失败原因/下次重试 | `tests/host.test.mjs`、`tests/client-smoke.mjs` |
| P0-3 费率/节假日单一事实源 | ✅ | `shared/tariff/index.js` canonical；`tools/sync-shared.mjs` 生成 Host ESM 副本与两份客户端内联副本，`--check` 校验漂移；峰值窗口、北京节假日、固定锚点、payload 解析形状、下一次切换扫描上限（10 天）统一 | `tests/tariff-consistency.test.mjs`：固定向量、UTC/JST、跨年、DST 换日、未发布年份，并对三份副本 + Host `bandOf` + 时钟 wrapper 交叉断言 |
| P0-4 适配器测试与失效可观测 | ✅ | `SIDEBAR_SHELL` 版本化类名表；`createTopCardHost` 不抛错、只增删自己的节点、复用残留 host；每类失败每页一次 `[sidebar-clock] sidebar adapter:` 警告（带 DSH 版本，区分"适配器不认识结构"与"插件未激活"）；0.2.1-rc.2 fixture 契约测试；升级检查清单 | `tests/sidebar-clock-adapter.test.cjs`、`docs/compatibility.md` |
| P0-5 工程护栏 | ✅ | CI（windows-latest，Node 22.15/24）；零依赖 `npm test` runner；`npm run pack`（store ZIP + sha256，可复现）；MIT LICENSE、CHANGELOG、根 `package.json` `engines.node >= 22.15`；asar 缺失时明确 SKIP；README/Node 声明修正 | `node tools/run-tests.mjs`、`npm run pack` + `Expand-Archive`/`Get-FileHash` 校验 |

### 本轮做出的决定（对应 §7）

1. **仓库定位**：按"可对外分发的最小集"补齐 MIT LICENSE、CHANGELOG、兼容矩阵与打包/校验流程；npm scope 改名、安全披露渠道、截图与发布工程仍留 P2。
2. **顶部固定位置**：保留 DOM 适配（判定值这个成本），但收成版本化、可测试、可观测的小模块；不引入 `MutationObserver` 自愈（没有证据表明 React 会移除 host），触发条件与检查清单写入 `docs/compatibility.md`。
3. **未发布年份**：统一使用固定锚点（元旦/劳动节/国庆节）并在 UI 中标注为锚点/预估；两端判定与解析形状由一致性测试锁死。
4. **跨会话统计**：仍未做，按原建议留给独立投影/插件。
5. **GitHub 写入**：本轮未动（P1 范围），保留默认只读 + 逐次审批。

### 仍未做（P1/P2 摘要）

测试边界模块化（P1-1 的"纯逻辑可 import"部分已由 canonical 模块 + 生成副本实现；DOM/浏览器测试仍用源码切片，两个 `client.js` 仍手写而非由脚本生成）、投影状态迁移测试（P1-2）、客户端定时器/可访问性/locale 细节（P1-3）、GitHub v2（P1-4）、文档模板化（P1-5）、上游插槽/发布工程/跨会话分析（P2）。`stateVersion` 仍为 5：新增字段只加在冻结快照与实时 status 上，旧状态通过 `normalizeHolidayProvenance` 与缺省容忍读取，显式迁移测试尚未补。节假日源仍只有单主源 + 手动列表 + 固定锚点，P0-2 中的"主源 + 备用源"未实现。

### 本轮基线（2026-10-20，Windows，Node v25.2.1）

`npm test` → **10 passed, 0 failed**（10 个测试脚本；新增 `tests/tariff-consistency.test.mjs` 与 `tests/sidebar-clock-adapter.test.cjs`）。CI 目标 Node 22.15 / 24。
