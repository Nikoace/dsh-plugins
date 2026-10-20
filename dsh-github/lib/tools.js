/**
 * Model-facing GitHub tools.
 *
 * Read tools are registered unconditionally and work anonymously for public
 * repositories. Write tools are registered too, but their bodies check
 * `allowWrites` and, when `requireApproval` is true, request per-call approval
 * before any request leaves the Host. Every tool declares an object-rooted
 * output value that `render` turns into Markdown.
 */

import { hasNextPage } from './http.js'
import { assertArgs, integerIn, optionalText, positiveInteger, requireText, stringArray } from './validate.js'
import { resolveRepo } from './repo.js'
import {
  compactComment,
  compactCommit,
  compactContentEntry,
  compactIssue,
  compactPull,
  compactPullFile,
  compactRepo,
  compactSearchItem,
  compactUser,
  renderCommits,
  renderDiff,
  renderFile,
  renderIssue,
  renderIssues,
  renderMutation,
  renderPull,
  renderPulls,
  renderRepo,
  renderSearch,
  renderStatus,
  textBlocks,
} from './format.js'

const SEARCH_TYPES = ['repositories', 'issues', 'pullRequests', 'code', 'users']
const ISSUE_STATES = ['open', 'closed', 'all']
const PULL_STATES = ['open', 'closed', 'all']
const DIRECTIONS = ['asc', 'desc']
const ISSUE_SORTS = ['created', 'updated', 'comments']
const PULL_SORTS = ['created', 'updated', 'popularity', 'long-running']

const REPO_PARAM = {
  type: 'string',
  description: 'Repository as "owner/name" or a GitHub URL. Omit to use the configured defaultRepo or the git origin of the session workspace.',
}
const PER_PAGE_PARAM = { type: 'integer', description: 'Results per page, 1-100 (default 20).' }
const PAGE_PARAM = { type: 'integer', description: 'Page number for pagination, starting at 1.' }

/**
 * Build an object parameter schema.
 *
 * @param {Record<string, object>} properties - parameter nodes.
 * @param {string[]} [required] - required names.
 * @returns {object} raw JSON Schema.
 */
function objectSchema(properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/**
 * Build the output declaration for one tool.
 *
 * @param {(value: object, maxOutputChars: number) => string} render - Markdown renderer.
 * @param {() => number} maxOutputChars - live output-budget getter.
 * @returns {{ schema: object, render: (args: unknown, value: any) => Array<{ type: 'text', text: string }> }} output declaration.
 */
function outputFor(render, maxOutputChars) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => textBlocks(render(value, maxOutputChars())),
  }
}

/**
 * Create every GitHub tool definition.
 *
 * @param {object} options - tool factory inputs.
 * @param {object} options.config - resolved plugin settings.
 * @param {object} options.client - GitHub HTTP client.
 * @param {object} options.ctx - plugin context.
 * @returns {object[]} tool definitions ready for `ctx.tools.register`.
 */
export function createGithubTools({ config, client, ctx }) {
  const maxOutputChars = () => config.maxOutputChars

  /**
   * Resolve the target repository for a call.
   *
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {object} exec - tool run context.
   * @returns {Promise<string>} `owner/name`.
   */
  const repoOf = (args, exec) =>
    resolveRepo({ repo: typeof args.repo === 'string' ? args.repo : undefined, config, ctx, exec, signal: exec.signal })

  /**
   * Read pagination arguments.
   *
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {number} [fallback] - default per-page size.
   * @returns {{ perPage: number, page: number }} pagination.
   */
  const pagination = (args, fallback = 20) => ({
    perPage: integerIn(args, 'perPage', fallback, 1, 100),
    page: integerIn(args, 'page', 1, 1, 1_000),
  })

  /**
   * Guard one write operation.
   *
   * @param {string} toolName - tool name shown to the approval UI.
   * @param {object} exec - tool run context.
   * @param {{ en: string, zh: string }} reason - bilingual approval reason.
   * @returns {Promise<void>}
   */
  const ensureWriteAllowed = async (toolName, exec, reason) => {
    if (!config.allowWrites) {
      throw new Error(
        'GitHub writes are disabled. Set allowWrites: true in the dsh-github plugin config (keep requireApproval: true so every write is confirmed) to enable ' + toolName + '.',
      )
    }
    if (!config.requireApproval) return
    let approval
    try {
      approval = ctx.get('approval')
    } catch {
      approval = undefined
    }
    if (approval === undefined) {
      throw new Error(
        'GitHub writes require approval, but this Harness has no approval service. No GitHub write request was sent. Restore the Harness approval service and retry, or keep writes disabled (allowWrites: false).',
      )
    }
    if (!exec.agent) throw new Error('GitHub writes require an active agent for the approval request.')
    let outcome
    try {
      outcome = await approval.request({
        agent: exec.agent,
        toolName,
        reason: reason.en,
        displayReason: { en: reason.en, zh: reason.zh },
        signal: exec.signal,
      })
    } catch (error) {
      throw new Error(`GitHub write approval failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (outcome !== 'allowed-once') throw new Error(`GitHub write was not approved (${outcome}); no change was made.`)
  }

  /**
   * Guard one write with the same repo/tool title every tool needs.
   *
   * @param {string} toolName - tool name.
   * @param {object} exec - tool run context.
   * @param {string} repo - target repository.
   * @param {string} action - action text, e.g. `create issue "title"`.
   * @returns {Promise<void>}
   */
  const guardWrite = (toolName, exec, repo, action) =>
    ensureWriteAllowed(toolName, exec, {
      en: `GitHub: ${action} in ${repo}`,
      zh: `GitHub：在 ${repo} ${action}`,
    })

  /** @type {object[]} */
  const tools = []

  // -------------------------------------------------------------------------
  // github_repo
  // -------------------------------------------------------------------------
  const repoParameters = objectSchema({ repo: REPO_PARAM })
  tools.push({
    name: 'github_repo',
    description:
      'Get metadata for a GitHub repository: description, default branch, language, stars, forks, open issue count, topics, license, and links. Read-only.',
    parameters: repoParameters,
    output: outputFor(renderRepo, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertArgs(repoParameters, args)
      const repo = await repoOf(args, exec)
      const response = await client.json(`/repos/${repo}`, { signal: exec.signal })
      return { repo: compactRepo(response.data) }
    },
  })

  // -------------------------------------------------------------------------
  // github_search
  // -------------------------------------------------------------------------
  const searchParameters = objectSchema(
    {
      query: { type: 'string', description: 'GitHub search query, using GitHub search syntax (qualifiers such as is:open, label:bug, repo:owner/name).' },
      type: { type: 'string', enum: SEARCH_TYPES, description: 'What to search: repositories, issues, pullRequests, code, or users (default issues).' },
      sort: { type: 'string', description: 'Optional sort field supported by the chosen search type (e.g. stars, updated, comments, created).' },
      order: { type: 'string', enum: DIRECTIONS, description: 'Sort direction: asc or desc (default desc).' },
      perPage: PER_PAGE_PARAM,
      page: PAGE_PARAM,
    },
    ['query'],
  )
  tools.push({
    name: 'github_search',
    description:
      'Search GitHub repositories, issues, pull requests, code, or users with GitHub search syntax. Code search requires an authenticated token. Read-only.',
    parameters: searchParameters,
    output: outputFor(renderSearch, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertArgs(searchParameters, args)
      const query = requireText(args, 'query')
      const type = SEARCH_TYPES.includes(args.type) ? args.type : 'issues'
      const { perPage, page } = pagination(args)
      const sort = optionalText(args, 'sort')
      const order = args.order === 'asc' ? 'asc' : 'desc'
      let path = '/search/issues'
      let effectiveQuery = query
      if (type === 'repositories') path = '/search/repositories'
      else if (type === 'code') path = '/search/code'
      else if (type === 'users') path = '/search/users'
      else if (type === 'pullRequests') {
        if (!/\b(?:is|type):pr\b/i.test(effectiveQuery)) effectiveQuery = `${effectiveQuery} is:pr`
      }
      const searchQuery = { q: effectiveQuery, per_page: perPage, page }
      if (sort.length > 0) searchQuery.sort = sort
      searchQuery.order = order
      const response = await client.json(path, { query: searchQuery, signal: exec.signal })
      const data = response.data ?? {}
      const items = Array.isArray(data.items) ? data.items : []
      const totalCount = typeof data.total_count === 'number' ? data.total_count : items.length
      return {
        type,
        query: effectiveQuery,
        totalCount,
        incompleteResults: data.incomplete_results === true,
        items: items.slice(0, perPage).map((item) => compactSearchItem(type, item)),
        perPage,
        page,
        hasMore: hasNextPage(response.headers) || page * perPage < totalCount,
      }
    },
  })

  // -------------------------------------------------------------------------
  // github_issues
  // -------------------------------------------------------------------------
  const issuesParameters = objectSchema({
    repo: REPO_PARAM,
    state: { type: 'string', enum: ISSUE_STATES, description: 'Issue state filter (default open).' },
    labels: { type: 'string', description: 'Comma-separated label names; all must match.' },
    assignee: { type: 'string', description: 'Login of an assigned user, or "none" for unassigned issues.' },
    creator: { type: 'string', description: 'Login of the issue author.' },
    since: { type: 'string', description: 'Only issues updated at or after this ISO 8601 timestamp.' },
    sort: { type: 'string', enum: ISSUE_SORTS, description: 'Sort field (default created).' },
    direction: { type: 'string', enum: DIRECTIONS, description: 'Sort direction (default desc).' },
    includePrs: { type: 'boolean', description: 'Include pull requests, which the GitHub issues API returns by default. Default false.' },
    perPage: PER_PAGE_PARAM,
    page: PAGE_PARAM,
  })
  tools.push({
    name: 'github_issues',
    description:
      'List issues in a repository with state, label, assignee, creator, and date filters. Pull requests are excluded unless includePrs is true. Read-only.',
    parameters: issuesParameters,
    output: outputFor(renderIssues, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertArgs(issuesParameters, args)
      const repo = await repoOf(args, exec)
      const { perPage, page } = pagination(args)
      const state = ISSUE_STATES.includes(args.state) ? args.state : 'open'
      const query = { state, per_page: perPage, page }
      const labels = optionalText(args, 'labels')
      if (labels.length > 0) query.labels = labels
      const assignee = optionalText(args, 'assignee')
      if (assignee.length > 0) query.assignee = assignee
      const creator = optionalText(args, 'creator')
      if (creator.length > 0) query.creator = creator
      const since = optionalText(args, 'since')
      if (since.length > 0) query.since = since
      if (ISSUE_SORTS.includes(args.sort)) query.sort = args.sort
      if (DIRECTIONS.includes(args.direction)) query.direction = args.direction
      const response = await client.json(`/repos/${repo}/issues`, { query, signal: exec.signal })
      const raw = Array.isArray(response.data) ? response.data : []
      const includePrs = args.includePrs === true
      const visible = includePrs ? raw : raw.filter((issue) => issue === null || typeof issue !== 'object' || issue.pull_request === undefined)
      return {
        repo,
        state,
        includePrs,
        items: visible.slice(0, perPage).map((issue) => compactIssue(issue)),
        perPage,
        page,
        hasMore: hasNextPage(response.headers) || raw.length >= perPage,
      }
    },
  })

  // -------------------------------------------------------------------------
  // github_issue
  // -------------------------------------------------------------------------
  const issueParameters = objectSchema(
    {
      repo: REPO_PARAM,
      number: { type: 'integer', description: 'Issue or pull request number.' },
      comments: { type: 'boolean', description: 'Include comments (default true).' },
      commentLimit: { type: 'integer', description: 'Maximum comments to include, 1-100 (default 20).' },
    },
    ['number'],
  )
  tools.push({
    name: 'github_issue',
    description:
      'Get one issue (or pull request as an issue) with its description, labels, assignees, milestone, and comments. Read-only.',
    parameters: issueParameters,
    output: outputFor(renderIssue, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertArgs(issueParameters, args)
      const repo = await repoOf(args, exec)
      const number = positiveInteger(args, 'number')
      const response = await client.json(`/repos/${repo}/issues/${number}`, { signal: exec.signal })
      const issue = compactIssue(response.data, 16_000)
      let comments = []
      if (args.comments !== false) {
        const limit = integerIn(args, 'commentLimit', 20, 1, 100)
        const commentsResponse = await client.json(`/repos/${repo}/issues/${number}/comments`, {
          query: { per_page: limit, page: 1 },
          signal: exec.signal,
        })
        const rawComments = Array.isArray(commentsResponse.data) ? commentsResponse.data : []
        comments = rawComments.slice(0, limit).map((comment) => compactComment(comment))
      }
      return { repo, issue, comments }
    },
  })

  // -------------------------------------------------------------------------
  // github_pulls
  // -------------------------------------------------------------------------
  const pullsParameters = objectSchema({
    repo: REPO_PARAM,
    state: { type: 'string', enum: PULL_STATES, description: 'Pull request state filter (default open).' },
    head: { type: 'string', description: 'Filter by head branch as "user:ref".' },
    base: { type: 'string', description: 'Filter by base branch.' },
    sort: { type: 'string', enum: PULL_SORTS, description: 'Sort field (default created).' },
    direction: { type: 'string', enum: DIRECTIONS, description: 'Sort direction (default desc).' },
    perPage: PER_PAGE_PARAM,
    page: PAGE_PARAM,
  })
  tools.push({
    name: 'github_pulls',
    description: 'List pull requests in a repository with state, branch, and sort filters. Read-only.',
    parameters: pullsParameters,
    output: outputFor(renderPulls, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertArgs(pullsParameters, args)
      const repo = await repoOf(args, exec)
      const { perPage, page } = pagination(args)
      const state = PULL_STATES.includes(args.state) ? args.state : 'open'
      const query = { state, per_page: perPage, page }
      const head = optionalText(args, 'head')
      if (head.length > 0) query.head = head
      const base = optionalText(args, 'base')
      if (base.length > 0) query.base = base
      if (PULL_SORTS.includes(args.sort)) query.sort = args.sort
      if (DIRECTIONS.includes(args.direction)) query.direction = args.direction
      const response = await client.json(`/repos/${repo}/pulls`, { query, signal: exec.signal })
      const raw = Array.isArray(response.data) ? response.data : []
      return {
        repo,
        state,
        items: raw.slice(0, perPage).map((pull) => compactPull(pull)),
        perPage,
        page,
        hasMore: hasNextPage(response.headers) || raw.length >= perPage,
      }
    },
  })

  // -------------------------------------------------------------------------
  // github_pull
  // -------------------------------------------------------------------------
  const pullParameters = objectSchema(
    {
      repo: REPO_PARAM,
      number: { type: 'integer', description: 'Pull request number.' },
      includeFiles: { type: 'boolean', description: 'Include changed files (default true).' },
      includeCommits: { type: 'boolean', description: 'Include commits (default true).' },
      filesLimit: { type: 'integer', description: 'Maximum changed files to include, 1-100 (default 100).' },
      commitsLimit: { type: 'integer', description: 'Maximum commits to include, 1-100 (default 50).' },
    },
    ['number'],
  )
  tools.push({
    name: 'github_pull',
    description:
      'Get one pull request with description, mergeability, changed files, and commits. Use github_pull_diff for the actual diff. Read-only.',
    parameters: pullParameters,
    output: outputFor(renderPull, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertArgs(pullParameters, args)
      const repo = await repoOf(args, exec)
      const number = positiveInteger(args, 'number')
      const response = await client.json(`/repos/${repo}/pulls/${number}`, { signal: exec.signal })
      const pull = compactPull(response.data, 16_000)
      const includeFiles = args.includeFiles !== false
      const includeCommits = args.includeCommits !== false
      const filesLimit = integerIn(args, 'filesLimit', 100, 1, 100)
      const commitsLimit = integerIn(args, 'commitsLimit', 50, 1, 100)
      const [filesResponse, commitsResponse] = await Promise.all([
        includeFiles
          ? client.json(`/repos/${repo}/pulls/${number}/files`, {
              query: { per_page: filesLimit, page: 1 },
              signal: exec.signal,
            })
          : Promise.resolve({ data: [] }),
        includeCommits
          ? client.json(`/repos/${repo}/pulls/${number}/commits`, {
              query: { per_page: commitsLimit, page: 1 },
              signal: exec.signal,
            })
          : Promise.resolve({ data: [] }),
      ])
      const files = Array.isArray(filesResponse.data) ? filesResponse.data.slice(0, filesLimit).map((file) => compactPullFile(file)) : []
      const commits = Array.isArray(commitsResponse.data) ? commitsResponse.data.slice(0, commitsLimit).map((commit) => compactCommit(commit)) : []
      return { repo, pull, files, commits }
    },
  })

  // -------------------------------------------------------------------------
  // github_pull_diff
  // -------------------------------------------------------------------------
  const diffParameters = objectSchema(
    {
      repo: REPO_PARAM,
      number: { type: 'integer', description: 'Pull request number.' },
    },
    ['number'],
  )
  tools.push({
    name: 'github_pull_diff',
    description: 'Get the unified diff of a pull request as text, for code review. Read-only.',
    parameters: diffParameters,
    output: outputFor(renderDiff, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertArgs(diffParameters, args)
      const repo = await repoOf(args, exec)
      const number = positiveInteger(args, 'number')
      const response = await client.text(`/repos/${repo}/pulls/${number}`, {
        accept: 'application/vnd.github.diff',
        signal: exec.signal,
      })
      const budget = Math.max(1_000, config.maxOutputChars - 1_000)
      const raw = response.text.length > 0 ? response.text : '(no diff returned)'
      return {
        repo,
        number,
        diff: raw.slice(0, budget),
        truncated: raw.length > budget,
      }
    },
  })

  // -------------------------------------------------------------------------
  // github_commits
  // -------------------------------------------------------------------------
  const commitsParameters = objectSchema({
    repo: REPO_PARAM,
    ref: { type: 'string', description: 'Branch name, tag, or commit SHA to start from (default branch).' },
    path: { type: 'string', description: 'Only commits touching this file or directory path.' },
    since: { type: 'string', description: 'Only commits after this ISO 8601 timestamp.' },
    until: { type: 'string', description: 'Only commits before this ISO 8601 timestamp.' },
    perPage: PER_PAGE_PARAM,
    page: PAGE_PARAM,
  })
  tools.push({
    name: 'github_commits',
    description: 'List commits in a repository or on a branch, optionally filtered by path and date. Read-only.',
    parameters: commitsParameters,
    output: outputFor(renderCommits, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertArgs(commitsParameters, args)
      const repo = await repoOf(args, exec)
      const { perPage, page } = pagination(args)
      const ref = optionalText(args, 'ref')
      const path = optionalText(args, 'path')
      const since = optionalText(args, 'since')
      const until = optionalText(args, 'until')
      const query = { per_page: perPage, page }
      if (ref.length > 0) query.sha = ref
      if (path.length > 0) query.path = path
      if (since.length > 0) query.since = since
      if (until.length > 0) query.until = until
      const response = await client.json(`/repos/${repo}/commits`, { query, signal: exec.signal })
      const raw = Array.isArray(response.data) ? response.data : []
      return {
        repo,
        ref,
        items: raw.slice(0, perPage).map((commit) => compactCommit(commit)),
        perPage,
        page,
        hasMore: hasNextPage(response.headers) || raw.length >= perPage,
      }
    },
  })

  // -------------------------------------------------------------------------
  // github_file
  // -------------------------------------------------------------------------
  const fileParameters = objectSchema({
    repo: REPO_PARAM,
    path: { type: 'string', description: 'File or directory path inside the repository; empty or omitted means the repository root.' },
    ref: { type: 'string', description: 'Branch, tag, or commit SHA (default branch).' },
  })
  tools.push({
    name: 'github_file',
    description:
      'Read one file (text, decoded from the GitHub contents API) or list a directory at a ref. Read-only; very large or binary files are reported instead of returned.',
    parameters: fileParameters,
    output: outputFor(renderFile, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertArgs(fileParameters, args)
      const repo = await repoOf(args, exec)
      const filePath = optionalText(args, 'path').replace(/^\/+|\/+$/g, '')
      const segments = filePath.split('/').filter(Boolean)
      if (segments.some((part) => part === '.' || part === '..')) {
        throw new Error('path must not contain "." or ".." segments')
      }
      const ref = optionalText(args, 'ref')
      const encoded = segments.map((part) => encodeURIComponent(part)).join('/')
      const query = ref.length > 0 ? { ref } : {}
      const contentsPath = encoded.length > 0 ? `/repos/${repo}/contents/${encoded}` : `/repos/${repo}/contents`
      const response = await client.json(contentsPath, { query, signal: exec.signal })
      const data = response.data
      if (Array.isArray(data)) {
        const entries = data.map((entry) => compactContentEntry(entry))
        return {
          repo,
          path: filePath,
          ref,
          kind: 'directory',
          entries: entries.slice(0, 1_000),
          entriesTruncated: entries.length > 1_000,
        }
      }
      const entry = data !== null && typeof data === 'object' ? data : {}
      const size = typeof entry.size === 'number' ? entry.size : 0
      const contentType = typeof entry.type === 'string' ? entry.type : 'file'
      if (contentType !== 'file') {
        return { repo, path: filePath, ref, kind: 'other', entry: compactContentEntry(entry) }
      }
      const rawContent = typeof entry.content === 'string' ? entry.content : ''
      if (entry.encoding !== 'base64' && (size > 0 || rawContent.length > 0)) {
        return { repo, path: filePath, ref, kind: 'too-large', size }
      }
      const buffer = Buffer.from(rawContent.replace(/\s+/g, ''), 'base64')
      const binary = buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0)
      if (binary) return { repo, path: filePath, ref, kind: 'binary', size }
      const decoded = buffer.toString('utf8')
      const budget = Math.max(1_000, config.maxOutputChars - 2_000)
      return {
        repo,
        path: filePath,
        ref,
        kind: 'file',
        size,
        content: decoded.slice(0, budget),
        truncated: decoded.length > budget,
      }
    },
  })

  // -------------------------------------------------------------------------
  // github_status
  // -------------------------------------------------------------------------
  const statusParameters = objectSchema({})
  tools.push({
    name: 'github_status',
    description:
      'Show the GitHub connection status: whether a token is configured (never the token), its source and scopes, the authenticated user, remaining rate limit, and write settings. Read-only.',
    parameters: statusParameters,
    output: outputFor(renderStatus, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertArgs(statusParameters, args)
      const rateResponse = await client.json('/rate_limit', { signal: exec.signal })
      const resources = rateResponse.data?.resources ?? {}
      const core = resources.core ?? rateResponse.data?.rate ?? null
      const rateLimit =
        core !== null && typeof core === 'object'
          ? {
              limit: typeof core.limit === 'number' ? core.limit : 0,
              remaining: typeof core.remaining === 'number' ? core.remaining : 0,
              used: typeof core.used === 'number' ? core.used : 0,
              reset: typeof core.reset === 'number' ? core.reset : 0,
              resetAt: typeof core.reset === 'number' && core.reset > 0 ? new Date(core.reset * 1000).toISOString() : '',
              resource: 'core',
            }
          : client.rateLimit()
      let user = null
      let scopes = []
      let authError = ''
      const token = await client.getToken()
      const authenticated = token.length > 0
      const tokenSource = config.token.length > 0 ? config.tokenSource : authenticated ? 'credential' : 'none'
      if (authenticated) {
        try {
          const userResponse = await client.json('/user', { signal: exec.signal })
          user = compactUser(userResponse.data)
          const header = userResponse.headers['x-oauth-scopes'] ?? ''
          scopes = header.split(',').map((scope) => scope.trim()).filter(Boolean)
        } catch (error) {
          user = null
          authError = error instanceof Error ? error.message : String(error)
        }
      }
      return {
        authenticated,
        tokenSource,
        apiBaseUrl: config.apiBaseUrl,
        user,
        scopes,
        authError,
        allowWrites: config.allowWrites,
        requireApproval: config.requireApproval,
        defaultRepo: config.defaultRepo,
        detectRepoFromGit: config.detectRepoFromGit,
        rateLimit,
      }
    },
  })

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------
  const createIssueParameters = objectSchema(
    {
      repo: REPO_PARAM,
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body in Markdown.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
      assignees: { type: 'array', items: { type: 'string' }, description: 'Login names to assign.' },
    },
    ['title'],
  )
  tools.push({
    name: 'github_create_issue',
    description:
      'Create a GitHub issue. Requires allowWrites: true; per-call user approval is required when requireApproval: true (the default). With requireApproval: false, writes execute without further confirmation. Write operation.',
    parameters: createIssueParameters,
    output: outputFor(renderMutation, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertArgs(createIssueParameters, args)
      const repo = await repoOf(args, exec)
      const title = requireText(args, 'title')
      const body = optionalText(args, 'body')
      const labels = stringArray(args, 'labels').slice(0, 20)
      const assignees = stringArray(args, 'assignees').slice(0, 10)
      await guardWrite('github_create_issue', exec, repo, `create issue "${title.slice(0, 120)}"`)
      const payload = { title }
      if (body.length > 0) payload.body = body
      if (labels.length > 0) payload.labels = labels
      if (assignees.length > 0) payload.assignees = assignees
      const response = await client.json(`/repos/${repo}/issues`, { method: 'POST', body: payload, signal: exec.signal })
      const issue = response.data ?? {}
      return {
        action: 'created-issue',
        repo,
        number: typeof issue.number === 'number' ? issue.number : 0,
        title: typeof issue.title === 'string' ? issue.title : title,
        htmlUrl: typeof issue.html_url === 'string' ? issue.html_url : '',
        labels,
      }
    },
  })

  const commentParameters = objectSchema(
    {
      repo: REPO_PARAM,
      number: { type: 'integer', description: 'Issue or pull request number to comment on.' },
      body: { type: 'string', description: 'Comment body in Markdown.' },
    },
    ['number', 'body'],
  )
  tools.push({
    name: 'github_comment',
    description:
      'Add a comment to a GitHub issue or pull request. Requires allowWrites: true; per-call user approval is required when requireApproval: true (the default). With requireApproval: false, writes execute without further confirmation. Write operation.',
    parameters: commentParameters,
    output: outputFor(renderMutation, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertArgs(commentParameters, args)
      const repo = await repoOf(args, exec)
      const number = positiveInteger(args, 'number')
      const body = requireText(args, 'body')
      await guardWrite('github_comment', exec, repo, `comment on #${number}`)
      const response = await client.json(`/repos/${repo}/issues/${number}/comments`, {
        method: 'POST',
        body: { body },
        signal: exec.signal,
      })
      const comment = response.data ?? {}
      return {
        action: 'created-comment',
        repo,
        number,
        commentId: typeof comment.id === 'number' ? comment.id : 0,
        htmlUrl: typeof comment.html_url === 'string' ? comment.html_url : '',
      }
    },
  })

  const createPullParameters = objectSchema(
    {
      repo: REPO_PARAM,
      title: { type: 'string', description: 'Pull request title.' },
      head: { type: 'string', description: 'Source branch (or "owner:branch" for a fork). It must already exist on GitHub.' },
      base: { type: 'string', description: 'Target branch to merge into.' },
      body: { type: 'string', description: 'Pull request body in Markdown.' },
      draft: { type: 'boolean', description: 'Open the pull request as a draft.' },
      maintainerCanModify: { type: 'boolean', description: 'Allow maintainers to push to the source branch (default true).' },
    },
    ['title', 'head', 'base'],
  )
  tools.push({
    name: 'github_create_pull_request',
    description:
      'Create a GitHub pull request from an existing branch. Requires allowWrites: true; per-call user approval is required when requireApproval: true (the default). With requireApproval: false, writes execute without further confirmation. Does not push branches. Write operation.',
    parameters: createPullParameters,
    output: outputFor(renderMutation, maxOutputChars),
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertArgs(createPullParameters, args)
      const repo = await repoOf(args, exec)
      const title = requireText(args, 'title')
      const head = requireText(args, 'head')
      const base = requireText(args, 'base')
      const body = optionalText(args, 'body')
      await guardWrite('github_create_pull_request', exec, repo, `create pull request "${title.slice(0, 120)}"`)
      const payload = { title, head, base }
      if (body.length > 0) payload.body = body
      if (args.draft === true) payload.draft = true
      if (typeof args.maintainerCanModify === 'boolean') payload.maintainer_can_modify = args.maintainerCanModify
      const response = await client.json(`/repos/${repo}/pulls`, { method: 'POST', body: payload, signal: exec.signal })
      const pull = response.data ?? {}
      return {
        action: 'created-pull-request',
        repo,
        number: typeof pull.number === 'number' ? pull.number : 0,
        title: typeof pull.title === 'string' ? pull.title : title,
        htmlUrl: typeof pull.html_url === 'string' ? pull.html_url : '',
        head,
        base,
        draft: pull.draft === true,
      }
    },
  })

  return tools
}
