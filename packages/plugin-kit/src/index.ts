/**
 * @fm618/plugin-kit —— 插件契约（只有类型与一个错误类，不含业务、不含网络）
 */
import type { ComponentType } from 'react'

export interface OaUser {
  id: number
  username: string
  nickname: string
  orgId: number | null
  orgName: string
  branchId: number | null
  branchName: string
}

export type OaStatus = 'booting' | 'anonymous' | 'authenticated' | 'offline'

export interface OaModule {
  id: string
  title: string
  order: number
  capability?: string
  panel: ComponentType<OaPanelProps>
  icon?: string
}

export interface OaPanelProps {
  runtime: OaRuntimeApi
  module: OaModule
}

export interface OaInvokeOptions {
  /** 路径参数，如 { id: 12 } */
  params?: Record<string, string | number>
  /** 查询参数 */
  query?: Record<string, string | number | boolean | undefined | null>
  /** 请求体 */
  body?: unknown
  signal?: AbortSignal
}

/**
 * 模块能看到的运行时。
 * 注意：没有 baseUrl，也没有令牌——模块无法自己发请求。
 */
export interface OaRuntimeApi {
  /** 调用 host 侧声明的操作（白名单），返回 data */
  invoke<T = unknown>(op: string, opts?: OaInvokeOptions): Promise<T>

  readonly status: OaStatus
  readonly user: OaUser | null
  readonly capabilities: ReadonlySet<string>
  has(capability: string): boolean

  registerModule(module: OaModule): () => void
  onStatus(listener: (status: OaStatus) => void): () => void
}

export class OaApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly errorCode: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'OaApiError'
  }

  get isReplaced(): boolean {
    return this.errorCode === 'SESSION_REPLACED'
  }

  get isUnauthenticated(): boolean {
    return this.errorCode === 'UNAUTHENTICATED'
  }
}
