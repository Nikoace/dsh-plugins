#!/usr/bin/env node
/**
 * Generate the per-target copies of the canonical tariff rules.
 *
 * `shared/tariff/index.js` is the single source of truth. The Web clients are
 * single-file module-loader bundles and cannot import local files, so their
 * copies are inlined between generated markers; the Host copy is a normal ESM
 * module that `dsh-token-cost/index.js` imports.
 *
 * Usage:
 *   node tools/sync-shared.mjs                 # regenerate every copy
 *   node tools/sync-shared.mjs --check         # fail when a copy drifted
 *   node tools/sync-shared.mjs --host-only     # only the Host ESM copy
 *
 * Exit codes: 0 = in sync / written, 1 = drift or a missing marker.
 *
 * `checkSync()` is exported so `tests/tariff-consistency.test.mjs` can verify
 * the copies without spawning a pipeline (the sandbox rejects piped child
 * stdio; CI still runs this file directly through `npm test`).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CANONICAL_FILE = 'shared/tariff/index.js'

/** Marker lines in a Web client, so the copy can be replaced in place. */
const INLINE_START = '    // >>> generated:tariff (canonical rules; do not edit — run `node tools/sync-shared.mjs`)'
const INLINE_END = '    // <<< generated:tariff'
const INLINE_INDENT = '      '

const HOST_HEADER = [
  '// DO NOT EDIT — generated copy of the canonical tariff rules.',
  '// Edit shared/tariff/index.js, then run: node tools/sync-shared.mjs',
  '',
].join('\n')

const MIRRORS = [
  { id: 'token-cost host', file: 'dsh-token-cost/tariff.js', mode: 'esm' },
  { id: 'token-cost client', file: 'dsh-token-cost/client.js', mode: 'inline' },
  { id: 'sidebar-clock client', file: 'dsh-sidebar-clock/client.js', mode: 'inline' },
]

/** @returns {string} canonical source normalized to LF. */
export function readCanonical() {
  return fs.readFileSync(path.join(ROOT, CANONICAL_FILE), 'utf8').replace(/\r\n/g, '\n')
}

/** Names exported by the canonical module, in declaration order. */
function exportedNames(source) {
  const names = []
  const pattern = /^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of source.matchAll(pattern)) names.push(match[1])
  return names
}

/** Body of the canonical module without `export` keywords, indented for inlining. */
function inlineBody(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/^export\s+/, ''))
    .map((line) => (line === '' ? '' : INLINE_INDENT + line))
    .join('\n')
}

/** @returns {string} the inline block (markers included), LF. */
function inlineBlock(source) {
  const names = exportedNames(source)
  return [
    INLINE_START,
    '    const Tariff = (() => {',
    inlineBody(source),
    '      return {',
    ...names.map((name) => `        ${name},`),
    '      }',
    '    })()',
    INLINE_END,
  ].join('\n')
}

/** @returns {string} the Host ESM artifact. */
function esmArtifact(source) {
  return HOST_HEADER + source
}

/** @returns {{ start: number, end: number, block: string } | null} marker span. */
function findInlineBlock(text) {
  const lines = text.split('\n')
  let startLine = -1
  let endLine = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trimEnd() === INLINE_START.trimEnd()) startLine = index
    else if (startLine >= 0 && lines[index].trimEnd() === INLINE_END.trimEnd()) {
      endLine = index
      break
    }
  }
  if (startLine < 0 || endLine < 0) return null
  const start = lines.slice(0, startLine).join('\n').length + (startLine > 0 ? 1 : 0)
  const block = lines.slice(startLine, endLine + 1).join('\n')
  return { start, end: start + block.length, block }
}

/**
 * Compare every generated copy with a fresh render of the canonical module.
 *
 * @returns {{ ok: boolean, messages: string[] }} drift report.
 */
export function checkSync() {
  const canonical = readCanonical()
  const messages = []
  let ok = true
  for (const mirror of MIRRORS) {
    const file = path.join(ROOT, mirror.file)
    let current
    try {
      current = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    } catch {
      ok = false
      messages.push(`MISSING ${mirror.file} (${mirror.id})`)
      continue
    }
    if (mirror.mode === 'esm') {
      if (current !== esmArtifact(canonical)) {
        ok = false
        messages.push(`DRIFT ${mirror.file} (${mirror.id})`)
      }
      continue
    }
    const found = findInlineBlock(current)
    if (found === null) {
      ok = false
      messages.push(`MARKER MISSING ${mirror.file} (${mirror.id})`)
      continue
    }
    if (found.block !== inlineBlock(canonical)) {
      ok = false
      messages.push(`DRIFT ${mirror.file} (${mirror.id})`)
    }
  }
  if (ok) messages.push('all generated tariff copies are in sync')
  return { ok, messages }
}

/** Write one generated artifact, reporting instead of throwing on a denied write. */
function writeFile(file, content) {
  try {
    fs.writeFileSync(file, content, 'utf8')
    console.log(`wrote ${path.relative(ROOT, file)}`)
    return true
  } catch (error) {
    console.error(`WRITE FAILED ${path.relative(ROOT, file)}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Regenerate every copy (or only the Host copy with `hostOnly`).
 *
 * @param {{ hostOnly?: boolean }} options - generation options.
 * @returns {number} process exit code (0 = success).
 */
export function syncAll(options = {}) {
  const canonical = readCanonical()
  let problems = 0
  let changed = 0
  for (const mirror of MIRRORS) {
    if (options.hostOnly === true && mirror.mode !== 'esm') continue
    const file = path.join(ROOT, mirror.file)
    let current = ''
    let missing = false
    try {
      current = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    } catch {
      missing = true
    }

    if (mirror.mode === 'esm') {
      const expected = esmArtifact(canonical)
      if (!missing && current === expected) {
        console.log(`ok    ${mirror.file} (${mirror.id})`)
        continue
      }
      console.log(`${missing ? 'MISSING' : 'DRIFT'} ${mirror.file} (${mirror.id})`)
      if (writeFile(file, expected)) changed += 1
      else problems += 1
      continue
    }

    if (missing) {
      console.error(`MISSING ${mirror.file} (${mirror.id})`)
      problems += 1
      continue
    }
    const found = findInlineBlock(current)
    if (found === null) {
      console.error(`MARKER MISSING ${mirror.file} (${mirror.id}): expected the generated block markers`)
      problems += 1
      continue
    }
    const expected = inlineBlock(canonical)
    if (found.block === expected) {
      console.log(`ok    ${mirror.file} (${mirror.id})`)
      continue
    }
    console.log(`DRIFT ${mirror.file} (${mirror.id})`)
    const next = current.slice(0, found.start) + expected + current.slice(found.end)
    if (writeFile(file, next)) changed += 1
    else problems += 1
  }
  console.log(changed === 0 ? 'nothing to update' : `updated ${changed} file(s)`)
  if (problems > 0) {
    console.error(`${problems} file(s) could not be synced`)
    return 1
  }
  return 0
}

/** CLI entry point. */
function main() {
  const args = new Set(process.argv.slice(2))
  const unknown = [...args].filter((arg) => !['--check', '--host-only'].includes(arg))
  if (unknown.length > 0) {
    console.error(`unknown argument(s): ${unknown.join(', ')}`)
    return 1
  }
  if (args.has('--check')) {
    const { ok, messages } = checkSync()
    for (const message of messages) (ok ? console.log : console.error)(message)
    if (!ok) console.error('run: node tools/sync-shared.mjs')
    return ok ? 0 : 1
  }
  return syncAll({ hostOnly: args.has('--host-only') })
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
