# HTML 静态预览 / Static HTML preview

在助手最终回复下方显示 HTML + CSS 预览卡片。原消息保持完整，可切换预览/源码、复制源码、展开/收起。

**此版本仅提供预览，不会从后续模型上下文中省略 HTML。** 用户确认先交付预览功能。关闭预览、切换源码或卸载插件都不会删除历史消息。关于上下文省略的核心接口限制，见 [技术记录](../docs/html-preview-context.md)。

## 使用

启用插件后，让助手输出一个完整、顶层的 `html` 围栏代码块，例如：

````markdown
```html
<style>
  .card { padding: 24px; border-radius: 16px; background: #eef3ff; color: #173460; }
</style>
<div class="card"><h2>周报</h2><p>本周完成 3 项工作。</p></div>
```
````

回复完成后，该轮底部会出现预览。已有历史轮次加载后也可以显示。插件只读取最终回复的文本块，用户输入、思考、工具输出和未闭合的围栏不会生成预览。

- 支持常见静态排版、表格、Flex/Grid，以及内联 `style` 和 `<style>` 中受支持的 CSS；支持 `var()` 与 `--*` 自定义属性、`>` 子选择器和 `@media (width > 600px)` 这类范围语法。
- 预览固定使用浅色文档画布（`color-scheme: light`）；深色界面下卡片内部仍是白底。
- 支持反引号、波浪线围栏；语言标记 `html` 大小写不敏感。只识别顶层围栏，不拼接独立 CSS 代码块。
- 每轮最多 5 个预览，每块源码最多 256 KiB；超限时保留源码入口并提示原因。
- 默认高度 360px，展开后 640px，预览内部滚动。
- 图片仅允许内嵌 PNG/JPEG/GIF/WebP 数据，不读取远程或本地文件。
- 不支持 JavaScript、SVG、表单、导航、嵌套框架、外部字体/CDN。CSS 白名单可能移除部分样式，因此它不是完整浏览器页面的复刻。

## 安装和升级

这是 DSH bundle。通过官方插件管理工具 `plugin_manager install_bundle`，以本目录的绝对路径为 `target` 安装并启用；也可将分发 ZIP 解压到固定位置后选择该目录。首次安装后刷新现有 DSH 页面。更新已加载的 Host 模块按插件管理工具的提示重启。

2026-10-21 已在 `desktop` profile 通过 `plugin_manager install_bundle` 安装并启用；live Client slot `conversation.chat.turnTail` 中已出现 `html-preview`（order 10）占位者。浏览器内的脚本/外链/表单隔离与视觉效果仍需按文末验收步骤人工确认。

## 实现

- 官方 `conversation.chat.turnTail` 列表插槽，通过 session 的 `useChat` / `turnDataSource(turn, 'turn-tail')` 订阅最终 `closing.blocks`。
- Host 是空入口，没有上下文过滤器、消息写入、模型工具或新事件类型。
- DOMPurify 3.4.17 的固定副本随包分发；下载来源和 SHA-256 在 [provenance.json](vendor/provenance.json)，原许可在 [LICENSE-DOMPurify](vendor/LICENSE-DOMPurify)。
- iframe 使用空 `sandbox` 和自包含 `srcdoc`，文档 CSP 禁止脚本、网络连接、外部资源及表单。HTML 清洗、受限 CSS、sandbox 和 CSP 分层生效。
- 原始 HTML 仅作为 React 文本显示或经用户点击复制；清洗版本仅用于 iframe。

客户端构建是仓库内三个已知模块的确定性组合，运行时不从 CDN 加载代码：

```powershell
node tools/build-html-preview.mjs
node tools/build-html-preview.mjs --check
node tools/run-tests.mjs html-preview
npm test
npm run pack
```

`tools/vendor-html-preview.mjs` 是显式依赖维护命令；日常构建不下载网络资源。修改清洗库版本时需重新检查许可证、散列和安全策略。

## 安装后验收

1. 确认插件详情的中英文标题、说明、图标正确，控制台无插槽异常。
2. 输出卡片、表格、长页面和多个 HTML 代码块，确认最终回复后出现预览；其他语言代码不触发。
3. 验证浅色/深色界面、窄屏、复制、源码切换、展开和滚动；切换会话、刷新、加载历史后不重复卡片。
4. 在真实浏览器中验证脚本/事件属性不能执行，外链、图片、CSS 资源、表单和嵌套框架不能发出请求或导航。
5. 禁用插件后原聊天内容和操作正常。

离线测试不能代替实际浏览器的 sandbox/CSP 执行验证。本次交付不声称完成这些浏览器验收。

## English

Static HTML/CSS previews below completed assistant replies, with source view, copy and expansion. This version **does not remove HTML from subsequent model context**. It reads the official turn-tail slot and never rewrites session history. Scripts, navigation, forms and external resources are disabled; supported CSS is intentionally limited. Install the bundle through the official plugin manager and refresh the existing GUI. Runtime installation, visual checks and browser enforcement checks remain unverified in this development session.
