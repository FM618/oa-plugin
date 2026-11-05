/**
 * 运行时设置：服务器地址等设备级配置。
 *
 * 位置：`$DSH_HOME/oa/runtime.json`（跟随 DSH 主目录，换 profile 不丢）。
 * 优先级：用户设置 > 环境变量 OA_SERVER_URL > 插件配置。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface RuntimeSettings {
  serverUrl?: string
  /** 上次登录的用户名，用于登录页预填（令牌不可用时的降级） */
  lastUsername?: string
}

export type ServerUrlSource = 'user' | 'env' | 'config' | 'none'

export function normalizeServerUrl(raw: string | null | undefined): string {
  const value = (raw ?? '').trim()
  if (!value) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

export class SettingsStore {
  readonly file: string

  constructor(home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')) {
    this.file = path.join(home, 'oa', 'runtime.json')
  }

  async read(): Promise<RuntimeSettings> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as RuntimeSettings) : {}
    } catch {
      return {}
    }
  }

  async write(settings: RuntimeSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  }
}

/** 解析最终使用的服务器地址，并说明它来自哪一层（设置页要展示） */
export function resolveServerUrl(
  stored: RuntimeSettings,
  envUrl: string | undefined,
  configUrl: string | undefined,
): { serverUrl: string; source: ServerUrlSource } {
  const fromUser = normalizeServerUrl(stored.serverUrl)
  if (fromUser) return { serverUrl: fromUser, source: 'user' }
  const fromEnv = normalizeServerUrl(envUrl)
  if (fromEnv) return { serverUrl: fromEnv, source: 'env' }
  const fromConfig = normalizeServerUrl(configUrl)
  if (fromConfig) return { serverUrl: fromConfig, source: 'config' }
  return { serverUrl: '', source: 'none' }
}
