#!/usr/bin/env node
// owner: U1 (BDS harness & e2e infra)
'use strict'
// `pnpm test:e2e [--] [mocha args]` → mocha with packages/mineflayer-bedrock/.mocharc.e2e.json.
// pnpm (>= 7) forwards a literal `--` to the script, which mocha would treat as "end of options"
// (turning `--grep smoke` into file patterns), so it is dropped here. Both
// `pnpm test:e2e --grep smoke` and `pnpm test:e2e -- --grep smoke` work.
//
// Servers come from the @bedboo/bds harness (one isolated BDS per test file, host-wide slots), or from
// BDS_HOST/BDS_PORT(/BDS_CONTAINER) when set. SIGINT/SIGTERM are forwarded to mocha, whose process
// removes its containers on exit (the harness reaps them later if it is killed hard).
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const pkgDir = path.join(__dirname, '../packages/mineflayer-bedrock')
const args = process.argv.slice(2).filter((arg, i) => !(arg === '--' && i === 0))
const mocha = path.join(pkgDir, 'node_modules', '.bin', process.platform === 'win32' ? 'mocha.cmd' : 'mocha')

if (!process.env.BDS_HOST && !process.env.BDS_PORT) {
  try {
    const { goldenInfo } = require('@bedboo/bds/lib/golden')
    if (!goldenInfo()) {
      console.error('[test:e2e] the golden BDS cache is missing: run `corepack pnpm bds pull` first (or set BDS_HOST/BDS_PORT)')
      process.exit(1)
    }
  } catch (err) {
    if (!fs.existsSync(path.join(__dirname, '../packages/bds'))) throw err
  }
}

const child = spawn(mocha, ['--config', '.mocharc.e2e.json', ...args], {
  cwd: pkgDir,
  stdio: 'inherit',
  shell: process.platform === 'win32' // .cmd shims need a shell on Windows
})
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { if (child.exitCode === null) child.kill(sig) })
}
child.on('error', (err) => { throw err })
child.on('close', (code, signal) => process.exit(code ?? (signal ? 130 : 1)))
