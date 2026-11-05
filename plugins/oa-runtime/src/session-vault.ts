/**
 * 会话保险箱：把 OA 会话令牌存进 DSH 的凭据服务（per-plugin record）。
 *
 * 为什么用它而不是自己写文件：
 * - 凭据记录由 DSH 统一管理（`$DSH_HOME/.credentials.yaml`），不需要我们发明存储格式；
 * - 记录按 `<scope>/<id>` 归属，插件只能读写自己 scope 下的条目；
 * - 即便存储本身不是加密的，也避免了"自己造一套加密 + 把密钥放在同一个目录"的假安全。
 *
 * 服务不存在时（老版本 DSH / 精简组合）整个类降级为 no-op，不影响登录。
 */

/** 凭据记录是 `{ kind, payload }`，payload 对 seam 不透明，只有 owner 能解释 */
const RECORD_KEY = 'oa-runtime/session'

export interface StoredSession {
  /** 存的时候连的是哪个服务器；换服务器后不应沿用旧令牌 */
  serverUrl: string
  token: string
  /** 绝对过期时间（毫秒时间戳） */
  expiresAt: number
}

/** 只声明用到的三个方法，避免依赖具体包版本的类型细节 */
export interface CredentialApi {
  readRecord(key: unknown): Promise<unknown>
  modifyRecord(key: unknown, mutate: (current: unknown) => unknown): Promise<void>
  deleteRecord(key: unknown): Promise<void>
}

export class SessionVault {
  private credentials: CredentialApi | null = null

  get available(): boolean {
    return this.credentials !== null
  }

  attach(credentials: CredentialApi): void {
    this.credentials = credentials
  }

  async load(): Promise<StoredSession | null> {
    if (!this.credentials) return null
    try {
      const record = (await this.credentials.readRecord(RECORD_KEY)) as
        | { kind?: string; payload?: unknown }
        | undefined
      const payload = record?.payload
      if (!payload || typeof payload !== 'object') return null
      const candidate = payload as Partial<StoredSession>
      if (typeof candidate.token !== 'string' || !candidate.token) return null
      return {
        serverUrl: typeof candidate.serverUrl === 'string' ? candidate.serverUrl : '',
        token: candidate.token,
        expiresAt: typeof candidate.expiresAt === 'number' ? candidate.expiresAt : 0,
      }
    } catch (error) {
      console.warn('[oa-runtime] 读取凭据记录失败：', error instanceof Error ? error.message : String(error))
      return null
    }
  }

  async save(session: StoredSession): Promise<void> {
    if (!this.credentials) return
    try {
      await this.credentials.modifyRecord(RECORD_KEY, () => ({ kind: 'grant', payload: session }))
    } catch (error) {
      console.warn('[oa-runtime] 写入凭据记录失败：', error instanceof Error ? error.message : String(error))
    }
  }

  async clear(): Promise<void> {
    if (!this.credentials) return
    try {
      await this.credentials.deleteRecord(RECORD_KEY)
    } catch (error) {
      console.warn('[oa-runtime] 删除凭据记录失败：', error instanceof Error ? error.message : String(error))
    }
  }
}
