#!/usr/bin/env node
// owner: U1 (BDS harness & e2e infra)
'use strict'
// `pnpm bds <pull|up|cmd|logs|down|clean>` — Docker BDS harness CLI. Implemented by U1.

const USAGE = `Usage: bds <command> [options]

Commands (implemented by U1):
  pull                 pull the image and extract the golden BDS 1.26.51.1 cache
  up --name <n>        start an isolated BDS instance
  cmd <n> <command>    send a console command
  logs <n>             follow server logs
  down <n>             stop and remove an instance
  clean [--all]        remove this user's (or all) bedboo containers

Until U1 lands, use the manual docker recipe in docs/testing.md.`

// pnpm forwards a literal `--` (`pnpm bds -- up`); ignore it.
const argv = process.argv.slice(2).filter((arg, i) => !(arg === '--' && i === 0))
const [command] = argv
if (!command || command === '--help' || command === '-h' || command === 'help') {
  console.log(USAGE)
  process.exit(command ? 0 : 1)
}
console.error(`bds ${command}: not implemented (U1)`)
process.exit(1)
