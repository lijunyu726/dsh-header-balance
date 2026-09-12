/**
 * 宿主半边（lib/index.js）的测试。
 *
 * 这里是本插件风险最高的部分：宿主半边的 `inject` 是**启动闸门**，装配错误
 * 会让整个 DSH 起不来；而 Remote 的标记若没写对，网关会报
 * `gateway/invocation-unavailable`，界面上只表现为一个空白芯片。
 *
 * 因此本文件不用打桩替身，而是**真的 import `@deepseek-ai/dsh-typert-protocol`**
 * 并断言 `remoteMethods()` 真的能读到标记。协议包是 DSH 运行时提供的 peer，
 * 本机由 scripts/link-host-deps.mjs 软链自已安装的 App；缺失时整体跳过。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

let protocol = null
try {
  protocol = await import('@deepseek-ai/dsh-typert-protocol')
} catch {
  protocol = null
}

const skip = protocol === null
  ? '未解析到 @deepseek-ai/dsh-typert-protocol（先跑 node scripts/link-host-deps.mjs）'
  : false

const mod = skip ? null : await import('../lib/index.js')
const { AccountBalanceService } = mod ?? {}

/**
 * 造一个够用的 Cordis 上下文桩。
 *
 * 关键点：
 * - `reflect.provide` 是 `Service` 构造函数必经之路（cordis/lib/index.js:1781）。
 *   真实实现走 `ctx.fiber.effect`，这里按它的**可观测效果**等价补齐：
 *   把 `{ type: 'service' }` 记进 `props` 并存下实例——网关的
 *   `collectSrcClaims()` 正是这样遍历 `ctx.reflect.props` 发现服务的。
 * - `credentials` / `settings` 必须能返回 undefined，用来验证软读取路径，
 *   这正是「不把可选服务写进 inject」所依赖的行为。
 *
 * @param services - 要提供的服务，键为服务名。
 * @returns 上下文桩。
 */
function fakeCtx(services = {}) {
  const provided = new Map()
  return {
    provided,
    reflect: {
      props: {},
      provide(name, value) {
        provided.set(name, value)
        this.props[name] = { type: 'service' }
      },
    },
    get(key) {
      return services[key]
    },
  }
}

/** 造一个 fetch 响应桩。 */
function fakeResponse({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

/** 造一个符合实测结构的余额响应体。 */
function payload(overrides = {}) {
  return {
    is_available: true,
    balance_infos: [
      {
        currency: 'CNY',
        total_balance: '12.34',
        granted_balance: '0.00',
        topped_up_balance: '12.34',
      },
    ],
    ...overrides,
  }
}

/**
 * 在受控的 fetch / 环境变量下跑一次 balance()。
 * @param options - 服务、响应、抛错与 API Key 来源。
 * @returns balance() 的返回值。
 */
async function runBalance({ ctx, response, throws, apiKey = 'sk-test-key' } = {}) {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.DEEPSEEK_API_KEY
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (throws !== undefined) throw throws
    return response
  }
  if (apiKey === null) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = apiKey

  try {
    const service = new AccountBalanceService(ctx ?? fakeCtx())
    const result = await service.balance()
    return { result, calls }
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = originalKey
  }
}

test('Remote 标记可被协议读出：方法为 balance、invocation 为 direct', { skip }, () => {
  const service = new AccountBalanceService(fakeCtx())
  const methods = protocol.remoteMethods(service)
  assert.deepEqual(methods, [{ method: 'balance', invocation: { kind: 'direct' } }])
})

test('构造即注册 accountBalance 服务，且 typertRemote 绑定自洽', { skip }, () => {
  const ctx = fakeCtx()
  const service = new AccountBalanceService(ctx)
  assert.equal(ctx.provided.get('accountBalance'), service)
  // 网关 readBinding 会逐字校验 serviceKey（dsh-api-gateway/lib/index.js:1002-1005）。
  assert.equal(service.typertRemote.serviceKey, 'accountBalance')
  assert.equal(service.typertRemote.namespace, 'accountBalance')
  assert.equal(service.typertRemote.service, service)
})

test('balance 是零参数方法（SRC 会解析参数名，签名不可随意改）', { skip }, () => {
  const service = new AccountBalanceService(fakeCtx())
  assert.equal(service.balance.length, 0)
})

test('成功路径：解析余额并用 Bearer 鉴权', { skip }, async () => {
  const { result, calls } = await runBalance({ response: fakeResponse({ body: payload() }) })
  assert.equal(result.ok, true)
  assert.equal(result.value.available, true)
  // 宿主负责把线上 snake_case 字符串解析成数字，浏览器侧只拿数字。
  assert.deepEqual(result.value.balances, [
    { currency: 'CNY', total: 12.34, granted: 0, toppedUp: 12.34 },
  ])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test-key')
})

test('API Key 绝不进入返回值', { skip }, async () => {
  const { result } = await runBalance({ response: fakeResponse({ body: payload() }) })
  assert.ok(!JSON.stringify(result).includes('sk-test-key'), '返回值里不应出现 API Key')
})

test('未配置 Key（凭据与环境变量都没有）→ balance/no-key，且不发起请求', { skip }, async () => {
  const { result, calls } = await runBalance({ response: fakeResponse({ body: payload() }), apiKey: null })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'balance/no-key')
  assert.match(result.error, /DEEPSEEK_API_KEY/)
  assert.equal(calls.length, 0, '没有 Key 就不该打网络')
})

test('凭据服务缺失时软回退到环境变量（不写进 inject 的理由）', { skip }, async () => {
  const ctx = fakeCtx() // get() 一律返回 undefined，模拟 credentials 未安装
  const { result } = await runBalance({ ctx, response: fakeResponse({ body: payload() }) })
  assert.equal(result.ok, true, '缺少凭据服务不应导致失败，应回退到 process.env')
})

test('凭据服务可用时优先走凭据', { skip }, async () => {
  const ctx = fakeCtx({
    credentials: { resolve: async () => ({ value: 'sk-from-credentials' }) },
  })
  const { calls } = await runBalance({ ctx, response: fakeResponse({ body: payload() }), apiKey: 'sk-from-env' })
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-from-credentials')
})

test('凭据解析抛错时静默回退到环境变量', { skip }, async () => {
  const ctx = fakeCtx({
    credentials: { resolve: async () => { throw new Error('keychain locked') } },
  })
  const { calls } = await runBalance({ ctx, response: fakeResponse({ body: payload() }), apiKey: 'sk-from-env' })
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-from-env')
})

test('HTTP 错误映射成可读原因', { skip }, async () => {
  const cases = [
    [401, /API Key 无效/],
    [402, /余额不足/],
    [403, /无权访问/],
    [429, /过于频繁/],
    [500, /服务异常/],
    [418, /HTTP 418/],
  ]
  for (const [status, pattern] of cases) {
    const { result } = await runBalance({ response: fakeResponse({ status, body: {} }) })
    assert.equal(result.ok, false, `HTTP ${status} 应为失败`)
    assert.equal(result.code, 'balance/http')
    assert.equal(result.status, status)
    assert.match(result.error, pattern, `HTTP ${status} 的原因文案不符`)
  }
})

test('响应格式异常 → balance/shape', { skip }, async () => {
  for (const body of [{}, { balance_infos: null }, { balance_infos: 'nope' }]) {
    const { result } = await runBalance({ response: fakeResponse({ body }) })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'balance/shape')
  }
})

test('超时与网络错误分别归类，且不误报成「未配置」', { skip }, async () => {
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  const first = await runBalance({ throws: timeout })
  assert.equal(first.result.code, 'balance/timeout')
  assert.match(first.result.error, /超时/)

  const network = Object.assign(new Error('fetch failed'), { name: 'TypeError' })
  const second = await runBalance({ throws: network })
  assert.equal(second.result.code, 'balance/network')
  assert.match(second.result.error, /无法连接/)
})

test('balance() 从不抛异常：任何失败都在带内返回', { skip }, async () => {
  // 让 ctx.get 本身爆炸，模拟最恶劣的装配环境。
  const ctx = fakeCtx()
  ctx.get = () => { throw new Error('ctx exploded') }
  const service = new AccountBalanceService(ctx)
  const result = await service.balance()
  assert.equal(result.ok, false)
  assert.ok(typeof result.error === 'string' && result.error.length > 0)
})

test('自定义 baseURL 生效并去掉尾部斜杠', { skip }, async () => {
  const ctx = fakeCtx({ settings: { get: () => ({ baseURL: 'https://proxy.example.com/v1//' }) } })
  const { calls } = await runBalance({ ctx, response: fakeResponse({ body: payload() }) })
  assert.equal(calls[0].url, 'https://proxy.example.com/v1/user/balance')
})

test('自定义 apiKeyEnv 生效', { skip }, async () => {
  const ctx = fakeCtx({ settings: { get: () => ({ apiKeyEnv: 'MY_OWN_KEY' }) } })
  const original = process.env.MY_OWN_KEY
  process.env.MY_OWN_KEY = 'sk-custom'
  try {
    const { calls } = await runBalance({ ctx, response: fakeResponse({ body: payload() }), apiKey: null })
    assert.equal(calls[0].init.headers.authorization, 'Bearer sk-custom')
  } finally {
    if (original === undefined) delete process.env.MY_OWN_KEY
    else process.env.MY_OWN_KEY = original
  }
})

test('缺少 is_available 字段时视为可用（旧响应不应误判）', { skip }, async () => {
  const body = { balance_infos: payload().balance_infos }
  const { result } = await runBalance({ response: fakeResponse({ body }) })
  assert.equal(result.ok, true)
  assert.equal(result.value.available, true)
})

test('is_available=false 时如实反映为不可用', { skip }, async () => {
  const { result } = await runBalance({
    response: fakeResponse({ body: payload({ is_available: false }) }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.available, false)
})

test('apply() 能构造服务（插件入口不抛）', { skip }, () => {
  const ctx = fakeCtx()
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(ctx.provided.get('accountBalance') instanceof AccountBalanceService, true)
})

test('inject 为空：可选服务不得进入启动闸门', { skip }, () => {
  // 声明了却拿不到的服务会让插件永久 pending，进而导致宿主启动失败。
  assert.deepEqual(mod.inject, [])
  assert.equal(mod.name, 'dsh-balance-chip')
})
