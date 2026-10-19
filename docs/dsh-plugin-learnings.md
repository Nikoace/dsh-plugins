# DSH Web UI 插件开发笔记

记录 2026-10-19 做 [`dsh-sidebar-clock`](../dsh-sidebar-clock/README.md) 时验证过的事实和坑。
环境：DSH 0.2.1-rc.2（Windows desktop，安装包 `resources/app.asar`）。

## 1. 侧边栏插槽拓扑与"最顶部"位置

- `sidebar` 是 **single slot**，由 ui-layout 的 AppFrame 渲染，默认被
  `@deepseek-ai/dsh-client-ui-sidebar` 的 SidebarRoot 占用。它声明的子槽（root scope）：
  - `sidebar.brand.mark` / `sidebar.brand.name`（single，**替换**品牌位，不是新增位）
  - `sidebar.toggle.badge`（single，收起态展开按钮里的通知）
  - `sidebar.panellist`（list，条目 id 要对应 `main` keyed slot 中的同名面板）
  - `sidebar.workspaces`（single，会话浏览区）
  - `sidebar.settings`（single，设置入口）
  - `sidebar.footer.action`（list，Settings 旁的附加操作）
- **没有"品牌行和新会话之间"的可加席位**。要放在固定像素位置，先接受下面的 SlotCore 语义：

- **SlotCore 语义**（asar 内 `SlotCore` 源码 + 离线实测）：
  - single slot 同一 `priority` 重复注册会抛错；不同 priority 可共存。
  - 渲染 `entriesOfSlot(key)[0]`，按 priority 升序 → **priority 最小者渲染**（`-1` 可盖过官方的 `0`）。
  - **priority 只决定占位者，不转移子槽所有权**：新的 `sidebar` 占用者再声明
    `children: { 'sidebar.brand.mark': … }` 会抛
    `slot "sidebar.brand.mark" is already declared`。
  - 所以"接管 sidebar 再重声明子槽"不可行。要固定位置只能：
    - (a) 整壳替换并自己实现全部结构（脆弱，侧栏一升级就坏）；或
    - (b) **官方可加席位 + 轻量 DOM 适配**（本插件采用）。

- 可加席位里 `sidebar.footer.action`（owner props `{wide}`）最适合放纯展示组件；
  `sidebar.panellist` 要求同时提供同名 `main` 面板，不适合纯展示。

- 固定位置插入的可行模式：
  1. 注册 `sidebar.footer.action`（`order` 靠前）作为载体；
  2. 组件里渲染一个隐藏 anchor；
  3. `useLayoutEffect` 里用 `anchor.closest(...)` 找到 sidebar 根，在 New Session
     按钮前插入**自己的空容器**，`createPortal` 把卡片渲染进去；
  4. 结构认不出时退回 footer 席位（优雅降级），只增删自己的容器，不动官方节点。
  当前构建的类名是 hashed（`_2H3hWW_root` / `_2H3hWW_logoRow` / `_2H3hWW_newSession`），
  适配器按版本绑定，DSH 改版后卡片会自动退回底部，等适配器更新。

## 2. 客户端插件加载 / 激活排错

- 桌面端启动失败会写
  `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-<time>-web-boot.log`，内容形如
  `Error: web boot: 1 entry did not activate` + `@local/xxx: failed`；页面 renderer
  console 里是同样的错。
- 三种状态（web-frontend bundle 的 boot 逻辑 `bZ()`）：
  - `failed` = 客户端 Cordis 插件 `apply` 抛错（日志**不带**原因，需自己复现）；
  - `pending (waiting for services: …)` = inject 的服务尚未就绪；
  - `import failed: <message>` = 模块 import 失败（带错误信息）。
- 新装 bundle 后 `plugin_manager list_plugins` 显示 `fiberPhase: active` **只说明 Host 半**
  激活；客户端半要**重载页面/应用**才会进 boot graph——已经打开的页面不会因为装了新
  bundle 就自动加载它（即使 client-hmr 在跑）。
- 验证客户端注册：`cordis_inspect_query`，client provider `Slots`，看目标 slot 的
  occupants（`id`/`order`/`active`）。
- 客户端插件 `inject` 尽量精简：本插件 `['slots','locale']` 足够；多声明会在启动早期
  处于 pending。

## 3. 插槽注册 API 要点

- `ctx.slots.inject(key, () => ctx.slots.register(options, Component))`；组件 props =
  renderer kit（`t`、`renderSlot`、`usePanelInfo` 等标准 hooks）+ 自己的 `inject` 面 +
  owner props（**owner props 最后覆盖**，如 `{wide}`、`{collapsed,width}`）。
- `renderSlot` 只发给**声明了 `children` 的 entry**；只占槽不声明就渲染不了子槽。
- `inject` 里 `hooks: { panels: store }` 会被转成 `usePanels`；也可以自己传 store 用
  `useSyncExternalStore`（更可控，避免 hooks 规则问题）。
- list slot 的 `label` 可以是函数（切语言重新求值），`order` 升序。
- 不要在客户端 `require('@deepseek-ai/dsh-client-ui-primitives')`；需要标记/样式就复制到
  自己前缀下，只用 `--dsw-alias-*` 主题 token。

## 4. 数据与时间逻辑（本插件场景）

- 高峰/低谷与 `dsh-token-cost` 一致：UTC `01:00–04:00`、`06:00–10:00`，周一至周五，
  按**北京日期**的中国法定节假日全天低谷；周末全天低谷。
- 节假日：`https://timor.tech/api/holiday/year/{year}`（与 token-cost 同源）。
  **浏览器可直接 fetch**：实测该端点回显请求 Origin
  （`access-control-allow-origin: <origin>`），不需要 Host 代理；结果缓存
  localStorage、6 小时刷新；下一年安排发布前用固定锚点（元旦 01-01 / 劳动节 05-01 /
  国庆节 10-01）。
- 节假日倒计时 target 用**北京午夜**（和费率切换同一时刻），否则非 UTC+8 地区会出现
  "徽标已转低谷、倒计时还没到"的矛盾。
- 纯函数测试技巧：把 client.js 中"纯时间/费率/日历"段用 `new Function` eval 出来，
  用**固定时间戳**断言（见 `tests/sidebar-clock-logic.cjs`）。
- **UI 语言 ≠ 浏览器语言**：日期/星期格式化要用 DSH 的 locale 快照
  （`ctx.locale.getSnapshot().active`），不要用 `navigator.language`——本机浏览器是
  `ja-JP`、DSH 界面是中文，混用会出现"10月19日(月)"这种中文界面里夹日文星期。
  快照通过 inject 面传给组件、渲染时读取，切语言会随 outlet 重渲染自动更新。
- **账户余额**走 Client Remote：`ctx.remote.account.getBalance({ version, locale,
  timezoneOffsetSeconds })`，返回 `{ ok, value }`，其中 `value` 是
  `null | { status:'ready', value:[{currency:'CNY'|'USD', balance:'12.34'}],
  bonusWallets:[…] } | { status:'failed' }`；`version` 可用
  `window.__DSH_BOOT__.release.version`。`remote.account` 是**可选服务**：用
  `ctx.get('remote.account')` 取、不要放进 `inject`，否则没有 Account controller 的
  profile 会让整个卡片不激活；拿不到就显示占位符。余额不是流，轮询即可
  （本插件 10 分钟一次）。

## 5. 本地工具与验证

- `tools/asar.cjs`：`list / cat / search / extract` 读 `resources/app.asar`
  （路径如 `dsh/node_modules/@deepseek-ai/...`）。在 asar 上直接跑 rg/glob/node 会失败；
  read 工具能读 asar 里的单个文件，批量搜索/提取用这个脚本。
- 安装/启停：`plugin_manager install_bundle`（目录 target 会写成 profile 的 `link:`
  依赖）、`set_bundle`、`list_bundles`、`list_plugins`。
- 离线验证注册语义：从 asar 抽**真实 SlotCore**（`tests/sidebar-clock-installed.cjs`
  按 bundle 标记截取），在 `vm` 沙箱里跑官方 sidebar + 本插件注册/卸载循环，验证共存、
  报错与释放（`tests/sidebar-clock-client-harness.cjs`，3 轮）。
- 环境限制：Windows sandbox 下 headless Chrome/Edge 拿不到 stdout，本机也没有浏览器
  自动化依赖；本地 fixture 做不了视觉验证，视觉只能人工看页面。

## 6. 教训

- 先弄清 slot 的**声明所有权**再动手：single slot 不是"后注册者赢"，也不可继承子槽。
- 追求固定像素位置时，优先官方可加席位 + 适配层；整壳替换的维护成本高、升级即坏。
- 客户端插件激活失败没有栈信息；"最小 inject + 离线 SlotCore 复现"最有效。
