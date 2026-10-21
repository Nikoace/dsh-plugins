/**
 * Small GitHub REST client over the global `fetch`.
 *
 * Responsibilities kept here: URL construction, authentication headers,
 * timeout/cancellation, GET response caching with ETag revalidation, rate-limit
 * extraction, and turning non-2xx responses into a single diagnosable error
 * type. Token values never enter messages.
 */

const DEFAULT_ACCEPT = 'application/vnd.github+json'
const MAX_CACHE_ENTRIES = 128

/** One failed GitHub API call. */
export class GitHubApiError extends Error {
  /**
   * @param {string} message - model-facing message.
   * @param {object} [info] - structured facts.
   * @param {number} [info.status] - HTTP status.
   * @param {string} [info.method] - HTTP method.
   * @param {string} [info.path] - API path.
   * @param {string} [info.requestId] - `x-github-request-id`.
   * @param {object | null} [info.rateLimit] - parsed rate-limit facts.
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = info.status
    this.method = info.method
    this.path = info.path
    this.requestId = info.requestId
    this.rateLimit = info.rateLimit ?? null
  }
}

/**
 * Read one header from a `Headers` instance or a plain object.
 *
 * @param {unknown} headers - response headers.
 * @param {string} name - lower-case header name.
 * @returns {string} header value, or `''`.
 */
function headerOf(headers, name) {
  if (headers === null || headers === undefined) return ''
  if (typeof headers.get === 'function') return headers.get(name) ?? ''
  if (typeof headers === 'object' && name in headers) {
    const value = headers[name]
    return typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : ''
  }
  return ''
}

/**
 * Whether a response's `Link` header advertises another page.
 *
 * @param {unknown} headers - response headers.
 * @returns {boolean} true when a `rel="next"` link exists.
 */
export function hasNextPage(headers) {
  const link = headerOf(headers, 'link')
  return /rel="next"/i.test(link)
}

/**
 * Parse the standard rate-limit headers.
 *
 * @param {unknown} headers - response headers.
 * @returns {{ limit: number, remaining: number, used: number, reset: number, resetAt: string, resource: string } | null} facts, or `null` when absent.
 */
export function parseRateLimit(headers) {
  const limit = Number.parseInt(headerOf(headers, 'x-ratelimit-limit'), 10)
  const remaining = Number.parseInt(headerOf(headers, 'x-ratelimit-remaining'), 10)
  const reset = Number.parseInt(headerOf(headers, 'x-ratelimit-reset'), 10)
  if (!Number.isFinite(limit) && !Number.isFinite(remaining) && !Number.isFinite(reset)) return null
  const used = Number.parseInt(headerOf(headers, 'x-ratelimit-used'), 10)
  return {
    limit: Number.isFinite(limit) ? limit : 0,
    remaining: Number.isFinite(remaining) ? remaining : 0,
    used: Number.isFinite(used) ? used : 0,
    reset: Number.isFinite(reset) ? reset : 0,
    resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : '',
    resource: headerOf(headers, 'x-ratelimit-resource'),
  }
}

/**
 * Build one absolute API URL and append query parameters.
 *
 * @param {string} apiBaseUrl - base URL without trailing slash.
 * @param {string} path - API path starting with `/`.
 * @param {Record<string, unknown>} [query] - query values; arrays join with commas.
 * @returns {string} absolute URL.
 * @throws {Error} when `path` is not a relative API path.
 */
export function buildUrl(apiBaseUrl, path, query = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('://')) {
    throw new Error(`invalid GitHub API path "${String(path)}": expected a path starting with "/"`)
  }
  const url = new URL(apiBaseUrl + path)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      url.searchParams.set(key, value.join(','))
    } else {
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

/** @param {unknown} error - thrown value. @returns {string} message. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the client used by every tool.
 *
 * @param {object} config - resolved plugin settings.
 * @param {object} [deps] - test seams and logging.
 * @param {typeof fetch} [deps.fetchImpl] - fetch implementation.
 * @param {{ warn?: (message: string) => void }} [deps.logger] - logger.
 * @returns {object} client with `request`, `json`, `text`, `rateLimit`, `cacheSize`.
 */
export function createHttpClient(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('dsh-github: this Harness has no global fetch implementation')
  const logger = deps.logger
  const tokenProvider = typeof deps.tokenProvider === 'function' ? deps.tokenProvider : undefined
  const cache = new Map()
  let lastRateLimit = null
  let lastToken = config.token
  let credentialGeneration = 0

  /** Invalidate even when a credential changes away and back to the same value. */
  function invalidateCredentials() {
    credentialGeneration += 1
    cache.clear()
    lastRateLimit = null
  }

  /**
   * Resolve the credential for one request. A stored credential can change
   * while the plugin stays loaded, so this is read per operation.
   *
   * @returns {Promise<string>} bearer token, or `''` for anonymous access.
   */
  async function effectiveToken() {
    if (tokenProvider === undefined) return config.token
    try {
      const value = await tokenProvider()
      return typeof value === 'string' ? value : config.token
    } catch (error) {
      logger?.warn?.(`[dsh-github] credential lookup failed: ${errorMessage(error)}`)
      return config.token
    }
  }

  /**
   * Take a credential snapshot. A lookup that overlapped an invalidation must
   * be repeated: its late result must not restore an older token/generation.
   * The generation is process-local; tokens never enter cache keys or errors.
   *
   * @param {() => void} [checkActive] - cancellation/deadline check.
   * @returns {Promise<{ token: string, generation: number }>}
   */
  async function credentialSnapshot(checkActive = () => {}) {
    for (;;) {
      checkActive()
      const startedGeneration = credentialGeneration
      const token = await effectiveToken()
      checkActive()
      if (startedGeneration !== credentialGeneration) continue
      if (token !== lastToken) {
        invalidateCredentials()
        lastToken = token
      }
      return { token, generation: credentialGeneration }
    }
  }

  /**
   * Request one API resource.
   *
   * @param {string} path - API path starting with `/`.
   * @param {object} [options] - request options.
   * @param {'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'} [options.method] - HTTP method; default `GET`.
   * @param {Record<string, unknown>} [options.query] - query parameters.
   * @param {unknown} [options.body] - JSON request body.
   * @param {string} [options.accept] - Accept media type.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @param {boolean} [options.raw] - return text instead of parsed JSON.
   * @param {boolean} [options.noCache] - bypass the GET cache.
   * @param {() => void} [options.beforeSend] - synchronous final authorization check, after credential lookup and immediately before fetch.
   * @returns {Promise<{ data: unknown, text: string, status: number, url: string, headers: Record<string, string>, rateLimit: object | null, fromCache: boolean }>} response.
   */
  async function request(path, options = {}) {
    const method = options.method ?? 'GET'
    const url = buildUrl(config.apiBaseUrl, path, options.query)
    const accept = options.accept ?? DEFAULT_ACCEPT
    const isGet = method === 'GET'
    const callerSignal = options.signal
    let timeoutFired = false
    const checkActive = () => {
      if (callerSignal?.aborted) throw new Error(`GitHub request cancelled (${method} ${path})`)
      if (timeoutFired) {
        throw new GitHubApiError(`GitHub request timed out after ${config.requestTimeoutMs} ms (${method} ${path})`, { method, path })
      }
    }
    const { token, generation } = await credentialSnapshot(checkActive)
    const checkCredential = () => {
      if (generation !== credentialGeneration) {
        throw new GitHubApiError(`GitHub credentials changed during request (${method} ${path}); retry with the current credentials.`, { method, path })
      }
    }
    checkActive()
    checkCredential()
    const cacheKey = `${method} ${url} ${accept}`
    const useCache = isGet && config.cacheTtlSeconds > 0 && options.noCache !== true
    const cached = useCache ? cache.get(cacheKey) : undefined
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      cache.delete(cacheKey)
      cache.set(cacheKey, cached)
      return { ...cached.response, fromCache: true }
    }

    const headers = {
      Accept: accept,
      'X-GitHub-Api-Version': config.apiVersion,
      'User-Agent': config.userAgent,
    }
    if (token.length > 0) headers.Authorization = `Bearer ${token}`
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (cached !== undefined && cached.etag.length > 0) headers['If-None-Match'] = cached.etag

    const controller = new AbortController()
    const timer = setTimeout(() => {
      timeoutFired = true
      controller.abort()
    }, config.requestTimeoutMs)

    const forwardAbort = () => controller.abort()
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) controller.abort()
      else callerSignal.addEventListener('abort', forwardAbort, { once: true })
    }

    /** Release the deadline and caller listener once the body (or a failure) is settled. */
    const cleanup = () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', forwardAbort)
    }

    let response
    try {
      const init = {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: 'follow',
      }
      // No await between this check and transport dispatch. Every write tool
      // supplies the same policy guard, including when approval is disabled.
      options.beforeSend?.()
      checkActive()
      checkCredential()
      response = await fetchImpl(url, init)
    } catch (error) {
      cleanup()
      if (callerSignal?.aborted) throw new Error(`GitHub request cancelled (${method} ${path})`)
      if (timeoutFired) {
        throw new GitHubApiError(`GitHub request timed out after ${config.requestTimeoutMs} ms (${method} ${path})`, {
          method,
          path,
        })
      }
      throw new GitHubApiError(`GitHub request failed: ${errorMessage(error)} (${method} ${path})`, { method, path })
    }

    let bodyText
    try {
      checkActive()
      bodyText = await response.text()
      checkActive()
      if (isGet) {
        // Also detect changes when no other request has resolved the token.
        // Keep the deadline/listener until this final async step settles.
        await credentialSnapshot(checkActive)
        checkActive()
        checkCredential()
      }
    } catch (error) {
      cleanup()
      if (callerSignal?.aborted) throw new Error(`GitHub request cancelled (${method} ${path})`)
      if (timeoutFired) {
        throw new GitHubApiError(`GitHub request timed out after ${config.requestTimeoutMs} ms (${method} ${path})`, {
          method,
          path,
        })
      }
      if (error instanceof GitHubApiError) throw error
      throw new GitHubApiError(`GitHub response could not be read: ${errorMessage(error)} (${method} ${path})`, {
        method,
        path,
        status: response.status,
      })
    }
    cleanup()
    const rateLimit = parseRateLimit(response.headers)
    if (rateLimit !== null && generation === credentialGeneration) lastRateLimit = rateLimit
    const requestId = headerOf(response.headers, 'x-github-request-id')
    const headerRecord = {}
    if (typeof response.headers.forEach === 'function') {
      response.headers.forEach((value, key) => {
        headerRecord[key] = value
      })
    } else if (response.headers !== null && typeof response.headers === 'object') {
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === 'string') headerRecord[key.toLowerCase()] = value
      }
    }

    if (response.status === 304) {
      if (cached === undefined) {
        throw new GitHubApiError(`GitHub API returned 304 without a cached response (${method} ${path})`, {
          method,
          path,
          status: 304,
          rateLimit,
          requestId,
        })
      }
      cached.expiresAt = Date.now() + config.cacheTtlSeconds * 1000
      return { ...cached.response, fromCache: true }
    }

    if (!response.ok) {
      let apiMessage = ''
      let documentationUrl = ''
      try {
        const parsed = JSON.parse(bodyText)
        if (parsed !== null && typeof parsed === 'object') {
          apiMessage = typeof parsed.message === 'string' ? parsed.message : ''
          documentationUrl = typeof parsed.documentation_url === 'string' ? parsed.documentation_url : ''
        }
      } catch {
        apiMessage = bodyText.slice(0, 200)
      }
      const parts = [`GitHub API ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: ${apiMessage || 'request failed'}`]
      parts.push(`(${method} ${path})`)
      if (response.status === 401) parts.push('— check the configured GitHub token')
      if ((response.status === 403 || response.status === 429) && rateLimit !== null && rateLimit.remaining === 0) {
        parts.push(`— rate limit exhausted; resets at ${rateLimit.resetAt || 'an unknown time'}`)
      }
      if (documentationUrl.length > 0) parts.push(`— ${documentationUrl}`)
      throw new GitHubApiError(parts.join(' '), { method, path, status: response.status, rateLimit, requestId })
    }

    const etag = headerOf(response.headers, 'etag')
    const responseValue = {
      data: undefined,
      text: bodyText,
      status: response.status,
      url,
      headers: headerRecord,
      rateLimit,
    }
    if (options.raw !== true) {
      try {
        responseValue.data = bodyText.length === 0 ? null : JSON.parse(bodyText)
      } catch {
        throw new GitHubApiError(`GitHub API returned non-JSON content for ${method} ${path}`, {
          method,
          path,
          status: response.status,
          rateLimit,
          requestId,
        })
      }
    }
    if (useCache && etag.length > 0) {
      cache.delete(cacheKey)
      cache.set(cacheKey, {
        etag,
        response: responseValue,
        expiresAt: Date.now() + config.cacheTtlSeconds * 1000,
      })
      while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
    }
    return { ...responseValue, fromCache: false }
  }

  return {
    /** @param {string} path - API path. @param {object} [options] - request options. @returns {Promise<object>} response. */
    request,
    /**
     * @param {string} path - API path.
     * @param {object} [options] - request options.
     * @returns {Promise<{ data: any, text: string, status: number, url: string, headers: Record<string, string>, rateLimit: object | null, fromCache: boolean }>} response.
     */
    json: (path, options) => request(path, options),
    /**
     * @param {string} path - API path.
     * @param {object} [options] - request options.
     * @returns {Promise<object>} raw-text response.
     */
    text: (path, options) => request(path, { ...options, raw: true }),
    /** @returns {object | null} the most recently observed rate-limit facts. */
    rateLimit: () => lastRateLimit,
    /** @returns {Promise<string>} the bearer token currently in effect (never rendered). */
    getToken: async () => (await credentialSnapshot()).token,
    /** Called synchronously on committed credential-store changes. */
    invalidateCredentials,
    /** @returns {number} cached GET responses. */
    cacheSize: () => cache.size,
    /** @returns {object} resolved configuration (including the token; never serialize). */
    config,
    /** @param {string} message - diagnostic text. */
    log: (message) => logger?.warn?.(message),
  }
}
