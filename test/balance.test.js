/**
 * 余额规范化与格式化测试 —— 纯逻辑层。
 *
 * 输入是**宿主半边已归一化**的形状（线上 snake_case 解析与数字转换都在
 * lib/index.js，其自身测试见 host-service.test.js）：
 *   { ok: true, value: { available, balances: [{ currency, total, granted, toppedUp }] } }
 *
 * 输入形状的期望值来自实测响应：四个金额字段线上均为两位小数字符串，且
 * `granted_balance + topped_up_balance === total_balance` 成立。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CURRENCY,
  currencySymbol,
  describeBalance,
  formatMoney,
} from '../lib/balance.js'

test('formatMoney 固定两位小数并带币种符号', () => {
  assert.equal(formatMoney(12.34, 'CNY'), '¥12.34')
  assert.equal(formatMoney(12.3, 'CNY'), '¥12.30')
  assert.equal(formatMoney(0, 'CNY'), '¥0.00')
  assert.equal(formatMoney(1234.5, 'USD'), '$1234.50')
  assert.equal(formatMoney(8, 'XYZ'), 'XYZ 8.00')
  assert.equal(formatMoney(undefined, 'CNY'), '—')
})

test('describeBalance：成功时芯片显示总额，拆分进悬停说明', () => {
  const described = describeBalance({
    ok: true,
    value: {
      available: true,
      balances: [{ currency: 'CNY', total: 12.34, granted: 0, toppedUp: 12.34 }],
    },
  })
  assert.equal(described.tone, 'ok')
  assert.equal(described.text, '余额 ¥12.34')
  assert.equal(described.compact, '¥12.34', '窄屏应只显金额，省掉「余额」二字')
  assert.match(described.title, /账户余额 ¥12\.34/)
  assert.match(described.title, /充值/)
  // 赠金为 0 时省略该行，避免占位变噪音。
  assert.doesNotMatch(described.title, /赠送/)
})

test('describeBalance：赠金非 0 时展示赠送与充值拆分', () => {
  const described = describeBalance({
    ok: true,
    value: {
      available: true,
      balances: [{ currency: 'CNY', total: 30, granted: 10, toppedUp: 20 }],
    },
  })
  assert.match(described.title, /赠送 ¥10\.00/)
  assert.match(described.title, /充值 ¥20\.00/)
  // 拆分只出现在悬停说明里，芯片本体仍是总额。
  assert.equal(described.text, '余额 ¥30.00')
  assert.doesNotMatch(described.text, /赠送/)
})

test('describeBalance：账户不可用时给出明确告警', () => {
  const described = describeBalance({
    ok: true,
    value: {
      available: false,
      balances: [{ currency: 'CNY', total: 0, granted: 0, toppedUp: 0 }],
    },
  })
  assert.equal(described.tone, 'warn')
  assert.match(described.title, /不可用/)
})

test('describeBalance：宿主侧失败时把原因带进悬停说明', () => {
  const described = describeBalance({ ok: false, code: 'balance/no-key', error: '未配置 DEEPSEEK_API_KEY（设置 → 模型）' })
  assert.equal(described.tone, 'warn')
  assert.equal(described.text, '余额 · —')
  assert.equal(described.title, '未配置 DEEPSEEK_API_KEY（设置 → 模型）')
})

test('describeBalance：空余额列表与非法载荷都不抛', () => {
  for (const result of [
    { ok: true, value: { available: true, balances: [] } },
    { ok: true, value: { available: true, balances: [{ currency: 'CNY', total: undefined }] } },
    { ok: true, value: {} },
    { ok: true },
    null,
    undefined,
  ]) {
    const described = describeBalance(result)
    assert.equal(described.tone, 'warn')
    assert.equal(described.text, '余额 · —')
    assert.ok(described.title.length > 0, '始终应有一句可读的悬停说明')
  }
})
