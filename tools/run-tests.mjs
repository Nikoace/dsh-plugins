#!/usr/bin/env node
// Zero-dependency test runner for this repository. `npm test` calls this file.
//
//   node tools/run-tests.mjs               run every harness
//   node tools/run-tests.mjs github        run harnesses whose name contains "github"
//   node tools/run-tests.mjs --list        list the harnesses that would run
//
// Discovery is explicit and deliberately limited to the top level of tests/:
//
//   *.test.mjs, *.test.cjs          assert-based test scripts
//   *-logic.cjs, *-harness.cjs      assert-based test scripts
//   *-smoke.mjs                     assert-based test scripts
//
// Anything else is not a test. In particular `*-installed.cjs` files are helper
// modules required by a harness (tests/sidebar-clock-installed.cjs is required by
// tests/sidebar-clock-client-harness.cjs); running them as standalone tests would
// double-count the work they support, so they are skipped here and stay exercised
// through the harness that requires them. Fixture directories are never walked.
//
// Every harness runs in its own Node process, so one crash, one hung timer or one
// polluted global cannot leak into the next. Output is inherited from the child,
// not captured, which keeps ANSI/log output intact and works in environments
// where piped stdio is unavailable. A harness exits 0 on success and nonzero on
// failure; the runner reports PASS/FAIL plus a summary and exits nonzero if any
// harness failed.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TESTS_DIR = join(ROOT, 'tests')
const TIMEOUT_MS = 180_000

const TEST_PATTERNS = [/\.test\.mjs$/, /\.test\.cjs$/, /-logic\.cjs$/, /-harness\.cjs$/, /-smoke\.mjs$/]
const HELPER_PATTERNS = [/-installed\.cjs$/]

function discover() {
  let entries
  try {
    entries = readdirSync(TESTS_DIR, { withFileTypes: true })
  } catch (error) {
    console.error('FAIL: cannot read the tests directory: ' + error.message)
    process.exit(1)
  }
  const tests = []
  const helpers = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (HELPER_PATTERNS.some((pattern) => pattern.test(name))) {
      helpers.push(name)
      continue
    }
    if (TEST_PATTERNS.some((pattern) => pattern.test(name))) tests.push(name)
  }
  // Stable, predictable order: alphabetical by file name.
  tests.sort((a, b) => a.localeCompare(b, 'en'))
  helpers.sort((a, b) => a.localeCompare(b, 'en'))
  return { tests, helpers }
}

const argv = process.argv.slice(2)
const listOnly = argv.includes('--list') || argv.includes('-l')
const filters = argv.filter((arg) => !arg.startsWith('-'))

const { tests: discovered, helpers } = discover()

if (helpers.length > 0) {
  console.log('helper modules (not run separately): ' + helpers.map((name) => 'tests/' + name).join(', '))
}

const selected = filters.length === 0
  ? discovered
  : discovered.filter((name) => filters.some((filter) => name.includes(filter)))

if (selected.length === 0) {
  console.error(
    discovered.length === 0
      ? 'FAIL: no test harnesses found in ' + TESTS_DIR
      : 'FAIL: no test harness matched: ' + filters.join(', '),
  )
  process.exit(1)
}

if (listOnly) {
  for (const name of selected) console.log('tests/' + name)
  process.exit(0)
}

const startedAt = Date.now()
const failures = []

console.log('')
for (const [index, name] of selected.entries()) {
  const label = `[${index + 1}/${selected.length}]`
  console.log(`${label} RUN  tests/${name}`)
  const childStartedAt = Date.now()
  const child = spawnSync(process.execPath, [join(TESTS_DIR, name)], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: TIMEOUT_MS,
    windowsHide: true,
  })
  const durationMs = Date.now() - childStartedAt
  const duration = `${durationMs} ms`

  let failure = null
  if (child.error) {
    failure = `could not start (${child.error.code || child.error.message})`
  } else if (child.status === null) {
    failure = child.signal
      ? `terminated by ${child.signal}` + (child.signal === 'SIGTERM' ? ` (timeout after ${TIMEOUT_MS} ms?)` : '')
      : 'exited without a status'
  } else if (child.status !== 0) {
    failure = `exit code ${child.status}`
  }

  if (failure) {
    failures.push({ name, failure, duration })
    console.log(`${label} FAIL tests/${name} (${duration}) - ${failure}`)
  } else {
    console.log(`${label} PASS tests/${name} (${duration})`)
  }
}

const totalMs = Date.now() - startedAt
const passed = selected.length - failures.length
console.log('')
console.log('-'.repeat(72))
console.log(`Tests: ${passed} passed, ${failures.length} failed, ${selected.length} total (${totalMs} ms)`)
if (failures.length > 0) {
  for (const { name, failure, duration } of failures) {
    console.log(`  FAIL  tests/${name} (${duration}) - ${failure}`)
  }
  console.log('Result: FAIL')
  process.exit(1)
}
console.log('Result: PASS (harnesses that print SKIP exit 0; see their output above)')
