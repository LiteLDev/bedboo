# External (real BDS) tests

`corepack pnpm test:e2e [-- --grep <suite>]` runs `test/external/**/*.test.js` with `.mocharc.e2e.json`
through `scripts/run-e2e.js`. Run `corepack pnpm bds pull` once per host first. Full documentation:
[`docs/testing.md`](../../../../docs/testing.md).

- File names are the mineflayer external test names (`docs/upstream/externalTests/<name>.js` →
  `<name>.test.js`) or Bedrock extras (e.g. `dimensionTravel.test.js`).
- Each file gets an isolated BDS from the `@bedboo/bds` harness (`useBot()` / `useServer()` from
  `./common`), or the already-running server from `BDS_HOST`/`BDS_PORT` (+ `BDS_CONTAINER` for console
  commands).
- Shared helpers (`bot.test.*`, console + raw packets only, never plugin APIs) live in `common/` and
  `common/helpers/<area>.js` — one owner per helper file (docs/CONTRIBUTING.md).

```js
const { useBot } = require('./common')
describe('time', function () {
  const ctx = useBot()                                  // flat creative world, deterministic gamerules
  beforeEach(() => ctx.bot.test.resetState())
  it('...', async () => { const { bot, server } = ctx /* … */ })
})
```

U1 files: `harness.test.js` (smoke: raw client join + console round trips; profile; snapshots),
`helpers.test.js` (every helper against a raw-client bot), `transport.test.js` (U0's raw transport
spike), `stress.test.js` (N parallel servers; `BEDBOO_STRESS=1 BEDBOO_WORKER_SLOTS=6`).
