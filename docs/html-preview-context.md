# HTML 预览的上下文边界

2026-10-21，对当前安装包的只读源码核实。用户原要求为 HTML+CSS 预览，并在发送新消息时省略历史 HTML；发现原计划使用的接口不支持历史过滤后，用户明确选择「先交付预览插件」。因此 0.1.0 不实现上下文省略。

## 原计划纠正

`agent/pre-step` 的 `decision.messages` 不是完整历史：它来自 `inbox.claim()`，仅代表新入队输入。普通 `sessionProjections` 注册表也只计算派生状态，不改变模型请求。不得通过这两个接口声称已过滤历史 HTML。

## 当前安装源码证据

以下相对于安装包 `dsh/node_modules/@deepseek-ai/`：

| 路径与行号 | 事实 |
| --- | --- |
| `dsh-agent-loop/lib/index.js:902–920` | `pre-step` 接收 `messages: claimed`。 |
| `dsh-agent-loop/lib/index.js:1175–1202` | `agent/request` waterfall 只返回调用配置。 |
| `dsh-agent-loop/lib/index.js:1274–1288` | 完整请求由 `session.deriveMessages()` 组装，随后深冻结。 |
| `dsh-session/lib/index.js:1722–1736` | `registerMessageProjection` 支持纯派生消息变更。 |
| `dsh-session/lib/types/known-event-types.js:85–88` | 必须解释的投影事件静态词汇仅含 `image/offload`。 |
| `dsh-session-persistence/lib/index.js:168–195` | 恢复时拒绝未知且不可忽略的事件。 |
| `dsh-session/lib/index.js:1517–1537` | 普通 `append()` 不提供 `ignorable` 元数据。 |
| `dsh-session/lib/types/surface.js:229–261` | assistant 消息禁止 `sourceEventSeqs`，而 replacement 必须提供该字段，因此不能精确替换单个 assistant 消息。 |
| `dsh-session/lib/types/surface.js:393–411` | 投影分支跳过正常 append，不能把 `assistant/message` 注册成投影类型来叠加过滤。 |
| `dsh-client-ui-chat/lib/client.js:8002–8027` | 聊天最终正文读原始 `event.data.message.content`，不是单独从 stream 恢复。 |

这些为源码证据，非运行时安装验证。不能用不登记持久化决策的 provider 包装或绕过原请求的重发替代正式投影，否则日志重建、resume/fork、缓存和实际请求可能不一致。

## 后续完整实现所需核心工作

新增正式持久化 `html/offload` 或通用内容投影事件，并更新核心事件词汇、恢复校验和所有离线/在线 fold 的解释器。事件需确定性记录目标消息、范围、占位文本和版本；原始消息和 stream 保持完整，模型投影只替换目标 HTML。

验证必须覆盖下一轮、同轮后续调用、重试、恢复、fork、compaction、插件卸载及不同 provider；尤其检查 provider 的 replayState 是否仍携带原 HTML。投影必须早于任何后续模型请求，包括自动压缩摘要请求。当前 0.1.0 未实现或启用这些核心变更。
