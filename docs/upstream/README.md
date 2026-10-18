# Pinned upstream references (read-only)

Exact copies of mineflayer files, kept so every unit ports against the same reference. Do not edit;
do not import from here at runtime (the library depends on the `mineflayer@4.39.0` npm package).

| File | Source |
|---|---|
| `api.md` | mineflayer tag `4.39.0` `docs/api.md` |
| `index.d.ts` | mineflayer tag `4.39.0` `index.d.ts` |
| `externalTest.js` | mineflayer tag `4.39.0` `test/externalTest.js` (the external test runner) |
| `externalTests/*.js` (46 files) | mineflayer tag `4.39.0` `test/externalTests/*.js` — the parity checklist |
| `externalTests/plugins/testCommon.js` | mineflayer tag `4.39.0` `test/externalTests/plugins/testCommon.js` (the 20 `bot.test.*` helpers) |
| `internalTest.js` | mineflayer tag `4.39.0` `test/internalTest.js` (mock-server unit tests; every `describe`/`it` is mapped to a unit in `docs/parity/U3-internal-tests.md`) — added by U3 |
| `abilities.master.js` | mineflayer `master` @ `7b4bb8d2b56be9cdb832474af873acd37e609746` (2026-10-10) `lib/plugins/abilities.js` — not in 4.39.0; we implement it too (`lib/plugins/abilities.js`, U9) |
| `LICENSE.mineflayer` | mineflayer tag `4.39.0` `LICENSE` |

Tag `4.39.0` = commit `c168635cf2f6602069fc5e408bec864702335581`.
Fetched from `https://raw.githubusercontent.com/PrismarineJS/mineflayer/<ref>/<path>`.

## License and attribution

mineflayer is MIT licensed — Copyright (c) 2013 Andrew Kelley — see `LICENSE.mineflayer`. These files are
redistributed unchanged under that license. Code adapted from them into bedboo must keep an attribution
comment naming the source file and version.
