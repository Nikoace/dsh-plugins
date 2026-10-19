/**
 * Repository-name normalization and best-effort discovery from the session's
 * git checkout.
 *
 * Tool calls may name a repository explicitly, fall back to `defaultRepo`, or —
 * when the plugin runs inside a Session whose working directory is a git
 * checkout — read the `origin` remote from `.git/config`. Discovery is best
 * effort: every failure degrades to an actionable "pass repo" error.
 */

import path from 'node:path'

const REPO_PART = /^[A-Za-z0-9._-]+$/
const DETECTION_TTL_MS = 60_000
const DETECTION_FAILURE_TTL_MS = 10_000

/** @type {Map<string, { repo: string, expiresAt: number }>} */
const detectionCache = new Map()

/**
 * Normalize one repository reference.
 *
 * Accepts `owner/name`, `https://github.com/owner/name(.git)`,
 * `git@github.com:owner/name.git`, and a repository page URL. Returns `''` for
 * anything that does not identify a repository.
 *
 * @param {unknown} input - repository reference.
 * @returns {string} `owner/name`, or `''`.
 */
export function normalizeRepo(input) {
  if (typeof input !== 'string') return ''
  let value = input.trim()
  if (value.length === 0 || value.length > 300) return ''
  value = value.replace(/\.git$/i, '').replace(/\/+$/, '')

  const scp = /^[^@\s]+@[^:\s]+:(.+)$/.exec(value)
  if (scp !== null) {
    value = scp[1]
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname
    } catch {
      return ''
    }
  } else if (/^(?:www\.)?github\.com\//i.test(value)) {
    value = value.replace(/^(?:www\.)?github\.com\//i, '')
  }

  const parts = value.replace(/^\/+/, '').split('/').filter((part) => part.length > 0)
  if (parts.length < 2) return ''
  const owner = parts[0]
  const name = parts[1].replace(/\.git$/i, '')
  if (!REPO_PART.test(owner) || !REPO_PART.test(name) || owner === '.' || owner === '..' || name === '.' || name === '..') return ''
  return `${owner}/${name}`
}

/**
 * Parse the `origin` remote out of a `.git/config` document.
 *
 * @param {unknown} content - file text.
 * @returns {string} `owner/name`, or `''` when no remote resolves to a repository.
 */
export function parseGitRemoteText(content) {
  if (typeof content !== 'string' || content.length === 0) return ''
  let section = ''
  let origin = ''
  let firstRemote = ''
  for (const line of content.split(/\r?\n/)) {
    const header = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line)
    if (header !== null) {
      section = header[1]
      continue
    }
    if (/^\s*\[/.test(line)) {
      section = ''
      continue
    }
    const entry = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)
    if (entry === null || section.length === 0) continue
    const repo = normalizeRepo(entry[1])
    if (repo.length === 0) continue
    if (!firstRemote) firstRemote = repo
    if (section === 'origin' && !origin) origin = repo
  }
  return origin || firstRemote
}

/**
 * Read one git metadata file relative to the checkout root.
 *
 * @param {object} fs - `ctx.fs` service.
 * @param {string} cwd - checkout root.
 * @param {string} relative - path relative to the root.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<string>} file text, or `''`.
 */
async function readCheckoutFile(fs, cwd, relative, signal) {
  try {
    const target = await fs.resolve(path.join(cwd, relative), { cwd })
    return await fs.readText(target, signal)
  } catch {
    return ''
  }
}

/**
 * Detect the origin repository of the Session's working directory.
 *
 * Reads `.git/config` through the composed filesystem (never with raw Node
 * filesystem calls), and follows a linked-worktree `.git` pointer to the main
 * checkout's config. Results are cached briefly per directory.
 *
 * @param {object} ctx - plugin context.
 * @param {object} exec - tool run context (needs `agent`).
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<string>} `owner/name`, or `''`.
 */
export async function detectRepoFromGit(ctx, exec, signal) {
  if (exec?.agent === undefined || exec.agent === null) return ''
  let workingDirectory
  let fs
  try {
    workingDirectory = ctx.get('workingDirectory')
    fs = ctx.get('fs')
  } catch {
    return ''
  }
  if (workingDirectory === undefined || fs === undefined) return ''

  let cwd
  try {
    cwd = await workingDirectory.ensure(exec.agent, signal)
  } catch {
    return ''
  }
  if (typeof cwd !== 'string' || cwd.length === 0) return ''

  const cached = detectionCache.get(cwd)
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.repo

  let repo = ''
  const configText = await readCheckoutFile(fs, cwd, path.join('.git', 'config'), signal)
  if (configText.length > 0) repo = parseGitRemoteText(configText)

  if (repo.length === 0) {
    const pointer = await readCheckoutFile(fs, cwd, '.git', signal)
    const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer)
    if (match !== null) {
      const gitDir = path.resolve(cwd, match[1])
      const mainConfig = path.join(path.dirname(path.dirname(gitDir)), 'config')
      const mainText = await readCheckoutFile(fs, cwd, path.relative(cwd, mainConfig), signal)
      if (mainText.length > 0) repo = parseGitRemoteText(mainText)
    }
  }

  detectionCache.set(cwd, {
    repo,
    expiresAt: Date.now() + (repo.length > 0 ? DETECTION_TTL_MS : DETECTION_FAILURE_TTL_MS),
  })
  return repo
}

/**
 * Resolve the repository a tool call operates on.
 *
 * @param {object} options - resolution inputs.
 * @param {string | undefined} options.repo - explicit `repo` argument.
 * @param {object} options.config - resolved plugin settings.
 * @param {object} options.ctx - plugin context.
 * @param {object} options.exec - tool run context.
 * @param {AbortSignal | undefined} options.signal - cancellation.
 * @returns {Promise<string>} `owner/name`.
 * @throws {Error} when no repository can be resolved.
 */
export async function resolveRepo({ repo, config, ctx, exec, signal }) {
  if (typeof repo === 'string' && repo.trim().length > 0) {
    const normalized = normalizeRepo(repo)
    if (normalized.length === 0) {
      throw new Error(`invalid repository "${repo.trim()}": expected owner/name or a GitHub repository URL`)
    }
    return normalized
  }
  if (config.defaultRepo) {
    const normalized = normalizeRepo(config.defaultRepo)
    if (normalized.length > 0) return normalized
  }
  if (config.detectRepoFromGit) {
    const detected = await detectRepoFromGit(ctx, exec, signal)
    if (detected.length > 0) return detected
  }
  throw new Error(
    'repository is required: pass repo="owner/name", set defaultRepo in the dsh-github config, or run in a git checkout with a GitHub origin remote',
  )
}

/** Clear the detection cache (tests and configuration reloads). */
export function clearRepoDetectionCache() {
  detectionCache.clear()
}
