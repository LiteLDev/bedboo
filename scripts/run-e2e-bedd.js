#!/usr/bin/env node
// owner: BEDD-6 (real-client e2e + docs)
'use strict'
// `corepack pnpm test:e2e:bedd [--] [mocha args]` → mocha with packages/mineflayer-bedrock/.mocharc.bedd.json: the
// opt-in real-client e2e (test/bedd/*.e2e.js) against a Minecraft Bedrock client hosted by Be.D.D. See docs/bedd.md
// and docs/testing.md#real-client-e2e-bedd.
//
// It runs on Windows with BEDBOO_BEDD_PIPE set to the BeDD client's control pipe; anywhere else the suites are
// reported as pending (skipped), never failed, so the command is safe on Linux CI too.
//
// The client must already be in a world (BeDD has no `connect` op yet):
// - a BDS world: the Docker BDS of `corepack pnpm bds up` (127.0.0.1, so BeDD's loopbackOnly is fine). Set
//   BDS_CONTAINER so the suites can set things up and check effects on the BDS console; when docker only runs in WSL,
//   also set BEDBOO_BEDD_DOCKER (e.g. `wsl -d Debian -e docker`). With BEDBOO_BEDD_START_BDS=1 (and docker on PATH)
//   this script starts that server itself (`bedboo-bedd-e2e`, survival, flat; kept running) and prints the port the
//   client has to join.
// - a singleplayer / LAN-host world: no console; setup runs as the player (`send`), checks use the tapped state.
const { spawn } = require('child_process')
const path = require('path')

const pkgDir = path.join(__dirname, '../packages/mineflayer-bedrock')
const args = process.argv.slice(2).filter((arg, i) => !(arg === '--' && i === 0))
const mocha = path.join(pkgDir, 'node_modules', '.bin', process.platform === 'win32' ? 'mocha.cmd' : 'mocha')

async function maybeStartBds () {
  if (process.env.BEDBOO_BEDD_START_BDS !== '1' || process.env.BDS_CONTAINER) return
  const bds = require('@bedboo/bds')
  const name = process.env.BEDBOO_BEDD_BDS_NAME || 'bedd-e2e'
  let srv
  const info = await require('@bedboo/bds/lib/docker').inspect('bedboo-' + name)
  if (info && !info.State?.Running) throw new Error(`bedboo-${name} exists but is stopped: \`corepack pnpm bds down ${name}\` and retry`)
  try {
    srv = await bds.attachServer(name)
    console.log(`[test:e2e:bedd] reusing ${srv.container} on ${srv.host}:${srv.port}`)
  } catch {
    srv = await bds.startServer({ name, persistent: true, useExternal: false, world: 'flat', gamemode: 'survival' })
    console.log(`[test:e2e:bedd] started ${srv.container} on ${srv.host}:${srv.port} (remove it with \`corepack pnpm bds down ${name}\`)`)
  }
  process.env.BDS_HOST = srv.host
  process.env.BDS_PORT = String(srv.port)
  process.env.BDS_CONTAINER = srv.container
  try {
    await waitForPlayer(srv)
  } finally {
    srv.detach()
  }
}

/** wait until a player is online (`list`): the BeDD client has to join the server before the suites can attach */
async function waitForPlayer (srv) {
  const timeout = Number(process.env.BEDBOO_BEDD_JOIN_TIMEOUT || 300000)
  const end = Date.now() + timeout
  let nextHint = 0
  for (;;) {
    const lines = await srv.commandOutput('list', { timeout: 15000 })
    const m = lines.map((l) => /There are (\d+)\/\d+ players online/.exec(l)).find(Boolean)
    if (m && Number(m[1]) > 0) return
    if (Date.now() > end) throw new Error(`no player joined ${srv.host}:${srv.port} within ${timeout} ms`)
    if (Date.now() >= nextHint) {
      console.log(`[test:e2e:bedd] waiting for the BeDD client to join ${srv.host}:${srv.port} (Play → Servers → Add server)`)
      nextHint = Date.now() + 30000
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

function report () {
  if (process.platform !== 'win32') console.log(`[test:e2e:bedd] ${process.platform}: the real-client suites skip (Windows only)`)
  else if (!process.env.BEDBOO_BEDD_PIPE) console.log('[test:e2e:bedd] BEDBOO_BEDD_PIPE is not set: the real-client suites skip')
  else {
    const where = process.env.BDS_CONTAINER ? `BDS console ${process.env.BDS_CONTAINER}` : 'no BDS console (tapped state only)'
    console.log(`[test:e2e:bedd] client ${process.env.BEDBOO_BEDD_PIPE}; ${where}`)
  }
}

async function main () {
  await maybeStartBds()
  report()
  const child = spawn(mocha, ['--config', '.mocharc.bedd.json', ...args], {
    cwd: pkgDir,
    stdio: 'inherit',
    shell: process.platform === 'win32' // .cmd shims need a shell on Windows
  })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { if (child.exitCode === null) child.kill(sig) })
  }
  child.on('error', (err) => { throw err })
  child.on('close', (code, signal) => process.exit(code ?? (signal ? 130 : 1)))
}

main().catch((err) => {
  console.error('[test:e2e:bedd]', err)
  process.exit(1)
})
