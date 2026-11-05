/**
 * OA 服务端 HTTP 客户端（纯 TS，不依赖 Cordis，便于单独测试）。
 *
 * 令牌只存在这个对象里：模块与浏览器都拿不到（ADR §6.2「只有 base 知道地址和 token」）。
 */
import { OaApiError } from '@dsh-oa/plugin-kit'

export interface OaClientConfig {
  serverUrl: string
  /** 设备类，与 DSH 设备类对齐（browser | dsh-plugin | desktop | mobile） */
  clientType?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface LoginResult {
  accessToken: string
  tokenType: string
  expiresIn: number
  kicked: boolean
  previousDevice: string | null
}

export interface MeResult {
  user: {
    id: number
    username: string
    nickname: string
    orgId: number | null
    orgName: string
    branchId: number | null
    branchName: string
  }
  capabilities: string[]
  modules: { id: string; enabled: boolean }[]
  serverTime: string
}

interface Envelope<T> {
  code: number
  message: string
  errorCode?: string
  data: T
}

export class OaClient {
  private serverUrl: string
  private readonly clientType: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private token: string | null = null

  constructor(config: OaClientConfig) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, '')
    this.clientType = config.clientType ?? 'dsh-plugin'
    this.fetchImpl = config.fetchImpl ?? fetch
    this.timeoutMs = config.timeoutMs ?? 15_000
  }

  get baseUrl(): string {
    return this.serverUrl
  }

  get authenticated(): boolean {
    return this.token !== null
  }

  /** 切换服务器：旧令牌属于旧服务器，必须一并清掉 */
  setServerUrl(serverUrl: string): void {
    this.serverUrl = serverUrl.replace(/\/+$/, '')
    this.token = null
  }

  /** 令牌原值；只给 host 内部的凭据持久化用，绝不下发到浏览器 */
  get tokenValue(): string | null {
    return this.token
  }

  /** 仅供测试/恢复会话使用；正常流程由 login 写入 */
  setToken(token: string | null): void {
    this.token = token
  }

  async discover(): Promise<{ features: string[]; minClientVersion: string; serverId: string }> {
    return this.request('GET', '/.well-known/oa-server')
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const result = await this.request<LoginResult>('POST', '/api/client/v1/auth/login', {
      body: { username, password },
      anonymous: true,
    })
    this.token = result.accessToken
    return result
  }

  async logout(): Promise<void> {
    if (!this.token) return
    try {
      await this.request('POST', '/api/client/v1/auth/logout')
    } finally {
      this.token = null
    }
  }

  async me(): Promise<MeResult> {
    return this.request('GET', '/api/client/v1/me')
  }

  /** 转发一次模块操作（op 已由 host 侧白名单校验） */
  async invoke<T = unknown>(
    method: string,
    path: string,
    opts: { params?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    const url = path.replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = opts.params?.[key]
      if (value === undefined) throw new OaApiError(`缺少路径参数 ${key}`, 400, 'VALIDATION', 400)
      return encodeURIComponent(String(value))
    })
    return this.request<T>(method, url, { query: opts.query, body: opts.body })
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown; anonymous?: boolean } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      'X-Client-Type': this.clientType,
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (!options.anonymous && this.token) headers.authorization = `Bearer ${this.token}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })
    } catch (error) {
      throw new OaApiError(
        error instanceof Error && error.name === 'AbortError'
          ? '请求超时，请检查网络或服务器地址'
          : `无法连接 OA 服务器：${error instanceof Error ? error.message : String(error)}`,
        0,
        'NETWORK',
        0,
      )
    } finally {
      clearTimeout(timer)
    }

    const requestId = response.headers.get('X-Request-ID') ?? undefined
    let envelope: Envelope<T> | null = null
    try {
      envelope = (await response.json()) as Envelope<T>
    } catch {
      envelope = null
    }

    if (!response.ok || !envelope || envelope.code !== 0) {
      const code = envelope?.code ?? response.status
      const errorCode = envelope?.errorCode ?? (response.ok ? 'INTERNAL' : `HTTP_${response.status}`)
      const message = envelope?.message ?? `请求失败（HTTP ${response.status}）`
      if (errorCode === 'UNAUTHENTICATED') this.token = null
      throw new OaApiError(message, code, errorCode, response.status, requestId)
    }
    return envelope.data
  }
}
