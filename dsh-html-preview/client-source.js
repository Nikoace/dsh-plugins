import { declarations, extractHtml, safeRules } from './core.js'
import DOMPurify from './vendor/purify.es.mjs'

// Build input: bundle the two local imports before passing this to ModuleLoader.
window.__ModuleLoader__.load({
  id: '@local/dsh-html-preview',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'htmlPreview'
    const MAX_BLOCKS = 5
    const MAX_BYTES = 256 * 1024
    const EMPTY = Object.freeze([])
    const EMPTY_SOURCE = { getSnapshot: () => EMPTY, subscribe: () => () => {} }
    const zh = {
      title: 'HTML 预览 {index}', preview: '预览', source: '源码', copy: '复制源码',
      copied: '已复制', copyFailed: '复制失败，请从源码视图手动复制。',
      collapse: '收起', show: '显示', expand: '展开高度', restore: '恢复高度',
      pending: '进入视口后加载预览。', failed: '无法解析或安全处理此 HTML。可查看、复制原始源码。',
      tooLarge: '此块超过 256 KiB，已停用预览。仍可查看和复制原始源码。',
      limit: '每轮最多显示 5 个 HTML 块，其余 {count} 块未显示。',
      static: '静态 HTML + CSS；脚本、外部资源和导航已禁用。',
      context: '仅预览；HTML 源码仍可能进入后续模型上下文。',
      unavailable: '当前会话接口不支持 HTML 预览。',
    }
    const en = {
      title: 'HTML preview {index}', preview: 'Preview', source: 'Source', copy: 'Copy source',
      copied: 'Copied', copyFailed: 'Copy failed. Copy manually from the source view.',
      collapse: 'Collapse', show: 'Show', expand: 'Expand height', restore: 'Restore height',
      pending: 'The preview loads when this card enters the viewport.',
      failed: 'This HTML could not be parsed or safely processed. You can view or copy the original source.',
      tooLarge: 'This block exceeds 256 KiB; preview is disabled. Original source is still available.',
      limit: 'Up to 5 HTML blocks are shown per turn; {count} additional blocks are hidden.',
      static: 'Static HTML + CSS; scripts, external resources, and navigation are disabled.',
      context: 'Preview only; HTML source may still enter subsequent model context.',
      unavailable: 'HTML preview is unavailable with this conversation interface.',
    }

    const TAGS = ('div span p br hr h1 h2 h3 h4 h5 h6 header footer main section article aside nav ' +
      'address blockquote pre code kbd samp var strong em b i u s del ins small sub sup mark ' +
      'ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td ' +
      'figure figcaption img style details summary time abbr ruby rt rp wbr').split(' ')
    const ATTRS = ('class id style title lang dir role aria-label aria-hidden aria-labelledby ' +
      'aria-describedby colspan rowspan scope headers span width height alt src ' +
      'start reversed value open datetime').split(' ')
    const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
      "connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; " +
      "child-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'"

    // The CSS helpers live in core.js so they can be unit-tested without a DOM.
    // CSP in the opaque-origin frame remains the final network boundary.
    function safeImage(value) {
      const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value)
      if (!match || match[2].length % 4 !== 0) return false
      try {
        const binary = window.atob(match[2])
        return binary.length > 0 && window.btoa(binary) === match[2]
      } catch { return false }
    }
    let purifier
    function makeDocument(source) {
      if (!purifier) {
        purifier = DOMPurify(window)
        if (!purifier.isSupported) throw new Error('DOMPurify unavailable')
        purifier.addHook('uponSanitizeAttribute', (node, data) => {
          if (data.attrName === 'src' && (node.nodeName !== 'IMG' || !safeImage(data.attrValue))) data.keepAttr = false
        })
      }
      const fragment = purifier.sanitize(source, {
        ALLOWED_TAGS: TAGS,
        ALLOWED_ATTR: ATTRS,
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
        ALLOW_UNKNOWN_PROTOCOLS: false,
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math', 'audio', 'video', 'source'],
        FORBID_ATTR: ['srcset', 'href', 'xlink:href', 'action', 'formaction', 'target', 'download', 'ping', 'srcdoc', 'nonce', 'is'],
        RETURN_DOM_FRAGMENT: true,
        FORCE_BODY: true,
        // The fragment is only serialized into an opaque-origin iframe through a
        // detached holder, never attached to the host document. Keep ids/names
        // intact so #id CSS, aria-labelledby and headers continue to resolve.
        SANITIZE_DOM: false,
        SANITIZE_NAMED_PROPS: false,
      })
      if (!fragment || fragment.nodeType !== 11) throw new Error('Invalid sanitized document')
      for (const element of fragment.querySelectorAll('[style]')) {
        const value = declarations(element.style)
        if (value) element.setAttribute('style', value)
        else element.removeAttribute('style')
      }
      for (const element of fragment.querySelectorAll('style')) {
        try {
          const sheet = new window.CSSStyleSheet()
          sheet.replaceSync(element.textContent)
          element.textContent = safeRules(sheet.cssRules)
        } catch {
          // A browser without constructable stylesheets keeps the markup but
          // drops the style element instead of failing the whole preview.
          element.remove()
        }
      }
      const holder = document.createElement('div')
      holder.appendChild(fragment)
      // Trusted policy is serialized before any user-controlled markup.
      return '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' + CSP +
        '"><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
        '<style>html{color-scheme:light;background:#fff;color:#111}body{margin:16px;background:#fff;color:#111;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>' +
        '</head><body>' + holder.innerHTML + '</body></html>'
    }

    const cardStyle = { border: '1px solid var(--dsw-alias-border-l1, #8886)', borderRadius: 10, overflow: 'hidden', marginBlock: 10, width: '100%', minWidth: 0 }
    const toolbarStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: 10 }
    const buttonStyle = { font: 'inherit', fontSize: 12, color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l1, #8886)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }
    const noteStyle = { padding: '8px 12px', fontSize: 12, opacity: 0.8, margin: 0 }

    function PreviewCard({ block, index, t }) {
      const root = React.useRef(null)
      const mounted = React.useRef(false)
      const [visible, setVisible] = React.useState(false)
      const [mode, setMode] = React.useState('preview')
      const [collapsed, setCollapsed] = React.useState(false)
      const [expanded, setExpanded] = React.useState(false)
      const [copyState, setCopyState] = React.useState('copy')
      const oversized = React.useMemo(() => new TextEncoder().encode(block.source).byteLength > MAX_BYTES, [block.source])
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])
      React.useEffect(() => {
        if (copyState !== 'copied') return undefined
        const timer = window.setTimeout(() => { if (mounted.current) setCopyState('copy') }, 1500)
        return () => window.clearTimeout(timer)
      }, [copyState])
      React.useEffect(() => {
        if (visible) return undefined
        if (typeof window.IntersectionObserver !== 'function') {
          setVisible(true)
          return undefined
        }
        const observer = new window.IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setVisible(true)
            observer.disconnect()
          }
        })
        if (root.current) observer.observe(root.current)
        return () => observer.disconnect()
      }, [visible])
      const result = React.useMemo(() => {
        if (!visible || oversized) return null
        try { return { srcDoc: makeDocument(block.source) } }
        catch { return { error: true } }
      }, [visible, oversized, block.source])
      async function copy() {
        try {
          await navigator.clipboard.writeText(block.source)
          if (mounted.current) setCopyState('copied')
        } catch {
          if (mounted.current) setCopyState('copyFailed')
        }
      }
      function button(label, onClick, extra = {}) {
        return h('button', { type: 'button', style: buttonStyle, onClick, ...extra }, t(label))
      }
      const height = expanded ? 640 : 360
      let content
      if (oversized || result?.error) {
        content = h('p', { role: 'alert', style: noteStyle }, t(oversized ? 'tooLarge' : 'failed'))
      } else if (result) {
        content = h('iframe', {
          title: t('title', { index }), sandbox: '', referrerPolicy: 'no-referrer',
          srcDoc: result.srcDoc,
          style: { display: 'block', width: '100%', height, border: 0, background: '#fff' },
        })
      } else {
        content = h('p', { style: { ...noteStyle, minHeight: 72 } }, t('pending'))
      }
      return h('section', { ref: root, style: cardStyle, 'aria-label': t('title', { index }) },
        h('div', { style: toolbarStyle },
          h('strong', { style: { fontSize: 13, marginRight: 'auto' } }, t('title', { index })),
          button('preview', () => { setMode('preview'); setCollapsed(false) }, { 'aria-pressed': mode === 'preview' }),
          button('source', () => { setMode('source'); setCollapsed(false) }, { 'aria-pressed': mode === 'source' }),
          button(copyState === 'copied' ? 'copied' : 'copy', copy),
          button(expanded ? 'restore' : 'expand', () => setExpanded(!expanded), { 'aria-pressed': expanded }),
          button(collapsed ? 'show' : 'collapse', () => setCollapsed(!collapsed), { 'aria-expanded': !collapsed })),
        copyState === 'copyFailed' ? h('p', { role: 'status', style: noteStyle }, t('copyFailed')) : null,
        // Retain a loaded frame on collapse and tab switches: initialization runs once.
        h('div', { hidden: collapsed },
          h('div', { hidden: mode !== 'preview' }, content, h('p', { style: noteStyle }, t('static'))),
          mode === 'source' ? h('pre', { style: { margin: 0, padding: 12, height, overflow: 'auto', boxSizing: 'border-box', whiteSpace: 'pre', fontSize: 12 } }, h('code', null, block.source)) : null))
    }

    function HtmlPreview(props) {
      if (typeof props.useChat !== 'function' || props.turn?.turn === undefined) {
        return h('p', { style: noteStyle, role: 'status' }, props.t('unavailable'))
      }
      return h(SubscribedPreview, props)
    }
    function SubscribedPreview({ turn, useChat, t }) {
      const nodes = useChat((snapshot) => snapshot.nodes)
      const supported = typeof nodes?.turnDataSource === 'function'
      const source = React.useMemo(() => supported ? nodes.turnDataSource(turn.turn, 'turn-tail') : EMPTY_SOURCE, [nodes, turn.turn, supported])
      const binding = React.useMemo(() => ({
        subscribe: (listener) => source.subscribe(listener),
        getSnapshot: () => source.getSnapshot(),
      }), [source])
      const tails = React.useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot)
      const parsed = React.useMemo(() => {
        const blocks = []
        let total = 0
        for (const tail of tails) {
          for (const block of tail.closing?.blocks ?? EMPTY) {
            if (block.kind !== 'text' || typeof block.text !== 'string') continue
            const found = extractHtml(block.text)
            total += found.length
            for (const html of found) if (blocks.length < MAX_BLOCKS) blocks.push(html)
          }
        }
        return { blocks, total }
      }, [tails])
      if (!supported) return h('p', { style: noteStyle, role: 'status' }, t('unavailable'))
      if (parsed.total === 0) return null
      return h('div', { style: { width: '100%', minWidth: 0 }, 'data-html-preview': '' },
        h('p', { style: noteStyle }, t('context')),
        ...parsed.blocks.map((block, index) => h(PreviewCard, { key: `${turn.turn}:${index}:${block.start}`, block, index: index + 1, t })),
        parsed.total > MAX_BLOCKS ? h('p', { style: noteStyle }, t('limit', { count: parsed.total - MAX_BLOCKS })) : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'html-preview: dictionaries')
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: 'html-preview', order: 10, locale: NS,
        }, HtmlPreview))
      },
    }
  },
})
