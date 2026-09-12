# AGENTS.md

面向在本仓库工作的智能体与协作者的约束。**先读这份，再改代码。**

## 仓库定位

`dsh-balance-chip` 是一个**双半边 DSH 插件**（宿主 Node + 浏览器），发布到 npm，通过 DSH 的 profile 补丁层加载。它不是独立应用——脱离 DSH 宿主无法运行。

- 独立公开 Git 仓库（`lijunyu726/dsh-balance-chip`），不隶属于 DSH 大仓。
- 上游权威是 DSH 的 **Typert Remote 协议**与**客户端槽位契约**。改这两处前必须先在已安装的 DSH 里核实实现，不要照抄本仓库的假设。

## 目录规范

| 路径 | 职责 |
|---|---|
| `lib/balance.js` | 纯展示逻辑：币种符号、金额格式化、文案组装。**无 DOM、无 react、无 import**，可在 Node 下直接单测 |
| `lib/index.js` | 宿主半边。读凭据、发请求、注册 Remote 服务 |
| `lib/client.js` | 浏览器半边。**打包产物形态**，手工维护模板 + 构建期内联段 |
| `scripts/inline-balance.mjs` | 构建期把 `lib/balance.js` 内联进 bundle |
| `scripts/link-host-deps.mjs` | 仅开发用：把宿主 peer 依赖软链到本仓库，让宿主测试能真跑 |
| `test/` | 三层测试，见下 |

## 硬约束

1. **客户端半边绝不能用 `ctx.remote.<namespace>`。** `remote.<ns>` 命名空间服务只为官方那 15 个 strict 贡献挂载（`dsh-api-remotes/client`），社区插件没有 strict codec，引用它会让插件**永久 pending**，而 pending 的条目会导致**整个宿主启动失败**。必须走原始载体：

   ```js
   connection.rpc.call('/api', 'accountBalance/balance', { args: {} })
   ```

2. **宿主 `inject` 必须保持为空数组。** 它是启动闸门。`settings` / `credentials` 都可能因用户配置而缺席，写进 `inject` 就等于让插件在那些环境下永久 pending，进而拖垮整个 App。一律用软读取：

   ```js
   const settings = this.ctx.get('settings')   // 可能是 undefined
   ```

3. **Remote 方法签名不可随意改。** 网关的 SRC 发现会从 `Function.prototype.toString()` **解析参数名**（`dsh-api-gateway/lib/index.js:1010-1039`）。因此：

   - 不能用解构、默认值、剩余参数、重名参数；
   - 只有末位参数**字面命名**为 `signal` 才会启用取消；
   - 当前的 `balance()` 是零参数，线上载荷必须**恰好**是 `{ args: {} }`。

4. **API Key 绝不能穿越到浏览器。** 取 Key、发请求、解析线上格式全部在 `lib/index.js`。客户端只接收数字。任何把 Key 放进返回值或传给客户端的改动都是安全缺陷。

5. **`lib/client.js` 不是普通 ES 模块。** 它由宿主当普通脚本加载，必须自行调用 `window.__ModuleLoader__.load(...)`，且 `id` 与 `package.json` 的 `name` 逐字一致。漏掉会报 `loaded without registering`，而**不会**抛语法错误。

6. **bundle 必须自包含。** 宿主解析器（`dsh-client-modules/lib/client.js:296-310`）只认平台 seed 字面量、已物化的包、已注册的 factory，**后两者都以包 id 为键**。因此：

   - 允许 `require('react')`（及 `react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`dsh-client-*` 等 seed 字面量）；
   - **绝不允许 `require('dsh-balance-chip/...')`**——自身子路径在浏览器里必然抛 `missed the module table`，而 `node --check` 对此完全无感。

   展示逻辑靠**构建期内联**进入 bundle（`npm run build:bundle`），真源仍是可单测的 `lib/balance.js`。

7. **归一化只做一次，在宿主侧。** 线上格式（snake_case、金额为字符串）只在 `lib/index.js` 解析；`lib/balance.js` 收到的已是 `{ currency, total, granted, toppedUp }` 的数字形状。两层各写一套解析曾导致约定漂移、芯片只显示占位符。

8. **不要引入第三方运行时依赖。** 宿主侧只允许 import DSH 运行时提供的 peer（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-protocol`），且必须放在 **peerDependencies**——装成普通依赖会让 pnpm 提升出第二份 cordis，导致服务注册表分裂。浏览器侧只允许 require 平台 seed。

## 验证方式

```sh
node scripts/link-host-deps.mjs   # 首次或 App 更新后跑一次
npm run verify                    # = npm run check && npm test
```

- `npm run check`：三个入口文件的 `node --check`，外加 `check:bundle`（内联段与源文件逐字比对）。
- `npm test`：36 项，三层。宿主侧测试**真的 import 协议包**并断言 `remoteMethods()` 能读到标记——这是验证 SRC 发现路径唯一可靠的办法。缺少已安装的 DSH 时宿主用例自动跳过。

四条要求：

- **期望值必须来自实测的接口响应**，不能从实现反抄，也不能照文档猜。字段名 `granted_balance` / `topped_up_balance` 与 `is_available` 在顶层都是实测确认的，参考实现里并未全部用到。
- **测试必须比真实宿主更严格，不能更宽松。** 姊妹插件 `dsh-price-phase` 曾为了让 `require('<包名>/<子路径>')` 通过而在测试里注入 Node 版解析当后门，把「浏览器里必然抛错」的 bug 掩盖了整个发布周期。凡是「为了让它跑通」而放宽测试的想法，先怀疑产品写错了。
- **跨层契约要有测试钉住。** 宿主返回形状与客户端读取形状是两个文件，最容易漂移。改任一侧时，两侧测试都要过。
- **新增失败态时，同时加一条断言**，并确认它**不会被误报成别的失败**（例如断网不该显示成「未配置 Key」）。

发布前：`npm run verify` 必须全绿，且 `npm pack --dry-run` 清单符合预期。

## 安全边界

- **凭据只在本机宿主进程内使用**，不写日志、不进返回值、不进仓库。
- 本插件**只读**：仅一个 `GET /user/balance`，不修改账户、不发起支付。充值靠跳转官方页面，由用户自己操作。
- `.gitignore` 已排除 `node_modules/`、`*.tgz`、`.env`。`node_modules/@deepseek-ai/*` 是本机软链，**不得提交**。
- 发布到 npm 不可逆（同版本号不能覆盖）。发版前确认版本号已递增。

## 回退方法

从 profile 补丁层移除那条 `insert` 条目并重新加载即可——宿主与客户端两个半边一起卸载，插件不修改任何既有状态，也不持久化任何数据。

仓库侧改动用 `git revert`。npm 侧已发布版本无法撤回，只能 `deprecate` 或发新版本修正。
