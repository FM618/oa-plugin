/**
 * 运行时对外的服务接口 + Cordis 上下文的最小结构子集。
 *
 * 这里不直接依赖 cordis 的具体类型（版本间 mixin 声明有差异），
 * 只声明本插件实际用到的四个成员；多余成员由 `[key: string]: unknown` 兜住。
 */
import type { OaClient } from './oa-client.js'

export interface OaOperation {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** 相对 OA 服务端的路径，支持 {id} 占位 */
  path: string
}

export interface OaRuntimeService {
  /** 模块在 host 侧声明可用操作；不在表里的 op 一律拒绝 */
  defineOps(defs: Record<string, OaOperation>): void
  invoke(op: string, opts?: {
    params?: Record<string, string | number>
    query?: Record<string, unknown>
    body?: unknown
  }): Promise<unknown>
  readonly client: OaClient
}

/** 插件在 host 侧拿到的上下文（只用这几个成员） */
export interface RuntimeContext {
  provide(name: string, value: unknown): void
  inject(deps: string[], callback: (ctx: RuntimeContext) => void): void
  effect(execute: () => unknown, label?: string): void
  [key: string]: unknown
}
