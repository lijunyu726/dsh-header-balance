/**
 * 浏览器半边（lib/client.js）的契约测试。
 *
 * 目的不是复测余额逻辑（那在 balance.test.js 与 host-service.test.js 里），
 * 而是抓打包错误：宿主把客户端半边当普通脚本加载，缺
 * `__ModuleLoader__.load()` 调用、id 与包名不一致、require 了平台不认识的
 * 模块，都会被报成 "loaded without registering"，或只在浏览器控制台留一句
 * `missed the module table`——语法检查完全看不到。
 *
 * 其中的 require 模拟**刻意比真实宿主更严格**：只放行平台 seed 字面量。
 * 早先在一个姊妹插件里，测试为了让 `require('<包名>/<子路径>')` 通过而注入
 * 了 Node 版解析当后门，结果把「浏览器里必然抛错」的 bug 掩盖了整个发布
 * 周期。这里不再重蹈。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const bundle = readFileSync(path.join(root, 'lib/client.js'), 'utf8')

/** 宿主 bundle 解析器认识的平台 seed（dsh-client-modules/lib/client.js:296-310）。 */
const PLATFORM_SEEDS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'dsh-client-store',
  'dsh-client-ui-slots',
  'dsh-client-ui-primitives',
  'dsh-client-ui-dockkit',
]

/** 假的 react：记录 createElement 调用，useRef/useCallback 等按最小语义实现。 */
function fakeReact() {
  const calls = []
  return {
    calls,
    react: {
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: (fn) => {
        fn()
      },
      useCallback: (fn) => fn,
      useRef: (initial) => ({ current: initial }),
      createElement: (...args) => {
        calls.push(args)
        return { type: args[0], props: args[1] ?? {}, children: args.slice(2) }
      },
    },
  }
}

/** 最小 DOM / window 替身，只覆盖 bundle 实际用到的 API。 */
function fakeDom() {
  const headChildren = []
  const document = {
    head: {
      appendChild: (el) => {
        headChildren.push(el)
      },
    },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
  }
  const window = {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    open: () => {},
  }
  return { document, window, headChildren }
}

/**
 * 在沙箱里加载 bundle。
 * @returns 模块注册记录、请求过的模块名、DOM 替身与宿主 require。
 */
function loadBundle() {
  const { calls, react } = fakeReact()
  const dom = fakeDom()
  const loaded = []
  const required = []
  const hostRequire = (id) => {
    required.push(id)
    if (id === 'react') return react
    if (PLATFORM_SEEDS.includes(id)) return {}
    throw new Error(
      `client-modules: require("${id}") missed the module table — ` +
        'not a platform seed word, not a materialized module, and no registered package factory',
    )
  }
  const sandbox = {
    window: Object.assign(dom.window, {
      __ModuleLoader__: {
        load: (definition) => {
          loaded.push(definition)
        },
      },
    }),
    document: dom.document,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(bundle, sandbox, { filename: 'lib/client.js' })
  return { loaded, required, calls, dom, hostRequire }
}

/** 执行 factory，返回模块 exports。 */
function loadModule(harness) {
  return harness.loaded[0].factory(harness.hostRequire)
}

test('bundle 恰好调用一次 __ModuleLoader__.load', () => {
  const { loaded } = loadBundle()
  assert.equal(loaded.length, 1, '必须且只能注册一个模块')
})

test('注册的 id 与 package.json 的包名一致', () => {
  const { loaded } = loadBundle()
  assert.equal(loaded[0].id, pkg.name)
})

test('factory 返回 apply / inject，且 inject 声明 slots 与 connection', () => {
  const harness = loadBundle()
  const module = loadModule(harness)
  assert.equal(typeof module.apply, 'function')
  // vm 沙箱里的数组与测试 realm 原型不同，只比较元素与顺序。
  assert.deepEqual([...module.inject], ['slots', 'connection'])
  assert.equal(module.name, pkg.name)
})

test('bundle 自包含：运行时只请求平台 seed 字面量', () => {
  const harness = loadBundle()
  loadModule(harness)
  assert.ok(harness.required.length > 0, 'factory 应当至少 require 了 react')
  for (const id of harness.required) {
    assert.ok(
      PLATFORM_SEEDS.includes(id),
      `bundle 请求了非 seed 模块 "${id}"；宿主解析器只认平台 seed 与已注册的包 id，` +
        '自身子路径必然抛 missed the module table',
    )
  }
})

test('bundle 不请求本包的任何子路径', () => {
  const harness = loadBundle()
  loadModule(harness)
  const offenders = harness.required.filter((id) => id.startsWith(`${pkg.name}/`))
  assert.deepEqual(offenders, [], `bundle 不得 require 自身子路径：${offenders.join(', ')}`)
})

test('内联段确实包含全部展示逻辑', () => {
  for (const symbol of [
    'currencySymbol',
    'formatMoney',
    'describeBalance',
    'CURRENCY_SYMBOLS',
    'DEFAULT_CURRENCY',
  ]) {
    assert.ok(bundle.includes(symbol), `bundle 缺少内联符号 ${symbol}，请运行 npm run build:bundle`)
  }
})

test('dsh.client 声明正确，且不引用 remote.* 命名空间', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-connection'])
  // remote.<ns> 只为官方 strict 贡献挂载；社区插件引用它会让插件永久 pending，
  // 并把宿主启动一起拖垮。
  assert.ok(!bundle.includes("'remote."), 'bundle 不得依赖 remote.* 命名空间')
  assert.ok(!bundle.includes('"remote.'), 'bundle 不得依赖 remote.* 命名空间')
})

test('apply 把芯片注册进会话头部工具区，并通过 inject 交出 connection', () => {
  const harness = loadBundle()
  const module = loadModule(harness)
  const registrations = []
  const injections = []
  const fakeConnection = { rpc: { call: async () => ({ ok: false }) } }
  module.apply({
    get: (key) => (key === 'connection' ? fakeConnection : undefined),
    slots: {
      inject: (name, fn) => {
        injections.push(name)
        fn()
      },
      register: (options, component) => registrations.push({ options, component }),
    },
  })
  assert.deepEqual(injections, ['conversation.session.header.utilities'])
  assert.equal(registrations.length, 1)
  const { options } = registrations[0]
  assert.equal(options.name, 'conversation.session.header.utilities')
  assert.equal(options.id, 'balance-chip')
  assert.equal(typeof options.order, 'number')
  // 槽位渲染时不传 props，服务必须经 inject 选项交进去。
  assert.equal(typeof options.inject, 'function')
  assert.equal(options.inject().connection, fakeConnection)
})

test('组件渲染出余额文本、刷新按钮，并注入样式表', () => {
  const harness = loadBundle()
  const module = loadModule(harness)
  const registrations = []
  module.apply({
    get: () => ({ rpc: { call: async () => ({ ok: false, error: 'x' }) } }),
    slots: {
      inject: (_name, fn) => fn(),
      register: (_options, component) => registrations.push(component),
    },
  })
  // 模拟槽位渲染：以 inject 选项提供的服务作为 props。
  const Chip = registrations[0]
  const tree = Chip({ connection: { rpc: { call: async () => ({ ok: false }) } } })

  const texts = harness.calls
    .map((args) => args.slice(2).flat(Infinity))
    .flat()
    .filter((v) => typeof v === 'string')
  assert.ok(texts.includes('余额'), `未渲染出「余额」标签，实际：${JSON.stringify(texts)}`)
  assert.ok(texts.includes('↻'), '未渲染出刷新按钮')
  assert.ok(tree.props.title !== undefined, '应带悬停说明')
  assert.equal(harness.dom.headChildren.length, 1, '样式表应注入一次')
  assert.match(harness.dom.headChildren[0].textContent, /dsh-balance-chip/)
})

test('点击刷新按钮会 stopPropagation，避免误触充值跳转', () => {
  const harness = loadBundle()
  const module = loadModule(harness)
  const registrations = []
  module.apply({
    get: () => ({ rpc: { call: async () => ({ ok: false }) } }),
    slots: {
      inject: (_name, fn) => fn(),
      register: (_options, component) => registrations.push(component),
    },
  })
  registrations[0]({ connection: { rpc: { call: async () => ({ ok: false }) } } })

  // 从 createElement 调用记录里捞出刷新按钮的 props。
  const buttonCall = harness.calls.find((args) => args[0] === 'button')
  assert.ok(buttonCall !== undefined, '未找到刷新按钮')
  let stopped = false
  buttonCall[1].onClick({ stopPropagation: () => { stopped = true } })
  assert.equal(stopped, true, '刷新按钮必须阻止冒泡')
})

test('样式表注入幂等', () => {
  const harness = loadBundle()
  const existing = new Set()
  harness.dom.document.getElementById = (id) => (existing.has(id) ? { id } : null)
  const originalAppend = harness.dom.document.head.appendChild
  harness.dom.document.head.appendChild = (el) => {
    existing.add(el.id)
    originalAppend(el)
  }
  const module = loadModule(harness)
  const registrations = []
  module.apply({
    get: () => ({ rpc: { call: async () => ({ ok: false }) } }),
    slots: {
      inject: (_name, fn) => fn(),
      register: (_options, component) => registrations.push(component),
    },
  })
  const Chip = registrations[0]
  const connection = { rpc: { call: async () => ({ ok: false }) } }
  Chip({ connection })
  Chip({ connection })
  assert.equal(harness.dom.headChildren.length, 1, '样式只应注入一次')
})
