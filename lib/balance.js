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
export const DEFAULT_CURRENCY = 'CNY'

/** 各币种的符号；未收录的币种退化为「代码 + 空格」。 */
export const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£' }

/**
 * 币种符号。
 * @param currency - 币种代码，如 `CNY`。
 * @returns 形如 `¥`；未收录时返回 `XYZ `（含尾空格，便于直接拼接金额）。
 */
export function currencySymbol(currency) {
  const code = typeof currency === 'string' ? currency.toUpperCase() : ''
  return CURRENCY_SYMBOLS[code] ?? (code.length > 0 ? `${code} ` : '')
}

/**
 * 格式化金额为展示文本。
 * @param amount - 金额；非有限数字时返回占位符 `—`。
 * @param currency - 币种代码。
 * @returns 形如 `¥12.34`、`$3.50`、`XYZ 8.00`。
 */
export function formatMoney(amount, currency) {
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
export function describeBalance(result) {
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
