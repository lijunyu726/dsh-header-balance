/**
 * 由 lib/balance.js 生成 lib/client.js 中的内联逻辑段。
 *
 * 为什么需要这一步见 ARCHITECTURE.md「为什么 bundle 必须自包含」：DSH 的
 * 浏览器 bundle 解析器只认平台 seed 字面量、已物化的包与已注册的 factory，
 * 后两者都以**包 id** 为键，因此 `require('dsh-balance-chip/balance')` 这类
 * 自身子路径必然抛 "missed the module table"。
 *
 * 用法：
 *   node scripts/inline-balance.mjs           # 写入 lib/client.js
 *   node scripts/inline-balance.mjs --check   # 只校验，不写入（CI/发布前用）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'lib', 'balance.js')
const bundlePath = path.join(root, 'lib', 'client.js')

const BEGIN = '    // #region 内联自 lib/balance.js（由 scripts/inline-balance.mjs 生成，勿手改）'
const END = '    // #endregion 内联自 lib/balance.js'

/**
 * 把 ESM 源转成可内联的片段：去掉 `export ` 前缀，其余逐字保留。
 * @param source - lib/balance.js 的全文。
 * @returns 可直接嵌入 factory 函数体的代码。
 */
export function toInlineFragment(source) {
  const stripped = source.replace(/^export (const|function|class) /gm, '$1 ')
  if (/^export /m.test(stripped)) {
    throw new Error('内联转换后仍残留 export 关键字，请检查 lib/balance.js 的导出写法')
  }
  return stripped
}

/**
 * 用当前 lib/balance.js 的内容重写 bundle 中的标记区。
 * @param bundle - lib/client.js 的全文。
 * @param fragment - 待内联的代码。
 * @returns 重写后的 bundle 全文。
 */
export function spliceBundle(bundle, fragment) {
  const begin = bundle.indexOf(BEGIN)
  const end = bundle.indexOf(END)
  if (begin === -1 || end === -1) throw new Error('lib/client.js 缺少内联标记区，无法定位插入点')
  if (end < begin) throw new Error('lib/client.js 的内联标记区顺序颠倒')
  const head = bundle.slice(0, begin + BEGIN.length)
  const tail = bundle.slice(end)
  return `${head}\n${fragment.replace(/\n+$/, '')}\n${tail}`
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const source = readFileSync(sourcePath, 'utf8')
  const bundle = readFileSync(bundlePath, 'utf8')
  const next = spliceBundle(bundle, toInlineFragment(source))

  if (checkOnly) {
    if (next !== bundle) {
      console.error('✗ lib/client.js 的内联段与 lib/balance.js 不一致')
      console.error('  运行 `npm run build:bundle` 重新生成。')
      process.exit(1)
    }
    console.log('✓ 内联段与 lib/balance.js 一致')
    return
  }

  if (next === bundle) {
    console.log('内联段已是最新，无需改动')
    return
  }
  writeFileSync(bundlePath, next)
  console.log('✓ 已更新 lib/client.js 的内联段')
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
