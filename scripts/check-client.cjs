const fs = require('fs')
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
  location: { origin: 'http://127.0.0.1:3100' },
  __OA_RUNTIME__: runtime,
  __ModuleLoader__: { load({ factory }) { factory(requireStub) } },
}

eval(fs.readFileSync(process.argv[2], 'utf8'))
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
