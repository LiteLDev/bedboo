#!/usr/bin/env node
'use strict'
// `pnpm typecheck`: runs `tsc --noEmit` over index.d.ts + types/ + test/types/usage.ts.
// test/types/tsconfig.json sets skipLibCheck (so a plain `tsc --noEmit -p test/types/tsconfig.json`
// passes), but that also skips our own .d.ts files; this script turns lib checking back on and fails
// only on diagnostics in this package's files. Several dependencies ship .d.ts files that do not
// compile under `strict` (protodef, prismarine-chunk, prismarine-nbt, …); those are counted and ignored.
const { spawnSync } = require('child_process')
const path = require('path')

const pkgDir = path.join(__dirname, '../..')
const tsc = path.join(pkgDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
const res = spawnSync(tsc, ['--noEmit', '--pretty', 'false', '--skipLibCheck', 'false', '-p', path.join(__dirname, 'tsconfig.json')], {
  cwd: pkgDir,
  encoding: 'utf8',
  shell: process.platform === 'win32' // .cmd shims need a shell on Windows
})
if (res.error) throw res.error
const lines = (res.stdout + res.stderr).split('\n').filter(Boolean)
const diagnostics = lines.filter(l => /error TS\d+/.test(l))
// `path(line,col): error TSxxxx: message` — classify by the file path only (messages may mention node_modules)
const ours = diagnostics.filter(l => !l.split('(')[0].includes('node_modules'))
const theirs = diagnostics.length - ours.length

if (ours.length) {
  console.error(ours.join('\n'))
  console.error(`\ntypecheck: ${ours.length} error(s) in mineflayer-bedrock type definitions`)
  process.exit(1)
}
if (res.status !== 0 && diagnostics.length === 0) {
  console.error(lines.join('\n'))
  console.error('\ntypecheck: tsc failed without diagnostics')
  process.exit(1)
}
console.log(`typecheck: OK (${theirs} diagnostic(s) in third-party .d.ts files ignored)`)
