# External (real BDS) tests

`pnpm test:e2e` runs `test/external/**/*.test.js` with `.mocharc.e2e.json`.

- File names are the mineflayer external test names (`docs/upstream/externalTests/<name>.js` →
  `<name>.test.js`) or Bedrock extras (e.g. `dimensionTravel.test.js`).
- Shared helpers (`bot.test.*`, console-only, never plugin APIs) live in `common/` and
  `common/helpers/<area>.js` — owned by U1, one owner per helper file (docs/CONTRIBUTING.md).
- Until U1's harness lands, tests use an already-running server via `BDS_HOST`/`BDS_PORT`
  (+ `BDS_CONTAINER` for console commands) and skip otherwise:

```sh
BDS_HOST=127.0.0.1 BDS_PORT=40100 BDS_CONTAINER=bds-u0 corepack pnpm test:e2e -- --grep smoke
```

`transport.test.js` is the U0 transport spike as a test (raw bedrock-protocol client through
`lib/client.js`: join, spawn, `level_chunk`, `subchunk`).
