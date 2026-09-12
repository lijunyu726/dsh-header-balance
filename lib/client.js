/**
 * DSH Web GUI 客户端插件：在会话页头部显示 DeepSeek 账户余额。
 *
 * 本文件是打包产物，必须遵守浏览器的 __ModuleLoader__ 契约：
 * window.__ModuleLoader__.load({ id, factory }) —— id 必须与 npm 包名一致，
 * factory 接收 `require` 并返回模块 exports；缺失 load() 调用会被宿主报成
 * "loaded without registering"。
 *
 * 硬约束：**bundle 必须自包含。** DSH 的 bundle 解析器只认平台 seed 字面量
 * （react / react-dom / cordis / dsh-client-*）、已物化的包与已注册的 factory，
 * 后两者都以**包 id** 为键，因此 `require('dsh-balance-chip/balance')` 这类
 * 自身子路径必然抛 "missed the module table"。展示逻辑因此在构建期由
 * scripts/inline-balance.mjs 从 lib/balance.js 内联进下面的标记区——真源
 * 仍是被 Node 直接单测的那一份。
 *
 * 与宿主侧的分工：API Key 与网络请求全部在宿主半边，这里只通过
 * `connection.rpc.call('/api', 'accountBalance/balance', { args: {} })` 取
 * 规范化后的余额数字。**不得**使用 `ctx.remote.accountBalance` ——
 * `remote.<ns>` 命名空间只为官方那 15 个 strict 贡献挂载，社区插件用了会
 * 永久 pending，并把宿主启动一起拖垮。
 */
window.__ModuleLoader__.load({
  id: 'dsh-balance-chip',
  factory: (require) => {
    const react = require('react')

    const STYLE_ID = 'dsh-balance-chip-css'
    const RPC_ENDPOINT = 'accountBalance/balance'
    const RECHARGE_URL = 'https://platform.deepseek.com/top_up'
    const REFRESH_MS = 60_000
    const NARROW_QUERY = '(max-width: 760px), (pointer: coarse) and (max-width: 960px)'

    // #region 内联自 lib/balance.js（由 scripts/inline-balance.mjs 生成，勿手改）
/**
 * 余额的展示格式化 —— 纯逻辑，无 DOM、无框架依赖、不发请求。
 *
 * **归一化不在这一层。** 线上格式（snake_case、金额为字符串）由宿主半边
 * `lib/index.js` 就地解析，穿越传输层到达这里的已经是：
 *
 *   { available: boolean,
 *     balances: [{ currency: 'CNY', total: 12.34, granted: 0, toppedUp: 12.34 }] }
 *
 * 这么分工是为了让「线上格式」这件事只有一个地方知道。早先两层各有一套
 * 归一化（客户端还按 `balance_infos` 去读），两边约定漂移后芯片只会显示
 * 占位符——这正是测试抓出来的问题。
 *
 * 金额在这里**只做展示格式化**，不参与任何计算；结算发生在服务端。
 */

/** 默认币种：接口未给 currency 时的兜底，避免出现裸数字。 */
const DEFAULT_CURRENCY = 'CNY'

/** 各币种的符号；未收录的币种退化为「代码 + 空格」。 */
const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£' }

/**
 * 币种符号。
 * @param currency - 币种代码，如 `CNY`。
 * @returns 形如 `¥`；未收录时返回 `XYZ `（含尾空格，便于直接拼接金额）。
 */
function currencySymbol(currency) {
  const code = typeof currency === 'string' ? currency.toUpperCase() : ''
  return CURRENCY_SYMBOLS[code] ?? (code.length > 0 ? `${code} ` : '')
}

/**
 * 格式化金额为展示文本。
 * @param amount - 金额；非有限数字时返回占位符 `—`。
 * @param currency - 币种代码。
 * @returns 形如 `¥12.34`、`$3.50`、`XYZ 8.00`。
 */
function formatMoney(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
  return `${currencySymbol(currency)}${amount.toFixed(2)}`
}

/**
 * 组装展示文本与悬停说明。
 *
 * 芯片本体只显示总余额（与既有实现一致的视觉密度）；赠送 / 充值的拆分放在
 * 悬停说明里——实测两者之和等于总额，因此是真实信息而非重复。赠送余额为 0
 * 时该行省略，多数账户没有赠金，占位只会变噪音。
 *
 * @param result - 宿主侧 Remote 的返回值，形如 `{ ok, value?, error? }`。
 * @returns 展示文本、悬停说明与状态色调。
 */
function describeBalance(result) {
  if (result?.ok !== true) {
    return {
      tone: 'warn',
      text: '余额 · —',
      compact: '—',
      title: result?.error ?? '余额查询失败',
    }
  }

  const available = result.value?.available !== false
  const rawList = Array.isArray(result.value?.balances) ? result.value.balances : []
  const balance = rawList[0]

  if (balance === undefined || typeof balance.total !== 'number' || !Number.isFinite(balance.total)) {
    return {
      tone: 'warn',
      text: '余额 · —',
      compact: '—',
      title: '账户未返回余额信息',
    }
  }

  const currency = balance.currency ?? DEFAULT_CURRENCY
  const money = formatMoney(balance.total, currency)
  const lines = [`账户余额 ${money}`]

  // 赠送 / 充值拆分：仅在赠金非 0 时展示。
  if (typeof balance.granted === 'number' && balance.granted !== 0) {
    const parts = [`赠送 ${formatMoney(balance.granted, currency)}`]
    if (typeof balance.toppedUp === 'number') {
      parts.push(`充值 ${formatMoney(balance.toppedUp, currency)}`)
    }
    lines.push(parts.join(' · '))
  }

  lines.push(
    available
      ? '点击前往开放平台充值'
      : '账户已不可用（余额耗尽或已停用），请前往开放平台充值',
  )

  return {
    tone: available ? 'ok' : 'warn',
    text: `余额 ${money}`,
    compact: money,
    title: lines.join('\n'),
  }
}
    // #endregion 内联自 lib/balance.js

    function installStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.dsh-balance-chip { display:inline-flex; align-items:center; gap:7px;',
        '  height:32px; box-sizing:border-box; font-size:13px; line-height:20px;',
        '  padding:6px 12px; border-radius:18px; cursor:pointer; user-select:text;',
        '  border:1px solid rgba(255,255,255,0.12); background:transparent;',
        '  color:var(--dsw-alias-label-primary, #F9FAFB); }',
        '.dsh-balance-chip-value { font-weight:400; font-variant-numeric:tabular-nums; }',
        '.dsh-balance-chip-refresh { display:inline-flex; align-items:center;',
        '  justify-content:center; width:22px; height:22px; margin-right:-6px;',
        '  border:none; background:transparent; cursor:pointer; color:inherit;',
        '  font-size:13px; opacity:0.55; padding:0; }',
        '.dsh-balance-chip-refresh:hover { opacity:0.9; }',
        // 手机端头部行被汉堡按钮占去 56px，余额芯片省略「余额」二字。
        `@media ${NARROW_QUERY} { .dsh-balance-chip-label { display:none; } }`,
      ].join('\n')
      document.head.appendChild(style)
    }

    function BalanceChip({ connection }) {
      const [state, setState] = react.useState({ loading: true, result: null })
      const [narrow, setNarrow] = react.useState(() => window.matchMedia(NARROW_QUERY).matches)
      // 卸载后到达的响应不应再写状态；用版本号丢弃过期结果，避免旧请求
      // 覆盖新结果（比 AbortController 更简单，且不依赖传输层支持取消）。
      const generation = react.useRef(0)

      const refresh = react.useCallback(() => {
        const mine = (generation.current += 1)
        setState((previous) => ({ loading: true, result: previous.result }))
        // `call` 在传输层失败（HTTP 非 200、信封不合法）时会 **抛**，
        // 因此第二个参数（onRejected）是必需的，不能只写 .then(onFulfilled)。
        connection.rpc.call('/api', RPC_ENDPOINT, { args: {} }).then(
          (result) => {
            if (generation.current !== mine) return
            setState({ loading: false, result })
          },
          (error) => {
            if (generation.current !== mine) return
            setState({
              loading: false,
              result: { ok: false, error: `RPC 失败：${String(error?.message ?? error)}` },
            })
          },
        )
      }, [connection])

      react.useEffect(() => {
        installStyle()
        refresh()
        const timer = window.setInterval(refresh, REFRESH_MS)
        const onFocus = () => refresh()
        const query = window.matchMedia(NARROW_QUERY)
        const onNarrowChange = () => setNarrow(query.matches)
        window.addEventListener('focus', onFocus)
        query.addEventListener('change', onNarrowChange)
        return () => {
          // 递增版本号，让在途响应失效。
          generation.current += 1
          window.clearInterval(timer)
          window.removeEventListener('focus', onFocus)
          query.removeEventListener('change', onNarrowChange)
        }
      }, [refresh])

      const described = describeBalance(state.result)
      // 加载中且尚无旧值时显示占位；有旧值时继续显示旧值，避免刷新时闪烁。
      const value = state.loading && state.result === null
        ? '…'
        : narrow
          ? described.compact
          : described.text.replace(/^余额\s*/, '')

      return react.createElement(
        'span',
        {
          className: 'dsh-balance-chip',
          'data-tone': described.tone,
          title: described.title,
          role: 'button',
          tabIndex: 0,
          onClick: () => window.open(RECHARGE_URL, '_blank', 'noopener'),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              window.open(RECHARGE_URL, '_blank', 'noopener')
            }
          },
        },
        react.createElement('span', { className: 'dsh-balance-chip-label' }, '余额'),
        react.createElement('span', { className: 'dsh-balance-chip-value' }, value),
        react.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-balance-chip-refresh',
            title: '刷新余额',
            'aria-label': '刷新余额',
            onClick: (event) => {
              // 阻止冒泡，否则点刷新会连带触发整块芯片的充值跳转。
              event.stopPropagation()
              refresh()
            },
          },
          '↻',
        ),
      )
    }

    /**
     * 'slots' -> dsh-client-ui-renderer；'connection' -> dsh-client-connection。
     * 两者都必须声明：槽位渲染时不传 props，服务得自己取。
     */
    const inject = ['slots', 'connection']

    /**
     * 注册余额芯片。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      // 槽位渲染时不传 props，所以在这里把服务取出来，通过
      // register 的 inject 选项交给组件。
      const connection = ctx.get('connection')
      ctx.slots.inject('conversation.session.header.utilities', () => {
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'balance-chip',
            order: 100,
            inject: () => ({ connection }),
          },
          BalanceChip,
        )
      })
    }

    return { apply, inject, name: 'dsh-balance-chip' }
  },
})
