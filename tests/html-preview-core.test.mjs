import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractHtml } from '../dsh-html-preview/core.js'

const fence = (source, marker = '```', language = 'html', ending = '\n') => `${marker}${language}${ending}${source}${marker}`

test('extracts exact HTML payload and UTF-16 offsets without mutating text', () => {
  const before = '消息😀\n'
  const body = '<div>原文 &amp; text</div>\n'
  const text = before + fence(body) + '\n后续消息'
  const original = text
  const [block] = extractHtml(text)
  assert.deepEqual(block, {
    start: before.length, sourceStart: before.length + 8,
    sourceEnd: before.length + 8 + body.length,
    end: before.length + 8 + body.length + 3,
    source: body, fence: '`', fenceLength: 3,
  })
  assert.equal(text.slice(block.sourceStart, block.sourceEnd), body)
  assert.equal(text.slice(block.start, block.end), fence(body))
  assert.equal(text, original)
  assert.equal(text.slice(0, block.start), before)
  assert.equal(text.slice(block.end), '\n后续消息')
})

test('supports CRLF, CR, tilde fences, longer closing markers and indentation', () => {
  const text = 'before\r\n  ~~~~HTML title="demo"\r\n  <p>x</p>\r\n ~~~~~\t\r\nafter'
  const [block] = extractHtml(text)
  assert.equal(block.source, '  <p>x</p>\r\n')
  assert.equal(block.fence, '~')
  assert.equal(block.fenceLength, 4)
  assert.equal(text.slice(block.end), '\r\nafter')
  assert.equal(extractHtml('```html\r<p>x</p>\r```')[0].source, '<p>x</p>\r')
})

test('closing fences require same character, minimum opening length and no trailing info', () => {
  const source = '<p>x</p>\n```\n~~~~\n```` nope\n'
  const [block] = extractHtml('````html\n' + source + '`````   \n')
  assert.equal(block.source, source)
  assert.equal(block.end, ('````html\n' + source + '`````   ').length)
})

test('only exact html language token is recognized', () => {
  for (const language of ['', 'js', 'html5', 'xhtml', 'text/html', 'html+css', '{html}', 'html-script']) {
    assert.deepEqual(extractHtml(fence('<p>x</p>\n', '```', language)), [], language)
  }
  for (const language of ['html', 'HTML', ' html ', 'html title=test', 'html\tother']) {
    assert.equal(extractHtml(fence('<p>x</p>\n', '```', language)).length, 1, language)
  }
})

test('other language and unlabelled fences shield nested HTML examples', () => {
  for (const language of ['markdown', '', 'js']) {
    const text = '````' + language + '\n```html\n<p>example</p>\n```\n````\n'
    assert.deepEqual(extractHtml(text), [])
  }
  assert.deepEqual(extractHtml('~~~text\n```html\n<p>example</p>\n```\n'), [])
})

test('unclosed fences and partial streamed closers remain untouched', () => {
  for (const text of ['```html', '```html\n', '```html\nx\n``', '~~~~html\nx\n~~~', '```html\nx\n~~~']) {
    assert.deepEqual(extractHtml(text), [])
  }
  const complete = fence('<p>done</p>\n')
  const text = complete + '\n```html\n<p>unfinished</p>'
  const blocks = extractHtml(text)
  assert.equal(blocks.length, 1)
  assert.equal(text.slice(blocks[0].end), '\n```html\n<p>unfinished</p>')
})

test('inline fences, block quotes and four-space indents do not count as top-level', () => {
  for (const text of [
    'prefix ```html\n<p>x</p>\n```',
    '> ```html\n> <p>x</p>\n> ```',
    '    ```html\n    <p>x</p>\n    ```',
    '\t```html\n\t<p>x</p>\n\t```',
    '- ```html\n  <p>x</p>\n  ```',
  ]) assert.deepEqual(extractHtml(text), [])
})

test('empty source, close at EOF and consecutive blocks have precise nonoverlapping ranges', () => {
  const text = '```html\n```\n~~~html\n<div></div>\n~~~'
  const blocks = extractHtml(text)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].source, '')
  assert.equal(blocks[1].source, '<div></div>\n')
  assert.equal(blocks[0].end, 11)
  assert.equal(blocks[1].start, 12)
  assert.equal(blocks[1].end, text.length)
  assert.equal(text.slice(blocks[0].end, blocks[1].start), '\n')
})

test('backticks in opener info invalidate a backtick opener but not a tilde opener', () => {
  assert.deepEqual(extractHtml('```html `bad`\nx\n```'), [])
  assert.equal(extractHtml('~~~html `ok`\nx\n~~~')[0].source, 'x\n')
})

test('extraction is unbounded; preview limits cannot truncate source or other messages', () => {
  const large = '汉'.repeat(90_000) + '\r\n'
  const text = Array.from({ length: 7 }, (_, i) => `before${i}\n${fence(i === 3 ? large : `${i}\n`)}\nafter${i}\n`).join('')
  const blocks = extractHtml(text)
  assert.equal(blocks.length, 7)
  assert.equal(blocks[3].source, large)
  let previous = 0
  for (const [index, block] of blocks.entries()) {
    assert.ok(block.start >= previous)
    assert.equal(text.slice(block.sourceStart, block.sourceEnd), block.source)
    assert.ok(text.slice(previous, block.start).includes(`before${index}`))
    assert.ok(text.slice(block.end).startsWith(`\nafter${index}\n`))
    previous = block.end
  }
})

test('plain messages including HTML outside a fence are preserved and invalid input is explicit', () => {
  for (const text of ['', 'hello\r\nworld', '<html><script>alert(1)</script></html>', '``html\nx\n``']) {
    assert.deepEqual(extractHtml(text), [])
  }
  for (const value of [undefined, null, 12, {}]) assert.throws(() => extractHtml(value), TypeError)
})
