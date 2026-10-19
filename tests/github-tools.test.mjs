// Offline unit tests for the dsh-github Host plugin.
//
// Run from D:\hobby\dsh-plugins with: node tests/github-tools.test.mjs
// Zero dependencies: node:assert/strict, node:path, global fetch/Response,
// and the plugin's own internals export. No network access is performed.

import assert from 'node:assert/strict'
import path from 'node:path'
import { apply, internals } from '../dsh-github/index.js'

const {
  DEFAULT_CONFIG,
  GITHUB_CONTENT_NOTICE,
  resolveConfig,
  createHttpClient,
  createGithubTools,
  GitHubApiError,
  buildUrl,
  parseRateLimit,
  normalizeRepo,
  parseGitRemoteText,
  resolveRepo,
  clearRepoDetectionCache,
  assertArgs,
  validateValue,
} = internals

const EXPECTED_TOOLS = [
  'github_repo',
  'github_search',
  'github_issues',
  'github_issue',
  'github_pulls',
  'github_pull',
  'github_pull_diff',
  'github_commits',
  'github_file',
  'github_status',
  'github_create_issue',
  'github_comment',
  'github_create_pull_request',
]

const READ_TOOLS = [
  'github_repo',
  'github_search',
  'github_issues',
  'github_issue',
  'github_pulls',
  'github_pull',
  'github_pull_diff',
  'github_commits',
  'github_file',
]

const WRITE_TOOLS = ['github_create_issue', 'github_comment', 'github_create_pull_request']

const REPO = 'octo/hello'

// ---------------------------------------------------------------------------
// Minimal test runner: every case is awaited in order; a pass count is printed
// at the end and any failure sets a non-zero exit code.
// ---------------------------------------------------------------------------

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok ${passed} - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`not ok - ${name}`)
    console.error(error?.stack ?? String(error))
  }
}

/** Assert that `fn` rejects; return the error for further assertions. */
async function rejects(fn, expected) {
  let error
  try {
    await fn()
  } catch (caught) {
    error = caught
  }
  assert.ok(error !== undefined, `expected a rejection matching ${String(expected)}, but the call resolved`)
  if (expected instanceof RegExp) assert.match(error.message, expected)
  else assert.ok(error.message.includes(expected), `expected the message to include ${JSON.stringify(expected)}; got: ${error.message}`)
  return error
}

/** Assert rendered text contains a fragment, printing the text on failure. */
function includes(text, fragment) {
  assert.ok(text.includes(fragment), `expected rendered text to include ${JSON.stringify(fragment)}; got:\n${text.slice(0, 2_000)}`)
}

// ---------------------------------------------------------------------------
// HTTP and tool-harness fixtures
// ---------------------------------------------------------------------------

/** Build a real `Response` carrying JSON. */
function jsonResponse(data, options = {}) {
  return new Response(JSON.stringify(data), {
    status: options.status ?? 200,
    statusText: options.statusText,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
}

/** Build a real `Response` carrying raw text. */
function textResponse(body, options = {}) {
  return new Response(body, {
    status: options.status ?? 200,
    statusText: options.statusText,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...(options.headers ?? {}) },
  })
}

/** Wrap a base64 payload with GitHub's line breaks, to exercise whitespace stripping. */
function base64Wrapped(text) {
  const encoded = Buffer.from(text).toString('base64')
  return encoded.length > 16 ? `${encoded.slice(0, 16)}\n${encoded.slice(16)}\n` : encoded
}

/**
 * Route table helper. Keys are `"METHOD /pathname"` (a pathname beginning with
 * `^` is treated as a regular expression). Values are a `Response`, a function
 * returning one, or absent.
 */
function routerOf(table) {
  return (request) => {
    for (const [key, value] of Object.entries(table)) {
      const separator = key.indexOf(' ')
      const method = key.slice(0, separator)
      const pathPart = key.slice(separator + 1)
      if (request.method !== method) continue
      const matches = pathPart.startsWith('^') ? new RegExp(pathPart).test(request.parsed.pathname) : request.parsed.pathname === pathPart
      if (!matches) continue
      return typeof value === 'function' ? value(request) : value
    }
    throw new Error(`unexpected mock request: ${request.method} ${request.parsed.pathname}${request.parsed.search}`)
  }
}

/** Cordis-like context: captures registrations and serves named services. */
function fakeCtx({ approval, services = {}, logger } = {}) {
  const registered = []
  return {
    logger: logger ?? { info() {}, warn() {} },
    registered,
    get(name) {
      if (Object.hasOwn(services, name)) return services[name]
      if (name === 'approval') return approval
      return undefined
    },
    tools: {
      register(definition) {
        registered.push(definition)
      },
    },
  }
}

/** Approval service stub; records each request. */
function approvalStub(outcome) {
  const calls = []
  return {
    calls,
    async request(request) {
      calls.push(request)
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
}

/** Tool execution context for a session. */
function execFor(id = 'a') {
  return { agent: { id }, signal: new AbortController().signal }
}

/** Create a resolved config + HTTP client + tool definitions over mock fetch. */
function createHarness(rawConfig = {}, options = {}) {
  const config = resolveConfig(rawConfig, options.env ?? {})
  const calls = []
  const router = options.router ?? ((request) => {
    throw new Error(`unexpected fetch: ${request.method} ${request.url}`)
  })
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    const request = {
      url,
      parsed: new URL(url),
      method: init.method ?? 'GET',
      headers: { ...(init.headers ?? {}) },
      body: init.body,
      signal: init.signal,
      index: calls.length,
    }
    calls.push(request)
    const response = await router(request)
    if (!(response instanceof Response)) throw new Error(`mock route for ${url} did not return a Response`)
    return response
  }
  const ctx = fakeCtx({ approval: options.approval, services: options.services })
  const client = createHttpClient(config, { fetchImpl })
  const tools = createGithubTools({ config, client, ctx })
  const byName = new Map(tools.map((definition) => [definition.name, definition]))
  return { config, client, ctx, tools, byName, calls, fetchImpl }
}

/** Rendering evidence per tool name, checked by the aggregate tests at the end. */
const renderEvidence = new Map()

/** Execute one tool and render its value, enforcing the block contract. */
async function callTool(harness, name, args, exec = execFor()) {
  const definition = harness.byName.get(name)
  assert.ok(definition !== undefined, `tool ${name} is registered`)
  const value = await definition.execute(args, exec)
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} output.render returns at least one block`)
  for (const block of blocks) {
    assert.equal(block.type, 'text', `${name} render block type`)
    assert.equal(typeof block.text, 'string', `${name} render block text is a string`)
    assert.ok(block.text.trim().length > 0, `${name} render block is non-empty`)
  }
  const text = blocks.map((block) => block.text).join('\n')
  renderEvidence.set(name, text)
  return { value, blocks, text }
}

/** Run one tool that is expected to fail. */
async function callToolFails(harness, name, args, expected, exec = execFor()) {
  const definition = harness.byName.get(name)
  assert.ok(definition !== undefined, `tool ${name} is registered`)
  return rejects(() => definition.execute(args, exec), expected)
}

// ---------------------------------------------------------------------------
// Response fixtures
// ---------------------------------------------------------------------------

const REPO_FIXTURE = {
  full_name: REPO,
  name: 'hello',
  owner: { login: 'octo', type: 'User' },
  description: 'A demo repository for offline tests.',
  private: false,
  archived: false,
  fork: false,
  default_branch: 'main',
  language: 'JavaScript',
  stargazers_count: 42,
  forks_count: 7,
  open_issues_count: 3,
  subscribers_count: 11,
  topics: ['demo', 'testing'],
  license: { spdx_id: 'MIT', name: 'MIT License' },
  homepage: 'https://example.com/hello',
  html_url: 'https://github.com/octo/hello',
  visibility: 'public',
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  pushed_at: '2026-01-02T03:04:05Z',
}

const ISSUE_A = {
  number: 1,
  title: 'Crash on startup',
  state: 'open',
  user: { login: 'alice', html_url: 'https://github.com/alice', type: 'User' },
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'bob' }],
  milestone: { title: 'v1.0' },
  comments: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  html_url: 'https://github.com/octo/hello/issues/1',
  body: 'Steps to reproduce the crash.',
}

const ISSUE_PR = {
  number: 2,
  title: 'Add feature',
  state: 'open',
  user: { login: 'carol' },
  labels: [],
  assignees: [],
  updated_at: '2026-01-03T00:00:00Z',
  html_url: 'https://github.com/octo/hello/issues/2',
  pull_request: { url: 'https://api.github.com/repos/octo/hello/pulls/2' },
}

const COMMENT_FIXTURE = {
  id: 100,
  user: { login: 'bob', html_url: 'https://github.com/bob', type: 'User' },
  body: 'Confirmed on Windows.',
  created_at: '2026-01-02T01:00:00Z',
  updated_at: '2026-01-02T01:00:00Z',
  html_url: 'https://github.com/octo/hello/issues/1#issuecomment-100',
  author_association: 'MEMBER',
}

const PULL_FIXTURE = {
  number: 3,
  title: 'Add widget',
  state: 'open',
  draft: false,
  user: { login: 'carol' },
  labels: [{ name: 'enhancement' }],
  head: { ref: 'feature/widget', sha: 'abc123def456' },
  base: { ref: 'main' },
  comments: 2,
  review_comments: 1,
  commits: 1,
  additions: 12,
  deletions: 3,
  changed_files: 1,
  mergeable: true,
  mergeable_state: 'clean',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-05T00:00:00Z',
  merged_at: null,
  html_url: 'https://github.com/octo/hello/pull/3',
  body: 'Adds a widget.',
}

const PULL_FILE_FIXTURE = {
  filename: 'src/widget.js',
  status: 'modified',
  additions: 10,
  deletions: 2,
  changes: 12,
}

const COMMIT_FIXTURE = {
  sha: 'abcdef1234567890abcdef1234567890abcdef12',
  commit: {
    message: 'Add widget\n\nA longer explanation.',
    author: { name: 'Carol', date: '2026-01-05T00:00:00Z' },
  },
  author: { login: 'carol' },
  html_url: 'https://github.com/octo/hello/commit/abcdef1234567890abcdef1234567890abcdef12',
}

// ---------------------------------------------------------------------------
// 1. resolveConfig
// ---------------------------------------------------------------------------

await test('resolveConfig applies the documented defaults', () => {
  const config = resolveConfig(undefined, {})
  assert.equal(config.token, '')
  assert.equal(config.hasToken, false)
  assert.equal(config.tokenSource, 'none')
  for (const [key, expected] of Object.entries(DEFAULT_CONFIG)) {
    if (key === 'token') continue
    assert.deepEqual(config[key], expected, `default value for ${key}`)
  }
})

await test('resolveConfig token precedence: config > tokenEnv > GITHUB_TOKEN > GH_TOKEN', () => {
  const everything = { GITHUB_TOKEN: 'from-github-token', GH_TOKEN: 'from-gh-token', CORP_TOKEN: 'from-corp-token' }

  let config = resolveConfig({ token: 'from-config' }, everything)
  assert.equal(config.token, 'from-config')
  assert.equal(config.tokenSource, 'config')
  assert.equal(config.hasToken, true)

  config = resolveConfig({ tokenEnv: 'CORP_TOKEN' }, everything)
  assert.equal(config.token, 'from-corp-token')
  assert.equal(config.tokenSource, 'env:CORP_TOKEN')
  assert.equal(config.hasToken, true)

  config = resolveConfig({}, everything)
  assert.equal(config.token, 'from-github-token')
  assert.equal(config.tokenSource, 'env:GITHUB_TOKEN')

  config = resolveConfig({}, { GH_TOKEN: 'from-gh-token' })
  assert.equal(config.token, 'from-gh-token')
  assert.equal(config.tokenSource, 'env:GH_TOKEN')

  config = resolveConfig({}, {})
  assert.equal(config.token, '')
  assert.equal(config.tokenSource, 'none')
  assert.equal(config.hasToken, false)

  // A blank tokenEnv falls back to the default name rather than disabling env lookup.
  config = resolveConfig({ tokenEnv: '   ' }, { GITHUB_TOKEN: 'from-github-token' })
  assert.equal(config.tokenEnv, 'GITHUB_TOKEN')
  assert.equal(config.tokenSource, 'env:GITHUB_TOKEN')

  // Configured tokens are trimmed; a whitespace token counts as absent.
  assert.equal(resolveConfig({ token: '  abc  ' }, {}).token, 'abc')
  assert.equal(resolveConfig({ token: '   ' }, { GH_TOKEN: 'fallback' }).tokenSource, 'env:GH_TOKEN')
})

await test('resolveConfig validates apiBaseUrl', () => {
  assert.equal(resolveConfig({}, {}).apiBaseUrl, 'https://api.github.com')
  assert.equal(resolveConfig({ apiBaseUrl: 'https://api.github.com/' }, {}).apiBaseUrl, 'https://api.github.com')
  assert.equal(resolveConfig({ apiBaseUrl: 'https://ghe.example.com/api/v3/' }, {}).apiBaseUrl, 'https://ghe.example.com/api/v3')
  assert.equal(resolveConfig({ apiBaseUrl: '   ' }, {}).apiBaseUrl, 'https://api.github.com')
  assert.throws(() => resolveConfig({ apiBaseUrl: 'api.github.com' }, {}), /must be an absolute http\(s\) URL/)
  assert.throws(() => resolveConfig({ apiBaseUrl: 'ftp://example.com' }, {}), /must use http or https/)
  assert.throws(() => resolveConfig({ apiBaseUrl: 'https://user:pass@example.com' }, {}), /must not embed credentials/)
  assert.throws(() => resolveConfig({ apiBaseUrl: 'https://api.github.com?per_page=1' }, {}), /must not contain a query or fragment/)
  assert.throws(() => resolveConfig({ apiBaseUrl: 'https://api.github.com#fragment' }, {}), /must not contain a query or fragment/)
})

await test('resolveConfig clamps numeric settings and normalizes text settings', () => {
  assert.equal(resolveConfig({ requestTimeoutMs: 10 }, {}).requestTimeoutMs, 1_000)
  assert.equal(resolveConfig({ requestTimeoutMs: 10_000_000 }, {}).requestTimeoutMs, 300_000)
  assert.equal(resolveConfig({ requestTimeoutMs: '5000' }, {}).requestTimeoutMs, 20_000)
  assert.equal(resolveConfig({ cacheTtlSeconds: -10 }, {}).cacheTtlSeconds, 0)
  assert.equal(resolveConfig({ cacheTtlSeconds: 99_999 }, {}).cacheTtlSeconds, 3_600)
  assert.equal(resolveConfig({ maxOutputChars: 10 }, {}).maxOutputChars, 1_000)
  assert.equal(resolveConfig({ maxOutputChars: 10_000_000 }, {}).maxOutputChars, 400_000)
  assert.equal(resolveConfig({ toolTimeoutMs: 0 }, {}).toolTimeoutMs, 1_000)
  assert.equal(resolveConfig({ toolTimeoutMs: 10_000_000 }, {}).toolTimeoutMs, 600_000)
  assert.equal(resolveConfig({ apiVersion: '  ' }, {}).apiVersion, '2022-11-28')
  assert.equal(resolveConfig({ userAgent: '   ' }, {}).userAgent, 'dsh-github-plugin')
  assert.equal(resolveConfig({ defaultRepo: '  octo/hello  ' }, {}).defaultRepo, 'octo/hello')
  assert.equal(resolveConfig({ detectRepoFromGit: 'yes' }, {}).detectRepoFromGit, true)
  assert.equal(resolveConfig({ detectRepoFromGit: false }, {}).detectRepoFromGit, false)
  assert.equal(resolveConfig({ allowWrites: true }, {}).allowWrites, true)
  assert.equal(resolveConfig({ requireApproval: false }, {}).requireApproval, false)
})

await test('resolveConfig validates and normalizes defaultRepo', () => {
  assert.equal(resolveConfig({}, {}).defaultRepo, '')
  assert.equal(resolveConfig({ defaultRepo: '  octo/hello  ' }, {}).defaultRepo, 'octo/hello')
  assert.equal(resolveConfig({ defaultRepo: 'https://github.com/octo/hello.git' }, {}).defaultRepo, 'octo/hello')
  assert.throws(() => resolveConfig({ defaultRepo: 'not-a-repository' }, {}), /defaultRepo must be "owner\/name"/)
  assert.throws(() => resolveConfig({ defaultRepo: 'octo' }, {}), /defaultRepo must be "owner\/name"/)
})

// ---------------------------------------------------------------------------
// 2. Tool registration
// ---------------------------------------------------------------------------

await test('apply registers exactly the 13 documented github tools', () => {
  const ctx = fakeCtx()
  apply(ctx, { token: 'test-token' })
  assert.equal(ctx.registered.length, 13)
  assert.deepEqual(ctx.registered.map((definition) => definition.name).sort(), [...EXPECTED_TOOLS].sort())
  assert.equal(new Set(ctx.registered.map((definition) => definition.name)).size, 13)
})

await test('every tool definition exposes the execute/parameters/output contract', () => {
  const harness = createHarness({ token: 'test-token' })
  assert.equal(harness.tools.length, 13)
  for (const name of EXPECTED_TOOLS) {
    const definition = harness.byName.get(name)
    assert.ok(definition !== undefined, `${name} is registered`)
    assert.equal(typeof definition.execute, 'function', `${name}.execute`)
    assert.equal(definition.parameters?.type, 'object', `${name}.parameters is object-rooted`)
    assert.equal(definition.output?.schema?.type, 'object', `${name}.output.schema is object-rooted`)
    assert.equal(typeof definition.output.render, 'function', `${name}.output.render`)
    assert.equal(typeof definition.isConcurrencySafe, 'function', `${name}.isConcurrencySafe`)
    assert.ok(definition.timeoutMs >= 1_000, `${name}.timeoutMs`)
  }
  for (const name of WRITE_TOOLS) assert.equal(harness.byName.get(name).isConcurrencySafe(), false, `${name} is not concurrency safe`)
  for (const name of READ_TOOLS) assert.equal(harness.byName.get(name).isConcurrencySafe(), true, `${name} is concurrency safe`)
})

// ---------------------------------------------------------------------------
// 3. Request construction
// ---------------------------------------------------------------------------

await test('anonymous github_repo sends the documented headers and no Authorization', async () => {
  const harness = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}`]: () => jsonResponse(REPO_FIXTURE) }) })
  await callTool(harness, 'github_repo', { repo: REPO })
  assert.equal(harness.calls.length, 1)
  const request = harness.calls[0]
  assert.equal(request.url, `https://api.github.com/repos/${REPO}`)
  assert.equal(request.method, 'GET')
  assert.equal(request.headers.Accept, 'application/vnd.github+json')
  assert.equal(request.headers['X-GitHub-Api-Version'], '2022-11-28')
  assert.equal(request.headers['User-Agent'], 'dsh-github-plugin')
  assert.equal('Authorization' in request.headers, false)
  assert.equal(request.body, undefined)
})

await test('configured token, apiBaseUrl, apiVersion, and userAgent are used', async () => {
  const harness = createHarness(
    {
      token: 'ghp_secret',
      apiBaseUrl: 'https://ghe.example.com/api/v3/',
      apiVersion: '2024-01-01',
      userAgent: 'custom-agent/1.0',
    },
    { router: routerOf({ [`GET /api/v3/repos/${REPO}`]: () => jsonResponse(REPO_FIXTURE) }) },
  )
  await callTool(harness, 'github_repo', { repo: REPO })
  const request = harness.calls[0]
  assert.equal(request.url, `https://ghe.example.com/api/v3/repos/${REPO}`)
  assert.equal(request.headers.Authorization, 'Bearer ghp_secret')
  assert.equal(request.headers['X-GitHub-Api-Version'], '2024-01-01')
  assert.equal(request.headers['User-Agent'], 'custom-agent/1.0')
})

await test('github_issues builds documented query parameters', async () => {
  const harness = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/issues`]: () => jsonResponse([]) }) })
  await callTool(harness, 'github_issues', {
    repo: REPO,
    state: 'closed',
    labels: 'bug,help wanted',
    assignee: 'octocat',
    creator: 'alice',
    since: '2026-01-01T00:00:00Z',
    sort: 'updated',
    direction: 'asc',
    perPage: 5,
    page: 2,
  })
  const query = harness.calls[0].parsed.searchParams
  assert.equal(query.get('state'), 'closed')
  assert.equal(query.get('labels'), 'bug,help wanted')
  assert.equal(query.get('assignee'), 'octocat')
  assert.equal(query.get('creator'), 'alice')
  assert.equal(query.get('since'), '2026-01-01T00:00:00Z')
  assert.equal(query.get('sort'), 'updated')
  assert.equal(query.get('direction'), 'asc')
  assert.equal(query.get('per_page'), '5')
  assert.equal(query.get('page'), '2')
})

await test('github_search selects the documented endpoint and query for each type', async () => {
  const cases = [
    ['issues', '/search/issues', 'bug is:open'],
    ['pullRequests', '/search/issues', 'bug is:open is:pr'],
    ['repositories', '/search/repositories', 'bug is:open'],
    ['code', '/search/code', 'bug is:open'],
    ['users', '/search/users', 'bug is:open'],
  ]
  for (const [type, expectedPath, expectedQuery] of cases) {
    const harness = createHarness({}, { router: routerOf({ [`GET ${expectedPath}`]: () => jsonResponse({ total_count: 0, items: [] }) }) })
    await callTool(harness, 'github_search', { query: 'bug is:open', type })
    assert.equal(harness.calls[0].parsed.pathname, expectedPath, `${type} endpoint`)
    const query = harness.calls[0].parsed.searchParams
    assert.equal(query.get('q'), expectedQuery, `${type} query`)
    assert.equal(query.get('per_page'), '20')
    assert.equal(query.get('page'), '1')
    assert.equal(query.get('order'), 'desc')
    assert.equal(query.get('sort'), null)
  }

  // An explicit is:pr qualifier is not duplicated, and sort/order are forwarded.
  const harness = createHarness({}, { router: routerOf({ 'GET /search/issues': () => jsonResponse({ total_count: 0, items: [] }) }) })
  await callTool(harness, 'github_search', { query: 'bug is:pr', type: 'pullRequests', sort: 'updated', order: 'asc' })
  const query = harness.calls[0].parsed.searchParams
  assert.equal(query.get('q'), 'bug is:pr')
  assert.equal(query.get('sort'), 'updated')
  assert.equal(query.get('order'), 'asc')

  // The default search type is issues.
  const defaultHarness = createHarness({}, { router: routerOf({ 'GET /search/issues': () => jsonResponse({ total_count: 0, items: [] }) }) })
  await callTool(defaultHarness, 'github_search', { query: 'rocket' })
  assert.equal(defaultHarness.calls[0].parsed.searchParams.get('q'), 'rocket')
})

await test('github_pull_diff requests the diff media type and keeps raw text', async () => {
  const diff = 'diff --git a/src/a.js b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n'
  const harness = createHarness(
    {},
    { router: routerOf({ [`GET /repos/${REPO}/pulls/7`]: () => textResponse(diff, { headers: { 'content-type': 'text/plain' } }) }) },
  )
  const { value } = await callTool(harness, 'github_pull_diff', { repo: REPO, number: 7 })
  assert.equal(harness.calls[0].headers.Accept, 'application/vnd.github.diff')
  assert.equal(value.diff, diff)
  assert.equal(value.truncated, false)
})

await test('github_file encodes path segments and forwards the ref', async () => {
  const payload = { type: 'file', encoding: 'base64', size: 5, content: base64Wrapped('hello'), name: 'my file.md', path: 'docs/my file.md' }
  const harness = createHarness(
    {},
    { router: routerOf({ [`GET /repos/${REPO}/contents/docs/my%20file.md`]: () => jsonResponse(payload) }) },
  )
  await callTool(harness, 'github_file', { repo: REPO, path: '/docs/my file.md', ref: 'v1.0.0' })
  assert.equal(harness.calls[0].parsed.pathname, `/repos/${REPO}/contents/docs/my%20file.md`)
  assert.equal(harness.calls[0].parsed.searchParams.get('ref'), 'v1.0.0')
})

await test('github_commits maps ref/path/date filters onto query parameters', async () => {
  const harness = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/commits`]: () => jsonResponse([]) }) })
  await callTool(harness, 'github_commits', {
    repo: REPO,
    ref: 'dev',
    path: 'src/index.js',
    since: '2026-01-01T00:00:00Z',
    until: '2026-02-01T00:00:00Z',
    perPage: 3,
    page: 2,
  })
  const query = harness.calls[0].parsed.searchParams
  assert.equal(query.get('sha'), 'dev')
  assert.equal(query.get('path'), 'src/index.js')
  assert.equal(query.get('since'), '2026-01-01T00:00:00Z')
  assert.equal(query.get('until'), '2026-02-01T00:00:00Z')
  assert.equal(query.get('per_page'), '3')
  assert.equal(query.get('page'), '2')
})

await test('write requests POST a JSON body with Content-Type', async () => {
  const harness = createHarness(
    { allowWrites: true, requireApproval: false, token: 'ghp_secret' },
    { router: routerOf({ [`POST /repos/${REPO}/issues`]: () => jsonResponse({ number: 5, title: 'Report a bug', html_url: 'https://github.com/octo/hello/issues/5' }) }) },
  )
  await callTool(harness, 'github_create_issue', {
    repo: REPO,
    title: 'Report a bug',
    body: 'Details here.',
    labels: ['bug'],
    assignees: ['alice'],
  })
  const request = harness.calls[0]
  assert.equal(request.method, 'POST')
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.equal(request.headers.Accept, 'application/vnd.github+json')
  assert.deepEqual(JSON.parse(request.body), {
    title: 'Report a bug',
    body: 'Details here.',
    labels: ['bug'],
    assignees: ['alice'],
  })
})

await test('buildUrl joins absolute base URLs and encodes query arrays', () => {
  assert.equal(buildUrl('https://api.github.com', `/repos/${REPO}`), `https://api.github.com/repos/${REPO}`)
  assert.equal(
    buildUrl('https://api.github.com', '/search/issues', { q: 'rocket', labels: ['bug', 'ui'], empty: '', nothing: undefined }),
    'https://api.github.com/search/issues?q=rocket&labels=bug%2Cui',
  )
  assert.throws(() => buildUrl('https://api.github.com', `repos/${REPO}`), /expected a path starting with "\/"/)
  assert.throws(() => buildUrl('https://api.github.com', 'https://evil.example/x'), /expected a path starting with "\/"/)
})

// ---------------------------------------------------------------------------
// 4. Rendering
// ---------------------------------------------------------------------------

await test('github_repo renders repository facts with the untrusted-data notice', async () => {
  const harness = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}`]: () => jsonResponse(REPO_FIXTURE) }) })
  const { value, text } = await callTool(harness, 'github_repo', { repo: REPO })
  assert.equal(value.repo.fullName, REPO)
  assert.equal(value.repo.stars, 42)
  includes(text, GITHUB_CONTENT_NOTICE)
  includes(text, '## octo/hello')
  includes(text, 'stars: 42')
  includes(text, 'forks: 7')
  includes(text, 'open issues: 3')
  includes(text, 'license: MIT')
  includes(text, 'default branch: `main`')
  includes(text, 'A demo repository for offline tests.')
  includes(text, '[octo/hello](https://github.com/octo/hello)')
})

await test('github_search renders search results with the untrusted-data notice', async () => {
  const harness = createHarness(
    {},
    {
      router: routerOf({
        'GET /search/issues': () =>
          jsonResponse({ total_count: 2, incomplete_results: false, items: [ISSUE_A, ISSUE_PR] }),
      }),
    },
  )
  const { value, text } = await callTool(harness, 'github_search', { query: 'bug is:open' })
  assert.equal(value.type, 'issues')
  assert.equal(value.totalCount, 2)
  assert.equal(value.items.length, 2)
  includes(text, GITHUB_CONTENT_NOTICE)
  includes(text, '## issues search')
  includes(text, '#1 Crash on startup')
})

await test('github_issues excludes pull requests unless includePrs is true', async () => {
  const harness = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/issues`]: () => jsonResponse([ISSUE_A, ISSUE_PR]) }) })
  const { value, text } = await callTool(harness, 'github_issues', { repo: REPO })
  assert.equal(value.includePrs, false)
  assert.equal(value.items.length, 1)
  assert.equal(value.items[0].isPullRequest, false)
  includes(text, GITHUB_CONTENT_NOTICE)
  includes(text, 'excluding PRs')
  includes(text, '#1 Crash on startup')
  assert.ok(!text.includes('Add feature'), 'pull requests are filtered out by default')

  const withPrs = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/issues`]: () => jsonResponse([ISSUE_A, ISSUE_PR]) }) })
  const included = await callTool(withPrs, 'github_issues', { repo: REPO, includePrs: true })
  assert.equal(included.value.includePrs, true)
  assert.equal(included.value.items.length, 2)
  includes(included.text, 'Add feature')
})

await test('github_issue renders the body and comments, and honors comments:false', async () => {
  const harness = createHarness(
    {},
    {
      router: routerOf({
        [`GET /repos/${REPO}/issues/1`]: () => jsonResponse(ISSUE_A),
        [`GET /repos/${REPO}/issues/1/comments`]: () => jsonResponse([COMMENT_FIXTURE]),
      }),
    },
  )
  const { value, text } = await callTool(harness, 'github_issue', { repo: REPO, number: 1 })
  assert.equal(value.issue.number, 1)
  assert.equal(value.comments.length, 1)
  includes(text, GITHUB_CONTENT_NOTICE)
  includes(text, '## Issue octo/hello#1: Crash on startup')
  includes(text, 'Steps to reproduce the crash.')
  includes(text, 'Confirmed on Windows.')
  includes(text, '@bob')

  const onlyIssue = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/issues/1`]: () => jsonResponse(ISSUE_A) }) })
  const skipped = await callTool(onlyIssue, 'github_issue', { repo: REPO, number: 1, comments: false })
  assert.deepEqual(skipped.value.comments, [])
  assert.equal(onlyIssue.calls.length, 1)
  includes(skipped.text, 'comments were not requested')
})

await test('github_pulls renders the pull request list with branch flags', async () => {
  const harness = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/pulls`]: () => jsonResponse([PULL_FIXTURE]) }) })
  const { value, text } = await callTool(harness, 'github_pulls', { repo: REPO })
  assert.equal(value.items.length, 1)
  includes(text, GITHUB_CONTENT_NOTICE)
  includes(text, '## Pull requests in octo/hello')
  includes(text, '#3 Add widget')
  includes(text, 'feature/widget → main')
  includes(text, 'labels: enhancement')
})

await test('github_pull renders files and commits, and skips them on request', async () => {
  const harness = createHarness(
    {},
    {
      router: routerOf({
        [`GET /repos/${REPO}/pulls/3`]: () => jsonResponse(PULL_FIXTURE),
        [`GET /repos/${REPO}/pulls/3/files`]: () => jsonResponse([PULL_FILE_FIXTURE]),
        [`GET /repos/${REPO}/pulls/3/commits`]: () => jsonResponse([COMMIT_FIXTURE]),
      }),
    },
  )
  const { value, text } = await callTool(harness, 'github_pull', { repo: REPO, number: 3 })
  assert.equal(value.files.length, 1)
  assert.equal(value.commits.length, 1)
  includes(text, GITHUB_CONTENT_NOTICE)
  includes(text, '## Pull request octo/hello#3: Add widget')
  includes(text, 'changes: +12 / -3 across 1 files')
  includes(text, '`src/widget.js` (modified) +10 / -2')
  includes(text, '`abcdef123456` Add widget A longer explanation')

  const bare = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/pulls/3`]: () => jsonResponse(PULL_FIXTURE) }) })
  const skipped = await callTool(bare, 'github_pull', { repo: REPO, number: 3, includeFiles: false, includeCommits: false })
  assert.deepEqual(skipped.value.files, [])
  assert.deepEqual(skipped.value.commits, [])
  assert.equal(bare.calls.length, 1)
})

await test('github_pull_diff renders a fenced diff with the untrusted-data notice', async () => {
  const diff = 'diff --git a/src/a.js b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n'
  const harness = createHarness(
    {},
    { router: routerOf({ [`GET /repos/${REPO}/pulls/7`]: () => textResponse(diff) }) },
  )
  const { text } = await callTool(harness, 'github_pull_diff', { repo: REPO, number: 7 })
  includes(text, GITHUB_CONTENT_NOTICE)
  includes(text, '## Diff for octo/hello#7')
  includes(text, '````diff')
  includes(text, 'diff --git a/src/a.js b/src/a.js')
  assert.ok(!text.includes('exceeds the output budget'))
})

await test('github_commits renders commit short SHAs, messages, and authors', async () => {
  const harness = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/commits`]: () => jsonResponse([COMMIT_FIXTURE]) }) })
  const { value, text } = await callTool(harness, 'github_commits', { repo: REPO })
  assert.equal(value.items.length, 1)
  assert.equal(value.items[0].shortSha, 'abcdef123456')
  includes(text, GITHUB_CONTENT_NOTICE)
  includes(text, '## Commits in octo/hello')
  includes(text, '`abcdef123456`')
  includes(text, 'Add widget A longer explanation')
  includes(text, '@carol')
})

await test('github_file decodes one file and renders it as a fenced block', async () => {
  const source = 'export const answer = 42\n'
  const payload = {
    type: 'file',
    encoding: 'base64',
    size: Buffer.byteLength(source),
    content: base64Wrapped(source),
    name: 'answer.js',
    path: 'src/answer.js',
    sha: 'abc123',
    html_url: 'https://github.com/octo/hello/blob/main/src/answer.js',
  }
  const harness = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/contents/src/answer.js`]: () => jsonResponse(payload) }) })
  const { value, text } = await callTool(harness, 'github_file', { repo: REPO, path: 'src/answer.js' })
  assert.equal(value.kind, 'file')
  assert.equal(value.content, source)
  assert.equal(value.truncated, false)
  includes(text, GITHUB_CONTENT_NOTICE)
  includes(text, '## `src/answer.js` in octo/hello')
  includes(text, '````js')
  includes(text, 'export const answer = 42')
})

await test('github_file lists directories with file and directory entries', async () => {
  const entries = [
    { name: 'answer.js', path: 'src/answer.js', type: 'file', size: 25, sha: 'a1', html_url: 'https://github.com/octo/hello/blob/main/src/answer.js' },
    { name: 'nested', path: 'src/nested', type: 'dir', size: 0, sha: 'b2', html_url: 'https://github.com/octo/hello/tree/main/src/nested' },
  ]
  const harness = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/contents/src`]: () => jsonResponse(entries) }) })
  const { value, text } = await callTool(harness, 'github_file', { repo: REPO, path: 'src', ref: 'main' })
  assert.equal(value.kind, 'directory')
  assert.equal(value.entries.length, 2)
  includes(text, GITHUB_CONTENT_NOTICE)
  includes(text, '## Directory `src` in octo/hello @ main')
  includes(text, '📄 [answer.js]')
  includes(text, '📁 [nested]')
})

await test('github_file caps directory listings at 1000 entries and flags the cut', async () => {
  const entries = Array.from({ length: 1_001 }, (_, index) => ({
    name: `f${index}`,
    path: `f${index}`,
    type: 'file',
    size: 0,
    sha: `s${index}`,
  }))
  const harness = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/contents/src`]: () => jsonResponse(entries) }) })
  const { value, text } = await callTool(harness, 'github_file', { repo: REPO, path: 'src' })
  assert.equal(value.kind, 'directory')
  assert.equal(value.entries.length, 1_000)
  assert.equal(value.entriesTruncated, true)
  includes(text, '_Only the first 1000 entries are shown._')
})

await test('github_file reports binary and too-large files instead of returning them', async () => {
  const binaryPayload = {
    type: 'file',
    encoding: 'base64',
    size: 5,
    content: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]).toString('base64'),
    name: 'logo.png',
    path: 'assets/logo.png',
    sha: 'd4',
  }
  const binaryHarness = createHarness(
    {},
    { router: routerOf({ [`GET /repos/${REPO}/contents/assets/logo.png`]: () => jsonResponse(binaryPayload) }) },
  )
  const binary = await callTool(binaryHarness, 'github_file', { repo: REPO, path: 'assets/logo.png' })
  assert.equal(binary.value.kind, 'binary')
  includes(binary.text, GITHUB_CONTENT_NOTICE)
  includes(binary.text, 'Binary file (5 bytes) — content is not shown.')

  const tooLargePayload = { type: 'file', encoding: 'none', size: 999_999, name: 'huge.bin', path: 'huge.bin', sha: 'e5' }
  const tooLargeHarness = createHarness(
    {},
    { router: routerOf({ [`GET /repos/${REPO}/contents/huge.bin`]: () => jsonResponse(tooLargePayload) }) },
  )
  const tooLarge = await callTool(tooLargeHarness, 'github_file', { repo: REPO, path: 'huge.bin' })
  assert.equal(tooLarge.value.kind, 'too-large')
  includes(tooLarge.text, 'too large for the GitHub contents API')
})

await test('github_file and github_pull_diff flag output truncation', async () => {
  const source = 'a'.repeat(1_500)
  const payload = {
    type: 'file',
    encoding: 'base64',
    size: source.length,
    content: base64Wrapped(source),
    name: 'big.txt',
    path: 'big.txt',
    sha: 'f6',
  }
  const fileHarness = createHarness(
    { maxOutputChars: 3_000 },
    { router: routerOf({ [`GET /repos/${REPO}/contents/big.txt`]: () => jsonResponse(payload) }) },
  )
  const file = await callTool(fileHarness, 'github_file', { repo: REPO, path: 'big.txt' })
  assert.equal(file.value.truncated, true)
  assert.equal(file.value.content.length, 1_000)
  includes(file.text, '_Content truncated to the output budget._')

  const bigDiff = 'diff --git a/big b/big\n' + '+line\n'.repeat(800)
  const diffHarness = createHarness(
    { maxOutputChars: 3_000 },
    { router: routerOf({ [`GET /repos/${REPO}/pulls/8`]: () => textResponse(bigDiff) }) },
  )
  const diff = await callTool(diffHarness, 'github_pull_diff', { repo: REPO, number: 8 })
  assert.equal(diff.value.truncated, true)
  assert.equal(diff.value.diff.length, 2_000)
  includes(diff.text, '_The diff exceeds the output budget and is truncated._')
})

await test('github_status reports the token connection without the untrusted-data notice', async () => {
  const reset = 1_900_000_000
  const harness = createHarness(
    { token: 'ghp_supersecret' },
    {
      router: routerOf({
        'GET /rate_limit': () => jsonResponse({ resources: { core: { limit: 5_000, remaining: 4_999, used: 1, reset } } }),
        'GET /user': () =>
          jsonResponse(
            { login: 'octocat', name: 'The Octocat', html_url: 'https://github.com/octocat', type: 'User' },
            { headers: { 'x-oauth-scopes': 'repo, read:org' } },
          ),
      }),
    },
  )
  const { value, text } = await callTool(harness, 'github_status', {})
  assert.equal(value.authenticated, true)
  assert.equal(value.tokenSource, 'config')
  assert.equal(value.user.login, 'octocat')
  assert.deepEqual(value.scopes, ['repo', 'read:org'])
  assert.equal(value.rateLimit.limit, 5_000)
  assert.equal(value.rateLimit.remaining, 4_999)
  assert.equal(value.rateLimit.resetAt, new Date(reset * 1_000).toISOString())
  assert.equal(harness.calls.length, 2)
  assert.ok(!text.includes(GITHUB_CONTENT_NOTICE), 'status carries no untrusted-content notice')
  includes(text, '## GitHub connection status')
  includes(text, 'authenticated: yes (token from config)')
  includes(text, 'token scopes: repo, read:org')
  includes(text, 'writes: disabled (read-only)')
  assert.ok(!text.includes('ghp_supersecret'), 'the token value never appears in rendered output')
  assert.ok(!JSON.stringify(value).includes('ghp_supersecret'), 'the token value never appears in the tool value')
})

await test('github_status reports anonymous mode without calling /user', async () => {
  const harness = createHarness(
    {},
    {
      router: routerOf({
        'GET /rate_limit': () => jsonResponse({ resources: { core: { limit: 60, remaining: 60, used: 0, reset: 1_900_000_000 } } }),
      }),
    },
  )
  const { value, text } = await callTool(harness, 'github_status', {})
  assert.equal(value.authenticated, false)
  assert.equal(value.user, null)
  assert.deepEqual(value.scopes, [])
  assert.equal(harness.calls.length, 1)
  assert.ok(!text.includes(GITHUB_CONTENT_NOTICE))
  includes(text, 'authenticated: no (anonymous, 60 requests/hour)')
  includes(text, 'rate limit: 60/60 remaining')
})

await test('github_status surfaces a token-check failure without failing the tool', async () => {
  const harness = createHarness(
    { token: 'ghp_expired' },
    {
      router: routerOf({
        'GET /rate_limit': () => jsonResponse({ resources: { core: { limit: 60, remaining: 59, used: 1, reset: 1_900_000_000 } } }),
        'GET /user': () => jsonResponse({ message: 'Bad credentials' }, { status: 401, statusText: 'Unauthorized' }),
      }),
    },
  )
  const { value, text } = await callTool(harness, 'github_status', {})
  assert.equal(value.authenticated, true)
  assert.equal(value.user, null)
  assert.match(value.authError, /check the configured GitHub token/)
  includes(text, 'token check failed:')
  includes(text, 'check the configured GitHub token')
  assert.ok(!text.includes('ghp_expired'), 'the token value never appears in rendered output')
})

// ---------------------------------------------------------------------------
// 5. Writes and approval
// ---------------------------------------------------------------------------

await test('writes are rejected before any fetch when allowWrites is false', async () => {
  const cases = [
    ['github_create_issue', { repo: REPO, title: 'A title' }],
    ['github_comment', { repo: REPO, number: 1, body: 'A comment' }],
    ['github_create_pull_request', { repo: REPO, title: 'A title', head: 'feature', base: 'main' }],
  ]
  for (const [name, args] of cases) {
    const harness = createHarness({ allowWrites: false, requireApproval: false }, { router: () => jsonResponse({}) })
    await callToolFails(harness, name, args, /GitHub writes are disabled/)
    assert.equal(harness.calls.length, 0, `${name} performed no request`)
  }
})

await test('approval is requested once and allowed-once proceeds with the write', async () => {
  const approval = approvalStub('allowed-once')
  const harness = createHarness(
    { allowWrites: true, token: 'ghp_secret' },
    {
      approval,
      router: routerOf({
        [`POST /repos/${REPO}/issues`]: () =>
          jsonResponse({ number: 5, title: 'Report a bug', html_url: 'https://github.com/octo/hello/issues/5' }),
      }),
    },
  )
  const exec = execFor()
  const { value, text } = await callTool(harness, 'github_create_issue', { repo: REPO, title: 'Report a bug' }, exec)
  assert.equal(approval.calls.length, 1)
  const request = approval.calls[0]
  assert.equal(request.agent, exec.agent)
  assert.equal(request.toolName, 'github_create_issue')
  assert.match(request.reason, /GitHub: create issue "Report a bug" in octo\/hello/)
  assert.equal(request.displayReason.en, request.reason)
  assert.match(request.displayReason.zh, /octo\/hello/)
  assert.equal(request.signal, exec.signal)
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.calls[0].method, 'POST')
  assert.equal(value.action, 'created-issue')
  assert.equal(value.number, 5)
  includes(text, 'Created issue')
  includes(text, 'Report a bug')
  assert.ok(!text.includes(GITHUB_CONTENT_NOTICE), 'write confirmations carry no content notice')
})

await test('approval outcomes other than allowed-once reject without a request', async () => {
  for (const outcome of ['rejected', 'unavailable']) {
    const approval = approvalStub(outcome)
    const harness = createHarness(
      { allowWrites: true },
      { approval, router: () => jsonResponse({ number: 1, html_url: 'https://github.com/octo/hello/issues/1' }) },
    )
    await callToolFails(harness, 'github_create_issue', { repo: REPO, title: 'A title' }, new RegExp(`not approved \\(${outcome}\\)`))
    assert.equal(approval.calls.length, 1)
    assert.equal(harness.calls.length, 0, `no fetch for ${outcome}`)
  }
})

await test('approval errors and a missing approval service reject cleanly', async () => {
  const throwing = createHarness(
    { allowWrites: true },
    { approval: approvalStub(new Error('boom')), router: () => jsonResponse({}) },
  )
  await callToolFails(throwing, 'github_create_issue', { repo: REPO, title: 'A title' }, /GitHub write approval failed: boom/)
  assert.equal(throwing.calls.length, 0)

  const noService = createHarness({ allowWrites: true }, { router: () => jsonResponse({}) })
  await callToolFails(noService, 'github_create_issue', { repo: REPO, title: 'A title' }, /no approval service/)
  assert.equal(noService.calls.length, 0)
})

await test('writes require an active agent for approval', async () => {
  const approval = approvalStub('allowed-once')
  const harness = createHarness({ allowWrites: true }, { approval, router: () => jsonResponse({}) })
  await callToolFails(harness, 'github_create_issue', { repo: REPO, title: 'A title' }, /require an active agent/, {
    signal: new AbortController().signal,
  })
  assert.equal(approval.calls.length, 0)
  assert.equal(harness.calls.length, 0)
})

await test('requireApproval:false proceeds without consulting the approval service', async () => {
  const approval = approvalStub('rejected')
  const harness = createHarness(
    { allowWrites: true, requireApproval: false, token: 'ghp_secret' },
    {
      approval,
      router: routerOf({
        [`POST /repos/${REPO}/issues/9/comments`]: () => jsonResponse({ id: 77, html_url: 'https://github.com/octo/hello/issues/9#issuecomment-77' }),
      }),
    },
  )
  const { value, text } = await callTool(harness, 'github_comment', { repo: REPO, number: 9, body: 'LGTM' })
  assert.equal(approval.calls.length, 0)
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(harness.calls[0].body), { body: 'LGTM' })
  assert.equal(value.action, 'created-comment')
  assert.equal(value.commentId, 77)
  includes(text, 'Added a comment')
})

await test('github_create_pull_request posts the documented payload and renders a confirmation', async () => {
  const harness = createHarness(
    { allowWrites: true, requireApproval: false, token: 'ghp_secret' },
    {
      router: routerOf({
        [`POST /repos/${REPO}/pulls`]: () =>
          jsonResponse({ number: 12, title: 'Add widget', html_url: 'https://github.com/octo/hello/pull/12', draft: true }),
      }),
    },
  )
  const { value, text } = await callTool(harness, 'github_create_pull_request', {
    repo: REPO,
    title: 'Add widget',
    head: 'feature/widget',
    base: 'main',
    body: 'Adds a widget.',
    draft: true,
    maintainerCanModify: false,
  })
  assert.deepEqual(JSON.parse(harness.calls[0].body), {
    title: 'Add widget',
    head: 'feature/widget',
    base: 'main',
    body: 'Adds a widget.',
    draft: true,
    maintainer_can_modify: false,
  })
  assert.equal(value.action, 'created-pull-request')
  assert.equal(value.number, 12)
  assert.equal(value.draft, true)
  includes(text, 'Created pull request')
  includes(text, 'feature/widget → main')
  includes(text, '(draft)')
  assert.ok(!text.includes(GITHUB_CONTENT_NOTICE))
})

await test('write requests are never served from the GET cache', async () => {
  let posts = 0
  const harness = createHarness(
    { allowWrites: true, requireApproval: false },
    {
      router: routerOf({
        [`POST /repos/${REPO}/issues`]: () => {
          posts += 1
          return jsonResponse({ number: 1, title: 'Same title', html_url: 'https://github.com/octo/hello/issues/1' })
        },
      }),
    },
  )
  await callTool(harness, 'github_create_issue', { repo: REPO, title: 'Same title' })
  await callTool(harness, 'github_create_issue', { repo: REPO, title: 'Same title' })
  assert.equal(posts, 2)
})

// ---------------------------------------------------------------------------
// 6. Error mapping
// ---------------------------------------------------------------------------

await test('404 becomes a GitHubApiError with status, path, and documentation link', async () => {
  const harness = createHarness(
    {},
    {
      router: routerOf({
        [`GET /repos/${REPO}`]: () =>
          jsonResponse(
            { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/repos/repos' },
            { status: 404, statusText: 'Not Found' },
          ),
      }),
    },
  )
  const error = await callToolFails(harness, 'github_repo', { repo: REPO }, /GitHub API 404 Not Found: Not Found/)
  assert.ok(error instanceof GitHubApiError)
  assert.equal(error.name, 'GitHubApiError')
  assert.equal(error.status, 404)
  assert.equal(error.method, 'GET')
  assert.equal(error.path, `/repos/${REPO}`)
  includes(error.message, 'https://docs.github.com/rest/repos/repos')
  includes(error.message, `(GET /repos/${REPO})`)
})

await test('401 explains the token problem', async () => {
  const harness = createHarness(
    { token: 'bad-token' },
    {
      router: routerOf({
        [`GET /repos/${REPO}`]: () => jsonResponse({ message: 'Bad credentials' }, { status: 401, statusText: 'Unauthorized' }),
      }),
    },
  )
  const error = await callToolFails(harness, 'github_repo', { repo: REPO }, /check the configured GitHub token/)
  assert.equal(error.status, 401)
  assert.equal(error.rateLimit, null)
})

await test('403 with an exhausted rate limit reports reset time and rate-limit facts', async () => {
  const reset = 1_900_000_000
  const harness = createHarness(
    {},
    {
      router: routerOf({
        [`GET /repos/${REPO}`]: () =>
          jsonResponse(
            { message: 'API rate limit exceeded for 203.0.113.1.' },
            {
              status: 403,
              statusText: 'Forbidden',
              headers: {
                'x-ratelimit-limit': '60',
                'x-ratelimit-remaining': '0',
                'x-ratelimit-used': '60',
                'x-ratelimit-reset': String(reset),
                'x-ratelimit-resource': 'core',
              },
            },
          ),
      }),
    },
  )
  const error = await callToolFails(harness, 'github_repo', { repo: REPO }, /GitHub API 403 Forbidden/)
  assert.equal(error.status, 403)
  assert.equal(error.rateLimit.remaining, 0)
  assert.equal(error.rateLimit.limit, 60)
  assert.equal(error.rateLimit.resource, 'core')
  assert.equal(error.rateLimit.resetAt, new Date(reset * 1_000).toISOString())
  includes(error.message, 'rate limit exhausted')
  includes(error.message, new Date(reset * 1_000).toISOString())
  assert.equal(harness.client.rateLimit().remaining, 0, 'the client remembers the last rate limit')

  // Without rate headers a 403 is reported plainly.
  const plain = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}`]: () => jsonResponse({ message: 'Forbidden' }, { status: 403 }) }) })
  const plainError = await callToolFails(plain, 'github_repo', { repo: REPO }, /GitHub API 403: Forbidden/)
  assert.equal(plainError.rateLimit, null)
  assert.ok(!plainError.message.includes('rate limit exhausted'))
})

await test('non-JSON success bodies in JSON mode become GitHubApiError', async () => {
  const harness = createHarness(
    {},
    { router: routerOf({ [`GET /repos/${REPO}`]: () => textResponse('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }) }) },
  )
  const error = await callToolFails(harness, 'github_repo', { repo: REPO }, /returned non-JSON content for GET/)
  assert.equal(error.status, 200)
  assert.equal(error.path, `/repos/${REPO}`)
})

await test('non-JSON error bodies fall back to a clipped body message', async () => {
  const harness = createHarness(
    {},
    { router: routerOf({ [`GET /repos/${REPO}`]: () => textResponse('Bad gateway from proxy', { status: 502, statusText: 'Bad Gateway' }) }) },
  )
  const error = await callToolFails(harness, 'github_repo', { repo: REPO }, /GitHub API 502 Bad Gateway/)
  includes(error.message, 'Bad gateway from proxy')
  assert.equal(error.status, 502)
})

await test('an empty JSON-mode body parses as null', async () => {
  const harness = createHarness({}, { router: routerOf({ 'GET /empty': () => new Response('', { status: 200 }) }) })
  const response = await harness.client.json('/empty')
  assert.equal(response.data, null)
  assert.equal(response.status, 200)
  assert.equal(response.fromCache, false)
})

await test('network failures and cancellation are mapped to readable errors', async () => {
  const network = createHarness({}, { router: () => { throw new TypeError('getaddrinfo ENOTFOUND api.github.com') } })
  const networkError = await rejects(() => network.client.json('/repos/octo/hello'), /GitHub request failed: getaddrinfo ENOTFOUND/)
  assert.ok(networkError instanceof GitHubApiError)

  const controller = new AbortController()
  controller.abort()
  const cancelled = createHarness({}, { router: () => { throw new Error('ignored by the client') } })
  await rejects(() => cancelled.client.json('/repos/octo/hello', { signal: controller.signal }), /GitHub request cancelled \(GET \/repos\/octo\/hello\)/)
})

await test('parseRateLimit reads the standard headers', () => {
  const reset = 1_900_000_000
  const rate = parseRateLimit(
    new Headers({
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-used': '60',
      'x-ratelimit-reset': String(reset),
      'x-ratelimit-resource': 'core',
    }),
  )
  assert.deepEqual(rate, {
    limit: 60,
    remaining: 0,
    used: 60,
    reset,
    resetAt: new Date(reset * 1_000).toISOString(),
    resource: 'core',
  })
  assert.equal(parseRateLimit(new Headers()), null)
})

// ---------------------------------------------------------------------------
// 7. GET ETag cache
// ---------------------------------------------------------------------------

await test('a fresh cached GET avoids a second fetch', async () => {
  let fetches = 0
  const harness = createHarness(
    {},
    {
      router: () => {
        fetches += 1
        return jsonResponse(REPO_FIXTURE, { headers: { etag: 'W/"v1"' } })
      },
    },
  )
  const first = await harness.client.json(`/repos/${REPO}`)
  const second = await harness.client.json(`/repos/${REPO}`)
  assert.equal(fetches, 1)
  assert.equal(first.fromCache, false)
  assert.equal(second.fromCache, true)
  assert.deepEqual(second.data, first.data)
  assert.equal(harness.client.cacheSize(), 1)
})

await test('an expired cache entry revalidates with If-None-Match and reuses the 304 body', async () => {
  const realNow = Date.now
  let now = 1_700_000_000_000
  Date.now = () => now
  try {
    let fetches = 0
    const harness = createHarness(
      { cacheTtlSeconds: 1 },
      {
        router: (request) => {
          fetches += 1
          if (request.headers['If-None-Match'] === undefined) return jsonResponse(REPO_FIXTURE, { headers: { etag: 'W/"v1"' } })
          return new Response(null, { status: 304 })
        },
      },
    )
    const first = await harness.client.json(`/repos/${REPO}`)
    assert.equal(first.fromCache, false)

    now += 2_000
    const second = await harness.client.json(`/repos/${REPO}`)
    assert.equal(fetches, 2)
    assert.equal(second.fromCache, true)
    assert.deepEqual(second.data, first.data)
    assert.equal(harness.calls[1].headers['If-None-Match'], 'W/"v1"')

    // The 304 refreshed the TTL, so the next call is served without a fetch.
    const third = await harness.client.json(`/repos/${REPO}`)
    assert.equal(fetches, 2)
    assert.equal(third.fromCache, true)
  } finally {
    Date.now = realNow
  }
})

await test('304 without a cached response is an error', async () => {
  const harness = createHarness({}, { router: () => new Response(null, { status: 304 }) })
  await rejects(() => harness.client.json(`/repos/${REPO}`), /304 without a cached response/)
})

await test('cacheTtlSeconds:0 disables the cache entirely', async () => {
  let fetches = 0
  const harness = createHarness(
    { cacheTtlSeconds: 0 },
    {
      router: () => {
        fetches += 1
        return jsonResponse(REPO_FIXTURE, { headers: { etag: `W/"v${fetches}"` } })
      },
    },
  )
  const first = await harness.client.json(`/repos/${REPO}`)
  const second = await harness.client.json(`/repos/${REPO}`)
  assert.equal(fetches, 2)
  assert.equal(first.fromCache, false)
  assert.equal(second.fromCache, false)
  assert.equal(harness.calls[1].headers['If-None-Match'], undefined)
  assert.equal(harness.client.cacheSize(), 0)
})

await test('cache keys include query parameters and can be bypassed with noCache', async () => {
  let fetches = 0
  const harness = createHarness(
    {},
    {
      router: () => {
        fetches += 1
        return jsonResponse([], { headers: { etag: `W/"q${fetches}"` } })
      },
    },
  )
  await callTool(harness, 'github_issues', { repo: REPO, state: 'open' })
  await callTool(harness, 'github_issues', { repo: REPO, state: 'closed' })
  await callTool(harness, 'github_issues', { repo: REPO, state: 'open' })
  assert.equal(fetches, 2)

  const bypass = await harness.client.json(`/repos/${REPO}/issues?state=open&per_page=20&page=1`, { noCache: true })
  assert.equal(bypass.fromCache, false)
})

await test('responses without an ETag are not cached', async () => {
  let fetches = 0
  const harness = createHarness(
    {},
    {
      router: () => {
        fetches += 1
        return jsonResponse(REPO_FIXTURE)
      },
    },
  )
  await harness.client.json(`/repos/${REPO}`)
  await harness.client.json(`/repos/${REPO}`)
  assert.equal(fetches, 2)
  assert.equal(harness.client.cacheSize(), 0)
})

// ---------------------------------------------------------------------------
// 8. Repository resolution
// ---------------------------------------------------------------------------

await test('normalizeRepo accepts documented repository references', () => {
  const cases = [
    ['octo/hello', 'octo/hello'],
    ['  octo/hello  ', 'octo/hello'],
    ['https://github.com/octo/hello', 'octo/hello'],
    ['https://github.com/octo/hello.git', 'octo/hello'],
    ['https://github.com/octo/hello/', 'octo/hello'],
    ['https://github.com/octo/hello/tree/main', 'octo/hello'],
    ['https://github.com/octo/hello?tab=readme', 'octo/hello'],
    ['git@github.com:octo/hello.git', 'octo/hello'],
    ['github.com/octo/hello', 'octo/hello'],
    ['www.github.com/octo/hello', 'octo/hello'],
    ['https://gitlab.com/octo/hello.git', 'octo/hello'],
    ['git://github.com/octo/hello.git', 'octo/hello'],
    ['octo/hello.git', 'octo/hello'],
    ['/octo/hello', 'octo/hello'],
    ['octo', ''],
    ['', ''],
    ['   ', ''],
    ['octo/', ''],
    ['octo/hello world', ''],
    ['octo/.', ''],
    ['octo/..', ''],
    ['https://github.com/octo/..', ''],
    ['https://github.com/octo', ''],
    ['./repo', ''],
    [null, ''],
    [42, ''],
  ]
  for (const [input, expected] of cases) {
    assert.equal(normalizeRepo(input), expected, `normalizeRepo(${JSON.stringify(input)})`)
  }
})

await test('parseGitRemoteText prefers the origin remote, then the first remote', () => {
  const mixed = [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "upstream"]',
    '\turl = https://github.com/upstream/fork.git',
    '\tfetch = +refs/heads/*:refs/remotes/upstream/*',
    '[remote "origin"]',
    '\turl = git@github.com:octo/hello.git',
  ].join('\r\n')
  assert.equal(parseGitRemoteText(mixed), 'octo/hello')

  const originFirst = ['[remote "origin"]', '\turl = https://github.com/first/name', '[remote "upstream"]', '\turl = https://github.com/second/name'].join('\n')
  assert.equal(parseGitRemoteText(originFirst), 'first/name')

  const upstreamOnly = ['[remote "upstream"]', '\turl = https://github.com/second/name'].join('\n')
  assert.equal(parseGitRemoteText(upstreamOnly), 'second/name')

  assert.equal(parseGitRemoteText('[core]\n\tbare = false\n'), '')
  assert.equal(parseGitRemoteText(''), '')
  assert.equal(parseGitRemoteText(undefined), '')
})

await test('resolveRepo prefers the explicit repo over defaultRepo', async () => {
  const config = resolveConfig({ defaultRepo: 'default/repo' }, {})
  const repo = await resolveRepo({ repo: 'explicit/repo', config, ctx: fakeCtx(), exec: execFor(), signal: undefined })
  assert.equal(repo, 'explicit/repo')
  assert.equal(
    await resolveRepo({ repo: 'https://github.com/octo/hello.git', config, ctx: fakeCtx(), exec: execFor() }),
    'octo/hello',
  )
})

await test('resolveRepo falls back to defaultRepo without touching git detection', async () => {
  let ensured = 0
  const services = {
    workingDirectory: {
      async ensure() {
        ensured += 1
        return 'D:\\work\\repo'
      },
    },
    fs: {},
  }
  const config = resolveConfig({ defaultRepo: 'default/repo' }, {})
  const repo = await resolveRepo({ config, ctx: fakeCtx({ services }), exec: execFor() })
  assert.equal(repo, 'default/repo')
  assert.equal(ensured, 0)
})

await test('resolveRepo rejects an invalid explicit repository', async () => {
  const config = resolveConfig({}, {})
  const error = await rejects(
    () => resolveRepo({ repo: 'not-a-repository', config, ctx: fakeCtx(), exec: execFor() }),
    /invalid repository "not-a-repository"/,
  )
  includes(error.message, 'expected owner/name or a GitHub repository URL')
})

await test('resolveRepo explains how to supply a repository when nothing resolves', async () => {
  const config = resolveConfig({ detectRepoFromGit: false }, {})
  await rejects(() => resolveRepo({ config, ctx: fakeCtx(), exec: execFor() }), /repository is required/)
  await rejects(() => resolveRepo({ config, ctx: fakeCtx(), exec: execFor() }), /defaultRepo in the dsh-github config/)
})

await test('resolveRepo detects the origin remote from the session checkout and caches it', async () => {
  clearRepoDetectionCache()
  const cwd = 'D:\\work\\repo'
  let reads = 0
  const services = {
    workingDirectory: {
      async ensure() {
        return cwd
      },
    },
    fs: {
      async resolve(target) {
        return target
      },
      async readText(target) {
        reads += 1
        return target === path.join(cwd, '.git', 'config')
          ? '[remote "origin"]\n\turl = git@github.com:detected/repo.git\n'
          : ''
      },
    },
  }
  const config = resolveConfig({}, {})
  const ctx = fakeCtx({ services })
  try {
    assert.equal(await resolveRepo({ config, ctx, exec: execFor() }), 'detected/repo')
    assert.equal(reads, 1)
    assert.equal(await resolveRepo({ config, ctx, exec: execFor() }), 'detected/repo')
    assert.equal(reads, 1, 'the detection result is cached briefly')
    clearRepoDetectionCache()
    assert.equal(await resolveRepo({ config, ctx, exec: execFor() }), 'detected/repo')
    assert.equal(reads, 2, 'clearing the cache forces a re-read')
  } finally {
    clearRepoDetectionCache()
  }
})

await test('resolveRepo follows a linked-worktree .git pointer to the main config', async () => {
  clearRepoDetectionCache()
  const cwd = 'D:\\work\\repo'
  const mainConfig = path.join(path.dirname(cwd), 'main', '.git', 'config')
  const services = {
    workingDirectory: {
      async ensure() {
        return cwd
      },
    },
    fs: {
      async resolve(target) {
        return target
      },
      async readText(target) {
        if (target === path.join(cwd, '.git', 'config')) return ''
        if (target === path.join(cwd, '.git')) return 'gitdir: ../main/.git/worktrees/wt\n'
        if (target === mainConfig) return '[remote "origin"]\n\turl = https://github.com/worktree/repo.git\n'
        return ''
      },
    },
  }
  const config = resolveConfig({}, {})
  try {
    assert.equal(await resolveRepo({ config, ctx: fakeCtx({ services }), exec: execFor() }), 'worktree/repo')
  } finally {
    clearRepoDetectionCache()
  }
})

await test('resolveRepo degrades to the actionable error when detection is unavailable', async () => {
  clearRepoDetectionCache()
  try {
    const config = resolveConfig({}, {})
    await rejects(() => resolveRepo({ config, ctx: fakeCtx(), exec: execFor() }), /repository is required/)
    await rejects(() => resolveRepo({ config, ctx: fakeCtx(), exec: {} }), /repository is required/)
  } finally {
    clearRepoDetectionCache()
  }
})

// ---------------------------------------------------------------------------
// 9. Argument validation and clamping
// ---------------------------------------------------------------------------

await test('assertArgs reports every schema violation it finds', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { name: { type: 'string' }, count: { type: 'integer' } },
    required: ['name', 'count'],
  }
  assert.deepEqual(validateValue(schema, { name: 'x', count: 2 }), [])
  assert.throws(() => assertArgs(schema, {}), /invalid arguments: .*\.name is required.*\.count is required/)
  assert.throws(() => assertArgs(schema, { name: 7, count: 2 }), /\.name must be a string/)
  assert.throws(() => assertArgs(schema, { name: 'x', count: 1.5 }), /\.count must be an integer/)
  assert.throws(() => assertArgs(schema, { name: 'x', count: 2, extra: true }), /\.extra is not a supported argument/)
})

await test('tools reject invalid arguments before any request leaves the host', async () => {
  const harness = createHarness({}, { router: () => jsonResponse({}) })
  await callToolFails(harness, 'github_issue', {}, /invalid arguments: .*\.number is required/)
  await callToolFails(harness, 'github_issue', { repo: REPO, number: '4' }, /\.number must be an integer/)
  await callToolFails(harness, 'github_issue', { repo: REPO, number: 4, bogus: true }, /\.bogus is not a supported argument/)
  await callToolFails(harness, 'github_search', {}, /\.query is required/)
  await callToolFails(harness, 'github_search', { query: 'bug', type: 'nonsense' }, /must be one of/)
  await callToolFails(harness, 'github_issues', { repo: REPO, state: 'bogus' }, /must be one of/)
  await callToolFails(harness, 'github_create_issue', { repo: REPO }, /\.title is required/)
  await callToolFails(harness, 'github_create_issue', { repo: REPO, title: 'x', labels: [1] }, /\.labels\[0\] must be a string/)
  await callToolFails(harness, 'github_status', { verbose: true }, /\.verbose is not a supported argument/)
  assert.equal(harness.calls.length, 0)
})

await test('blank required strings and non-positive numbers are rejected', async () => {
  const harness = createHarness({ allowWrites: true, requireApproval: false }, { router: () => jsonResponse({}) })
  await callToolFails(harness, 'github_create_issue', { repo: REPO, title: '   ' }, /title must be a non-empty string/)
  await callToolFails(harness, 'github_comment', { repo: REPO, number: 1, body: '   ' }, /body must be a non-empty string/)
  await callToolFails(harness, 'github_issue', { repo: REPO, number: 0 }, /number must be a positive integer/)
  await callToolFails(harness, 'github_pull', { repo: REPO, number: 0 }, /number must be a positive integer/)
  await callToolFails(harness, 'github_pull_diff', { repo: REPO, number: 0 }, /number must be a positive integer/)
  await callToolFails(harness, 'github_comment', { repo: REPO, number: 0, body: 'x' }, /number must be a positive integer/)
  await callToolFails(harness, 'github_file', { repo: REPO, path: 'src/../secret' }, /path must not contain "\." or "\.\." segments/)
  assert.equal(harness.calls.length, 0)
})

await test('integer arguments clamp to their documented ranges', async () => {
  const harness = createHarness(
    {},
    {
      router: (request) => {
        if (request.parsed.pathname.endsWith('/issues')) return jsonResponse([])
        throw new Error(`unexpected ${request.url}`)
      },
    },
  )
  await callTool(harness, 'github_issues', { repo: REPO, perPage: 5_000, page: -3 })
  let query = harness.calls[harness.calls.length - 1].parsed.searchParams
  assert.equal(query.get('per_page'), '100')
  assert.equal(query.get('page'), '1')

  await callTool(harness, 'github_issues', { repo: REPO, perPage: 0 })
  query = harness.calls[harness.calls.length - 1].parsed.searchParams
  assert.equal(query.get('per_page'), '1')

  await callTool(harness, 'github_issues', { repo: REPO, page: 5_000 })
  query = harness.calls[harness.calls.length - 1].parsed.searchParams
  assert.equal(query.get('page'), '1000')
})

await test('commentLimit and pull file/commit limits clamp as documented', async () => {
  const commentHarness = createHarness(
    {},
    {
      router: routerOf({
        [`GET /repos/${REPO}/issues/4`]: () => jsonResponse(ISSUE_A),
        [`GET /repos/${REPO}/issues/4/comments`]: () => jsonResponse([]),
      }),
    },
  )
  await callTool(commentHarness, 'github_issue', { repo: REPO, number: 4, commentLimit: 500 })
  const commentsRequest = commentHarness.calls.find((request) => request.parsed.pathname.endsWith('/comments'))
  assert.equal(commentsRequest.parsed.searchParams.get('per_page'), '100')

  const pullHarness = createHarness(
    {},
    {
      router: routerOf({
        [`GET /repos/${REPO}/pulls/3`]: () => jsonResponse(PULL_FIXTURE),
        [`GET /repos/${REPO}/pulls/3/files`]: () => jsonResponse([]),
        [`GET /repos/${REPO}/pulls/3/commits`]: () => jsonResponse([]),
      }),
    },
  )
  await callTool(pullHarness, 'github_pull', { repo: REPO, number: 3, filesLimit: 1_000, commitsLimit: 1_000 })
  const filesRequest = pullHarness.calls.find((request) => request.parsed.pathname.endsWith('/files'))
  const commitsRequest = pullHarness.calls.find((request) => request.parsed.pathname.endsWith('/commits'))
  assert.equal(filesRequest.parsed.searchParams.get('per_page'), '100')
  assert.equal(commitsRequest.parsed.searchParams.get('per_page'), '100')
})

// ---------------------------------------------------------------------------
// Regression cases added after the independent review
// ---------------------------------------------------------------------------

await test('request timeout covers the response body, not just headers', async () => {
  const config = resolveConfig({ requestTimeoutMs: 1_000 }, {})
  let aborted = false
  const client = createHttpClient(config, {
    fetchImpl: async (_url, init) => ({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () =>
        new Promise((_resolve, reject) => {
          const signal = init.signal
          if (signal.aborted) {
            aborted = true
            reject(new Error('aborted'))
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('aborted'))
            },
            { once: true },
          )
        }),
    }),
  })
  const started = Date.now()
  await rejects(() => client.json('/repos/octo/hello'), /timed out after 1000 ms/)
  assert.ok(Date.now() - started < 5_000, 'the stalled body was cut off by the request deadline')
  assert.equal(aborted, true, 'the request signal was aborted while the body was pending')
})

await test('JSON and diff responses for the same pull URL do not share a cache entry', async () => {
  const harness = createHarness(
    {},
    {
      router: (request) =>
        request.headers.Accept === 'application/vnd.github.diff'
          ? textResponse('diff --git a/x b/x\n--- a/x\n+++ b/x\n')
          : jsonResponse(PULL_FIXTURE),
    },
  )
  await callTool(harness, 'github_pull', { repo: REPO, number: 3, includeFiles: false, includeCommits: false })
  const diff = await callTool(harness, 'github_pull_diff', { repo: REPO, number: 3 })
  assert.equal(harness.calls.length, 2, 'the diff was fetched instead of reusing the cached JSON')
  assert.equal(harness.calls[1].headers.Accept, 'application/vnd.github.diff')
  assert.match(diff.value.diff, /^diff --git/)
})

await test('github_issues hasMore follows the Link header and the unfiltered page', async () => {
  const linkHarness = createHarness(
    {},
    {
      router: routerOf({
        [`GET /repos/${REPO}/issues`]: () =>
          jsonResponse([ISSUE_PR], { headers: { link: `<https://api.github.com/repos/${REPO}/issues?page=2>; rel="next"` } }),
      }),
    },
  )
  const linked = await callTool(linkHarness, 'github_issues', { repo: REPO, perPage: 1 })
  assert.equal(linked.value.items.length, 0, 'the only page item was a PR and is filtered from items')
  assert.equal(linked.value.hasMore, true, 'the Link header still advertises another page')
  assert.match(linked.text, /page=2/)

  const fullHarness = createHarness({}, { router: routerOf({ [`GET /repos/${REPO}/issues`]: () => jsonResponse([ISSUE_PR]) }) })
  const full = await callTool(fullHarness, 'github_issues', { repo: REPO, perPage: 1 })
  assert.equal(full.value.hasMore, true, 'a full raw page implies another page even when PRs are filtered')
})

await test('an empty base64 file renders as an empty file instead of too-large', async () => {
  const harness = createHarness(
    {},
    {
      router: routerOf({
        [`GET /repos/${REPO}/contents/empty.txt`]: () =>
          jsonResponse({ type: 'file', name: 'empty.txt', path: 'empty.txt', size: 0, encoding: 'base64', content: '', html_url: 'https://github.com/octo/hello/blob/main/empty.txt' }),
      }),
    },
  )
  const file = await callTool(harness, 'github_file', { repo: REPO, path: 'empty.txt' })
  assert.equal(file.value.kind, 'file')
  assert.equal(file.value.content, '')
  assert.equal(file.value.truncated, false)
  includes(file.text, '````txt')
})

await test('a null user in a users search renders a fallback entry', async () => {
  const harness = createHarness(
    {},
    {
      router: routerOf({
        'GET /search/users': () => jsonResponse({ total_count: 1, incomplete_results: false, items: [null] }),
      }),
    },
  )
  const result = await callTool(harness, 'github_search', { query: 'nobody', type: 'users' })
  assert.equal(result.value.items[0], null)
  includes(result.text, 'unreadable user entry')
})

await test('clip respects its character budget and code fences outgrow embedded runs', async () => {
  assert.ok(internals.clip('x'.repeat(100), 40).length <= 40, 'clip never exceeds the budget')
  const content = 'before\n`````\nafter\n'
  const harness = createHarness(
    {},
    {
      router: routerOf({
        [`GET /repos/${REPO}/contents/snippet.md`]: () =>
          jsonResponse({ type: 'file', name: 'snippet.md', path: 'snippet.md', size: content.length, encoding: 'base64', content: base64Wrapped(content), html_url: 'https://github.com/octo/hello/blob/main/snippet.md' }),
      }),
    },
  )
  const file = await callTool(harness, 'github_file', { repo: REPO, path: 'snippet.md' })
  includes(file.text, '``````md')
  includes(file.text, '``````')
})

await test('apply registers scope-aware system-prompt guidance', () => {
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => (name === 'systemPrompt' ? { section: (options) => sections.push(options) } : undefined),
    tools: { register() {}, get: () => ({}) },
  }
  apply(ctx, {})
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:github')
  assert.equal(sections[0].order, 2_500)
  const text = sections[0].text({ scope: undefined })
  includes(text, 'untrusted')
  includes(text, 'github_pull_diff')
  const hidden = { ...ctx, tools: { register() {}, get: () => undefined } }
  const hiddenSections = []
  hidden.get = (name) => (name === 'systemPrompt' ? { section: (options) => hiddenSections.push(options) } : undefined)
  apply(hidden, {})
  assert.equal(hiddenSections[0].text({ scope: undefined }), '', 'the section is empty when no github tool is visible')
})

await test('a cancelled write approval fails closed with the outcome name', async () => {
  const harness = createHarness(
    { allowWrites: true, requireApproval: true },
    { approval: approvalStub('cancelled'), router: () => jsonResponse({}) },
  )
  await callToolFails(harness, 'github_comment', { repo: REPO, number: 1, body: 'hi' }, /not approved \(cancelled\)/)
  assert.equal(harness.calls.length, 0)
})

// ---------------------------------------------------------------------------
// Settings integration (Config → Host settings forms)
// ---------------------------------------------------------------------------

await test('Config exposes the editable settings as volatile references', () => {
  const parsed = internals.Config({})
  const volatile = []
  for (const [key, node] of Object.entries(parsed)) {
    if (node !== null && typeof node === 'object' && typeof node.get === 'function') volatile.push(key)
  }
  assert.deepEqual(volatile.sort(), [...internals.VOLATILE_FIELDS].sort())
  assert.equal(parsed.defaultRepo.get(), '')
  assert.equal(parsed.detectRepoFromGit.get(), true)
  assert.equal(parsed.allowWrites.get(), false)
  assert.equal(parsed.requireApproval.get(), true)
  assert.equal(parsed.requestTimeoutMs.get(), 20_000)
  assert.equal(parsed.cacheTtlSeconds.get(), 30)
  assert.equal(parsed.maxOutputChars.get(), 60_000)
  assert.equal(parsed.toolTimeoutMs, 60_000, 'ordinary fields stay plain values')
})

await test('the settings form projection selects exactly the volatile fields', () => {
  const schema = internals.Config
  /** Mirror of the Host settings service's `volatileForm` walk. */
  const volatileForm = (node) => {
    if (node?.meta?.volatile) return { type: 'json' }
    if (node?.type === 'object') {
      const dict = {}
      for (const [key, child] of Object.entries(node.dict ?? {})) {
        const field = volatileForm(child)
        if (field !== undefined) dict[key] = field
      }
      return Object.keys(dict).length > 0 ? { type: 'object', dict } : undefined
    }
    return undefined
  }
  const form = volatileForm(schema)
  assert.ok(form !== undefined, 'the Config projects a form')
  assert.deepEqual(Object.keys(form.dict).sort(), [...internals.VOLATILE_FIELDS].sort())
  const serialized = JSON.parse(JSON.stringify(schema.toJSON()))
  const root = serialized.refs?.[serialized.uid]
  assert.equal(root?.type, 'object', 'the serialized envelope rehydrates an object root')
  const resolveNode = (entry) => (typeof entry === 'number' ? serialized.refs[entry] : entry)
  const serializedVolatile = Object.entries(root.dict ?? {})
    .filter(([, entry]) => resolveNode(entry)?.meta?.volatile === true)
    .map(([key]) => key)
  assert.deepEqual(serializedVolatile.sort(), [...internals.VOLATILE_FIELDS].sort())
})

await test('a volatile settings write is visible without re-applying the plugin', () => {
  const write = Symbol.for('cosmokit.volatile.write')
  const parsed = internals.Config({})
  const writes = parsed.allowWrites
  const budget = parsed.maxOutputChars
  const config = resolveConfig({ allowWrites: writes, maxOutputChars: budget }, {})
  assert.equal(config.allowWrites, false)
  assert.equal(config.maxOutputChars, 60_000)
  writes[write](true)
  budget[write](12_345)
  assert.equal(config.allowWrites, true, 'the getter reads the updated reference')
  assert.equal(config.maxOutputChars, 12_345)
})

await test('a token provider is read per request and resets the response cache on change', async () => {
  const config = resolveConfig({}, {})
  const authorizations = []
  let token = 'token-one'
  const client = createHttpClient(config, {
    tokenProvider: async () => token,
    fetchImpl: async (_url, init) => {
      authorizations.push(init.headers.Authorization)
      return jsonResponse({ full_name: REPO }, { headers: { etag: '"token-etag"' } })
    },
  })
  await client.json(`/repos/${REPO}`)
  await client.json(`/repos/${REPO}`)
  assert.deepEqual(authorizations, ['Bearer token-one'], 'the cached GET did not re-fetch')
  token = 'token-two'
  await client.json(`/repos/${REPO}`)
  assert.deepEqual(authorizations, ['Bearer token-one', 'Bearer token-two'], 'a changed token cleared the cache and re-authenticated')
  assert.equal(await client.getToken(), 'token-two')
})

// ---------------------------------------------------------------------------
// Aggregate rendering evidence across the whole suite
// ---------------------------------------------------------------------------

await test('all 13 tools produced a non-empty rendering while testing', () => {
  for (const name of EXPECTED_TOOLS) {
    assert.ok(renderEvidence.has(name), `${name} was exercised and rendered`)
    assert.ok(renderEvidence.get(name).trim().length > 0, `${name} rendered text is non-empty`)
  }
})

await test('read renderings carry the untrusted-data notice; status and writes do not', () => {
  for (const name of READ_TOOLS) {
    assert.ok(renderEvidence.get(name).includes(GITHUB_CONTENT_NOTICE), `${name} carries the content notice`)
  }
  assert.ok(!renderEvidence.get('github_status').includes(GITHUB_CONTENT_NOTICE), 'github_status carries no content notice')
  for (const name of WRITE_TOOLS) {
    assert.ok(!renderEvidence.get(name).includes(GITHUB_CONTENT_NOTICE), `${name} confirmation carries no content notice`)
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = failures.length
console.log(`\ngithub-tools tests: ${passed} passed, ${failed} failed (${passed + failed} total)`)
if (failed > 0) process.exitCode = 1
