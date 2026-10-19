// Replay a real stored Session log through the Host fold and compare the token
// totals with an independent replica of the shipped `tokenUsage` projection.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { decodeSessionLog, parseRecords } from '../tools/session-events.mjs'
import { apply, internals } from '../dsh-token-cost/index.js'

const { resolveSettings, foldEvent, viewOf, initialState } = internals

const file = process.argv[2] ?? new URL('./fixtures/session.v4.jsonl.zstd', import.meta.url)
if (!fs.existsSync(file)) {
  console.log(`replay test skipped: ${file} not found`)
  process.exit(0)
}

const records = parseRecords(decodeSessionLog(fs.readFileSync(file)))
assert.ok(records.length > 100, 'the fixture session has a substantial log')
const header = records.find((record) => record.type === 'session')
assert.ok(header !== undefined, 'the log starts with a session header')
const events = records.filter((record) => typeof record.type === 'string' && record.type !== 'session')
assert.ok(events.every((event) => typeof event.seq === 'number' && typeof event.time === 'number'), 'every event has seq and time')

const settings = resolveSettings({ pricingSource: false })
const definition = (() => {
  let captured
  apply(
    {
      sessionProjections: { register: (value) => ((captured = value), () => {}) },
      effect: (callback) => callback(),
      get: () => undefined,
      logger: {},
    },
    { pricingSource: false },
  )
  return captured
})()

let state = definition.init({ createdAt: header.createdAt })
for (const event of events) state = definition.apply(state, event)
const view = definition.wire.view(state)

// Independent replica of the shipped tokenUsage fold semantics: a sample
// replaces the previous sample of the same attempt, and llm/retry-started
// closes that replacement slot.
const zero = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
const bucketsOf = (usage) => ({
  input: usage.inputTokens ?? 0,
  cacheRead: usage.cacheReadTokens ?? 0,
  cacheWrite: usage.cacheWriteTokens ?? 0,
  output: usage.outputTokens ?? 0,
})
const lastUsage = (stream) => {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}
const usageOf = (event) => {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/attempt' && event.type !== 'assistant/message') return undefined
  return lastUsage(event.data.stream)
}

const totals = zero()
let last = null
let settlementSamples = 0
for (const event of events) {
  if (event.type === 'llm/retry-started') {
    if (last !== null && last.turn === event.data.turn && last.step === event.data.step) last = null
    continue
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
  const usage = usageOf(event)
  if (usage === undefined) continue
  settlementSamples += 1
  const buckets = bucketsOf(usage)
  const previous = last !== null && last.turn === event.data.turn && last.step === event.data.step ? last.buckets : null
  for (const name of Object.keys(totals)) totals[name] += buckets[name] - (previous?.[name] ?? 0)
  last = { turn: event.data.turn, step: event.data.step, buckets }
}

assert.equal(view.tokens.input, totals.input, 'uncached input matches the tokenUsage fold')
assert.equal(view.tokens.cacheRead, totals.cacheRead, 'cache read matches the tokenUsage fold')
assert.equal(view.tokens.cacheWrite, totals.cacheWrite, 'cache write matches the tokenUsage fold')
assert.equal(view.tokens.output, totals.output, 'output matches the tokenUsage fold')

const sumBuckets = (buckets) => buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output + buckets.reasoning
assert.equal(view.micros, view.peakMicros + view.offPeakMicros, 'bands add up')
assert.equal(view.micros, sumBuckets(view.bucketMicros), 'per-factor costs add up')
assert.equal(view.micros, view.models.reduce((sum, model) => sum + model.micros, 0), 'per-model costs add up')
assert.equal(view.calls, view.peak.calls + view.offPeak.calls, 'call counts split by band')
assert.ok(view.calls > 100, 'the fixture billed many requests')
assert.ok(view.micros > 0, 'the replay prices the session')
assert.equal(view.unpricedCalls, 0, 'the official card prices the shipped route')
assert.equal(view.estimatedCalls, 0, 'the exact model entry matches')
assert.equal(view.pricing.version, 'config', 'an offline catalog uses the configured card')
assert.deepEqual(view.pricing.peakWindows, [[60, 240], [360, 600]])

const roundTrip = JSON.parse(JSON.stringify(view))
assert.deepEqual(roundTrip, view, 'the wire value is plain JSON')

assert.ok(view.calls <= settlementSamples + events.filter((event) => event.type === 'assistant/message').length, 'attempts can add calls, never lose them')
assert.equal(view.models.length, 1, 'one model in this fixture')
assert.equal(JSON.stringify(state).includes('micros'), false, 'no money is persisted in projection state')

console.log('real-log replay: all assertions passed')
console.log(
  JSON.stringify(
    {
      calls: view.calls,
      peakCalls: view.peak.calls,
      offPeakCalls: view.offPeak.calls,
      micros: view.micros,
      currency: view.currency,
      peakMicros: view.peakMicros,
      offPeakMicros: view.offPeakMicros,
      savedMicros: view.savedMicros,
      tokens: view.tokens,
    },
    null,
    2,
  ),
)
