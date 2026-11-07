/**
 * 设置页「OA 连接」冒烟：用最小 React shim 跑一遍 client 半部（lib/client.js），
 * 确认注册出来的是「三项输入 + 一个按钮」，而不是退回两个按钮 / 少一个字段。
 *
 * 前置：`pnpm -C plugins/oa-runtime build`（读 lib/client.js）。
 * 运行：`node plugins/oa-runtime/scripts/smoke-settings.mjs`
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const element = (type, props, key) => ({ type, key, props: props || {} })

// 只实现这个分区用到的四个 hook；状态更新在 shim 里不重渲染，只校验首次渲染结构
const React = {
  createElement: (type, props, ...children) => element(type, { ...props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  Fragment: 'fragment',
}
const jsxRuntime = { jsx: element, jsxs: element, Fragment: 'fragment' }

function requireShim(id) {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return { IconListPenOutlineRegular: 'icon', IconLoadingOutlineRegular: 'icon' }
  }
  throw new Error(`unexpected require: ${id}`)
}

const registrations = new Map()
const ctx = {
  slots: {
    inject: (_name, register) => {
      register()
      return () => {}
    },
    register: (spec, component) => {
      registrations.set(spec.id, component)
      return () => {}
    },
  },
}

globalThis.window = {
  __ModuleLoader__: { load: ({ factory }) => (globalThis.__oaModule = factory(requireShim)) },
  addEventListener() {},
  dispatchEvent() {},
}
globalThis.CustomEvent = class {}
globalThis.fetch = async (requestPath) => ({
  ok: true,
  status: 200,
  json: async () => {
    const path = String(requestPath)
    if (path.includes('/api/oa/session/me')) {
      return {
        code: 0,
        message: 'ok',
        errorCode: 'OK',
        data: { user: { id: 1, username: 'shuser', nickname: '张三' }, capabilities: ['worklog.use'] },
      }
    }
    if (path.includes('/api/oa/settings')) {
      return {
        code: 0,
        message: 'ok',
        errorCode: 'OK',
        data: { serverUrl: 'https://oa.example.com', source: 'user', lastUsername: 'shuser' },
      }
    }
    return { code: 0, message: 'ok', errorCode: 'OK', data: null }
  },
})

vm.runInThisContext(readFileSync(path.resolve(HERE, '../lib/client.js'), 'utf8'))
const api = globalThis.__oaModule
if (!api || typeof api.apply !== 'function') throw new Error('client bundle 没有导出 apply')
api.apply(ctx)

const Section = registrations.get('oa-connection')
if (!Section) throw new Error('settings.section 里没有 oa-connection')

/** 把渲染树拍平成输入框 / 按钮 / 文本，方便断言 */
function inspect(tree) {
  const found = { inputs: [], buttons: [], texts: [] }
  ;(function walk(node) {
    if (node == null) return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node === 'string') return found.texts.push(node)
    if (node.type === 'input') found.inputs.push(node.props)
    if (node.type === 'button') found.buttons.push(node.props)
    if (node.props && node.props.children !== undefined) walk(node.props.children)
  })(tree)
  return found
}

const problems = []

// 未登录（首次渲染 status=booting）：三项表单 + 一个按钮 + 必填提示
const anonymous = inspect(Section({}))
if (anonymous.inputs.length !== 3) problems.push(`未登录：期望 3 个输入，实际 ${anonymous.inputs.length}`)
if (anonymous.buttons.length !== 1) problems.push(`未登录：期望 1 个按钮，实际 ${anonymous.buttons.length}`)
if (!anonymous.texts.includes('连接并登录')) problems.push('未登录：按钮文案不是「连接并登录」')
if (anonymous.inputs.filter((input) => input.type === 'password').length !== 1) problems.push('未登录：缺少密码框')

// 已登录：表单收起，只留「退出登录」；不能同时出现「已登录」和「还缺：密码」
await new Promise((resolve) => setTimeout(resolve, 30))
const authed = inspect(Section({}))
if (authed.inputs.length !== 0) problems.push(`已登录：表单应收起，实际 ${authed.inputs.length} 个输入`)
if (authed.buttons.length !== 1) problems.push(`已登录：期望只有 1 个按钮，实际 ${authed.buttons.length}`)
if (authed.buttons[0]?.children !== '退出登录') problems.push(`已登录：唯一按钮应是「退出登录」，实际 ${authed.buttons[0]?.children}`)
if (authed.texts.includes('切换服务器或账号')) problems.push('已登录：不应再有「切换服务器或账号」')
if (authed.texts.some((text) => String(text).startsWith('还缺：'))) problems.push('已登录：仍在显示「还缺：…」')
if (!authed.texts.includes('要修改连接信息，请先退出登录')) problems.push('已登录：缺少「先退出登录」的引导文案')

console.log('未登录：', anonymous.inputs.length, '个输入 /', anonymous.buttons.map((button) => button.children).join(' / '))
console.log('已登录：', authed.inputs.length, '个输入 /', authed.buttons.map((button) => button.children).join(' / '))
if (problems.length) {
  console.log(`FAIL\n - ${problems.join('\n - ')}`)
  process.exit(1)
}
console.log('PASS 设置分区结构（未登录常显表单 / 已登录收起表单）')
