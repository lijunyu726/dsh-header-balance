# dsh-header-balance

English | [中文](./README.md)

**A DeepSeek balance chip for the DSH Web GUI**: shows your account balance in the conversation header, opens the recharge page on click, and reveals the granted / topped-up split on hover.

The API key and the network request live entirely **on the host side** — the key never reaches browser code.

[![Balance chip demo: the balance in the conversation header, clicking through to the recharge page](./docs/demo.gif)](./docs/demo.mp4)

---

## Features

| Capability | Notes |
|---|---|
| Balance display | A chip in the conversation header showing the total, matching the visual density of the built-in "Session log" button |
| Click to recharge | Clicking the chip opens `platform.deepseek.com/top_up`; the Electron shell routes it to your system browser |
| Manual refresh | The `↻` button inside the chip (it stops propagation, so it cannot trigger the recharge jump) |
| Auto refresh | On mount, every 60 seconds, and whenever the window regains focus |
| Hover detail | Account balance plus the granted / topped-up split (that line is omitted when the grant is 0) and the recharge hint |
| Narrow screens | Phones drop the word "余额" and keep only the amount |
| Unavailable warning | When `is_available` is false it says so, instead of quietly showing ¥0.00 |
| Readable failures | Distinct messages for a missing key, an invalid key, insufficient balance, rate limiting, timeout, no network, and a malformed response |

## Install

```sh
dsh plugin --profile web add dsh-header-balance
```

Restart DSH and the chip appears in the conversation header.

`dsh plugin add` reads the `dsh.bundle.patch` field in this package's `package.json` and inserts the plugin into the profile tree for you. **No manual edit of `cordis.patch.yml` is needed.** The entry it writes is shown below, for troubleshooting only:

```yaml
- insert:
    - id: dsh-header-balance
      name: 'dsh-header-balance'
```

Installing through npm directly also works (for a hand-rolled profile, or offline distribution), but then you do add that entry yourself:

```sh
npm install dsh-header-balance
```

The plugin resolves the same credential reference as the official `llm-deepseek` adapter (default `DEEPSEEK_API_KEY`), so if your model works, the balance lookup works — no separate configuration.

## Architecture (and why there is host-side code)

Balance is not a pure front-end widget; it needs the host:

```
Browser (lib/client.js)                  Host (lib/index.js)
  connection.rpc.call('/api',             reads settings['llm-deepseek']
    'accountBalance/balance', {} )   →    resolves the API key via credentials
        ↓                                  GET api.deepseek.com/user/balance
  receives normalized numbers only  ←──   parses the wire's snake_case strings
```

Three hard constraints, each documented with citations in `ARCHITECTURE.md`:

1. **The client must not use `ctx.remote.accountBalance`.** The `remote.<ns>` namespace services are mounted only for the 15 official strict contributions; declaring one would park the plugin forever and **take host startup down with it**. Use the raw carrier `connection.rpc.call`.
2. **The host's `inject` must stay empty.** It is a startup gate: a declared service that never arrives keeps the plugin pending and the whole app fails to boot. `settings` / `credentials` are read softly via `ctx.get()` with fallbacks.
3. **The Remote method signature is load-bearing.** Gateway SRC discovery parses parameter names out of `Function.prototype.toString()`, so no destructuring, defaults, rest parameters, or duplicate names.

Wire endpoint: `accountBalance/balance`, payload `{ args: {} }`.

## Development

```sh
node scripts/link-host-deps.mjs   # symlink host-side peer deps into this repo (dev only)
npm run build:bundle              # regenerate the bundle's inlined logic from lib/balance.js
npm run check                     # syntax preflight + verify the inlined region matches the source
npm test                          # 36 tests
npm run verify                    # all of the above
```

The display logic inside `lib/client.js` is not hand-written: `scripts/inline-balance.mjs` inlines it from `lib/balance.js` at build time. DSH's bundle resolver only knows platform seed words and registered package ids, so requiring the package's own subpath always fails — and the logic cannot be hand-written into the bundle either, since then it could not be unit-tested in Node.

### Three test layers

- `test/balance.test.js` (12) — display formatting and copy. Pure functions, no dependencies.
- `test/host-service.test.js` (19) — the host half. It **really imports `@deepseek-ai/dsh-typert-protocol`** and asserts that `remoteMethods()` reads the Remote marker back, so the SRC discovery path is genuinely exercised rather than stubbed. Covers the happy path, seven failure classes, credential precedence and fallback, and "the API key never appears in the return value".
- `test/client-contract.test.js` (5) — the bundle contract. Actually executes `lib/client.js` in `node:vm`, with a `require` that **only admits platform seed words** — stricter than the real host.

The host-side tests need `scripts/link-host-deps.mjs`; without an installed DSH they **skip automatically** and say so in the report, leaving the pure-logic tests unaffected.

## Known limits

- **Verified only against the DSH 0.1.5 slot contract** (`conversation.session.header.utilities`, `kind: list`).
- **The granted / topped-up split lives in the hover tooltip only**; the chip itself shows the total, deliberately, to keep the header control narrow.
- **No balance history, no usage statistics, no low-balance threshold alerts.**
- **Amounts are never used in arithmetic** — formatting only. Settlement happens server-side.
- Depends on the host-side `settings` and `credentials` services; if either is absent it falls back to process environment variables, and reports "not configured" when neither yields a key.

## License

MIT
