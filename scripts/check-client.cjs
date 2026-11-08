const path = require('path')
const { pathToFileURL } = require('url')
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  useMemo: (f) => f(),
  Fragment: 'Fragment',
}
const requireStub = (name) =>
  name === 'react'
    ? React
    : new Proxy({}, { get: () => function Stub() {} })

let captured = null
const runtime = {
  invoke: async () => ({ items: [], total: 0 }),
  has: () => true,
  status: 'authenticated',
  user: { id: 1, username: 'u', nickname: '用户' },
  capabilities: new Set(['worklog.use']),
  registerModule: (m) => { captured = m; return () => {} },
  onStatus: () => () => {},
}

global.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  location: { origin: 'http://localhost:3100' },
  __OA_RUNTIME__: runtime,
  __ModuleLoader__: { load({ factory }) { factory(requireStub) } },
}

// 用标准模块加载执行 bundle。
// 以前把读到的源码直接交给 eval 执行：静态扫描会把它标成「动态执行代码」，
// 而且 argv 指到任何文件都会被执行。bundle 顶层只调用 window.__ModuleLoader__.load(...)，
// 按模块加载执行，行为等价，也不再需要 eval。
;(async () => {
  try {
    await import(pathToFileURL(path.resolve(process.argv[2])).href)
  } catch (error) {
    console.error(`FAIL 加载失败（${process.argv[2]}）:`, error.message)
    process.exit(1)
  }

  if (!captured) { console.error('FAIL 模块未注册'); process.exit(1) }
  console.log(`注册成功: ${captured.id} / ${captured.title} / order=${captured.order}`)
  for (const status of ['authenticated', 'anonymous', 'offline']) {
    const stateRuntime = { ...runtime, status }
    try {
      const tree = captured.panel({ runtime: stateRuntime, module: captured })
      console.log(`  渲染 OK（status=${status}），根节点 type =`, typeof tree.type === 'function' ? tree.type.name : tree.type)
    } catch (error) {
      console.error(`FAIL 渲染抛错（status=${status}）:`, error.message)
      console.error(String(error.stack).split('\n').slice(0, 5).join('\n'))
      process.exit(1)
    }
  }
})()

