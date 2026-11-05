/**
 * @fm618/oa-worklog —— host 半部
 *
 * 只做一件事：向运行时声明本模块允许调用的服务端操作（白名单）。
 * 没有 fetch、没有令牌、没有地址。
 */
import type { OaRuntimeService } from '@fm618/oa-runtime'

/** 只需要 oaRuntime 一个服务 */
type WorklogContext = { oaRuntime: OaRuntimeService }

export const inject: string[] = ['oaRuntime']

export function apply(ctx: WorklogContext) {
  ctx.oaRuntime.defineOps({
    'worklog.list': { method: 'GET', path: '/api/client/v1/worklogs' },
    'worklog.create': { method: 'POST', path: '/api/client/v1/worklogs' },
    'worklog.update': { method: 'PUT', path: '/api/client/v1/worklogs/{id}' },
    'worklog.delete': { method: 'DELETE', path: '/api/client/v1/worklogs/{id}' },
  })
  console.info('[oa-worklog] 已声明 4 个工作日志操作')
}
