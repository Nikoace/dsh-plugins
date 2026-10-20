'use strict'
// Helper module (not a standalone assertion script): extracts the real SlotCore
// and official sidebar bundle from the installed DSH `app.asar`.
//
// tests/sidebar-clock-client-harness.cjs requires this file and exercises the
// extraction; it is not run as a separate test by `npm test`.
//
// The archive location is configurable with DSH_ASAR and defaults to the DSH
// desktop install used during development. When the archive is missing (CI, a
// machine without the DSH desktop app, a fresh checkout) the helper prints a
// clear SKIP line and returns null, so callers can exit 0 instead of failing on
// an absent local dependency. When the archive is present but the pinned
// SlotCore markers moved, the assertion below fails loudly and asks for the test
// adapter to be refreshed.
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')

const DEFAULT_ASAR = 'D:/software/deepseek-harness/resources/app.asar'
const ASAR = process.env.DSH_ASAR || DEFAULT_ASAR
const SKIP_REASON = 'SKIP: DSH app.asar not found (set DSH_ASAR or install DSH desktop)'

function installedClient() {
  if (!fs.existsSync(ASAR)) {
    console.log(SKIP_REASON)
    console.log('  looked for: ' + ASAR)
    return null
  }
  // If the archive exists but cannot be read, let that throw: a broken install
  // should be visible, not skipped.
  const archive = fs.readFileSync(ASAR)
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
  return { read, assets, frontend, SlotCore, archivePath: ASAR }
}

module.exports = { installedClient, ASAR, SKIP_REASON }

if (require.main === module) {
  const installed = installedClient()
  if (!installed) {
    console.log('SKIP: nothing to verify without the installed DSH shell')
    process.exit(0)
  }
  console.log('PASS: loaded the installed SlotCore and official sidebar from ' + installed.archivePath)
}
