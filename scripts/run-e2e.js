#!/usr/bin/env node
'use strict'
// `pnpm test:e2e [--] [mocha args]` → mocha with packages/mineflayer-bedrock/.mocharc.e2e.json.
// pnpm (>= 7) forwards a literal `--` to the script, which mocha would treat as "end of options"
// (turning `--grep smoke` into file patterns), so it is dropped here. Both
// `pnpm test:e2e --grep smoke` and `pnpm test:e2e -- --grep smoke` work.
const { spawnSync } = require('child_process')
const path = require('path')

const pkgDir = path.join(__dirname, '../packages/mineflayer-bedrock')
const args = process.argv.slice(2).filter((arg, i) => !(arg === '--' && i === 0))
const mocha = path.join(pkgDir, 'node_modules', '.bin', process.platform === 'win32' ? 'mocha.cmd' : 'mocha')
const res = spawnSync(mocha, ['--config', '.mocharc.e2e.json', ...args], {
  cwd: pkgDir,
  stdio: 'inherit',
  shell: process.platform === 'win32' // .cmd shims need a shell on Windows
})
if (res.error) throw res.error
process.exit(res.status ?? 1)
