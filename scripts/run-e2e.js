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
//
// `--shard i/n` (U16a, wave 5): run only the i-th of n parts of test/external/*.test.js (1-based), balanced by the
// files' measured durations, e.g. four processes `pnpm test:e2e --shard 1/4` … `--shard 4/4` for a full run. Each
// shard holds one slot at a time (its files run serially); give each its own BEDBOO_OWNER when the shards together
// need more than BEDBOO_WORKER_SLOTS slots. `--shard-list` prints the files of the shard and exits.
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const pkgDir = path.join(__dirname, '../packages/mineflayer-bedrock')
let args = process.argv.slice(2).filter((arg, i) => !(arg === '--' && i === 0))
const mocha = path.join(pkgDir, 'node_modules', '.bin', process.platform === 'win32' ? 'mocha.cmd' : 'mocha')

/**
 * Approximate seconds per e2e file (U16a's wave-5 full runs: tests + server start); unlisted files count DEFAULT_WEIGHT.
 * Only the balance depends on these numbers.
 */
const WEIGHTS = {
  'digEverything.test.js': 760,
  'digOres.test.js': 520,
  'physicsLoop.test.js': 140,
  'physicsBlocks.test.js': 120,
  'combatMatrix.test.js': 120,
  'ecosystemPathfinder.test.js': 110,
  'craftingTags.test.js': 50,
  'digging.test.js': 45,
  'physicsFlight.test.js': 45,
  'ecosystemCollectBlock.test.js': 40,
  'furnace.test.js': 40,
  'dimensionTravel.test.js': 40,
  'craftingMatrix.test.js': 35,
  'coreJoin.test.js': 30,
  'hardening.test.js': 30,
  'physicsInteractions.test.js': 30,
  'readmeQuickstart.test.js': 30,
  'animals.test.js': 28,
  'entities.test.js': 28,
  'exampleBee.test.js': 25,
  'enchanting.test.js': 25,
  'exampleEcosystem.test.js': 25,
  'riding.test.js': 22,
  'scaffold.test.js': 22,
  'mobFights.test.js': 20,
  'anvil.test.js': 20,
  'ecosystemPvp.test.js': 20
}
const DEFAULT_WEIGHT = 12
const WEIGHT_KEY = (f) => path.basename(f)

/** the files of shard `index` (0-based) of `count`: longest first, each to the shard with the least work so far */
function shardFiles (index, count) {
  const dir = path.join(pkgDir, 'test', 'external')
  // the config's spec: test/external/**/*.test.js (paths relative to test/external)
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.test.js')).sort()
  const weight = (f) => WEIGHTS[WEIGHT_KEY(f)] ?? DEFAULT_WEIGHT
  const shards = Array.from({ length: count }, () => ({ files: [], load: 0 }))
  for (const f of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((best, s) => (s.load < best.load ? s : best))
    lightest.files.push(f)
    lightest.load += weight(f)
  }
  return shards[index].files.sort().map((f) => path.join('test', 'external', f))
}

const shardAt = args.findIndex((a) => a === '--shard' || a.startsWith('--shard='))
if (shardAt !== -1) {
  const value = args[shardAt].includes('=') ? args[shardAt].split('=')[1] : args[shardAt + 1]
  const m = /^(\d+)\/(\d+)$/.exec(value ?? '')
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
    console.error(`[test:e2e] --shard expects i/n with 1 <= i <= n, got ${value}`)
    process.exit(2)
  }
  args.splice(shardAt, args[shardAt].includes('=') ? 1 : 2)
  const files = shardFiles(Number(m[1]) - 1, Number(m[2]))
  if (args.includes('--shard-list')) {
    console.log(files.join('\n'))
    process.exit(0)
  }
  if (files.length === 0) {
    console.log(`[test:e2e] shard ${value}: no test files`)
    process.exit(0)
  }
  // the config's `spec` would add every file again (mocha appends CLI specs): its other options are passed instead
  const config = JSON.parse(fs.readFileSync(path.join(pkgDir, '.mocharc.e2e.json'), 'utf8'))
  const options = ['--no-config']
  if (config.timeout !== undefined) options.push('--timeout', String(config.timeout))
  if (config.exit) options.push('--exit')
  for (const r of [].concat(config.require ?? [])) options.push('--require', r)
  args = [...options, ...args, ...files]
}

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

const child = spawn(mocha, shardAt !== -1 ? args : ['--config', '.mocharc.e2e.json', ...args], {
  cwd: pkgDir,
  stdio: 'inherit',
  shell: process.platform === 'win32' // .cmd shims need a shell on Windows
})
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { if (child.exitCode === null) child.kill(sig) })
}
child.on('error', (err) => { throw err })
child.on('close', (code, signal) => process.exit(code ?? (signal ? 130 : 1)))
