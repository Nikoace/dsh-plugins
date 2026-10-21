// Deterministic offline regressions for review R1/R4. Only synthetic credentials
// and in-process HTTP responses are used; no network or real GitHub mutations.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, Config } from '../dsh-github/index.js'
import { resolveConfig } from '../dsh-github/lib/config.js'
import { createHttpClient } from '../dsh-github/lib/http.js'
import { createGithubTools } from '../dsh-github/lib/tools.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

// Attach the rejection handler immediately, before driving another async step.
const settled = (promise) => promise.then(value => ({ value }), error => ({ error }))
const response = (value, remaining = 50) => new Response(JSON.stringify(value), {
  headers: { etag: '"synthetic-etag"', 'x-ratelimit-remaining': String(remaining) },
})
function rejected(result, pattern) {
  assert.ok(result.error, 'operation must reject')
  assert.match(result.error.message, pattern)
}

function httpFixture(fetchImpl) {
  let token = 'synthetic-A'
  const calls = []
  const client = createHttpClient(resolveConfig({ cacheTtlSeconds: 1 }, {}), {
    tokenProvider: async () => token,
    fetchImpl: (url, init) => {
      calls.push({ url, ...init })
      return fetchImpl(url, init, calls.length)
    },
  })
  return { client, calls, setToken: (value) => { token = value } }
}

for (const observeSwitch of [false, true]) {
  await test(`R1: A -> anonymous, switch ${observeSwitch ? 'observed by another request' : 'during body only'}`, async () => {
    const started = deferred()
    const finish = deferred()
    const { client, calls, setToken } = httpFixture((_url, _init, n) => {
      if (n !== 1) return response({ private: false }, 60)
      return { ok: true, status: 200, headers: new Headers({ etag: '"private"', 'x-ratelimit-remaining': '1' }),
        text: async () => { started.resolve(); await finish.promise; return '{"private":true}' } }
    })
    const old = settled(client.json('/private'))
    await started.promise
    setToken('')
    if (observeSwitch) await client.json('/public')
    finish.resolve()
    const result = await old
    const anonymous = await client.json('/private')
    assert.equal(anonymous.fromCache, false)
    assert.equal(anonymous.data.private, false)
    assert.equal(calls.at(-1).headers.Authorization, undefined)
    rejected(result, /credential.*changed/i)
    assert.equal(client.rateLimit().remaining, 60)
  })
}

await test('R1: A -> B -> A never lets the first A overwrite the new A cache or rate limit', async () => {
  const started = deferred()
  const finish = deferred()
  const { client, setToken } = httpFixture(async (_url, _init, n) => {
    if (n === 1) { started.resolve(); await finish.promise; return response({ version: 'old-A' }, 1) }
    return response({ version: n === 2 ? 'B' : 'new-A' }, 49)
  })
  const old = settled(client.json('/private'))
  await started.promise
  setToken('synthetic-B')
  await client.json('/private')
  setToken('synthetic-A')
  await client.json('/private')
  finish.resolve()
  const result = await old
  const current = await client.json('/private')
  assert.equal(current.fromCache, true)
  assert.equal(current.data.version, 'new-A')
  assert.equal(client.rateLimit().remaining, 49)
  rejected(result, /credential.*changed/i)
})

for (const change of ['credential', 'cancel']) {
  await test(`R1: delayed 304 cannot reuse or refresh a cached body after ${change}`, async () => {
    const originalNow = Date.now
    let now = 1_000_000
    Date.now = () => now
    const started = deferred()
    const finish = deferred()
    const controller = new AbortController()
    try {
      const { client, calls, setToken } = httpFixture(async (_url, init, n) => {
        if (n === 2) {
          assert.equal(init.headers['If-None-Match'], '"synthetic-etag"')
          started.resolve()
          await finish.promise
          return new Response(null, { status: 304 })
        }
        return response({ version: n === 1 ? 'old-A' : 'current' })
      })
      await client.json('/private')
      now += 2_000
      const old = settled(client.json('/private', { signal: controller.signal }))
      await started.promise
      if (change === 'credential') { setToken(''); await client.json('/public') }
      else controller.abort()
      finish.resolve()
      const result = await old
      const current = await client.json('/private')
      assert.equal(current.fromCache, false, 'obsolete 304 must not refresh the TTL')
      assert.equal(current.data.version, 'current')
      if (change === 'credential') assert.equal(calls.at(-1).headers['If-None-Match'], undefined)
      rejected(result, change === 'credential' ? /credential.*changed/i : /cancelled/)
    } finally { Date.now = originalNow; finish.resolve() }
  })
}

await test('R1: cancelling a pending body cannot populate the cache even when transport ignores abort', async () => {
  const started = deferred()
  const finish = deferred()
  const controller = new AbortController()
  const { client } = httpFixture((_url, _init, n) => n !== 1 ? response({ fresh: true }) : {
    ok: true, status: 200, headers: new Headers({ etag: '"cancelled"' }),
    text: async () => { started.resolve(); await finish.promise; return '{"fresh":false}' },
  })
  const old = settled(client.json('/private', { signal: controller.signal }))
  await started.promise
  controller.abort()
  finish.resolve()
  const result = await old
  assert.equal(client.cacheSize(), 0)
  assert.equal((await client.json('/private')).data.fresh, true)
  rejected(result, /cancelled/)
})

await test('R1: an already-cancelled cache hit rejects without fetching', async () => {
  const { client, calls } = httpFixture(() => response({ private: true }))
  await client.json('/private')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(client.json('/private', { signal: controller.signal }), /cancelled/)
  assert.equal(calls.length, 1)
})

await test('R1: cancellation during credential lookup sends no request', async () => {
  const started = deferred()
  const finish = deferred()
  const controller = new AbortController()
  let calls = 0
  const client = createHttpClient(resolveConfig({}, {}), {
    tokenProvider: async () => { started.resolve(); return finish.promise },
    fetchImpl: () => { calls += 1; return response({}) },
  })
  const pending = settled(client.json('/private', { signal: controller.signal }))
  await started.promise
  controller.abort()
  finish.resolve('synthetic-A')
  const result = await pending
  assert.equal(calls, 0)
  rejected(result, /cancelled/)
})

await test('R1: an out-of-order credential lookup cannot restore the old token', async () => {
  const started = deferred()
  const finish = deferred()
  let token = 'synthetic-A'
  let lookups = 0
  const headers = []
  const client = createHttpClient(resolveConfig({}, {}), {
    tokenProvider: async () => {
      if (++lookups === 1) { started.resolve(); return finish.promise }
      return token
    },
    fetchImpl: (_url, init) => { headers.push(init.headers.Authorization); return response({}) },
  })
  const old = settled(client.json('/first'))
  await started.promise
  token = 'synthetic-B'
  await client.json('/second')
  finish.resolve('synthetic-A')
  await old
  assert.ok(headers.every(value => value === 'Bearer synthetic-B'), 'a superseded lookup must be rejected or resolved again')
})

// Minimal Host event seam. Its synchronous notifications model the documented
// loader/volatile-update and credentials/reference-updated commit notifications.
function context(services = {}) {
  const listeners = new Map()
  const registered = []
  return {
    registered,
    get: (name) => services[name],
    tools: { register: (tool) => registered.push(tool) },
    logger: { info() {}, warn() {} },
    inject() {},
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
    },
    emit(name, ...args) { for (const listener of listeners.get(name) ?? []) listener(...args) },
  }
}

for (const during of ['body', 'lookup']) {
  await test(`R1: Host notifications invalidate A -> B -> A during ${during} without an intervening request`, async () => {
    const originalFetch = globalThis.fetch
    const savedEnv = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN }
    const started = deferred()
    const finish = deferred()
    let calls = 0
    let lookups = 0
    let token = 'synthetic-A'
    const ctx = context({ credentials: { resolve: async () => {
      if (++lookups === 1 && during === 'lookup') { started.resolve(); await finish.promise }
      return { value: token }
    } } })
    try {
      delete process.env.GITHUB_TOKEN
      delete process.env.GH_TOKEN
      globalThis.fetch = async () => {
        calls += 1
        if (calls === 1 && during === 'body') { started.resolve(); await finish.promise }
        return response({ full_name: 'example/private', description: calls === 1 ? 'old' : 'new' })
      }
      apply(ctx, Config({}))
      const tool = ctx.registered.find(tool => tool.name === 'github_repo')
      const old = settled(tool.execute({ repo: 'example/private' }, {}))
      await started.promise
      token = 'synthetic-B'; ctx.emit('credentials/reference-updated', 'GITHUB_TOKEN')
      token = 'synthetic-A'; ctx.emit('credentials/reference-updated', 'GITHUB_TOKEN')
      finish.resolve()
      const result = await old
      if (during === 'body') {
        rejected(result, /credential.*changed/i)
        const current = await tool.execute({ repo: 'example/private' }, {})
        assert.equal(current.repo.description, 'new')
      } else {
        assert.ok(result.error || lookups > 1, 'lookup overlapping credential updates must be invalidated')
      }
    } finally {
      finish.resolve()
      globalThis.fetch = originalFetch
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
}

const writes = [
  ['github_create_issue', { repo: 'example/project', title: 'offline fixture' }],
  ['github_comment', { repo: 'example/project', number: 1, body: 'offline fixture' }],
  ['github_create_pull_request', { repo: 'example/project', title: 'offline fixture', head: 'feature', base: 'main' }],
]

for (const [name, args] of writes) {
  for (const phase of ['approval', 'credentials', 'credentials-without-approval']) {
    for (const change of ['disable', 'disable-enable', 'cancel', 'approval-policy']) {
      await test(`R4: ${name}, ${change} during ${phase}, sends zero POSTs`, async () => {
        const parsed = Config({ allowWrites: true, requireApproval: phase !== 'credentials-without-approval' })
        const config = resolveConfig(parsed, {})
        const started = deferred()
        const finish = deferred()
        const controller = new AbortController()
        let approvals = 0
        let posts = 0
        let lookups = 0
        const ctx = context({ approval: { request: async () => {
          approvals += 1
          if (phase === 'approval') { started.resolve(); await finish.promise }
          return 'allowed-once'
        } } })
        const client = createHttpClient(config, {
          tokenProvider: async () => {
            lookups += 1
            if (phase !== 'approval') { started.resolve(); await finish.promise }
            return 'synthetic-A'
          },
          fetchImpl: () => { posts += 1; return response({ number: 1, id: 1 }) },
        })
        const tool = createGithubTools({ config, client, ctx }).find(tool => tool.name === name)
        const pending = settled(tool.execute(args, { agent: {}, signal: controller.signal }))
        await started.promise
        const update = (field, value) => {
          parsed[field][Symbol.for('cosmokit.volatile.write')](value)
          ctx.emit('loader/volatile-update', [[field]])
        }
        if (change === 'cancel') controller.abort()
        else if (change === 'approval-policy') {
          update('requireApproval', !config.requireApproval)
          update('requireApproval', !config.requireApproval)
        } else {
          update('allowWrites', false)
          if (change === 'disable-enable') update('allowWrites', true)
        }
        finish.resolve()
        const result = await pending
        assert.equal(posts, 0, 'revoked operations must never reach the HTTP transport')
        rejected(result, change === 'cancel' ? /cancelled/ : /writes are disabled|policy.*changed/i)
        if (phase === 'approval') assert.equal(lookups, 0, 'reject immediately after approval')
        assert.equal(approvals, phase === 'credentials-without-approval' ? 0 : 1)
        // A new operation under the restored policy still works and gets its own approval.
        if (change === 'disable-enable') {
          await tool.execute(args, { agent: {} })
          assert.equal(posts, 1)
          assert.equal(approvals, phase === 'credentials-without-approval' ? 0 : 2)
        }
      })
    }
  }
}
