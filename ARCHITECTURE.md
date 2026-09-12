# ARCHITECTURE.md

## 这个插件在 DSH 里的位置

DSH 的界面由**槽位（slot）**拼装，宿主侧能力由 **Typert Remote** 跨进程暴露。本插件同时用到两者，因此是**双半边**结构：

```
浏览器（Web GUI）
├── @deepseek-ai/dsh-client-ui-conversation
│   └── 渲染 conversation.session.header.utilities（kind: list, scope: session）
│       └── dsh-balance-chip 的 BalanceChip   ← 本插件注册在这里
│           │
│           │  connection.rpc.call('/api', 'accountBalance/balance', { args: {} })
│           ▼
└── @deepseek-ai/dsh-client-connection ── 原始 RPC 载体
        │
        │  POST /api/accountBalance/balance
        ▼
宿主（Node 进程）
├── @deepseek-ai/dsh-api-gateway
│   └── 通过 **SRC 回退路径** 发现本插件的 Remote
│       └── dsh-balance-chip 的 AccountBalanceService.balance()
│           ├── ctx.get('settings')    → llm-deepseek 命名空间（软读取）
│           ├── ctx.get('credentials') → resolve('DEEPSEEK_API_KEY')（软读取）
│           └── GET api.deepseek.com/user/balance
```

## 模块职责

### `lib/balance.js` —— 纯展示层

| 导出 | 职责 |
|---|---|
| `DEFAULT_CURRENCY` | 接口未给 currency 时的兜底（`CNY`） |
| `CURRENCY_SYMBOLS` | 币种 → 符号映射 |
| `currencySymbol(currency)` | 符号查询；未收录时退化为 `代码 + 空格` |
| `formatMoney(amount, currency)` | `¥12.34`；非有限数字 → `—` |
| `describeBalance(result)` | 组装芯片文本、悬停说明、状态色调 |

**不 import 任何东西**，不碰 DOM、不碰 react、不发请求。所有可测的展示复杂度都在这里。

### `lib/index.js` —— 宿主半边

| 成员 | 职责 |
|---|---|
| `AccountBalanceService` | 继承 `TypertRemoteService`，注册 `accountBalance` 服务 |
| `.balance()` | 取 Key → 发请求 → 解析 → 返回 `{ ok, value }` 或 `{ ok, code, error }` |
| `toAmount(value)` | 线上金额（字符串或数字）→ 有限数字 |
| `httpMessage(status)` | HTTP 状态 → 中文原因 |
| `apply(ctx)` | 构造服务实例即完成注册 |

### `lib/client.js` —— 浏览器半边

只做四件事：注入样式表、持有 `connection` 服务、按 60 秒 / focus 刷新、把组件注册进槽位。展示逻辑来自内联段。

### `scripts/inline-balance.mjs` —— 构建期内联

把 `lib/balance.js`（去掉 `export` 关键字）替换进 `lib/client.js` 的标记区：

```
    // #region 内联自 lib/balance.js（由 scripts/inline-balance.mjs 生成，勿手改）
    … 逐字内联 …
    // #endregion 内联自 lib/balance.js
```

理由见下面「为什么 bundle 必须自包含」。

## 关键设计决策

### 为什么必须走宿主侧，而不是浏览器直接 fetch

浏览器直接调 `api.deepseek.com` 需要三样东西，缺一不可，而每一样都是问题：

1. **API Key 会进入浏览器**——页面脚本、DevTools、任何扩展都能读到。这是不可接受的安全缺陷。
2. DSH 的凭据服务只在宿主侧（`dsh-credentials`），浏览器侧没有对应能力。
3. 浏览器直连第三方域还要面对 CORS 与代理配置。

因此宿主负责「有权限的那部分」，浏览器只负责「好看的那部分」。

### 为什么客户端用 `connection.rpc.call` 而不是 `ctx.remote.accountBalance`

Typert Gateway 有两种发现路径：

- **strict 描述符**：由 Typert 编译器生成，随包分发。客户端的 `remote.<namespace>` 命名空间服务**只**为这类描述符挂载，且贡献列表硬编码在 `@deepseek-ai/dsh-api-remotes/client` 的 15 个官方包里。
- **SRC（source-marker）回退**：网关直接扫描 `ctx.reflect.props` 里的活服务，从原型上的标记读出 Remote 方法，参数名从 `Function.prototype.toString()` 解析。**不依赖 tsx，也不依赖生成物。**

社区插件没有 strict 描述符，所以 `ctx.remote.accountBalance` **根本不存在**。更糟的是声明式引用它会让插件**永久 pending**，而 pending 的宿主条目会导致**整个 App 启动失败**。

正确做法是走原始载体 `connection.rpc.call(...)`。代价是拿不到类型化封装，收益是不会把宿主拖垮。

### 为什么 `inject` 保持为空

`inject` 在 Cordis 里是**启动闸门**：声明的服务若永远不出现，插件就永久 pending，宿主启动随之失败。

本插件需要的 `settings` 与 `credentials` 都可能因用户配置而缺席（没配模型、禁用了凭据提供者）。把它们写进 `inject` 等于让插件在这些环境下变成定时炸弹。因此一律软读取：

```js
const settings = this.ctx.get('settings')      // undefined 也能继续
const credentials = this.ctx.get('credentials') // 取不到就回退到 process.env
```

代价是失败要在运行时自己兜住，收益是插件在任何配置下都不会阻止 App 启动。这一条有专门的测试钉住。

### 归一化只在一处发生

线上响应是 snake_case，金额是**字符串**：

```json
{ "is_available": true,
  "balance_infos": [{ "currency": "CNY", "total_balance": "12.34",
                      "granted_balance": "0.00", "topped_up_balance": "12.34" }] }
```

解析放在 `lib/index.js`，浏览器侧收到的已经是：

```js
{ available: true, balances: [{ currency: 'CNY', total: 12.34, granted: 0, toppedUp: 12.34 }] }
```

**第一版是两层各写一套归一化**（宿主透传 snake_case，客户端又按 `balance_infos` 去读），两边约定漂移后芯片只显示占位符。测试抓出了这个跨层契约漂移，现在归一化只有一处。

### 为什么 bundle 必须自包含（姊妹插件踩过的坑）

DSH 的浏览器 bundle 解析器只有三条路：

```js
makeRequire(edges) {
  return (spec) => {
    if (this.seed.has(spec)) return this.seed.get(spec)        // 平台 seed
    const id = stripClientSuffix(spec)
    const record = this.loadCache.get(id)                       // 键 = 包 id
    if (record !== undefined) return record.exports
    if (this.factories.has(id)) return this.materialize(id).exports  // 键 = 包 id
    throw new Error(`client-modules: require("${spec}") missed the module table …`)
  }
}
```

`loadCache` 与 `factories` **都以包 id 为键**，因此 `require('dsh-balance-chip/balance')` 这类自身子路径永远命中不了。

姊妹插件 `dsh-price-phase` 0.1.0 正是这么写的并带病发布，而两道防线当时都失效：`node --check` 只看语法；契约测试为了让那条 require 通过，在测试里注入了 Node 版解析当后门。

本仓库从一开始就用同一套修法：**构建期内联**（保持单一真源 + 可测试），并让测试的 require 模拟**只放行平台 seed 字面量**。

### 刷新策略

挂载时、每 60 秒、窗口重新获得焦点时刷新，与既有实现一致。用**自增版本号**丢弃过期响应：卸载或新一轮刷新后到达的旧响应不再写状态。比 `AbortController` 简单，也不依赖传输层支持取消。

刷新期间**保留旧值**（只在首次加载时显示 `…`），避免每次刷新都闪一下。

### 点击与刷新的手势冲突

整块芯片是充值跳转，内部又有一个 `↻` 按钮。按钮的 `onClick` 必须 `stopPropagation()`，否则点刷新会连带触发充值跳转——这是既有实现里已经处理过的细节，本插件沿用并有测试钉住。

## 外部依赖

**运行时零第三方依赖。**

宿主侧 import 两个 DSH 运行时提供的包，且**只放 peerDependencies**：

| 包 | 用途 |
|---|---|
| `@deepseek-ai/dsh-typert-protocol` | `TypertRemoteService` 基类与 `Remote` 装饰器 |
| `@deepseek-ai/cordis` | 间接依赖（`Service` 基类） |

装成普通 `dependencies` 会让 pnpm 提升出**第二份 cordis**，导致服务注册表分裂——这是必须避免的。

浏览器侧只 `require('react')`，由宿主提供。

## 已知边界与未实现

| 项 | 状态 |
|---|---|
| 账号多币种 | 只渲染 `balance_infos[0]`；接口实测目前只返回一条 |
| 余额历史 / 趋势图 | 未实现，刻意不做 |
| 用量统计 | 未实现，属于另一个插件 |
| 低余额告警阈值 | 未实现 |
| 余额耗尽的判断 | 依赖接口的 `is_available`；为 false 时给出明确文案而非显示 `¥0.00` |
| SRC 回退的长期稳定性 | 官方文档把 SRC 描述为开发期回退，但已发布的 0.1.5-rc.2 里**没有模式闸门**，且线上运行中的 `dsh-desktop` 就走这条路。若上游将来加闸门，本插件的宿主侧会失效——届时应改用生成的 strict 描述符 |
| DSH 版本兼容性 | 只在 0.1.5-rc.2 的槽位与 Remote 契约上验证过 |
| `link-host-deps.mjs` 的软链 | 仅开发用；真实安装由 profile 目录的依赖解析提供，不依赖本脚本 |
