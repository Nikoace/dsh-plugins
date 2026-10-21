// Offline observations supporting ../code-review-2026-10-21.md.
// Run from any directory: node <path-to-this-file>
// R1/R4 and R2/R5/R6 now assert fixes; the other assertions pin reviewed defects.
// No network, real credentials, profile writes, or production code changes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHttpClient } from '../../dsh-github/lib/http.js'
import { resolveConfig } from '../../dsh-github/lib/config.js'
import { createGithubTools } from '../../dsh-github/lib/tools.js'
import { normalizeRepo, parseGitRemoteText } from '../../dsh-github/lib/repo.js'
import { internals as cost } from '../../dsh-token-cost/index.js'
import * as tariff from '../../shared/tariff/index.js'

const results = []
const record = (id, observed) => results.push({ id, observed })
const jsonResponse = (value, etag = '"review"') => new Response(JSON.stringify(value), {
  status: 200, headers: { 'content-type': 'application/json', etag },
})
const tick = () => new Promise((resolve) => setImmediate(resolve))

// R1 FIXED: an older authenticated response cannot refill the anonymous cache.
{
  let token = 'synthetic-review-token'
  let releaseOld
  let requests = 0
  const client = createHttpClient(resolveConfig({}, {}), {
    tokenProvider: async () => token,
    fetchImpl: async (_url, init) => {
      requests += 1
      if (init.headers.Authorization) {
        return await new Promise((resolve) => { releaseOld = () => resolve(jsonResponse({ private: true })) })
      }
      return jsonResponse({ private: false })
    },
  })
  const oldRequest = client.json('/repos/example/private')
  const rejectedOldRequest = assert.rejects(oldRequest, /credentials changed/)
  await tick()
  assert.equal(typeof releaseOld, 'function')
  token = ''
  await client.json('/repos/example/public')
  releaseOld()
  await rejectedOldRequest
  const anonymousResult = await client.json('/repos/example/private')
  assert.equal(anonymousResult.fromCache, false)
  assert.equal(anonymousResult.data.private, false)
  assert.equal(requests, 3)
  record('R1', { fixed: true, anonymousReceivedPrivateCachedData: false, networkRequests: requests })
}

// R2 FIXED: an explicit non-holiday is not replaced with an estimate.
{
  const payload = { holiday: {
    '02-02': { date: '2026-02-02', name: 'workday fixture', holiday: false },
    '02-17': { date: '2026-02-17', name: 'holiday fixture', holiday: true },
  } }
  const dates = tariff.parseHolidayPayload(payload, 2026)
  const provenance = tariff.holidayProvenance({ auto: dates, years: [2026] })
  const merged = tariff.provenanceDates(provenance)
  const time = Date.parse('2026-02-02T02:00:00Z')
  assert.equal(tariff.bandAt(time, { holidays: dates }), 'peak')
  assert.equal(tariff.bandAt(time, { holidays: merged }), 'peak')
  assert.deepEqual(provenance.fixed, [])
  record('R2', { fixed: true, sourceOnlyBand: 'peak', mergedBand: 'peak', restoredEstimate: false })
}

const settings = cost.resolveSettings({ pricingSource: false, holidaysSource: false, rates: {
  'deepseek-flash': { input: 4, cacheRead: 0.1, cacheWrite: 4, output: 8, offPeakMultiplier: 0.5 },
} })
const route = { type: 'request/header', time: 0, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } }
const start = (time) => ({ type: 'step/start', time, data: { turn: 1, step: 1 } })
const message = (time, attempt = false) => ({
  type: attempt ? 'assistant/attempt' : 'assistant/message', time,
  data: { turn: 1, step: 1, ...(attempt
    ? { stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1_000_000 } } }] }
    : { usage: { inputTokens: 1_000_000 } }) },
})

// R3: a retry after the band boundary is still charged at step/start.
{
  const first = Date.parse('2026-10-19T03:59:00Z')
  const retry = Date.parse('2026-10-19T04:01:00Z')
  const catalog = cost.createPricingCatalog(settings)
  let state = cost.initialState(catalog.epochsFor(first))
  const events = [route, start(first), message(first, true),
    { type: 'llm/retry-started', time: retry, data: { turn: 1, step: 1 } }, message(retry)]
  for (const event of events) state = cost.foldEvent(state, event)
  const view = cost.viewOf(state)
  assert.equal(state.attemptStartedAt, retry)
  assert.equal(view.calls, 2)
  assert.equal(view.peak.calls, 2)
  assert.equal(view.micros, 8_000_000)
  record('R3', { peakCalls: view.peak.calls, offPeakCalls: view.offPeak.calls, actualMicros: view.micros, expectedMicros: 6_000_000 })
}

// R4 FIXED: disabling writes while approval is pending blocks the POST.
{
  const raw = { allowWrites: true, requireApproval: true }
  const config = resolveConfig(raw, {})
  let approve
  let writes = 0
  const tools = createGithubTools({ config,
    client: { json: async (_path, options) => { assert.equal(options.method, 'POST'); writes += 1; return { data: { id: 1 } } } },
    ctx: { get: (key) => key === 'approval' ? { request: () => new Promise((resolve) => { approve = resolve }) } : undefined },
  })
  const pending = tools.find((tool) => tool.name === 'github_comment').execute(
    { repo: 'example/project', number: 1, body: 'offline fixture' }, { agent: {}, signal: undefined },
  )
  const rejectedWrite = assert.rejects(pending, /GitHub writes are disabled/)
  await tick()
  assert.equal(typeof approve, 'function')
  raw.allowWrites = false
  approve('allowed-once')
  await rejectedWrite
  assert.equal(writes, 0)
  record('R4', { fixed: true, allowWritesAfterApproval: config.allowWrites, postsSent: writes })
}

// R5 FIXED: one year is fetched; a failed refresh leaves the saved calendar intact.
{
  const source = fs.readFileSync(new URL('../../dsh-sidebar-clock/client.js', import.meta.url), 'utf8')
  const begin = source.indexOf('    async function refreshHolidayCalendar(now) {')
  const end = source.indexOf('\n    // -----------------------------------------------------------------------', begin)
  assert.ok(begin >= 0 && end > begin, 'clock refresh source markers must exist')
  let failCurrent = false
  let cached
  const refresh = new Function('holidayYears', 'fetchHolidayYear', 'holidayDatesForYears', 'writeHolidayCache',
    source.slice(begin, end) + '\nreturn refreshHolidayCalendar;')(
    () => [2026],
    async (year) => {
      if (year === 2026 && failCurrent) throw new Error('offline fixture timeout')
      return [{ date: `${year}-04-06`, name: 'fixture holiday' }]
    }, tariff.holidayDatesForYears, (value) => { cached = value },
  )
  const good = await refresh(0)
  assert.equal(good.dates['2026-04-06'], 'fixture holiday')
  failCurrent = true
  await assert.rejects(refresh(0), /offline fixture timeout/)
  assert.equal(cached, good)
  assert.equal(Object.hasOwn(cached.dates, '2026-04-06'), true)
  record('R5', { fixed: true, retainedGoodDate: true, persistedLoss: false })
}

// R6 FIXED: HTTP 200 containing a business error preserves the last good calendar.
{
  let broken = false
  let now = Date.parse('2026-10-19T02:00:00Z')
  const cards = []
  const controller = cost.createRefreshController({
    settings: cost.resolveSettings({ pricingSource: false, holidaysSource: 'https://fixture.invalid/{year}' }),
    now: () => now,
    timers: { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {} },
    onCard: (card) => cards.push(card),
    web: { fetch: async ({ url }) => ({ statusCode: 200, body: { content: JSON.stringify(broken
      ? { code: -1, message: 'synthetic upstream failure' }
      : { dates: [`${url.slice(-4)}-04-06`] }) } }) },
  })
  controller.start()
  await tick()
  assert.ok(cards.at(-1).holidays.includes('2026-04-06'))
  const lastSuccess = controller.status().holidays.fetchedAt
  broken = true
  now += 1000
  await controller.refreshHolidays()
  assert.equal(cards.at(-1).holidays.includes('2026-04-06'), true)
  assert.ok(controller.status().holidays.error)
  assert.equal(controller.status().holidays.fetchedAt, lastSuccess)
  record('R6', { fixed: true, retainedGoodDate: true, failureRecordedAsFresh: false })
  controller.stop()
}

// R7: foreign Git hosts are silently converted into GitHub owner/name.
{
  const explicit = normalizeRepo('https://gitlab.com/example/project')
  const detected = parseGitRemoteText('[remote "origin"]\n  url = git@gitlab.com:example/project.git\n')
  assert.equal(explicit, 'example/project')
  assert.equal(detected, 'example/project')
  record('R7', { foreignUrl: explicit, foreignOrigin: detected, defaultApiBase: resolveConfig({}, {}).apiBaseUrl })
}

// R8: rebuilding without the old in-memory catalog changes historical pricing.
// This models a full projection rebuild, not a normal persisted-state restore.
{
  const firstFetch = Date.parse('2026-10-19T02:00:00Z')
  const requestTime = firstFetch + 60_000
  const afterRestart = requestTime + 60_000
  const card = structuredClone(settings.fallbackCard)
  card.source = 'synthetic-official'
  card.rates['deepseek-flash'].input = 8
  const oldCatalog = cost.createPricingCatalog(settings)
  oldCatalog.ingest(card, firstFetch)
  const events = [route, start(requestTime), message(requestTime)]
  const fold = (catalog) => events.reduce((state, event) => cost.foldEvent(state, event), cost.initialState(catalog.epochsFor(requestTime)))
  const oldState = fold(oldCatalog)
  const freshCatalog = cost.createPricingCatalog(settings)
  freshCatalog.ingest(card, afterRestart)
  const rebuilt = fold(freshCatalog)
  const oldAmount = cost.viewOf(oldState).micros
  const rebuiltAmount = cost.viewOf(rebuilt).micros
  const restoredAmount = cost.viewOf(cost.syncEpochs(structuredClone(oldState), freshCatalog.epochsFor(requestTime))).micros
  assert.equal(oldAmount, 8_000_000)
  assert.equal(rebuiltAmount, 4_000_000)
  assert.equal(restoredAmount, oldAmount)
  record('R8', { originalMicros: oldAmount, fullRebuildMicros: rebuiltAmount, persistedStateRestoreMicros: restoredAmount })
}

console.log(JSON.stringify({ mode: 'offline review observations; R1/R2/R4/R5/R6 verify fixes; R3/R7/R8 remain open', results }, null, 2))
