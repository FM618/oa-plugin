/**
 * @fm618/oa-runtime —— client 半部
 *
 * - root slot：未登录时整页登录页（priority -1 盖住 AppFrame）
 * - 登录后释放 root，注册各模块的 sidebar.panellist 入口与 main 面板
 * - 模块通过 `require('@fm618/oa-runtime/client').registerModule(...)` 声明自己
 *
 * 令牌不在浏览器里：所有请求打同源 /api/oa/*，由 host 半部带令牌转发。
 */
const React = require('react')
const {
  IconListPenOutlineRegular,
  IconLoadingOutlineRegular,
} = require('@deepseek-ai/dsh-client-ui-primitives')

// ── 状态 ────────────────────────────────────────────────────────────
const state = { status: 'booting', user: null, capabilities: new Set(), error: '', offlineReason: '', settings: null, editingServer: false, diagnostics: null, blockedReason: '' }
const modules = new Map()
const listeners = new Set()
let slotCtx = null
const registeredModules = new Set()

function emit() {
  for (const fn of listeners) {
    try { fn(state) } catch (e) { console.warn('[oa-runtime] listener failed', e) }
  }
}

function patch(next) {
  Object.assign(state, next)
  emit()
  registerPanels()
}

function useStore() {
  const [, force] = React.useState(0)
  React.useEffect(() => {
    const fn = () => force((n) => n + 1)
    listeners.add(fn)
    return () => listeners.delete(fn)
  }, [])
  return state
}

// ── 与 host 通信（同源）──────────────────────────────────────────────
async function call(path, init) {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  let body = null
  try { body = await response.json() } catch { body = null }
  if (!response.ok || !body || body.code !== 0) {
    const error = new Error((body && body.message) || `HTTP ${response.status}`)
    error.errorCode = (body && body.errorCode) || 'INTERNAL'
    error.status = response.status
    throw error
  }
  return body.data
}

const runtimeApi = {
  invoke(op, opts = {}) {
    return call('/api/oa/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, params: opts.params, query: opts.query, body: opts.body }),
    })
  },
  get status() { return state.status },
  get user() { return state.user },
  get capabilities() { return state.capabilities },
  has(capability) { return state.capabilities.has(capability) },
  registerModule(module) {
    modules.set(module.id, module)
    registerPanels()
    return () => { modules.delete(module.id) }
  },
  onStatus(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

// ── 模块面板注册 ─────────────────────────────────────────────────────
function iconFor(name) {
  // 目前只有日志一个图标；新增模块时在这里映射
  return IconListPenOutlineRegular
}

function registerPanels() {
  if (!slotCtx) return
  for (const module of modules.values()) {
    // 逐模块幂等：每个模块只注册一次，之后新增模块也能补上
    if (registeredModules.has(module.id)) continue
    // 未登录也注册：面板本身负责显示「去设置里登录」的提示，
    // 能力过滤交给面板（登录后能力才可知）
    const missingCapability = module.capability && !runtimeApi.has(module.capability)
    if (missingCapability && state.status === 'authenticated') continue
    registeredModules.add(module.id)
    const Icon = iconFor(module.icon)
    slotCtx.slots.inject('sidebar.panellist', () =>
      slotCtx.slots.register(
        { name: 'sidebar.panellist', id: module.id, order: module.order, label: () => module.title },
        function OaModuleIcon(props) {
          return React.createElement(Icon, { size: (props && props.size) || 16 })
        },
      ),
    )
    slotCtx.slots.inject('main', () =>
      slotCtx.slots.register({ name: 'main', key: module.id }, function OaModulePanel() {
        return React.createElement(module.panel, { runtime: runtimeApi, module })
      }),
    )
  }
}

// ── 设置：OA 连接 ────────────────────────────────────────────────────
/**
 * 设置页里的「OA 连接」：服务器地址、当前状态、退出登录。
 *
 * 登录之后引导页就不再出现，所以修改服务器必须有常驻入口——这是它存在的理由。
 */
function OaConnectionSection() {
  const s = useStore()
  const [url, setUrl] = React.useState('')
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    void (async () => {
      const settings = await loadSettings()
      setUrl((settings && settings.serverUrl) || '')
      setUsername((settings && settings.lastUsername) || '')
    })()
  }, [])

  async function saveServer(event) {
    event.preventDefault()
    if (busy) return
    setBusy('server')
    setError('')
    setMessage('')
    try {
      const result = await call('/api/oa/settings/server', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverUrl: url.trim() }),
      })
      setMessage(`已连接：${result.name || result.serverUrl}（${result.apiVersion || 'v1'}）`)
      await loadSettings()
      await boot()
    } catch (e) {
      setError(e.message || '连接失败')
    } finally {
      setBusy('')
    }
  }

  async function login(event) {
    event.preventDefault()
    if (busy) return
    setBusy('login')
    setError('')
    setMessage('')
    try {
      await call('/api/oa/session/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      setPassword('')
      await loadSettings()
      await boot()
      setMessage('登录成功')
    } catch (e) {
      const code = e.errorCode || ''
      setError(
        code === 'NETWORK'
          ? '无法连接服务器，请先检查上面的服务器地址'
          : code === 'NO_SERVER'
            ? '尚未配置服务器地址'
            : e.message || '登录失败',
      )
    } finally {
      setBusy('')
    }
  }

  async function logout() {
    try {
      await call('/api/oa/session/logout', { method: 'POST' })
    } catch {}
    patch({ status: 'anonymous', user: null, capabilities: new Set() })
    setMessage('已退出登录')
  }

  const sourceText = { user: '本机设置', env: '环境变量', config: '插件配置', none: '未配置' }
  const statusText = {
    authenticated: '已登录',
    anonymous: '未登录',
    offline: '连不上',
    booting: '连接中',
    blocked: '版本不兼容',
  }

  return React.createElement(
    'div',
    { style: styles.settingsSection },

    // ① 当前状态
    React.createElement(
      'div',
      { style: styles.settingsRow },
      React.createElement('span', { style: styles.settingsLabel }, '当前服务器'),
      React.createElement('span', { style: styles.settingsValue }, hostOf(s.settings && s.settings.serverUrl)),
      React.createElement('span', { style: styles.badge2 }, sourceText[(s.settings && s.settings.source) || 'none']),
      React.createElement(
        'span',
        { style: s.status === 'authenticated' ? styles.badgeOk : styles.badge2 },
        s.status === 'authenticated'
          ? `已登录：${(s.user && (s.user.nickname || s.user.username)) || ''}`
          : statusText[s.status] || s.status,
      ),
    ),

    // ② 地址
    React.createElement(
      'form',
      { style: styles.settingsForm, onSubmit: saveServer },
      React.createElement('input', {
        style: { ...styles.input, flex: 1, minWidth: 260 },
        placeholder: 'https://oa.example.com',
        value: url,
        onChange: (e) => setUrl(e.target.value),
      }),
      React.createElement(
        'button',
        { style: { ...styles.primary, opacity: busy === 'server' ? 0.6 : 1 }, type: 'submit', disabled: Boolean(busy) },
        busy === 'server' ? '连接中…' : '测试并保存',
      ),
    ),

    // ③ 登录（已登录时换成退出）
    s.status === 'authenticated'
      ? React.createElement(
          'div',
          { style: styles.settingsForm },
          React.createElement('button', { style: styles.link, type: 'button', onClick: logout }, '退出登录'),
        )
      : React.createElement(
          'form',
          { style: styles.settingsForm, onSubmit: login },
          React.createElement('input', {
            style: { ...styles.input, width: 160 },
            placeholder: 'OA 用户名',
            value: username,
            onChange: (e) => setUsername(e.target.value),
          }),
          React.createElement('input', {
            style: { ...styles.input, width: 160 },
            type: 'password',
            placeholder: '密码',
            value: password,
            onChange: (e) => setPassword(e.target.value),
          }),
          React.createElement(
            'button',
            { style: { ...styles.primary, opacity: busy === 'login' ? 0.6 : 1 }, type: 'submit', disabled: Boolean(busy) },
            busy === 'login' ? '登录中…' : '登录',
          ),
        ),

    s.status === 'blocked'
      ? React.createElement('div', { style: styles.settingsError }, s.blockedReason || '插件版本过低，请升级后重试。')
      : null,
    s.status === 'offline'
      ? React.createElement(
          'div',
          { style: styles.settingsHint },
          `连不上服务器${s.offlineReason ? `：${s.offlineReason}` : ''}。请确认地址与网络后点「测试并保存」。`,
        )
      : null,
    message ? React.createElement('div', { style: styles.settingsOk }, message) : null,
    error ? React.createElement('div', { style: styles.error }, error) : null,
    React.createElement(
      'div',
      { style: styles.settingsMuted },
      '这里是插件唯一的登录入口：登录一次后，重启 DSH 不需要再登录。',
    ),
  )
}

// ── 未接入服务器 ─────────────────────────────────────────────────────
/**
 * 单一服务器模式：没有服务器就等于什么都不能用。
 * 这一页要回答三件事：为什么用不了、找谁、怎么重试。
 */
// ── 登录页 ───────────────────────────────────────────────────────────
function hostOf(url) {
  if (!url) return '未配置'
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const styles = {
  input: { height: 40, padding: '0 12px', border: '1px solid #d0d3d9', borderRadius: 8, fontSize: 14 },
  error: { color: '#d93026', fontSize: 13 },
  primary: { height: 30, padding: '0 14px', border: 'none', borderRadius: 6, background: '#1f6feb', color: '#fff', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' },
  settingsSection: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 },
  settingsRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  settingsLabel: { fontSize: 13, color: '#646a73' },
  settingsValue: { fontSize: 13, fontWeight: 500 },
  settingsForm: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  settingsMuted: { fontSize: 12, color: '#8f959e' },
  settingsHint: { fontSize: 12, color: '#8a6d3b', background: '#fff8e6', border: '1px solid #ffe0a3', borderRadius: 6, padding: '6px 10px' },
  settingsOk: { fontSize: 12, color: '#1a7f37' },
  badge2: { fontSize: 11, color: '#4e5969', background: '#f2f3f5', borderRadius: 4, padding: '1px 6px' },
  badgeOk: { fontSize: 11, color: '#1a7f37', background: '#e8f5ec', borderRadius: 4, padding: '1px 6px' },
  settingsError: { fontSize: 12, color: '#d93026', background: '#fff1f0', border: '1px solid #ffccc7', borderRadius: 6, padding: '6px 10px' },
  link: { background: 'none', border: 'none', color: '#1f6feb', cursor: 'pointer', fontSize: 13, padding: 0 },
}

// ── 启动 ─────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const settings = await call('/api/oa/settings')
    patch({ settings })
    return settings
  } catch {
    return null
  }
}

async function fetchDiagnostics() {
  try {
    const diag = await call('/api/oa/diagnostics')
    patch({ diagnostics: diag })
    return diag
  } catch {
    return null
  }
}

async function boot() {
  try {
    const me = await call('/api/oa/session/me')
    patch({
      status: 'authenticated',
      user: me.user,
      capabilities: new Set(me.capabilities || []),
      error: '',
      offlineReason: '',
    })
  } catch (error) {
    const errorCode = error.errorCode || ''
    if (errorCode === 'NO_SERVER' || errorCode === 'NETWORK') {
      // 单一服务器模式：没有服务器就什么都做不了，直接引导接入
      const diag = await fetchDiagnostics()
      patch({
        status: 'offline',
        user: null,
        capabilities: new Set(),
        offlineReason: (diag && diag.message) || error.message,
      })
    } else {
      patch({ status: 'anonymous', user: null, capabilities: new Set(), offlineReason: '' })
    }
  }
}

// 跨包共享：两个 client bundle 各自打包，无法共享模块实例，
// 因此用 window 上的全局对象作为注册表（S1 未验证前的稳妥做法）。
function publishRuntime() {
  if (typeof window === 'undefined') return
  window.__OA_RUNTIME__ = runtimeApi
  try { window.dispatchEvent(new CustomEvent('oa-runtime:ready', { detail: runtimeApi })) } catch {}
}

export const inject = ['slots']

export function apply(ctx) {
  slotCtx = ctx
  publishRuntime()
  // 设置页的常驻入口：登录后引导页消失，修改服务器只能从这里进
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'oa-connection', order: 20, label: () => 'OA 连接' },
      OaConnectionSection,
    ),
  )
  // 首屏主路径先跑；设置与版本检查放后台（早期并发会挂住首个请求，见 D-037）
  boot()
  void (async () => {
    await loadSettings()
    const diag = await fetchDiagnostics()
    if (diag && diag.validUrl && diag.reachable && !diag.compatible) {
      patch({ status: 'blocked', blockedReason: diag.message })
    }
  })()
  console.log('[oa-runtime] client half ready')
}
