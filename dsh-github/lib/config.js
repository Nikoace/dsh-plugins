/**
 * Plugin settings for the GitHub integration.
 *
 * The Host passes the Loader row's parsed `Config` to `apply()`. Fields marked
 * `.volatile()` in the schema arrive as stable references; this module resolves
 * them on every read so the Settings page can change workspace/write policy
 * live, without remounting the plugin.
 */

import { normalizeRepo } from './repo.js'

/** Defaults documented in README.md and docs/github-integration-analysis.md. */
export const DEFAULT_CONFIG = Object.freeze({
  token: '',
  tokenEnv: 'GITHUB_TOKEN',
  apiBaseUrl: 'https://api.github.com',
  apiVersion: '2022-11-28',
  userAgent: 'dsh-github-plugin',
  defaultRepo: '',
  detectRepoFromGit: true,
  allowWrites: false,
  requireApproval: true,
  requestTimeoutMs: 20_000,
  cacheTtlSeconds: 30,
  maxOutputChars: 60_000,
  toolTimeoutMs: 60_000,
})

/**
 * Fields exposed by the Settings page (`Config.volatile()`).
 *
 * @type {readonly string[]}
 */
export const VOLATILE_FIELDS = Object.freeze([
  'defaultRepo',
  'detectRepoFromGit',
  'allowWrites',
  'requireApproval',
  'requestTimeoutMs',
  'cacheTtlSeconds',
  'maxOutputChars',
])

const ENV_TOKEN_FALLBACKS = ['GITHUB_TOKEN', 'GH_TOKEN']

/** @param {unknown} value - candidate. @returns {value is Record<string, unknown>} plain record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a volatile reference or a plain value.
 *
 * @param {unknown} value - config value, possibly a volatile reference.
 * @returns {unknown} current plain value.
 */
function unwrap(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * @param {unknown} value - candidate.
 * @returns {string} trimmed string, or `''`.
 */
function text(value) {
  const current = unwrap(value)
  return typeof current === 'string' ? current.trim() : ''
}

/**
 * @param {unknown} value - candidate.
 * @param {boolean} fallback - default.
 * @returns {boolean} resolved boolean.
 */
function booleanOf(value, fallback) {
  const current = unwrap(value)
  return typeof current === 'boolean' ? current : fallback
}

/**
 * @param {unknown} value - candidate.
 * @param {number} fallback - default.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} resolved finite number.
 */
function numberIn(value, fallback, min, max) {
  const current = unwrap(value)
  if (typeof current !== 'number' || !Number.isFinite(current)) return fallback
  return Math.max(min, Math.min(max, current))
}

/**
 * Normalize one API base URL.
 *
 * @param {unknown} value - configured value.
 * @returns {string} base URL without a trailing slash.
 * @throws {Error} when the value is not an absolute http(s) URL.
 */
export function normalizeApiBaseUrl(value) {
  const raw = text(value)
  if (raw.length === 0) return DEFAULT_CONFIG.apiBaseUrl
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`dsh-github: apiBaseUrl must be an absolute http(s) URL, received "${raw}"`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`dsh-github: apiBaseUrl must use http or https, received "${raw}"`)
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('dsh-github: apiBaseUrl must not embed credentials')
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error('dsh-github: apiBaseUrl must not contain a query or fragment')
  }
  return raw.replace(/\/+$/, '')
}

/**
 * Resolve a token and remember where it came from. Stored credentials are
 * resolved separately, per request, by the HTTP client's token provider.
 *
 * @param {Record<string, unknown>} raw - row config.
 * @param {Record<string, string | undefined> | undefined} env - environment snapshot.
 * @returns {{ token: string, tokenSource: string, hasToken: boolean, tokenEnv: string }} token facts.
 */
export function resolveToken(raw, env) {
  const configured = text(raw.token)
  const tokenEnv = text(raw.tokenEnv) || DEFAULT_CONFIG.tokenEnv
  if (configured.length > 0) {
    return { token: configured, tokenSource: 'config', hasToken: true, tokenEnv }
  }
  if (tokenEnv.length > 0) {
    const fromEnv = text(env?.[tokenEnv])
    if (fromEnv.length > 0) {
      return { token: fromEnv, tokenSource: `env:${tokenEnv}`, hasToken: true, tokenEnv }
    }
  }
  for (const name of ENV_TOKEN_FALLBACKS) {
    if (name === tokenEnv) continue
    const fromEnv = text(env?.[name])
    if (fromEnv.length > 0) {
      return { token: fromEnv, tokenSource: `env:${name}`, hasToken: true, tokenEnv }
    }
  }
  return { token: '', tokenSource: 'none', hasToken: false, tokenEnv }
}

/**
 * Resolve the effective plugin settings.
 *
 * Volatile fields are getters over their references, so a Settings write is
 * visible to the next tool call. Static fields (token, API origin, versions)
 * keep the values resolved at activation.
 *
 * @param {unknown} rawConfig - the Loader row's parsed `Config`.
 * @param {Record<string, string | undefined>} [env] - environment snapshot.
 * @returns {object} resolved settings with live volatile getters.
 */
export function resolveConfig(rawConfig, env = globalThis.process?.env ?? {}) {
  const raw = isRecord(rawConfig) ? rawConfig : {}
  const tokenInfo = resolveToken(raw, env)
  const apiBaseUrl = normalizeApiBaseUrl(raw.apiBaseUrl)
  const apiVersion = text(raw.apiVersion) || DEFAULT_CONFIG.apiVersion
  const userAgent = text(raw.userAgent) || DEFAULT_CONFIG.userAgent
  const configuredRepo = text(raw.defaultRepo)
  if (configuredRepo.length > 0 && normalizeRepo(configuredRepo).length === 0) {
    throw new Error(`dsh-github: defaultRepo must be "owner/name" or a GitHub repository URL, received "${configuredRepo}"`)
  }
  return {
    token: tokenInfo.token,
    tokenEnv: tokenInfo.tokenEnv,
    tokenSource: tokenInfo.tokenSource,
    hasToken: tokenInfo.hasToken,
    apiBaseUrl,
    apiVersion,
    userAgent,
    get defaultRepo() {
      const value = text(raw.defaultRepo)
      return value.length > 0 ? normalizeRepo(value) : ''
    },
    get detectRepoFromGit() {
      return booleanOf(raw.detectRepoFromGit, DEFAULT_CONFIG.detectRepoFromGit)
    },
    get allowWrites() {
      return booleanOf(raw.allowWrites, DEFAULT_CONFIG.allowWrites)
    },
    get requireApproval() {
      return booleanOf(raw.requireApproval, DEFAULT_CONFIG.requireApproval)
    },
    get requestTimeoutMs() {
      return numberIn(raw.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 1_000, 300_000)
    },
    get cacheTtlSeconds() {
      return numberIn(raw.cacheTtlSeconds, DEFAULT_CONFIG.cacheTtlSeconds, 0, 3_600)
    },
    get maxOutputChars() {
      return numberIn(raw.maxOutputChars, DEFAULT_CONFIG.maxOutputChars, 1_000, 400_000)
    },
    toolTimeoutMs: numberIn(raw.toolTimeoutMs, DEFAULT_CONFIG.toolTimeoutMs, 1_000, 600_000),
  }
}
