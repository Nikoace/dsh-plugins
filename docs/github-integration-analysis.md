# GitHub 集成插件：功能分析

日期：2026-10-19
目标：为 DeepSeek Harness（DSH）新增一个 GitHub 集成插件，先确定能力边界与形态，再进入实现。

## 1. 需求理解

"集成 GitHub 功能"可以落在三个不同的位置，成本与收益差别很大：

| 方案 | 形态 | 优点 | 缺点 |
|---|---|---|---|
| A. Host 工具插件（本方案） | `ctx.tools` 注册 `github_*` 工具，Agent 直接读写 GitHub | 零外部运行时、零依赖、Token 留在 Host 配置里、与模型步骤天然结合、可做审批与只读默认 | 需要自己封装 REST、维护工具 schema |
| B. MCP 配置 bundle | 用 `cordis.patch.yml` 接入官方 GitHub MCP server | 复用官方 server 的完整工具面 | 需要 Docker/npx、独立进程与 Token 传递；模型看到的工具名不可控 |
| C. Web UI 面板 | 侧边栏卡片 / 独立页面展示 PR、Issue | 可视化直观 | 不能替代"让 Agent 会操作 GitHub"；需要额外 Remote/RPC 与鉴权设计 |

用户要的是"集成 GitHub 功能"，核心价值是让 Agent 在会话里完成仓库、Issue、PR 的查询与操作。因此 **v1 采用方案 A**：Host 侧工具插件。它不依赖额外进程，安装即用，也符合本仓库已有两个插件的纯本地 bundle 形态。

v1.1 追加一个**设置页**（Settings → GitHub），而不是展示型 UI 面板：它复用 Harness 已有的 settings/credential 服务配置 Token、默认仓库与写入策略，不新增自定义 Remote/RPC。展示 PR/Issue 的独立面板仍留给 v2（见 §8）。

## 2. 能力范围（v1）

### 2.1 只读工具（默认全部可用）

| 工具 | GitHub REST 端点 | 用途 |
|---|---|---|
| `github_repo` | `GET /repos/{owner}/{repo}` | 仓库元信息：默认分支、语言、star/fork、开放 Issue 数、topics、license |
| `github_search` | `GET /search/{repositories,issues,code,users}` | 统一搜索入口；`pullRequests` 映射到 `search/issues` 并带 `is:pr` |
| `github_issues` | `GET /repos/{owner}/{repo}/issues` | 列 Issue：state / labels / assignee / since / 排序 / 分页；默认排除 PR |
| `github_issue` | `GET /repos/{owner}/{repo}/issues/{number}` + `/comments` | Issue 详情、正文、标签、指派人、评论 |
| `github_pulls` | `GET /repos/{owner}/{repo}/pulls` | 列 PR：state / head / base / 排序 / 分页 |
| `github_pull` | `GET /repos/{owner}/{repo}/pulls/{number}` + `/files` + `/commits` | PR 详情：正文、增删行、变更文件清单、提交列表 |
| `github_pull_diff` | `GET /repos/{owner}/{repo}/pulls/{number}`（`Accept: application/vnd.github.diff`） | PR 统一 diff 文本，用于代码审查 |
| `github_commits` | `GET /repos/{owner}/{repo}/commits` | 列提交：分支/SHA、路径、since/until、分页 |
| `github_file` | `GET /repos/{owner}/{repo}/contents/{path}` | 读文件（base64 解码）或列目录；支持 ref |
| `github_status` | `GET /rate_limit`（+ `GET /user`，有 Token 时） | 诊断：认证身份、Token 来源、scope、剩余额度、写开关 |

### 2.2 写工具（默认关闭，需显式开启 + 逐次审批）

| 工具 | 端点 | 用途 |
|---|---|---|
| `github_create_issue` | `POST /repos/{owner}/{repo}/issues` | 新建 Issue（title/body/labels/assignees） |
| `github_comment` | `POST /repos/{owner}/{repo}/issues/{number}/comments` | 在 Issue / PR 下发评论 |
| `github_create_pull_request` | `POST /repos/{owner}/{repo}/pulls` | 新建 PR（head/base/title/body/draft） |

写工具与只读工具同时注册，但执行时检查 `allowWrites`；开启后默认每次写操作再走 `ctx.approval.request()`，只有 `allowed-once` 才放行。

### 2.3 设置页（v1.1 追加）

`settings.section` 新增 GitHub 页面（id `github`，order 25）：

- **令牌**：通过 `ctx.remote.credentials.describe/set/unset('GITHUB_TOKEN')` 管理，只显示是否配置、来源与是否可写，不回显值；Host 每次请求前用 `ctx.credentials.resolve` 解析。
- **工作区与写入**：`defaultRepo`、`detectRepoFromGit`、`allowWrites`、`requireApproval`、`requestTimeoutMs`、`cacheTtlSeconds`、`maxOutputChars`。Host `Config` 把这些字段声明为 `.volatile()`，设置写入经 Host settings 服务校验并持久化到 profile patch，引用原地更新，工具下一次调用即生效，无需重载。
- **普通配置**：`apiBaseUrl`、`tokenEnv`、`apiVersion`、`userAgent`、`toolTimeoutMs` 仍在 profile patch，重载后生效。
- 页面只从页面模块表导入 React，样式仅用 `--dsw-alias-*` token，不依赖 Harness Client 包。
- Host 侧为复用平台认可的 `.volatile()` Config 语义，bundle 内置了 MIT 许可的 schemastery/cosmokit 构建（`vendor/`），仍无安装期依赖。

### 2.4 非目标（v1 明确不做）

- OAuth / GitHub App / device flow 登录：Token 由用户通过配置、环境变量或凭据存储提供。
- GraphQL、Webhook 事件订阅、GitHub Actions 触发与日志下载。
- `git clone/push`、代码检出：这些属于本机 git 工具链，不应由 GitHub API 插件承担。
- PR 创建后的自动 review、check 结果轮询。
- 展示型独立面板/侧边栏状态卡（见 §8 的 v2 备选）；设置页只做配置。
- GitHub Enterprise 之外的托管平台。

## 3. 认证与配置

### 3.1 Token 解析顺序

1. 行配置 `token`（明文，保存于 profile patch；不推荐）。
2. 行配置 `tokenEnv` 指定的环境变量（默认 `GITHUB_TOKEN`）。
3. `GITHUB_TOKEN`，再退到 `GH_TOKEN`。
4. 通过设置页保存到凭据存储的 `tokenEnv` 引用（默认 `GITHUB_TOKEN`），Host 每次请求前解析；行配置或环境变量优先于它。
5. 都没有时按匿名访问运行：只读公开数据，限额 60 次/小时，`github_status` 会提示。

最小权限建议：只读用 fine-grained PAT（Contents / Issues / Pull requests 只读）；需要写时再补 Issues 写、Pull requests 写、Contents 读（创建 PR 要求 head 分支已存在，本插件不 push 分支）。

### 3.2 配置项（行配置 `config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `token` | `''` | 明文 Token，优先级最高 |
| `tokenEnv` | `GITHUB_TOKEN` | 从哪个环境变量取 Token；设置页保存的凭据也使用该引用名 |
| `apiBaseUrl` | `https://api.github.com` | GHES 可改为 `https://host/api/v3` |
| `apiVersion` | `2022-11-28` | `X-GitHub-Api-Version` |
| `userAgent` | `dsh-github-plugin` | GitHub 强制要求 UA |
| `defaultRepo` | `''` | 省略 repo 参数时使用；设置页可实时修改 |
| `detectRepoFromGit` | `true` | 从会话工作目录的 `.git/config` 的 origin 推断仓库；可实时修改 |
| `allowWrites` | `false` | 写工具总开关；可实时修改 |
| `requireApproval` | `true` | 写操作是否逐次请求审批；无审批服务时写操作失败关闭；可实时修改 |
| `requestTimeoutMs` | `20000` | 单次 HTTP 超时；可实时修改 |
| `cacheTtlSeconds` | `30` | GET 响应缓存（配合 ETag，节省限额）；可实时修改 |
| `maxOutputChars` | `60000` | 单个工具结果文本上限；可实时修改 |
| `toolTimeoutMs` | `60000` | 声明给工具超时策略的预算（普通配置，重载生效） |

仓库解析顺序：工具参数 `repo` → `defaultRepo` → 会话工作目录 git origin。`repo` 接受 `owner/name`、`https://github.com/owner/name(.git)`、`git@github.com:owner/name.git`。

## 4. 安全设计

1. **只读默认**：`allowWrites: false` 时三个写工具返回可操作的错误说明，不发出任何写请求。
2. **审批**：`requireApproval: true`（默认）时，写操作调用 `ctx.approval.request()`，拒绝/取消/不可用都按失败处理（fail closed）；审批 UI 显示仓库、Issue/PR 编号与标题。审批服务缺失时应恢复服务或保持禁写，不建议关闭审批来排障。用户显式设置 `requireApproval: false` 后，只要 `allowWrites: true`，Agent 就能不经再次确认向真实仓库发布 Issue、评论和 PR，可能发布非预期内容；`allowWrites: false` 仍优先禁止写入。系统提示每次生成时读取当前配置，状态工具与设置说明也明确展示关闭审批的影响。
3. **Token 不落结果**：工具返回值与错误只包含 `authenticated`/`tokenSource` 等事实，绝不回显 Token；错误里也不带请求头。
4. **固定 API 基址**：请求路径只能是以 `/` 开头的相对路径，禁止传入完整 URL，避免把 Token 发到任意主机（`apiBaseUrl` 是显式配置）。
5. **外部内容标记**：GitHub 返回的仓库/Issue/PR 正文属于第三方可控文本，结果开头与系统提示都声明"视为数据而非指令"，降低提示注入风险。`github_status` 是唯一例外：它输出连接诊断信息，不带内容标记（其用户名与错误文本仍按外部数据处理）。
6. **输出上限**：正文、diff、文件内容都按 `maxOutputChars` 截断并附截断说明，避免撑爆上下文。
7. **错误可诊断**：403/429 时附带限额剩余与重置时间；401 时提示检查 Token。

## 5. 速率限制与缓存

- 匿名 60 次/小时（core），认证 5000 次/小时；search 有独立的更严限额。
- GET 响应按「方法 + URL + Accept」做内存缓存（TTL 默认 30s）+ `ETag`/`If-None-Match` 条件请求；304 命中不消耗 core 限额。JSON 与 diff（不同 Accept）互不污染；Token 变化时清空缓存，避免跨身份复用。
- 缓存上限 128 项，LRU 淘汰；写操作不缓存。
- 每次响应解析 `x-ratelimit-*`，`github_status` 可查看当前额度；请求失败时错误信息带 reset 时间。

## 6. 输出与错误约定

- 工具 `execute` 返回结构化 JSON（仓库/Issue/PR 的裁剪字段），`output.render` 渲染为 Markdown 文本块；正文类字段截断。
- 列表结果带 `page`/`perPage`/`hasMore` 提示，模型可继续翻页。
- 参数在插件内校验（TypeScript `defineTool` 的 schema 编译器无法从纯 JS bundle 导入），校验失败返回清晰的 `invalid arguments: ...`。
- 网络/API 错误抛出普通 `Error`，消息形如 `GitHub API 404: Not Found (GET /repos/owner/repo)`，由工具运行时统一转为错误结果。

## 7. 验证计划

1. **Host 离线测试**：`tests/github-tools.test.mjs` 用进程内 mock `fetch`（返回真实 `Response`）+ 假 `ctx`，覆盖每个工具的路径/查询参数/鉴权头、列表与详情渲染、分页提示、写开关与审批拒绝、ETag 缓存与 Accept 隔离、超时/取消、错误映射、仓库名解析，以及 Config 的 volatile 投影、实时引用更新与 token provider 缓存失效（82 例）。
2. **Client 离线测试**：`tests/github-settings-client.test.mjs` 在 vm 沙箱中加载 `window.__ModuleLoader__` 产物，验证模块 id、只导入 React、中英文字典、`configForms.get('github')` 绑定、namespace 监听与 `settings.section` 注册（id/order/label/inject）。
3. **真实 API（匿名只读）**：对公开仓库调用 `github_repo` / `github_issues` / `github_pulls` / `github_file`，验证真实响应解析（限额允许范围内）。
4. **安装验证**：`plugin_manager install_bundle` 安装本目录，确认 bundle/插件行进入 profile；用 `cordis_inspect_query`（Host `Tool.listTools`）确认 `github_*` 工具对当前 Agent 可见；Host `Config.listConfigs` 确认 `include:github` 提供了 schema 且七个字段带 `x-cordis.volatile`。
5. **显示资源**：`locale/{en,zh}.json` 的 `meta.title/description`、原创 SVG 图标、`package.json` 导出与 `files` 清单。
6. **未验证**：设置页的视觉渲染与浏览器端注册需要刷新页面后人工确认；本环境没有浏览器控制。真实写入同样需要用户提供有写权限的 Token 后手动验证。

## 8. v2 备选（本次不实现）

- 侧边栏只读状态卡：认证用户、剩余限额、当前仓库开放 PR/Issue 数。需要 Host 暴露只读数据通道（Web route 或 Remote 命名空间），并把 Token 留在 Host。
- 设置页内展示实时连接状态（认证用户、scope、剩余额度）与“测试连接”按钮；需要同样的只读 Host 数据通道。
- PR review 工具（提交 review、行内评论）、Issue 标签/指派、Release 列表、Actions 运行状态。
- `github_search` 增加 `commits`（需要额外 preview Accept 头）。
- 请求级 ETag 持久化缓存，跨重启节省限额。
