'use strict'
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')

function installedClient() {
  const file = process.env.DSH_ASAR || 'D:/software/deepseek-harness/resources/app.asar'
  const archive = fs.readFileSync(file)
  const dataStart = 8 + archive.readUInt32LE(4)
  const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString())
  function read(name) {
    let entry = header
    for (const part of name.split('/')) entry = entry?.files?.[part]
    assert.ok(entry && !entry.unpacked && !entry.link, 'missing packed file: ' + name)
    const offset = dataStart + Number(entry.offset)
    return archive.subarray(offset, offset + entry.size).toString('utf8')
  }
  const assets = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/'
  const frontend = read(assets + 'index-CN7NIWNw.js')
  // Version-pinned extraction: fail loudly if the installed bundle changes.
  const start = frontend.indexOf('function xI(')
  const end = frontend.indexOf('const SI=', start)
  assert.ok(start >= 0 && end > start, 'SlotCore markers changed; refresh this test adapter')
  const SlotCore = vm.runInNewContext(frontend.slice(start, end) + '\n$I', { queueMicrotask })
  return { read, assets, frontend, SlotCore }
}
module.exports = { installedClient }
