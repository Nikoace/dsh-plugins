# GitHub 凭证与写入权限边界修复

对应 [2026-10-21 审查报告](code-review-2026-10-21.md) 的 R1、R4。
修复基点：`6cac55b2c70b4de07035de4edab23cb2edfb4b4b`。
本次验证环境：Linux、Node v24.19.0、npm 11.9.0。全部测试使用合成凭证、进程内 HTTP mock 和宿主事件 fixture，未执行真实 GitHub 写入测试。

## 实现

### R1：凭证代次隔离

- HTTP 客户端维护只在进程内使用的递增凭证代次。凭证值变化或收到凭证更新通知都会推进代次，清空 GET 缓存和当前限额状态。缓存键与错误消息不包含令牌。
- 请求捕获凭证与代次。在异步凭证读取期间发生失效时，重新读取凭证，避免晚完成的旧查询把客户端切回旧令牌。
- 读取缓存、发送请求以及 GET 响应完成后的提交路径均检查代次。GET 响应体完成后再读取一次当前凭证，覆盖“撤销后没有其他请求”的情况。旧代次的 GET 抛出明确的凭证变化错误，不返回旧私有内容、不写缓存，也不刷新 304 条目的 TTL。
- `apply()` 订阅当前 `tokenEnv` 的 `credentials/reference-updated`，所以 A → B → A 即使没有中间请求也会失效。静态配置/环境令牌继续优先于凭证存储；其他凭证引用的更新不影响本客户端。
- 在凭证读取后、缓存命中前、发送前以及响应提交前检查取消状态。即使 mock transport 忽略 AbortSignal，取消后的响应也不能填入缓存。

### R4：统一最终写权限检查

- 三个写工具都通过 `writeJson()`：检查默认拒绝策略，按配置逐次审批，审批完成后重新检查，并把同一个同步检查器传给 HTTP 层。
- HTTP 层在异步凭证读取和请求体序列化完成后、调用 `fetch` 前执行检查，检查与发送之间没有 `await`。
- 检查器验证取消状态、当前 `allowWrites` 和写入策略代次。宿主的 `loader/volatile-update` 通知记录 `allowWrites`、`requireApproval` 的每次变化；关闭再恢复不会使旧操作重新有效。审批要求变更也使待发送操作失效，调用方需要重新发起。
- 非宿主调用者仍会在每个检查点重读配置。默认关闭写入、缺少审批服务时拒绝、只接受 `allowed-once`、显式 `requireApproval: false` 的行为保留。

宿主事件契约核对来源：

- [Loader 在更新 volatile 引用后同步通知所属插件](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/vendor/loader/src/config/entry.ts)。
- [Credentials provider 在变更提交后发布 reference-updated](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/credentials/credentials/src/index.ts)。
- [官方 live configuration 用法](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cookbook/adding-a-settings-card.md)。

## 测试先行与结果

先只新增 `tests/github-security-boundaries.test.mjs`，没有修改生产代码。基线原有 GitHub Host 测试为 **102 通过、0 失败**；新增回归为 **0 通过、47 失败**，均为行为断言失败。然后实施修复，新增回归 **47 通过、0 失败**。

| 覆盖范围 | 结果 |
|---|---|
| R1，11 项 | A → 匿名（有/无中间请求）、A → B → A、迟到响应与限额隔离、304 失效与取消、响应体取消、已取消的缓存命中、凭证读取取消、乱序凭证读取、宿主更新通知跨响应/凭证读取 |
| R4，36 项 | 三个工具 × 三个等待阶段（审批、审批后的凭证读取、免审批的凭证读取）× 四种变化（关闭、关闭再恢复、取消、审批策略来回切换）；撤销操作均为 0 POST，恢复后新操作可以正常审批并发送 |
| `node tools/run-tests.mjs github` | 4 个脚本通过；Host 共 149 项（原有 102 + 新增 47），另有设置页和令牌帮助测试 |
| 本地 Linux `npm test` | 退出码 0；runner 报告 15 passed / 0 failed。实际 14 个脚本完成断言、1 个脚本 SKIP，见下方说明 |
| 会话 fixture 回放 | 176 次调用回放通过 |
| `node docs/review-evidence/2026-10-21.mjs` | 8 组断言通过；R1 匿名重新请求并取得公开响应，networkRequests = 3；R4 postsSent = 0 |
| `git diff --check` | 通过 |

完整测试中的跳过项为 `sidebar-clock-client-harness.cjs`：本环境未安装 DSH `app.asar`，不能执行真实安装包的 SlotCore 激活/卸载验证。runner 把退出码 0 的 SKIP 也计为 PASS，不能将结果解读为 15 个脚本都完成实际断言。

### 提交后的 Windows CI

修复提交 `c12368b74bede67dac36591ce153db6880ec88f0` 的 [PR CI](https://github.com/Nikoace/dsh-plugins/actions/runs/39575008385) 在 Node **22.15.1** 和 **24.21.0** 上均通过全部四个 GitHub 测试脚本（新增 47 项和原有 102 项 Host 用例均通过）。但两套完整测试都以退出码 1 结束：`html-preview-bundle.test.mjs` 报 `Vendor hash mismatch: purify.es.mjs`；runner 为 14 passed / 1 failed，其中仍包含一个安装包 SKIP。

核对 [主分支基点的 CI](https://github.com/Nikoace/dsh-plugins/actions/runs/39549504434/job/119055226708)，在本次修改之前就有完全相同的 vendor 哈希错误。此次没有修改 HTML preview 或降低完整性校验；该已有 CI 失败仍需单独修复。**本地完整测试通过不等于远端完整 CI 通过。**

离线证据脚本已把 R1/R4 从“固定缺陷表现”调整为“验证修复结果”。历史审查内容继续保留，并明确标注状态。R3、R7、R8 不属于本次修复。

## 未覆盖的风险与保证边界

- 未执行真实 GitHub 写入、线上令牌轮换、真实 DSH 宿主事件分发或浏览器端到端验证。宿主通知由 fixture 模拟，并核对了上述官方源码；实际安装版本的集成仍需验证。
- 不发送尚未派发的已撤销写操作；已经交给 `fetch` 的写请求无法保证撤回，也无法把取消理解为服务器一定没有修改数据。不会自动重试 POST。
- 隔离依赖凭证来源如实返回当前值并发布变更事件。无事件的自定义 provider 仍能通过读取检测不同令牌，但无法识别两次读取之间完全不可见的 A → B → A；类似地，不发布配置更新事件的自定义宿主无法识别完全未被读取的关闭再恢复。
- 凭证 provider 的异步等待本身没有可强制终止的接口；取消会阻止其完成后发出请求或提交缓存，但不保证挂起的 provider 立即结束。HTTP transport 的既有超时和取消测试继续通过。
- 缓存仍是单实例进程内缓存；此次不处理跨实例协调、已返回调用方的数据撤回、响应总字节预算、重定向政策或 R7 的非 GitHub 目标主机校验。
