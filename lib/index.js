/**
 * 宿主端（Node）半边：以用户自己的凭据查询 DeepSeek 账户余额，并通过
 * Typert Remote 暴露给浏览器半边。
 *
 * 为什么必须放宿主侧：API Key 绝不能进入浏览器代码。客户端只能拿到
 * 规范化后的余额数字。
 *
 * 两条 0.1.5 的硬约束（都踩过一次就起不来）：
 *
 * 1. `inject` 是**启动闸门**。声明了却拿不到的服务会让这个插件永久
 *    pending，而 pending 的条目会导致**整个宿主启动失败**。因此
 *    `settings` / `credentials` 一律用软 `ctx.get()` 读取，不进 inject。
 *
 * 2. SRC 发现路径会从 `Function.prototype.toString()` **解析参数名**
 *    （dsh-api-gateway/lib/index.js:1010-1039）。因此 Remote 方法的签名
 *    不能用解构、默认值、剩余参数或重名参数；只有末位参数**字面命名**
 *    为 `signal` 才会启用取消。
 *
 * 发现机制：本插件没有生成的 strict 描述符，走的是网关的 SRC 回退路径
 * （dsh-api-gateway/lib/index.js:758-763、:518-531）。该路径**不依赖 tsx**，
 * 已安装的 dsh-desktop 就是这么工作的。线上端点名为 `<namespace>/balance`，
 * 即 `accountBalance/balance`。
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'dsh-balance-chip'

/** 无硬依赖：见上文第 1 条。 */
export const inject = []

/**
 * 纯 JS 复刻 `@Remote('balance')`。
 *
 * 真正的装饰器只需要一个 decorator context，所以这里喂给它一个桩，
 * 捕获它注册的 initializer，再在实例构造时重放——与 dsh-desktop
 * （lib/index.js:579-590）同一套做法。
 */
const REMOTE_INITIALIZERS = []
function markRemote(method) {
  Remote(method)(null, {
    private: false,
    static: false,
    name: method,
    addInitializer: (fn) => {
      REMOTE_INITIALIZERS.push(fn)
    },
  })
}
markRemote('balance')

/** 与官方 llm-deepseek 适配器共享的设置命名空间。 */
const SETTINGS_NS = 'llm-deepseek'
const DEFAULT_KEY_REF = 'DEEPSEEK_API_KEY'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const TIMEOUT_MS = 10_000

/** 递增请求序号，用于丢弃过期响应，避免旧请求覆盖新结果。 */
let requestSeq = 0

/**
 * 余额查询服务。
 *
 * `balance()` **从不抛异常**：所有失败都以 `{ ok: false, code, error }`
 * 的形式在带内返回，让芯片能直接渲染原因。这与官方文档的分工一致——
 * 业务与网络失败走带内，装配错误才该抛（那样会显形为 gateway/internal，
 * 而不是一个静默空白的芯片）。
 */
export class AccountBalanceService extends TypertRemoteService {
  /**
   * @param ctx - 宿主 Cordis 上下文。
   */
  constructor(ctx) {
    super(ctx, 'accountBalance')
    for (const initialize of REMOTE_INITIALIZERS) initialize.call(this)
  }

  /**
   * 查询账户余额。
   *
   * 注意：SRC 会解析本方法的参数名，因此**不得**改动签名为解构 / 默认值 /
   * 剩余参数。当前为零参数，线上载荷必须恰好是 `{ args: {} }`。
   *
   * @returns 成功时 `{ ok: true, value: { available, balances } }`；
   *          失败时 `{ ok: false, code, error, status? }`。
   */
  async balance() {
    try {
      const settings = this.ctx.get('settings')
      const config = settings?.get(SETTINGS_NS) ?? {}
      const keyRef = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0
        ? config.apiKeyEnv
        : DEFAULT_KEY_REF

      const apiKey = await this.#resolveKey(keyRef)
      if (apiKey.length === 0) {
        return {
          ok: false,
          code: 'balance/no-key',
          error: `未配置 ${keyRef}（设置 → 模型）`,
        }
      }

      const baseUrl = (typeof config.baseURL === 'string' && config.baseURL.length > 0
        ? config.baseURL
        : DEFAULT_BASE_URL
      ).replace(/\/+$/, '')

      const seq = (requestSeq += 1)
      const response = await fetch(`${baseUrl}/user/balance`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })

      if (!response.ok) {
        return {
          ok: false,
          code: 'balance/http',
          error: httpMessage(response.status),
          status: response.status,
        }
      }

      const data = await response.json()
      if (!Array.isArray(data?.balance_infos)) {
        return { ok: false, code: 'balance/shape', error: '余额响应格式异常' }
      }

      return {
        ok: true,
        value: {
          // 缺省视为可用：旧响应没有该字段时不应误判。
          available: data.is_available === undefined ? true : data.is_available !== false,
          // 线上格式（snake_case 字符串）在这里就地解析完，浏览器侧只拿数字。
          // 归一化只做一次，避免两层各有一套解析规则而漂移。
          balances: data.balance_infos.map((raw) => ({
            currency: typeof raw?.currency === 'string' && raw.currency.length > 0
              ? raw.currency
              : 'CNY',
            total: toAmount(raw?.total_balance),
            granted: toAmount(raw?.granted_balance),
            toppedUp: toAmount(raw?.topped_up_balance),
          })),
          // 供调试与「丢弃过期响应」使用；不影响展示。
          seq,
        },
      }
    } catch (error) {
      const aborted = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      return {
        ok: false,
        code: aborted ? 'balance/timeout' : 'balance/network',
        error: aborted
          ? '余额查询超时'
          : `无法连接 DeepSeek：${String(error?.message ?? error)}`,
      }
    }
  }

  /**
   * 解析 API Key：先问凭据服务，再回退到进程环境变量。
   * @param keyRef - 环境变量 / 凭据引用名。
   * @returns key 字符串；取不到时为空串。
   */
  async #resolveKey(keyRef) {
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(keyRef)
        if (typeof hit?.value === 'string' && hit.value.length > 0) return hit.value
      } catch {
        // 凭据服务存在但解析失败（未配置 / 后端异常）时静默回退到环境变量。
      }
    }
    const fromEnv = process.env[keyRef]
    return typeof fromEnv === 'string' ? fromEnv : ''
  }
}

/**
 * 把接口返回的金额转成有限数字。
 *
 * 实测金额在线上是**字符串**（如 `"12.34"`），但异构实现可能给数字，
 * 因此两种都接受；其余（null、对象、非数字字符串）归为 undefined，
 * 由浏览器侧渲染成占位符。
 *
 * @param value - 接口原始值。
 * @returns 有限数字，或 undefined。
 */
function toAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 把 HTTP 状态映射成可读原因。
 * @param status - HTTP 状态码。
 * @returns 中文说明。
 */
function httpMessage(status) {
  if (status === 401) return 'API Key 无效或已过期'
  if (status === 402) return '账户余额不足'
  if (status === 403) return 'API Key 无权访问该接口'
  if (status === 429) return '请求过于频繁，请稍后再试'
  if (status >= 500) return `DeepSeek 服务异常：HTTP ${status}`
  return `余额查询失败：HTTP ${status}`
}

/**
 * 插件入口：构造服务实例即完成注册。
 * @param ctx - 宿主 Cordis 上下文。
 */
export function apply(ctx) {
  new AccountBalanceService(ctx)
}
