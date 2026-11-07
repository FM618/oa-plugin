/**
 * @fm618/oa-runtime —— host 半部（BFF）
 *
 * 职责：
 * 1. 持有服务器地址与令牌（模块与浏览器都拿不到）
 * 2. 向浏览器暴露固定路由：会话三件套 + 一次白名单调用
 * 3. 给业务模块提供 defineOps / invoke 服务
 *
 * 路由是**固定路径 + 操作白名单**，不是通用代理（ADR §9.1 第 1 条）。
 */
import { OaApiError } from './contract.js'

import { OaClient } from './oa-client.js'
import { SessionVault, type CredentialApi } from './session-vault.js'
import { SettingsStore, normalizeServerUrl, resolveServerUrl } from './settings.js'
import { diagnose } from './diagnostics.js'
import type { OaOperation, OaRuntimeService, RuntimeContext } from './context.js'

export type { OaOperation, OaRuntimeService, RuntimeContext } from './context.js'

// 契约对外可见：模块作者从本包 import 类型与错误类，不再有单独的 kit 包
export type {
  OaUser,
  OaStatus,
  OaModule,
  OaPanelProps,
  OaInvokeOptions,
  OaRuntimeApi,
} from './contract.js'
export { OaApiError } from './contract.js'

export interface RuntimeConfig {
  /** OA 服务端地址，如 https://oa.example.com */
  serverUrl: string
  /** 设备类，默认 dsh-plugin（与会话槽位一致） */
  clientType?: string
}

export const inject: string[] = []

const ROUTE_LOGIN = '/api/oa/session/login'
const ROUTE_LOGOUT = '/api/oa/session/logout'
const ROUTE_ME = '/api/oa/session/me'
const ROUTE_INVOKE = '/api/oa/invoke'

interface Ok<T> {
  code: 0
  message: 'ok'
  errorCode: 'OK'
  data: T
}

function ok<T>(data: T): Ok<T> {
  return { code: 0, message: 'ok', errorCode: 'OK', data }
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fail(error: unknown): Response {
  if (error instanceof OaApiError) {
    return respond(
      { code: error.code || 500, message: error.message, errorCode: error.errorCode, data: null },
      error.status >= 400 ? error.status : 502,
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return respond({ code: 500, message, errorCode: 'INTERNAL', data: null }, 500)
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text()
    if (!text) return {}
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new OaApiError('请求体不是合法 JSON', 400, 'VALIDATION', 400)
  }
}

export function apply(ctx: RuntimeContext, config: RuntimeConfig) {
  if (!config?.serverUrl) {
    console.warn('[oa-runtime] 未配置 serverUrl，未登录状态下不可用')
  }
  const settingsStore = new SettingsStore()
  // apply 是同步的：先用插件配置/环境变量起一个 client，读到 runtime.json 后再补正
  const initial = resolveServerUrl({}, process.env.OA_SERVER_URL, config?.serverUrl)
  const client = new OaClient({ serverUrl: initial.serverUrl, clientType: config?.clientType })
  let serverUrlSource: string = initial.source
  const ops = new Map<string, OaOperation>()
  const vault = new SessionVault()

  let settingsReady = false
  let restoreAttempt: Promise<void> | null = null
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  /** 只真正恢复一次；失败只记日志，不影响后续请求 */
  function ensureRestore(): Promise<void> {
    restoreAttempt ??= restoreSession().catch((error) => {
      console.warn('[oa-runtime] 恢复会话失败：', error instanceof Error ? error.message : String(error))
    })
    return restoreAttempt
  }

  /**
   * 等"设置就绪 + 凭据服务就绪"后完成一次恢复。
   *
   * 客户端 boot() 在页面一加载就请求 /me，而恢复是异步的（读 runtime.json、挂凭据服务）。
   * 不等待就会出现"重启后明明有会话，界面却显示未登录"——登录态没丢，是竞态。
   * 上限 2.5 秒；超时按未登录处理，不能把界面卡死。
   */
  async function waitForRestore(timeoutMs = 2500): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!settingsReady && Date.now() < deadline) await sleep(20)
    // 凭据服务是软依赖：通常同一 tick 就挂上，额外给 200ms
    const credentialDeadline = Math.min(deadline, Date.now() + 200)
    while (!vault.available && Date.now() < credentialDeadline) await sleep(20)
    if (vault.available && client.baseUrl) await ensureRestore()
  }

  /** 启动时尝试恢复上次的会话（令牌在凭据服务里，不在浏览器里） */
  async function restoreSession() {
    const saved = await vault.load()
    if (!saved) return
    if (saved.serverUrl !== client.baseUrl) {
      // 换服务器了，旧令牌对新服务器无意义
      await vault.clear()
      return
    }
    if (!saved.token || saved.expiresAt <= Date.now()) {
      await vault.clear()
      return
    }
    client.setToken(saved.token)
    console.info('[oa-runtime] 已从凭据服务恢复上次会话（重启无需重新登录）')
  }

  /** 令牌交给凭据服务：重启后免登录（D-034）。存不进去只影响免登录，不影响本次登录 */
  async function rememberSession(expiresIn: number): Promise<void> {
    const token = client.tokenValue
    if (!token) return
    await vault.save({
      serverUrl: client.baseUrl,
      token,
      expiresAt: Date.now() + expiresIn * 1000,
    })
  }

  const notConfigured = () =>
    respond(
      { code: 503, message: '尚未接入 OA 服务器：请让管理员配置服务器地址', errorCode: 'NO_SERVER', data: null },
      503,
    )
  const hasServer = () => Boolean(client.baseUrl)

  const service: OaRuntimeService = {
    defineOps(defs) {
      for (const [name, def] of Object.entries(defs)) {
        if (ops.has(name)) console.warn(`[oa-runtime] 操作重复声明：${name}`)
        ops.set(name, def)
      }
    },
    async invoke(op, opts = {}) {
      const def = ops.get(op)
      if (!def) throw new OaApiError(`未声明的操作：${op}`, 400, 'VALIDATION', 400)
      return client.invoke(def.method, def.path, opts)
    },
    client,
  }

  ctx.provide('oaRuntime', service)

  // 异步补正：runtime.json 里的用户设置优先级最高
  void (async () => {
    const stored = await settingsStore.read()
    const resolved = resolveServerUrl(stored, process.env.OA_SERVER_URL, config?.serverUrl)
    if (resolved.serverUrl !== client.baseUrl) {
      client.setServerUrl(resolved.serverUrl)
      console.info(`[oa-runtime] 使用设置文件中的服务器地址：${resolved.serverUrl || '(未配置)'}`)
    }
    serverUrlSource = resolved.source
  })().catch((error) => {
    console.warn('[oa-runtime] 读取设置失败：', error instanceof Error ? error.message : String(error))
  }).finally(() => {
    settingsReady = true
  })
  void (async () => {
    while (!settingsReady) await sleep(20)
    if (vault.available && client.baseUrl) await ensureRestore()
  })()

  // credentials 是软依赖：组合里没有凭据服务时，退化为"重启后需重新登录"
  ctx.inject(['credentials'], async (credCtx) => {
    const credentials = (credCtx as unknown as { credentials: CredentialApi }).credentials
    vault.attach(credentials)
    if (settingsReady && client.baseUrl) await ensureRestore()
  })

  // connection 是软依赖：仅 DSH Web / 桌面载体提供
  ctx.inject(['connection'], (connCtx) => {
    const connection = (connCtx as unknown as { connection: { fetch: { register(route: unknown): () => Promise<void> } } }).connection

    const routes = [
      {
        path: '/api/oa/settings',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          const stored = await settingsStore.read()
          const resolved = resolveServerUrl(stored, process.env.OA_SERVER_URL, config?.serverUrl)
          return respond(ok({
            serverUrl: resolved.serverUrl,
            source: resolved.source,
            active: client.baseUrl,
            lastUsername: stored.lastUsername ?? null,
          }))
        },
      },
      {
        path: '/api/oa/diagnostics',
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          let candidate = client.baseUrl
          if (request.method === 'POST') {
            const body = await readJson(request)
            // 显式传了地址就只认它：非法地址应报错，不能悄悄回退到当前服务器
            if (typeof body.serverUrl === 'string') candidate = normalizeServerUrl(body.serverUrl)
          }
          return respond(ok(await diagnose(candidate, config?.clientType)))
        },
      },
      {
        path: '/api/oa/settings/server',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          try {
            const body = await readJson(request)
            const candidate = normalizeServerUrl(String(body.serverUrl ?? ''))
            if (!candidate) {
              return respond({ code: 400, message: '服务器地址不合法（需以 http:// 或 https:// 开头）', errorCode: 'VALIDATION', data: null }, 400)
            }
            // 先探活再保存：地址写错了不该污染配置
            const probe = await diagnose(candidate, config?.clientType)
            if (!probe.reachable) {
              return respond({ code: 400, message: probe.message ?? '连不上这个地址', errorCode: 'UNREACHABLE', data: null }, 400)
            }
            if (!probe.compatible) {
              return respond({ code: 400, message: probe.message ?? '插件版本过低', errorCode: 'INCOMPATIBLE', data: null }, 400)
            }
            const stored = await settingsStore.read()
            await settingsStore.write({ ...stored, serverUrl: candidate })
            // 地址没变就只更新配置：照旧清令牌/清凭据的话，
            // 用户点一次「测试并保存」就会被无声注销
            if (candidate !== client.baseUrl) {
              client.setServerUrl(candidate)
              await vault.clear()
              restoreAttempt = null
              await ensureRestore()
            }
            return respond(ok({ serverUrl: candidate, name: probe.serverName ?? '', apiVersion: probe.apiVersion ?? '' }))
          } catch (error) {
            return fail(error)
          }
        },
      },
      {
        path: ROUTE_LOGIN,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          try {
            const body = await readJson(request)
            const username = String(body.username ?? '').trim()
            const password = String(body.password ?? '')
            if (!username || !password) {
              return respond({ code: 400, message: '用户名与密码不能为空', errorCode: 'VALIDATION', data: null }, 400)
            }

            // 候选地址：设置页「连接并登录」把用户刚填的地址一并带上来。
            // 先在这台服务器上登录，两步都成功才提交（写设置、切地址、存令牌）——
            // 密码打错时现有会话与地址一点不动（D-079）。
            const hasCandidate = body.serverUrl !== undefined && body.serverUrl !== null
            const candidate = hasCandidate ? normalizeServerUrl(String(body.serverUrl ?? '')) : ''
            if (hasCandidate && !candidate) {
              return respond({ code: 400, message: '服务器地址不合法（需以 http:// 或 https:// 开头）', errorCode: 'VALIDATION', data: null }, 400)
            }

            // 先等启动恢复结束：否则它在提交之后才跑，会用旧凭据覆盖/清掉刚存的会话
            await waitForRestore()

            if (candidate && candidate !== client.baseUrl) {
              const probe = new OaClient({ serverUrl: candidate, clientType: config?.clientType })
              const result = await probe.login(username, password)
              restoreAttempt = Promise.resolve()
              const stored = await settingsStore.read()
              await settingsStore.write({ ...stored, serverUrl: candidate, lastUsername: username })
              client.setServerUrl(candidate)
              client.setToken(probe.tokenValue)
              await rememberSession(result.expiresIn)
              return respond(ok({ ...result, serverUrl: candidate, switched: true }))
            }

            if (!hasServer()) return notConfigured()
            const result = await client.login(username, password)
            restoreAttempt = Promise.resolve()
            // 记住用户名：即使日后令牌不可用，登录页也能预填
            const stored = await settingsStore.read()
            await settingsStore.write({ ...stored, lastUsername: username })
            await rememberSession(result.expiresIn)
            return respond(
              ok({ ...result, serverUrl: client.baseUrl, switched: false }),
            )
          } catch (error) {
            return fail(error)
          }
        },
      },
      {
        path: ROUTE_LOGOUT,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            await client.logout()
            await vault.clear()
            return respond(ok(null))
          } catch (error) {
            return fail(error)
          }
        },
      },
      {
        path: ROUTE_ME,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            // 页面一加载就可能打到这里：先等 host 把令牌从凭据服务恢复出来
            await waitForRestore()
            if (!hasServer()) return notConfigured()
            if (!client.authenticated) {
              return respond({ code: 401, message: '未登录', errorCode: 'UNAUTHENTICATED', data: null }, 401)
            }
            return respond(ok(await client.me()))
          } catch (error) {
            if (error instanceof OaApiError && error.isUnauthenticated) await vault.clear()
            return fail(error)
          }
        },
      },
      {
        path: ROUTE_INVOKE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          try {
            // 页面一加载就可能打到这里：先等 host 把令牌从凭据服务恢复出来
            await waitForRestore()
            if (!hasServer()) return notConfigured()
            if (!client.authenticated) {
              return respond({ code: 401, message: '未登录', errorCode: 'UNAUTHENTICATED', data: null }, 401)
            }
            const body = await readJson(request)
            const op = String(body.op ?? '')
            const result = await service.invoke(op, {
              params: body.params as Record<string, string | number> | undefined,
              query: body.query as Record<string, unknown> | undefined,
              body: body.body,
            })
            return respond(ok(result))
          } catch (error) {
            return fail(error)
          }
        },
      },
    ]

    for (const route of routes) {
      connCtx.effect(() => connection.fetch.register(route), `oa-runtime: ${route.path}`)
    }
    console.info(`[oa-runtime] BFF 路由已注册（${routes.length} 条），服务端=${client.baseUrl}`)
  })
}
