# DSH 版本兼容性

## HTML 预览插件（0.1.0）

`dsh-html-preview` 使用当前安装包的 `conversation.chat.turnTail` 列表槽、session `useChat` 和 `turnDataSource(turn, 'turn-tail')`。数据源返回 node data 数组；最终正文位于 `closing.blocks`。不依赖哈希类名，不替换消息组件。

当前验证范围是源码契约、离线构建/逻辑测试，以及 `desktop` profile 的安装和 live slot 激活（`html-preview`，order 10）；浏览器内的脚本/网络隔离和视觉验收仍需按插件 README 的验收步骤人工确认。升级后需检查这些接口、slot props 和最终回复结构。该版本不修改模型上下文，原因见 [HTML 上下文记录](html-preview-context.md)。

---

> 适用范围：`dsh-sidebar-clock` 的侧边栏顶部 DOM 适配器（唯一一处 DOM 侵入点）。
> 最后验证：2026-10-20，DSH 0.2.1-rc.2（Windows desktop，`resources/app.asar`），Node v25.2.1。

侧边栏卡片本身只依赖官方 `sidebar.footer.action` 席位，与 DSH 版本无关；只有"把卡片放到品牌行与新会话之间"这个**顶部位置**依赖外壳的哈希类名。结构认不出时自动留在 footer，功能不受影响。

## 1. 兼容矩阵

| DSH 外壳版本 | 适配器类名映射（`SIDEBAR_SHELL.dshVersion`） | 顶部位置 | footer 降级 | 说明 |
|---|---|---|---|---|
| 0.2.1-rc.2 | `0.2.1-rc.2` | ✅ 已验证 | ✅ | 当前安装版本；fixture + 契约测试覆盖 |
| 0.2.x 更早版本 | `0.2.1-rc.2`（未验证） | ⚠️ 未知 | ✅ | 结构不匹配时自动降级并打一次警告 |
| 0.3.x / 未来版本 | 需按 §3 重新验证后再定 | ⚠️ 未知 | ✅ | 不要按单个哈希追更新，按组更新映射 |

`SIDEBAR_SHELL` 是**一个版本化单元**：`dshVersion`、`root`、`logoRow`、`newSession` 四个字段必须一起更新。不要因为某次页面小改单独改一个类名——哈希类名会随构建变化，但结构契约只在真正的 shell 改版时才变。

## 2. 类名来源（provenance）

0.2.1-rc.2 的安装包（`D:/software/deepseek-harness/resources/app.asar`）里：

| 事实 | 位置 |
|---|---|
| DSH 版本 `0.2.1-rc.2` | `dsh/package.json` 的 `version` |
| 侧边栏实现 | `dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js` |
| 哈希类名表 | 同文件的 `SidebarRoot_module_css_default`（`.css` 模块映射，`root`/`logoRow`/`newSession` 等） |
| DOM 顺序 | 同文件 `SidebarRoot()` 的返回树：root 的直接子节点依次是 `logoRow` → `newSession` → `panelList` → `regionArea` → `footArea` |
| footer 席位 | `footArea` 内含 `footerActions`（渲染 `sidebar.footer.action`）与 `settingsArea`，两者都在 sidebar root 内 |
| Tooltip 不产生包裹节点 | 同一安装包的启动 `index-*.js` 中 Tooltip 用 `cloneElement` 克隆子节点；`newSession` 仍是 root 的直接子节点 |

当前类名（`client.js` 内 `SIDEBAR_SHELL`）：

| key | class |
|---|---|
| `root` | `_2H3hWW_root` |
| `logoRow` | `_2H3hWW_logoRow` |
| `newSession` | `_2H3hWW_newSession` |

⚠️ 这三个类名**不在** `dsh-web-frontend` 的 `index-*.js` 里（那里是 SlotCore / boot 逻辑），在侧边栏插件包里。按 §3 的命令搜索。

对应 fixture：`tests/fixtures/sidebar-shell-0.2.1-rc.2.html`（从上述真实结构裁剪的最小 outerHTML，只保留元素层级/类名/宽屏属性，去掉 React 文本与图标子树）。
对应测试：`tests/sidebar-clock-adapter.test.cjs`——从 `client.js` 的 `sidebar-shell-adapter:start/end` 标记之间切出**真实适配器源码**，用最小 DOM stub + fixture 跑契约用例。

## 3. DSH 升级后重新检查（检查清单）

从仓库根目录执行：

```powershell
# 1. 确认安装版本
node tools/asar.cjs cat dsh/package.json

# 2. 三个哈希类名是否仍存在于侧边栏包（注意路径是 sidebar 包，不是 web-frontend）
node tools/asar.cjs search "_2H3hWW_" dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar

# 3. 找到新的 class map（哈希前缀变化时）
node tools/asar.cjs search "SidebarRoot_module_css_default" dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar

# 4. 检查 render 顺序：root 直接子节点中 logoRow 在 newSession 之前，且 footer action 仍在 root 内
node tools/asar.cjs search "SidebarRoot_module_css_default.newSession" dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar
```

如果类名或顺序变了：

1. 成组更新 `dsh-sidebar-clock/client.js` 里的 `SIDEBAR_SHELL`（四个字段一起改）；
2. 重新捕获 `tests/fixtures/sidebar-shell-<新版本>.html`（保留真实三层结构与 footer 单元），删掉旧 fixture；
3. 更新本文件 §1 矩阵、§2 provenance 与 fixture 注释；
4. 跑全部测试：

```powershell
node tests/sidebar-clock-adapter.test.cjs
node tests/sidebar-clock-logic.cjs
node tests/sidebar-clock-client-harness.cjs
node tests/sidebar-clock-installed.cjs
```

适配器测试不需要安装 DSH（fixture + stub DOM 即可）；后两个测试从 asar 读取真实 SlotCore/侧边栏，依赖安装包路径（可用 `DSH_ASAR` 覆盖）。

## 4. 失败模式：结构不认识 vs 插件没激活

日志只覆盖 adapter 侧；"插件没激活"时 adapter 根本不运行，所以不会有这条警告。

| 现象 | 含义 | 排查方向 |
|---|---|---|
| 页面控制台出现 `[sidebar-clock] sidebar adapter: DSH <version> sidebar structure unrecognised (<reason>)`，卡片在 footer | 插件已激活，只是顶部适配器不认识当前外壳；功能正常 | 按 §3 更新类名映射。`<reason>` 取值：`root class not found` / `logo row not found` / `new session button not found` / `order unexpected` / `anchor outside sidebar root` / `adapter threw while reading the sidebar DOM: …` |
| 没有上述警告，卡片完全不见 | 客户端插件没激活（import failed / inject pending / apply 抛错），或已被禁用 | 看桌面端 `crash-*-web-boot.log` 的 `entry did not activate`；`plugin_manager list_plugins` 只看 Host 半；装完/升级后要重载页面 |
| 警告存在，卡片在 footer 正常显示 | 预期的优雅降级 | 等适配器更新即可，不必禁用插件 |

约束：

- 每种失败类型**每次页面加载只警告一次**（`adapterWarnings` Set），不会每秒刷屏；
- 前缀固定 `[sidebar-clock] sidebar adapter: `，且包含 `dshVersion` 与具体 reason；
- 日志本身包在 try/catch 里：`console` 不可用或 `console.warn` 抛错都不会影响卡片；
- 警告文案明确区分"版本化适配器不匹配"与"插件未激活"（`not a plugin-activation failure` / `did not activate`）。

## 5. 哪些变化必须升级版本化适配器

- `root` / `logoRow` / `newSession` 任一哈希类名改名；
- sidebar root 的直接子节点顺序变化（品牌行不再位于新会话按钮之前）；
- `sidebar.footer.action` 的 anchor 不再位于 sidebar root 内（`closest` 找不到根）；
- 外壳换成另一套 DOM，或类名映射整体变化（整壳替换、不同前端构建）；
- 未来 primitives 给按钮加包裹元素，使 `newSession` 不再是 root 直接子节点（同样属于结构变化）；
- 官方新增"品牌行下方"的 header/top 席位——这是最好的结局：删掉整个适配器，改用官方 slot（见 `docs/plugin-reflections.md` P2）。

## 6. 刻意没有做的事（设计决策）

- **没有 MutationObserver 自愈**：没有证据表明 React reconciliation 会移除我们插入的 `div.dsh-sc-host`。卡片在 `wide` 变化（展开/收起）时由 `useLayoutEffect` 重新插入，这已经覆盖实际观测到的重挂载场景；在拿到"host 被移除"的证据前不加全局 mutation 监听，避免无依据的防御代码与常驻开销（P0-4 要求）。
- **不移动/删除任何官方节点**：适配器只创建/复用/删除自己的 `div.dsh-sc-host[data-sidebar-clock-host]`，且插在 New Session 之前；重复调用复用同一个 host（幂等），`remove()` 只摘除自己。
- **不接管 sidebar slot**：仍只占 `sidebar.footer.action` 加法席位；顶部卡片是 portal 到自己的容器，不重声明官方子槽。

## 7. 测试与运行时版本要求

- 仓库要求 **Node ≥ 22.15**（根 `package.json` 的 `engines`；`tests/replay.test.mjs` 使用 `zlib.zstdDecompressSync`，该 API 自 Node 22.15 起提供）。适配器测试本身只用到 `node:fs`/`node:path`，但发布与 CI 以 22.15 为下限。
- `tests/sidebar-clock-adapter.test.cjs` 覆盖：happy path（插在 New Session 之前且在 root 内、只增一个节点、复用/幂等、`remove()` 只删自己）、缺 root / 缺 logoRow / 缺 newSession / 顺序颠倒 / anchor 不在 root 内、每种失败只警告一次且带 `dshVersion`、null/非元素/恶意节点不抛错、`console.warn` 抛错也不影响返回。
