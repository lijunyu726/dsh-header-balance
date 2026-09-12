/**
 * 把宿主侧 peer 依赖软链到本仓库的 node_modules，让宿主半边能在本地被
 * 真实加载并测试。
 *
 * 为什么需要：本插件的宿主半边 import 了 `@deepseek-ai/dsh-typert-protocol`
 * 与 `@deepseek-ai/cordis`。这两个包**故意不放在 dependencies** 里——它们是
 * DSH 运行时提供的 peer，装成普通依赖会让 pnpm 提升出第二份 cordis，
 * 导致服务注册表分裂。真实安装时它们由 profile 目录的软链解析到 App 内。
 *
 * 本机它们只存在于已安装的 DSH App 内，Node 从仓库目录解析不到，因此这里
 * 按 profile 的同一思路建软链，仅用于开发与测试。缺失 App 时**静默跳过**，
 * 让仓库在无 App 的机器上仍能跑通纯逻辑测试。
 *
 * 用法：node scripts/link-host-deps.mjs
 */
import { existsSync, mkdirSync, symlinkSync, rmSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scopedDir = path.join(root, 'node_modules', '@deepseek-ai')

/** 默认从本机已安装的 DSH App 取依赖；可用环境变量覆盖。 */
const APP_SCOPE = process.env.DSH_APP_SCOPE
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app/node_modules/@deepseek-ai'

const PACKAGES = ['cordis', 'dsh-typert-protocol']

if (!existsSync(APP_SCOPE)) {
  console.log(`[link-host-deps] 未找到 DSH App 依赖目录，跳过：${APP_SCOPE}`)
  console.log('[link-host-deps] 纯逻辑测试不受影响；宿主半边测试会自动跳过。')
  process.exit(0)
}

mkdirSync(scopedDir, { recursive: true })
let linked = 0
let skipped = 0

for (const name of PACKAGES) {
  const target = path.join(APP_SCOPE, name)
  const link = path.join(scopedDir, name)
  if (!existsSync(target)) {
    console.log(`[link-host-deps] 跳过 ${name}：App 内不存在`)
    skipped += 1
    continue
  }
  // 已存在则先移除，保证重复运行是幂等的。
  if (existsSync(link) || isSymlink(link)) rmSync(link, { force: true })
  symlinkSync(target, link, 'dir')
  console.log(`[link-host-deps] ${name} -> ${target}`)
  linked += 1
}

console.log(`[link-host-deps] 完成：新建 ${linked} 个，跳过 ${skipped} 个`)

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
