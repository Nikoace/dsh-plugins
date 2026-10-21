import assert from 'node:assert/strict'
import { test } from 'node:test'
import { declarations, safeCssValue, safeRules } from '../dsh-html-preview/core.js'

/** Minimal CSSStyleDeclaration-shaped object for the pure helpers. */
function styleOf(properties, priorities = {}) {
  const names = Object.keys(properties)
  const style = {
    length: names.length,
    getPropertyValue: (property) => properties[property] ?? '',
    getPropertyPriority: (property) => priorities[property] ?? '',
  }
  names.forEach((name, index) => { style[index] = name })
  return style
}

const rule = (selectorText, properties) => ({ type: 1, selectorText, style: styleOf(properties) })

test('keeps child combinators and id selectors', () => {
  assert.equal(
    safeRules([rule('.card > h2', { color: 'red', margin: '0' })]),
    '.card > h2{color:red;margin:0;}',
  )
  assert.equal(
    safeRules([rule('#card', { 'background-color': '#eef', 'border-radius': '8px' })]),
    '#card{background-color:#eef;border-radius:8px;}',
  )
})

test('keeps CSS variables and preserves custom-property case', () => {
  assert.equal(
    safeRules([
      rule(':root', { '--brand': '#123', '--Space': '8px' }),
      rule('.card', { color: 'var(--brand)', padding: 'var(--Space)' }),
    ]),
    ':root{--brand:#123;--Space:8px;}.card{color:var(--brand);padding:var(--Space);}',
  )
  assert.equal(declarations(styleOf({ '--Brand': '#123' })), '--Brand:#123;')
})

test('keeps range media queries and nested supports rules', () => {
  const media = { type: 4, conditionText: '(width > 600px)', cssRules: [rule('.wide', { display: 'block' })] }
  assert.equal(safeRules([media]), '@media (width > 600px){.wide{display:block;}}')
  const supports = { type: 12, conditionText: '(display: grid)', cssRules: [rule('.grid', { display: 'grid' })] }
  assert.equal(
    safeRules([{ type: 4, conditionText: 'screen', cssRules: [supports] }]),
    '@media screen{@supports (display: grid){.grid{display:grid;}}}',
  )
})

test('rejects resource loaders, tag breakouts and escaped functions', () => {
  for (const value of [
    'url(https://example.com/x.png)',
    'image-set("x.png" 1x)',
    'var(--brand, url(https://example.com/x.png))',
    '</style><script>alert(1)</script>',
    '@import "x.css"',
    'red;/*comment*/',
    '\\3c /style',
    'expression(alert(1))',
  ]) assert.equal(safeCssValue(value), false, value)
  for (const value of [
    'red',
    'linear-gradient(135deg, #fff 0%, #000 100%)',
    'calc(100% - 10px)',
    'var(--brand)',
    'width > 600px',
  ]) assert.equal(safeCssValue(value), true, value)
})

test('emits only allowlisted declarations and keeps !important', () => {
  assert.equal(declarations(styleOf({ color: 'red', behavior: 'url(x)' })), 'color:red;')
  assert.equal(declarations(styleOf({ background: 'url(https://x)' })), '')
  assert.equal(declarations(styleOf({ '--bg': 'url(https://x)' })), '')
  assert.equal(declarations(styleOf({ color: 'red' }, { color: 'important' })), 'color:red!important;')
  assert.equal(declarations(styleOf({})), '')
})

test('drops unsupported selectors and at-rules', () => {
  assert.equal(safeRules([{ type: 1, selectorText: 'a < b', style: styleOf({ color: 'red' }) }]), '')
  assert.equal(safeRules([{ type: 1, selectorText: '.a\\:b', style: styleOf({ color: 'red' }) }]), '')
  assert.equal(safeRules([{ type: 3, href: 'x.css' }]), '')
  assert.equal(safeRules([{ type: 7, name: 'spin' }]), '')
  assert.equal(safeRules([{ type: 4, conditionText: 'screen' }]), '@media screen{}')
})

test('bounds nested at-rule recursion', () => {
  let rules = [rule('.deep', { color: 'red' })]
  for (let i = 0; i < 10; i++) rules = [{ type: 4, conditionText: 'screen', cssRules: rules }]
  assert.equal(safeRules(rules).includes('.deep'), false)
})
