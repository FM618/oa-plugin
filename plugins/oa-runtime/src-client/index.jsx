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
 * 设置页里的「OA 连接」：当前连接 + 一个表单完成「连接并登录」。
 *
 * 为什么是一个按钮、两行输出（D-079）：
 * - 原来「测试并保存」只探活、不登录，第二个按钮才登录；两件事各自成功，
 *   状态行却只有一行，读起来像"新地址测试通过 = 已登录"；
 * - 现在按用户的心智顺序走：先证明服务器通，再用这组账号登录。两行各说一件事，
 *   第一行失败就不再尝试登录；
 * - 提交是原子的：两行都成功才写配置、切服务器、存令牌。密码打错时现有会话一点不动。
 *
 * 登录之后引导页就不再出现，所以修改服务器必须有常驻入口——这是它存在的理由。
 */
function OaConnectionSection() {
  const s = useStore()
  const [url, setUrl] = React.useState('')
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [loaded, setLoaded] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [lines, setLines] = React.useState([])

  React.useEffect(() => {
    void (async () => {
      const settings = await loadSettings()
      setUrl((settings && settings.serverUrl) || '')
      setUsername((settings && settings.lastUsername) || '')
      setLoaded(true)
    })()
  }, [])

  const missing = [
    !url.trim() && '服务器地址',
    !username.trim() && '用户名',
    !password && '密码',
  ].filter(Boolean)
  const ready = loaded && missing.length === 0
  const canSubmit = ready && !busy
  const authenticated = s.status === 'authenticated'
  // 已登录时只留「退出登录」：换服务器/换账号先退出，避免登录态与草稿互相打架
  const showForm = !authenticated

  /** 改输入就丢掉上一次的结果：那些行说的是"上一次那个地址/账号"，不该留在眼前 */
  const edit = (setter) => (event) => {
    setter(event.target.value)
    if (lines.length) setLines([])
  }

  /** 把第 index 行从「进行中」改成结果（行是追加的，位置固定） */
  function setLine(index, line) {
    setLines((prev) => {
      const next = prev.slice()
      next[index] = line
      return next
    })
  }

  async function connect(event) {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setLines([{ kind: 'pending', text: '正在检测服务器…' }])

    // ① 探活：地址格式、服务身份、版本兼容
    const diag = await fetchDiagnostics(url.trim())
    if (!diag) {
      setLine(0, { kind: 'fail', text: '检测请求没发出去，请稍后重试' })
      setBusy(false)
      return
    }
    if (!diag.validUrl || !diag.reachable) {
      setLine(0, { kind: 'fail', text: diag.message || '连不上这个地址' })
      setBusy(false)
      return
    }
    if (!diag.compatible) {
      setLine(0, { kind: 'fail', text: diag.message || '插件版本过低' })
      setBusy(false)
      return
    }
    setLine(0, {
      kind: 'ok',
      text: `服务器可达：${diag.serverName || hostOf(diag.serverUrl)}（${diag.apiVersion || 'v1'}${diag.latencyMs ? `，${diag.latencyMs}ms` : ''}）`,
    })

    // ② 登录：host 侧先在这台服务器上验证，成功了才落盘
    setLines((prev) => [...prev, { kind: 'pending', text: '正在登录…' }])
    let result
    try {
      result = await call('/api/oa/session/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverUrl: url.trim(), username: username.trim(), password }),
      })
    } catch (e) {
      setLine(1, { kind: 'fail', text: loginFailureText(e) })
      setBusy(false)
      return
    }

    // 客户端 bundle 可以热刷新，host 半部却要重启才换：旧 host 会忽略 serverUrl，
    // 悄悄登录到原来那台服务器。这种"半升级"必须在界面上拦住，不能显示成功。
    if (!result || !sameServer(result.serverUrl, url)) {
      setLine(1, { kind: 'fail', text: '插件服务端还是旧版本：这台服务器没被切换，请重启 DSH 后再试' })
      setBusy(false)
      return
    }

    setPassword('')
    await loadSettings()
    await boot()
    const who = (state.user && (state.user.nickname || state.user.username)) || username.trim()
    setLine(1, { kind: 'ok', text: `登录成功：${who}${result && result.kicked ? '（原设备已下线）' : ''}` })
    setBusy(false)
  }

  async function logout() {
    try {
      await call('/api/oa/session/logout', { method: 'POST' })
    } catch {}
    patch({ status: 'anonymous', user: null, capabilities: new Set() })
    setPassword('')
    setLines([])
  }

  const sourceText = { user: '本机设置', env: '环境变量', config: '插件配置', none: '未配置' }
  const statusText = {
    authenticated: '已登录',
    anonymous: '未登录',
    offline: '连不上',
    booting: '连接中',
    blocked: '版本不兼容',
  }

  return (
    <div style={styles.settingsSection}>
      {/* ① 当前连接：永远说"现在这条连接"是什么，不随输入框里的草稿变 */}
      <div style={styles.settingsRow}>
        <span style={styles.settingsLabel}>当前服务器</span>
        <span style={styles.settingsValue}>{hostOf(s.settings && s.settings.serverUrl)}</span>
        <span style={styles.badge2}>{sourceText[(s.settings && s.settings.source) || 'none']}</span>
        <span style={s.status === 'authenticated' ? styles.badgeOk : styles.badge2}>
          {s.status === 'authenticated'
            ? `已登录：${(s.user && (s.user.nickname || s.user.username)) || ''}`
            : statusText[s.status] || s.status}
        </span>
      </div>

      {/* 已登录：只留退出登录。换服务器/换账号先退出，避免两套状态同时出现 */}
      {authenticated ? (
        <div style={styles.settingsForm}>
          <button style={styles.link} type="button" disabled={busy} onClick={logout}>
            退出登录
          </button>
          <span style={styles.settingsMuted}>要修改连接信息，请先退出登录</span>
        </div>
      ) : null}

      {/* ② 三项一起填，一个按钮：只在未登录时出现 */}
      {showForm ? (
        <form style={styles.settingsForm} onSubmit={connect}>
          <input
            style={{ ...styles.input, flex: '1 1 100%', minWidth: 260 }}
            placeholder="服务器地址，如 https://oa.example.com"
            aria-label="服务器地址"
            autoComplete="url"
            value={url}
            disabled={busy}
            onChange={edit(setUrl)}
          />
          <input
            style={{ ...styles.input, width: 160 }}
            placeholder="OA 用户名"
            aria-label="OA 用户名"
            autoComplete="username"
            value={username}
            disabled={busy}
            onChange={edit(setUsername)}
          />
          <input
            style={{ ...styles.input, width: 160 }}
            type="password"
            placeholder="密码"
            aria-label="密码"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={edit(setPassword)}
          />
          <button
            style={{ ...styles.primary, opacity: canSubmit ? 1 : 0.55, cursor: canSubmit ? 'pointer' : 'not-allowed' }}
            type="submit"
            disabled={!canSubmit}
          >
            {busy ? '连接中…' : '连接并登录'}
          </button>
        </form>
      ) : null}
      {showForm && loaded && missing.length ? (
        <div style={styles.settingsMuted}>还缺：{missing.join('、')}</div>
      ) : null}

      {/* ③ 分步结果：第一行探服务器，第二行登录 */}
      {lines.length ? (
        <div style={styles.steps} aria-live="polite">
          {lines.map((line, index) => (
            <div
              key={index}
              style={line.kind === 'ok' ? styles.stepOk : line.kind === 'fail' ? styles.stepFail : styles.stepPending}
            >
              <span style={styles.stepIcon}>{line.kind === 'ok' ? '✓' : line.kind === 'fail' ? '✗' : '…'}</span>
              {line.text}
            </div>
          ))}
        </div>
      ) : null}

      {s.status === 'blocked' ? (
        <div style={styles.settingsError}>{s.blockedReason || '插件版本过低，请升级后重试。'}</div>
      ) : null}
      {s.status === 'offline' ? (
        <div style={styles.settingsHint}>
          {`连不上服务器${s.offlineReason ? `：${s.offlineReason}` : ''}。确认地址与网络后点「连接并登录」。`}
        </div>
      ) : null}
      <div style={styles.settingsMuted}>这里是插件唯一的登录入口：登录一次后，重启 DSH 不需要再登录。</div>
    </div>
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

/** 比较两个地址是不是同一台服务器（忽略大小写、尾斜杠） */
function sameServer(left, right) {
  try {
    const normalize = (value) => new URL(value).href.replace(/\/+$/, '')
    return normalize(left) === normalize(right)
  } catch {
    return false
  }
}

const styles = {
  input: { height: 40, padding: '0 12px', border: '1px solid #d0d3d9', borderRadius: 8, fontSize: 14 },
  primary: { height: 30, padding: '0 14px', border: 'none', borderRadius: 6, background: '#1f6feb', color: '#fff', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' },
  settingsSection: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 },
  settingsRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  settingsLabel: { fontSize: 13, color: '#646a73' },
  settingsValue: { fontSize: 13, fontWeight: 500 },
  settingsForm: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  settingsMuted: { fontSize: 12, color: '#8f959e' },
  settingsHint: { fontSize: 12, color: '#8a6d3b', background: '#fff8e6', border: '1px solid #ffe0a3', borderRadius: 6, padding: '6px 10px' },
  steps: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: '18px' },
  stepOk: { color: '#1a7f37' },
  stepFail: { color: '#d93026' },
  stepPending: { color: '#8f959e' },
  stepIcon: { display: 'inline-block', width: 14 },
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

/** 探活：给了地址就诊断那一个候选地址（设置页「连接并登录」第一步），否则诊断当前地址 */
async function fetchDiagnostics(serverUrl) {
  try {
    const diag = await call(
      '/api/oa/diagnostics',
      serverUrl
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serverUrl }),
          }
        : undefined,
    )
    patch({ diagnostics: diag })
    return diag
  } catch {
    return null
  }
}

/** 登录失败：服务端的原话最准（密码错就是「用户名或密码错误」），网络类错误补一句人话 */
function loginFailureText(error) {
  const code = (error && error.errorCode) || ''
  if (code === 'NETWORK') return '服务器刚才还通，但登录请求没发出去（网络断了或超时）'
  if (code === 'NO_SERVER') return '还没配置服务器地址'
  return (error && error.message) || '登录失败'
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
