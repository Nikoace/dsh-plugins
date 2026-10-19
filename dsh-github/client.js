/**
 * Client half of `dsh-github`: Settings → GitHub.
 *
 * The page binds the `github` Host entry through `ctx.configForms` (volatile
 * fields declared by the Host `Config`), so workspace/write policy edits are
 * persisted through the Host settings service and apply live. The GitHub token
 * is stored through the credential service instead of the profile patch; the
 * page only ever sees presence, source, and writability.
 *
 * No Harness Client package is imported: the controls are plain React elements
 * styled with `--dsw-alias-*` theme tokens, matching the settings shell's row
 * layout.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-github',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'settings.github'
    const CREDENTIAL_REF = 'GITHUB_TOKEN'
    const PLUGIN_ID = '@local/dsh-github'

    const zh = {
      nav: 'GitHub',
      title: 'GitHub 集成',
      description: '配置 GitHub 连接、默认仓库与写入策略。设置保存后立即生效，无需重启。',
      loading: '正在读取设置…',
      unavailable: 'GitHub 插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      save: '保存设置',
      saving: '保存中…',
      reset: '撤销修改',
      saved: '设置已保存。',
      noChanges: '没有需要保存的修改。',
      saveFailed: '保存失败，已恢复 Host 上的最新值，请重试。',
      invalidNumber: '请输入有效数字。',
      fieldsTitle: '工作区与写入',
      fieldDefaultRepo: '默认仓库',
      hintDefaultRepo: '省略 repo 参数时使用；留空则从会话的 git origin 推断。',
      fieldDetectRepo: '从 git origin 推断仓库',
      hintDetectRepo: '读取会话工作目录的 .git/config 中的 origin remote。',
      fieldAllowWrites: '允许写入 GitHub',
      hintAllowWrites: '开启后 Agent 可新建 Issue、评论和 PR。默认关闭。',
      fieldRequireApproval: '写入前请求审批',
      hintRequireApproval: '默认逐次审批。关闭后，只要允许写入，Agent 就能不经再次确认直接修改真实 GitHub 仓库，可能发布非预期内容。',
      fieldRequestTimeout: '请求超时（毫秒）',
      hintRequestTimeout: '单次 GitHub API 调用超时，1 000–300 000。',
      fieldCacheTtl: '缓存有效期（秒）',
      hintCacheTtl: 'GET 响应的内存缓存时间，0 表示禁用。',
      fieldMaxOutputChars: '结果输出上限（字符）',
      hintMaxOutputChars: '单个工具结果的最大字符数，1 000–400 000。',
      tokenTitle: '访问令牌',
      tokenDescription: '令牌保存在 Host 的凭据存储中，插件只读取而不会回显。推荐使用只读 fine-grained PAT；需要写入时再补充 Issues / Pull requests 写权限。',
      tokenConfigured: '已配置',
      tokenMissing: '未配置（匿名访问，60 次/小时）',
      tokenSource: '来源：{source}',
      tokenPlaceholder: '粘贴 GitHub Token（ghp_… 或 github_pat_…）',
      tokenSave: '保存令牌',
      tokenSaving: '保存中…',
      tokenClear: '清除令牌',
      tokenSaved: '令牌已保存，新的工具调用会立即使用。',
      tokenCleared: '令牌已清除。',
      tokenFailed: '令牌操作失败：{message}',
      tokenWritableHint: '当前凭据存储不可写，无法从这里保存令牌。',
      tokenEnvHint: '环境变量 GITHUB_TOKEN 仍然优先于此处保存的令牌。',
      advancedTitle: '高级配置',
      advancedBody: 'API 地址、Token 环境变量名、API 版本与 User-Agent 属于普通配置，保存在 profile patch 的 github 行；修改后重载插件生效。',
    }

    const en = {
      nav: 'GitHub',
      title: 'GitHub integration',
      description: 'Configure the GitHub connection, default repository, and write policy. Saved settings apply immediately, without a restart.',
      loading: 'Reading settings…',
      unavailable: 'The GitHub plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      save: 'Save settings',
      saving: 'Saving…',
      reset: 'Discard changes',
      saved: 'Settings saved.',
      noChanges: 'Nothing to save.',
      saveFailed: 'Save failed; the latest Host values were reloaded. Try again.',
      invalidNumber: 'Enter a valid number.',
      fieldsTitle: 'Workspace and writes',
      fieldDefaultRepo: 'Default repository',
      hintDefaultRepo: 'Used when a tool call omits repo; leave blank to infer it from the session git origin.',
      fieldDetectRepo: 'Detect the repository from git origin',
      hintDetectRepo: 'Reads the origin remote from .git/config in the session working directory.',
      fieldAllowWrites: 'Allow GitHub writes',
      hintAllowWrites: 'Lets the agent create issues, comments, and pull requests. Off by default.',
      fieldRequireApproval: 'Ask for approval before writes',
      hintRequireApproval: 'Approval is required per write by default. Turning this off lets the agent change the real GitHub repository without further confirmation when writes are enabled, potentially publishing unintended content.',
      fieldRequestTimeout: 'Request timeout (ms)',
      hintRequestTimeout: 'Per-call GitHub API timeout, 1,000–300,000.',
      fieldCacheTtl: 'Cache TTL (seconds)',
      hintCacheTtl: 'In-memory cache for GET responses; 0 disables it.',
      fieldMaxOutputChars: 'Result output cap (characters)',
      hintMaxOutputChars: 'Maximum characters in one tool result, 1,000–400,000.',
      tokenTitle: 'Access token',
      tokenDescription: 'The token is stored in the Host credential store; the plugin reads it without echoing it. Prefer a read-only fine-grained PAT, and add Issues / Pull requests write access only when writes are enabled.',
      tokenConfigured: 'Configured',
      tokenMissing: 'Not configured (anonymous, 60 requests/hour)',
      tokenSource: 'Source: {source}',
      tokenPlaceholder: 'Paste a GitHub token (ghp_… or github_pat_…)',
      tokenSave: 'Save token',
      tokenSaving: 'Saving…',
      tokenClear: 'Clear token',
      tokenSaved: 'Token saved; new tool calls use it immediately.',
      tokenCleared: 'Token cleared.',
      tokenFailed: 'Token operation failed: {message}',
      tokenWritableHint: 'The credential store is read-only here, so the token cannot be saved from this page.',
      tokenEnvHint: 'The GITHUB_TOKEN environment variable still takes precedence over a token saved here.',
      advancedTitle: 'Advanced configuration',
      advancedBody: 'API base URL, token environment variable, API version, and User-Agent are ordinary configuration in the profile patch github row; reload the plugin after editing them.',
    }

    /**
     * One settings field descriptor. Numbers are clamped client-side to the same
     * bounds `resolveConfig` enforces on the Host.
     */
    const FIELDS = [
      { key: 'defaultRepo', kind: 'text', label: 'fieldDefaultRepo', hint: 'hintDefaultRepo', placeholder: 'owner/name', fallback: '' },
      { key: 'detectRepoFromGit', kind: 'boolean', label: 'fieldDetectRepo', hint: 'hintDetectRepo', fallback: true },
      { key: 'allowWrites', kind: 'boolean', label: 'fieldAllowWrites', hint: 'hintAllowWrites', fallback: false },
      { key: 'requireApproval', kind: 'boolean', label: 'fieldRequireApproval', hint: 'hintRequireApproval', fallback: true },
      { key: 'requestTimeoutMs', kind: 'number', label: 'fieldRequestTimeout', hint: 'hintRequestTimeout', min: 1_000, max: 300_000, fallback: 20_000 },
      { key: 'cacheTtlSeconds', kind: 'number', label: 'fieldCacheTtl', hint: 'hintCacheTtl', min: 0, max: 3_600, fallback: 30 },
      { key: 'maxOutputChars', kind: 'number', label: 'fieldMaxOutputChars', hint: 'hintMaxOutputChars', min: 1_000, max: 400_000, fallback: 60_000 },
    ]

    const css = `
.dsh-gh-settings { display: flex; flex-direction: column; gap: 18px; max-width: 760px; padding: 4px 0 32px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 1.5; }
.dsh-gh-header { display: flex; flex-direction: column; gap: 4px; }
.dsh-gh-title { margin: 0; font-size: 16px; font-weight: 600; }
.dsh-gh-desc { margin: 0; color: var(--dsw-alias-label-secondary); }
.dsh-gh-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.dsh-gh-card-head { display: flex; flex-direction: column; gap: 4px; }
.dsh-gh-card-title { margin: 0; font-size: 14px; font-weight: 600; }
.dsh-gh-hint { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-gh-row { display: flex; gap: 24px; align-items: center; justify-content: space-between; padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-gh-row:first-of-type { border-top: none; padding-top: 0; }
.dsh-gh-row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-gh-row-label { font-weight: 500; }
.dsh-gh-control { flex: none; display: flex; align-items: center; gap: 8px; }
.dsh-gh-input { box-sizing: border-box; width: 180px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
.dsh-gh-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-gh-input:disabled { color: var(--dsw-alias-label-secondary); cursor: not-allowed; }
.dsh-gh-switch { position: relative; display: inline-flex; width: 36px; height: 20px; flex: none; }
.dsh-gh-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.dsh-gh-switch input:disabled { cursor: not-allowed; }
.dsh-gh-track { pointer-events: none; box-sizing: border-box; width: 36px; height: 20px; padding: 2px; border-radius: 999px; background: var(--dsw-alias-state-idle-primary); transition: background 120ms ease; }
.dsh-gh-switch input:checked + .dsh-gh-track { background: var(--dsw-alias-brand-primary); }
.dsh-gh-knob { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-bg-base); transition: transform 120ms ease; }
.dsh-gh-switch input:checked + .dsh-gh-track .dsh-gh-knob { transform: translateX(16px); }
.dsh-gh-actions { display: flex; align-items: center; gap: 10px; }
.dsh-gh-button { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; }
.dsh-gh-button:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.dsh-gh-button:disabled { opacity: 0.5; cursor: not-allowed; }
.dsh-gh-button-primary { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.dsh-gh-button-danger { color: var(--dsw-alias-state-error-primary); }
.dsh-gh-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-gh-status { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.dsh-gh-status-ok { color: var(--dsw-alias-state-success-primary); }
.dsh-gh-notice { margin: 0; font-size: 12px; }
.dsh-gh-notice-error { color: var(--dsw-alias-state-error-primary); }
.dsh-gh-notice-success { color: var(--dsw-alias-state-success-primary); }
.dsh-gh-token-row { display: flex; gap: 8px; align-items: center; }
.dsh-gh-token-row .dsh-gh-input { flex: 1; width: auto; }
.dsh-gh-empty { margin: 0; color: var(--dsw-alias-label-secondary); }
`

    /**
     * Read one field from the Host settings snapshot as a plain comparable value.
     *
     * @param {object} field - descriptor.
     * @param {unknown} value - raw value.
     * @returns {string | number | boolean} comparable value.
     */
    function plainField(field, value) {
      if (field.kind === 'boolean') return typeof value === 'boolean' ? value : field.fallback
      if (field.kind === 'number') {
        const number = typeof value === 'number' ? value : Number(value)
        return Number.isFinite(number) ? number : field.fallback
      }
      return typeof value === 'string' ? value : field.fallback
    }

    /**
     * Build the editable draft from a Host settings value.
     *
     * @param {object} value - `configForms` namespace value.
     * @returns {Record<string, string | boolean>} draft.
     */
    function draftFrom(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const draft = {}
      for (const field of FIELDS) {
        const current = plainField(field, source[field.key])
        draft[field.key] = field.kind === 'boolean' ? current === true : String(current)
      }
      return draft
    }

    /** @param {unknown} error - thrown value. @returns {string} message. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * Settings → GitHub section.
     *
     * @param {object} props - slot props.
     * @returns {object} React element tree.
     */
    function GithubSettings(props) {
      const { form, remote } = props
      const t = typeof props.t === 'function' ? props.t : props.fallbackT
      const subscribe = React.useCallback((onChange) => form.subscribe(onChange), [form])
      const readSnapshot = React.useCallback(() => form.getSnapshot(), [form])
      const snapshot = React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot)
      const value = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}

      const [draft, setDraft] = React.useState(() => draftFrom(value))
      const [dirty, setDirty] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        if (dirty) return
        setDraft(draftFrom(value))
      }, [snapshot.revision, snapshot.status, dirty])

      const edit = (field, next) => {
        setDraft((current) => ({ ...current, [field]: next }))
        setDirty(true)
        setNotice(null)
      }

      const fieldsDisabled = saving || snapshot.status !== 'ready' || snapshot.writable !== true

      const reset = () => {
        setDraft(draftFrom(value))
        setDirty(false)
        setNotice(null)
      }

      const save = async () => {
        if (fieldsDisabled) return
        const operations = []
        for (const field of FIELDS) {
          const previous = plainField(field, value[field.key])
          let next
          if (field.kind === 'boolean') next = draft[field.key] === true
          else if (field.kind === 'number') {
            const number = Number(draft[field.key])
            if (!Number.isFinite(number)) {
              setNotice({ kind: 'error', text: t('invalidNumber') })
              return
            }
            next = Math.min(field.max, Math.max(field.min, Math.round(number)))
          } else {
            next = String(draft[field.key] ?? '').trim()
          }
          if (!Object.is(previous, next)) operations.push({ op: 'set', path: [field.key], value: next })
        }
        if (operations.length === 0) {
          setDirty(false)
          setNotice({ kind: 'info', text: t('noChanges') })
          return
        }
        setSaving(true)
        setNotice(null)
        let accepted = false
        try {
          accepted = await form.mutate(operations, snapshot.revision)
        } catch (error) {
          accepted = false
        }
        setSaving(false)
        if (accepted) {
          setDirty(false)
          setNotice({ kind: 'success', text: t('saved') })
        } else {
          setNotice({ kind: 'error', text: t('saveFailed') })
        }
      }

      const [credential, setCredential] = React.useState({ loading: true, configured: false, source: '', writable: true, error: '' })
      const [tokenDraft, setTokenDraft] = React.useState('')
      const [tokenBusy, setTokenBusy] = React.useState(false)
      const [tokenNotice, setTokenNotice] = React.useState(null)

      const loadCredential = React.useCallback(async () => {
        try {
          const response = await remote.credentials.describe([CREDENTIAL_REF])
          if (response === null || typeof response !== 'object' || response.ok !== true) {
            const message = response?.error?.message ?? t('tokenFailed', { message: messageOf(response?.error) })
            setCredential({ loading: false, configured: false, source: '', writable: true, error: message })
            return
          }
          const info = response.value?.[CREDENTIAL_REF] ?? {}
          setCredential({
            loading: false,
            configured: info.configured === true,
            source: typeof info.source === 'string' ? info.source : '',
            writable: info.writable !== false,
            error: '',
          })
        } catch (error) {
          setCredential({ loading: false, configured: false, source: '', writable: true, error: messageOf(error) })
        }
      }, [remote, t])

      React.useEffect(() => {
        void loadCredential()
      }, [loadCredential])

      const saveToken = async () => {
        const token = tokenDraft.trim()
        if (token.length === 0) return
        setTokenBusy(true)
        setTokenNotice(null)
        try {
          const response = await remote.credentials.set(CREDENTIAL_REF, token)
          if (response !== null && typeof response === 'object' && response.ok === false) {
            setTokenNotice({ kind: 'error', text: t('tokenFailed', { message: response.error?.message ?? 'rejected' }) })
          } else {
            setTokenDraft('')
            setTokenNotice({ kind: 'success', text: t('tokenSaved') })
            await loadCredential()
          }
        } catch (error) {
          setTokenNotice({ kind: 'error', text: t('tokenFailed', { message: messageOf(error) }) })
        }
        setTokenBusy(false)
      }

      const clearToken = async () => {
        setTokenBusy(true)
        setTokenNotice(null)
        try {
          const response = await remote.credentials.unset(CREDENTIAL_REF)
          if (response !== null && typeof response === 'object' && response.ok === false) {
            setTokenNotice({ kind: 'error', text: t('tokenFailed', { message: response.error?.message ?? 'rejected' }) })
          } else {
            setTokenNotice({ kind: 'success', text: t('tokenCleared') })
            await loadCredential()
          }
        } catch (error) {
          setTokenNotice({ kind: 'error', text: t('tokenFailed', { message: messageOf(error) }) })
        }
        setTokenBusy(false)
      }

      const header = h(
        'div',
        { className: 'dsh-gh-header' },
        h('h2', { className: 'dsh-gh-title' }, t('title')),
        h('p', { className: 'dsh-gh-desc' }, t('description')),
      )

      const tokenCard = h(
        'section',
        { className: 'dsh-gh-card', 'aria-labelledby': 'dsh-gh-token-title' },
        h(
          'div',
          { className: 'dsh-gh-card-head' },
          h('h3', { className: 'dsh-gh-card-title', id: 'dsh-gh-token-title' }, t('tokenTitle')),
          h('p', { className: 'dsh-gh-hint' }, t('tokenDescription')),
        ),
        h(
          'div',
          { className: 'dsh-gh-row' },
          h(
            'div',
            { className: 'dsh-gh-row-text' },
            h(
              'span',
              { className: credential.configured ? 'dsh-gh-status dsh-gh-status-ok' : 'dsh-gh-status' },
              credential.loading ? t('loading') : credential.configured ? t('tokenConfigured') : t('tokenMissing'),
            ),
            credential.configured && credential.source
              ? h('p', { className: 'dsh-gh-hint' }, t('tokenSource', { source: credential.source }))
              : null,
            credential.error ? h('p', { className: 'dsh-gh-hint dsh-gh-notice-error' }, credential.error) : null,
          ),
        ),
        h(
          'div',
          { className: 'dsh-gh-token-row' },
          h('input', {
            className: 'dsh-gh-input',
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: t('tokenPlaceholder'),
            value: tokenDraft,
            disabled: tokenBusy || credential.writable === false,
            'aria-label': t('tokenTitle'),
            onChange: (event) => setTokenDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void saveToken()
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-gh-button dsh-gh-button-primary',
              disabled: tokenBusy || tokenDraft.trim().length === 0 || credential.writable === false,
              onClick: () => void saveToken(),
            },
            tokenBusy ? t('tokenSaving') : t('tokenSave'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-gh-button dsh-gh-button-danger',
              disabled: tokenBusy || !credential.configured || credential.writable === false,
              onClick: () => void clearToken(),
            },
            t('tokenClear'),
          ),
        ),
        credential.writable === false ? h('p', { className: 'dsh-gh-hint' }, t('tokenWritableHint')) : null,
        h('p', { className: 'dsh-gh-hint' }, t('tokenEnvHint')),
        tokenNotice ? h('p', { className: tokenNotice.kind === 'error' ? 'dsh-gh-notice dsh-gh-notice-error' : 'dsh-gh-notice dsh-gh-notice-success' }, tokenNotice.text) : null,
      )

      let fieldsCard
      if (snapshot.status === 'loading') {
        fieldsCard = h('section', { className: 'dsh-gh-card' }, h('p', { className: 'dsh-gh-empty' }, t('loading')))
      } else if (snapshot.status !== 'ready') {
        fieldsCard = h('section', { className: 'dsh-gh-card' }, h('p', { className: 'dsh-gh-empty' }, t('unavailable')))
      } else {
        const rows = FIELDS.map((field) => {
          const id = `dsh-gh-field-${field.key}`
          const disabled = fieldsDisabled
          let control
          if (field.kind === 'boolean') {
            control = h(
              'label',
              { className: 'dsh-gh-switch' },
              h('input', {
                id,
                type: 'checkbox',
                role: 'switch',
                'aria-checked': draft[field.key] === true,
                checked: draft[field.key] === true,
                disabled,
                onChange: (event) => edit(field.key, event.target.checked),
              }),
              h('span', { className: 'dsh-gh-track', 'aria-hidden': true }, h('span', { className: 'dsh-gh-knob' })),
            )
          } else {
            control = h('input', {
              id,
              className: 'dsh-gh-input',
              type: field.kind === 'number' ? 'number' : 'text',
              inputMode: field.kind === 'number' ? 'numeric' : 'text',
              min: field.kind === 'number' ? field.min : undefined,
              max: field.kind === 'number' ? field.max : undefined,
              step: field.kind === 'number' ? 1 : undefined,
              placeholder: field.placeholder,
              value: draft[field.key],
              disabled,
              onChange: (event) => edit(field.key, event.target.value),
            })
          }
          return h(
            'div',
            { className: 'dsh-gh-row', key: field.key },
            h(
              'div',
              { className: 'dsh-gh-row-text' },
              h('label', { className: 'dsh-gh-row-label', htmlFor: id }, t(field.label)),
              h('p', { className: 'dsh-gh-hint' }, t(field.hint)),
            ),
            h('div', { className: 'dsh-gh-control' }, control),
          )
        })
        fieldsCard = h(
          'section',
          { className: 'dsh-gh-card', 'aria-labelledby': 'dsh-gh-fields-title' },
          h(
            'div',
            { className: 'dsh-gh-card-head' },
            h('h3', { className: 'dsh-gh-card-title', id: 'dsh-gh-fields-title' }, t('fieldsTitle')),
            snapshot.writable !== true ? h('p', { className: 'dsh-gh-hint' }, t('readOnly')) : null,
          ),
          ...rows,
          h(
            'div',
            { className: 'dsh-gh-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-gh-button dsh-gh-button-primary',
                disabled: fieldsDisabled || !dirty,
                onClick: () => void save(),
              },
              saving ? t('saving') : t('save'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-gh-button',
                disabled: fieldsDisabled || !dirty,
                onClick: reset,
              },
              t('reset'),
            ),
            notice ? h('p', { className: notice.kind === 'error' ? 'dsh-gh-notice dsh-gh-notice-error' : 'dsh-gh-notice dsh-gh-notice-success' }, notice.text) : null,
          ),
        )
      }

      const advanced = h(
        'section',
        { className: 'dsh-gh-card' },
        h('h3', { className: 'dsh-gh-card-title' }, t('advancedTitle')),
        h('p', { className: 'dsh-gh-hint' }, t('advancedBody')),
      )

      return h('div', { className: 'dsh-gh-settings' }, header, tokenCard, fieldsCard, advanced)
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-github: dictionaries')
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const tag = document.createElement('style')
          tag.dataset.plugin = PLUGIN_ID
          tag.dataset.pluginCss = `${PLUGIN_ID}/settings.css`
          tag.textContent = css
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'dsh-github: styles')

        const form = ctx.configForms.get('github')
        ctx.effect(() => () => {
          void form.dispose()
        }, 'dsh-github: settings form')

        ctx.effect(
          () =>
            ctx.configForms.whileServed(['github'], () =>
              ctx.slots.inject('settings.section', () =>
                ctx.slots.register(
                  {
                    name: 'settings.section',
                    id: 'github',
                    order: 25,
                    label: () => t('nav'),
                    locale: NS,
                    inject: () => ({ form, remote: ctx.remote, fallbackT: t }),
                  },
                  GithubSettings,
                ),
              ),
            ),
          'dsh-github: settings section',
        )
      },
    }
  },
})
