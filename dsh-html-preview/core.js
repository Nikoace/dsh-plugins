/**
 * Pure helpers shared by the Client bundle and the offline tests.
 *
 * `extractHtml` reads closed, top-level Markdown fences whose first info token
 * is `html`; offsets are UTF-16 string offsets and the original text is never
 * mutated. `safeCssValue`, `declarations` and `safeRules` re-emit the restricted
 * CSS subset used inside the sandboxed preview document. They take CSSOM-shaped
 * inputs so they can be exercised without a browser.
 */

/** CSS properties allowed in a preview document. */
const CSS_PROPERTIES = new Set(('color background-color background background-image background-size ' +
  'background-position background-repeat background-origin background-clip background-attachment ' +
  'display position top right bottom left inset z-index float clear box-sizing ' +
  'width min-width max-width height min-height max-height aspect-ratio ' +
  'margin margin-top margin-right margin-bottom margin-left margin-inline margin-block ' +
  'padding padding-top padding-right padding-bottom padding-left padding-inline padding-block ' +
  'border border-top border-right border-bottom border-left border-width border-style border-color ' +
  'border-radius border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius ' +
  'outline outline-width outline-style outline-color outline-offset box-shadow ' +
  'font font-family font-size font-weight font-style font-variant line-height letter-spacing word-spacing ' +
  'text-align text-align-last text-decoration text-decoration-line text-decoration-color text-decoration-style ' +
  'text-transform text-indent text-overflow text-shadow vertical-align white-space word-break overflow-wrap ' +
  'overflow overflow-x overflow-y opacity visibility object-fit object-position ' +
  'flex flex-grow flex-shrink flex-basis flex-direction flex-wrap align-items align-self align-content ' +
  'justify-content justify-items justify-self order gap row-gap column-gap ' +
  'grid grid-template-columns grid-template-rows grid-template-areas grid-auto-columns grid-auto-rows ' +
  'grid-auto-flow grid-column grid-row grid-column-start grid-column-end grid-row-start grid-row-end grid-area ' +
  'border-collapse border-spacing table-layout caption-side empty-cells list-style-type list-style-position ' +
  'transform transform-origin perspective backface-visibility isolation').split(' '))

/**
 * Functions allowed inside a declaration value. `var` is deliberate: a custom
 * property value is filtered by the same checks before it can be referenced.
 */
const CSS_FUNCTIONS = new Set(('rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix ' +
  'calc min max clamp minmax repeat fit-content var ' +
  'linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient ' +
  'translate translatex translatey translatez translate3d scale scalex scaley scalez scale3d ' +
  'rotate rotatex rotatey rotatez rotate3d skew skewx skewy matrix matrix3d perspective').split(' '))

/**
 * Whether a declaration value can be re-emitted. `<`, `\` and `@` are rejected
 * because they can end the style element or hide a resource function behind an
 * escape; comments are rejected for the same reason. Function names are matched
 * against a small allowlist so `url()` (and other resource loaders) cannot pass.
 * `>` is a normal CSS token and stays allowed: it is needed by range media
 * queries and appears inside ordinary values.
 */
export function safeCssValue(value) {
  if (typeof value !== 'string') return false
  if (/[\\@<]/.test(value) || /\/\*|\*\//.test(value)) return false
  for (const match of value.matchAll(/([-\w]+)\s*\(/g)) {
    if (!CSS_FUNCTIONS.has(match[1].toLowerCase())) return false
  }
  return true
}

/**
 * Re-emit one CSSStyleDeclaration, keeping allowlisted properties and safe
 * values. Custom properties (`--name`) are accepted as well, with their original
 * case preserved because custom-property names are case-sensitive.
 */
export function declarations(style) {
  const output = []
  for (let i = 0; i < style.length; i++) {
    const name = style[i]
    if (typeof name !== 'string') continue
    const property = name.startsWith('--') ? name : name.toLowerCase()
    const value = style.getPropertyValue(property)
    if (!safeCssValue(value)) continue
    if (!property.startsWith('--') && !CSS_PROPERTIES.has(property)) continue
    output.push(`${property}:${value}${style.getPropertyPriority(property) === 'important' ? '!important' : ''};`)
  }
  return output.join('')
}

/**
 * Re-emit the supported at-rule subset. Only style rules and `@media` /
 * `@supports` wrappers survive; imports, font faces, keyframes and other rules
 * are dropped. Nested wrappers are bounded so a hostile document cannot recurse
 * without limit.
 */
export function safeRules(rules, depth = 0) {
  if (depth > 8) return ''
  const output = []
  for (const rule of rules) {
    if (rule.type === 1) {
      if (typeof rule.selectorText !== 'string' || /[\\<@]/.test(rule.selectorText)) continue
      output.push(`${rule.selectorText}{${declarations(rule.style)}}`)
    } else if (rule.type === 4 || rule.type === 12) {
      if (typeof rule.conditionText !== 'string' || !safeCssValue(rule.conditionText)) continue
      output.push(`@${rule.type === 4 ? 'media' : 'supports'} ${rule.conditionText}{${safeRules(rule.cssRules ?? [], depth + 1)}}`)
    }
  }
  return output.join('')
}

/**
 * Extract closed, top-level Markdown fences whose first info token is `html`.
 * [start, end) includes both fence lines but excludes the closing line ending, so
 * replacing a block preserves its neighbors. [sourceStart, sourceEnd) is the
 * exact original payload (including line endings). Other fenced languages shield
 * their contents; unfinished fences remain text.
 * No preview budget is applied here; callers decide which blocks to display.
 */
export function extractHtml(text) {
  if (typeof text !== 'string') throw new TypeError('Expected text to be a string')
  const blocks = []
  const lines = /([^\r\n]*)(\r\n|\n|\r|$)/g
  let opened = null
  let match
  while (lines.lastIndex < text.length && (match = lines.exec(text)) !== null) {
    const line = match[1]
    const start = match.index
    if (opened !== null) {
      const close = /^ {0,3}(`+|~+)[\t ]*$/.exec(line)
      if (close && close[1][0] === opened.fence && close[1].length >= opened.fenceLength) {
        if (opened.html) {
          const { html, ...block } = opened
          blocks.push({ ...block, sourceEnd: start, end: start + line.length, source: text.slice(block.sourceStart, start) })
        }
        opened = null
      }
      continue
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) continue
    const info = open[2].trim()
    opened = {
      html: /^html(?:[\t ].*)?$/i.test(info),
      start,
      sourceStart: lines.lastIndex,
      fence: open[1][0],
      fenceLength: open[1].length,
    }
  }
  return blocks
}
