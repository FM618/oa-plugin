/**
 * 连接诊断：把「连不上」拆成可解释的几种情况。
 *
 * 顺序：地址格式 → 网络可达 → 服务端身份 → 版本兼容。
 * 每一步失败都给一句人能看懂的话，而不是一个 fetch 错误。
 */
import { OaApiError } from './contract.js'

import { OaClient } from './oa-client.js'
import { normalizeServerUrl } from './settings.js'

/** 客户端版本；发版时必须与本包 version 同步（见 scripts/check-version.mjs） */
export const CLIENT_VERSION = '0.1.1'

export interface Diagnostics {
  serverUrl: string
  reachable: boolean
  /** 地址格式是否合法 */
  validUrl: boolean
  serverName?: string
  serverId?: string
  apiVersion?: string
  minClientVersion?: string
  features?: string[]
  clientVersion: string
  /** 客户端版本是否满足服务端要求 */
  compatible: boolean
  latencyMs?: number
  message?: string
}

/** 只比较 major.minor.patch；预发布后缀按字符串比较兜底 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [aMain, bMain] = [split(a), split(b)]
  for (let i = 0; i < 3; i += 1) {
    const left = aMain[i] ?? 0
    const right = bMain[i] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

export async function diagnose(rawUrl: string, clientType?: string): Promise<Diagnostics> {
  const serverUrl = normalizeServerUrl(rawUrl)
  const base: Diagnostics = {
    serverUrl,
    validUrl: Boolean(serverUrl),
    reachable: false,
    clientVersion: CLIENT_VERSION,
    compatible: true,
  }

  if (!serverUrl) {
    return { ...base, message: '地址格式不合法（需要以 http:// 或 https:// 开头）' }
  }

  const probe = new OaClient({ serverUrl, clientType, timeoutMs: 8000 })
  const startedAt = Date.now()
  try {
    const info = (await probe.discover()) as {
      name?: string
      serverId?: string
      apiVersion?: string
      minClientVersion?: string
      features?: string[]
    }
    const latencyMs = Date.now() - startedAt
    const minVersion = info.minClientVersion ?? '0.0.0'
    const compatible = compareVersions(CLIENT_VERSION, minVersion) >= 0
    return {
      ...base,
      reachable: true,
      serverName: info.name,
      serverId: info.serverId,
      apiVersion: info.apiVersion,
      minClientVersion: minVersion,
      features: info.features ?? [],
      compatible,
      latencyMs,
      message: compatible
        ? undefined
        : `插件版本过低：服务端要求至少 ${minVersion}，当前 ${CLIENT_VERSION}`,
    }
  } catch (error) {
    const reason = error instanceof OaApiError ? error.message : String(error)
    return { ...base, message: `连不上这个地址：${reason}` }
  }
}
