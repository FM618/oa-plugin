/**
 * 连接流程冒烟：假 OA 服务器 + 真实 oa-runtime host 半部（dist）。
 *
 * 覆盖 D-079 的两条关键语义：
 * 1. 设置页「连接并登录」先用候选地址登录，成功才提交（写配置 / 切地址 / 存凭据）；
 * 2. 密码打错时，现有服务器、现有会话、现有配置都不动。
 *
 * 前置：`pnpm -C plugins/oa-runtime build`（读 dist/）。
 * 运行：`node plugins/oa-runtime/scripts/smoke-connect.mjs`
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.resolve(HERE, '../dist/index.js')
const { apply } = await import(pathToFileURL(ENTRY).href)

const { createServer } = http

/** 最小 OA 服务端：发现端点 + 登录 + me + 登出 */
function startServer({ name, id, user, password, minClientVersion = '0.0.1' }) {
  let serial = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const url = new URL(req.url, 'http://local')
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      if (url.pathname === '/.well-known/oa-server') {
        return send(200, {
          code: 0,
          message: 'ok',
          data: { name, serverId: id, apiVersion: 'v1', minClientVersion, features: ['worklog'] },
        })
      }
      if (url.pathname === '/api/client/v1/auth/login' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}')
        if (body.username !== user || body.password !== password) {
          return send(400, { code: 400, message: '用户名或密码错误', data: null })
        }
        serial += 1
        return send(200, {
          code: 0,
          message: 'ok',
          data: { accessToken: `token-${id}-${serial}`, tokenType: 'Bearer', expiresIn: 3600, kicked: false, previousDevice: null },
        })
      }
      if (url.pathname === '/api/client/v1/me') {
        const auth = req.headers.authorization || ''
        if (!auth.startsWith(`Bearer token-${id}-`)) {
          return send(401, { code: 401, message: '未登录', data: null })
        }
        return send(200, {
          code: 0,
          message: 'ok',
          data: {
            user: { id: 1, username: user, nickname: '张三', orgId: null, orgName: '', branchId: null, branchName: '' },
            capabilities: ['worklog.use'],
            modules: [],
            serverTime: new Date().toISOString(),
          },
        })
      }
      if (url.pathname === '/api/client/v1/auth/logout') return send(200, { code: 0, message: 'ok', data: null })
      return send(404, { code: 404, message: 'not found', data: null })
    })
  })
  // 只绑回环：假服务器不能被局域网访问
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** 端口是随机分配的，URL 按实际绑定地址拼，不写死回环 IP */
function originOf(server) {
  const { address, port } = server.address()
  return `http://${address.includes(':') ? `[${address}]` : address}:${port}`
}

const serverA = await startServer({ name: 'OA A', id: 'a', user: 'shuser', password: 'secret-a' })
const serverB = await startServer({ name: 'OA B', id: 'b', user: 'shuser', password: 'secret-b' })
const urlA = originOf(serverA)
const urlB = originOf(serverB)

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}: ${JSON.stringify(detail)}`)
  }
}

/** 每个场景一个干净的 DSH_HOME + 一份独立的 host 实例 */
async function newHost({ serverUrl, vaultSession }) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'oa-smoke-'))
  process.env.DSH_HOME = home
  mkdirSync(path.join(home, 'oa'), { recursive: true })
  if (serverUrl) {
    await fs.writeFile(path.join(home, 'oa', 'runtime.json'), JSON.stringify({ serverUrl, lastUsername: 'shuser' }), 'utf8')
  }

  const credentials = {
    store: vaultSession ? { 'oa-runtime/session': { kind: 'grant', payload: vaultSession } } : {},
    async readRecord(key) {
      return this.store[key]
    },
    async modifyRecord(key, mutate) {
      this.store[key] = mutate(this.store[key])
    },
    async deleteRecord(key) {
      delete this.store[key]
    },
  }

  const routes = new Map()
  const ctx = {
    provide() {},
    effect(fn) {
      const result = fn()
      if (result && typeof result.then === 'function') result.catch((error) => console.warn('[smoke] effect:', error.message))
    },
    inject(deps, callback) {
      if (deps.includes('connection')) {
        callback({
          ...ctx,
          connection: {
            fetch: {
              register: async (route) => {
                routes.set(route.path, route)
                return async () => {}
              },
            },
          },
        })
      } else if (deps.includes('credentials')) {
        callback({ ...ctx, credentials })
      }
    },
  }

  apply(ctx, { serverUrl: serverUrl || '' })
  await new Promise((resolve) => setTimeout(resolve, 150))

  const call = async (method, routePath, body) => {
    const route = routes.get(routePath)
    if (!route) throw new Error(`route missing: ${routePath}`)
    const init = { method, headers: { 'content-type': 'application/json' } }
    if (body !== undefined) init.body = JSON.stringify(body)
    const response = await route.fetch(new Request(`http://local${routePath}`, init))
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
    return { status: response.status, body: parsed }
  }

  return {
    call,
    credentials,
    settingsFile: path.join(home, 'oa', 'runtime.json'),
    readSettings: () => JSON.parse(readFileSync(path.join(home, 'oa', 'runtime.json'), 'utf8')),
  }
}

// ── 场景 1：已登录 A，切到 B；随后用错密码切回 A ────────────────────
console.log('场景 1：已登录 A → 换 B（原子提交）→ 密码错回 A（不动现有会话）')
{
  const host = await newHost({
    serverUrl: urlA,
    vaultSession: { serverUrl: urlA, token: 'token-a-1', expiresAt: Date.now() + 3_600_000 },
  })

  let me = await host.call('GET', '/api/oa/session/me')
  check('启动恢复 A 的会话', me.status === 200, me)

  const login = await host.call('POST', '/api/oa/session/login', {
    serverUrl: urlB,
    username: 'shuser',
    password: 'secret-b',
  })
  check('换到 B 登录成功（switched=true）', login.status === 200 && login.body.data.switched === true, login)

  me = await host.call('GET', '/api/oa/session/me')
  check('/me 走的是 B', me.status === 200 && me.body.data.user.nickname === '张三', me)
  check('runtime.json 写到 B', host.readSettings().serverUrl === urlB, host.readSettings())
  check('凭据里是 B 的令牌', host.credentials.store['oa-runtime/session'].payload.serverUrl === urlB, host.credentials.store)

  const wrong = await host.call('POST', '/api/oa/session/login', {
    serverUrl: urlA,
    username: 'shuser',
    password: 'wrong',
  })
  check('密码错：400 + 服务端原话', wrong.status === 400 && wrong.body.message === '用户名或密码错误', wrong)

  me = await host.call('GET', '/api/oa/session/me')
  check('密码错后仍登录在 B', me.status === 200, me)
  check('密码错后配置仍是 B', host.readSettings().serverUrl === urlB, host.readSettings())
  check('密码错后凭据仍是 B', host.credentials.store['oa-runtime/session'].payload.serverUrl === urlB, host.credentials.store)

  const again = await host.call('POST', '/api/oa/session/login', {
    serverUrl: urlB,
    username: 'shuser',
    password: 'secret-b',
  })
  check('同地址重登 switched=false', again.status === 200 && again.body.data.switched === false, again)

  // localhost:1 在本机必然拒绝：用来测「不可达」这条分支，且不引入字面量 IP
  const down = await host.call('POST', '/api/oa/diagnostics', { serverUrl: 'http://localhost:1' })
  check('不可达：reachable=false', down.status === 200 && down.body.data.reachable === false, down)
  check('不可达：一句人话', /连不上这个地址/.test(down.body.data.message || ''), down.body.data)

  const bad = await host.call('POST', '/api/oa/session/login', { serverUrl: 'ftp://x', username: 'shuser', password: 'x' })
  check('非法地址：400 VALIDATION', bad.status === 400 && bad.body.errorCode === 'VALIDATION', bad)
}

// ── 场景 2：全新安装，没有配置任何服务器 ─────────────────────────────
console.log('场景 2：未配置服务器 → 用候选地址首次登录')
{
  const host = await newHost({ serverUrl: '' })

  let me = await host.call('GET', '/api/oa/session/me')
  check('未配置时 /me 返回 NO_SERVER', me.status === 503 && me.body.errorCode === 'NO_SERVER', me)

  const login = await host.call('POST', '/api/oa/session/login', {
    serverUrl: urlB,
    username: 'shuser',
    password: 'secret-b',
  })
  check('首装候选地址登录成功', login.status === 200 && login.body.data.switched === true, login)

  me = await host.call('GET', '/api/oa/session/me')
  check('登录后 /me 立刻可用', me.status === 200 && me.body.data.user.username === 'shuser', me)
  check('runtime.json 写入 B', host.readSettings().serverUrl === urlB, host.readSettings())
  check('凭据写入 B', host.credentials.store['oa-runtime/session'].payload.serverUrl === urlB, host.credentials.store)
}

serverA.close()
serverB.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
