// owner: U1 (BDS harness & e2e infra)
'use strict'
/**
 * @bedboo/bds — Docker-based Bedrock Dedicated Server harness.
 *
 *   const { startServer, createTestBot } = require('@bedboo/bds')
 *   const server = await startServer({ world: 'flat', gamemode: 'creative' })   // isolated BDS in a slot
 *   await server.commandWithOutput('list', /players online/)
 *   const { bot } = await createTestBot({ server, createBot: require('mineflayer-bedrock').createBot })
 *   …
 *   bot.end(); await server.stop()
 *
 * ENV FALLBACK: if `BDS_HOST` or `BDS_PORT` is set, `startServer()` starts nothing and returns a
 * handle to that already-running server (`BDS_CONTAINER` names its container for console commands).
 *
 * Details: docs/testing.md.
 *
 * @typedef {import('./lib/server').BdsServer} ServerHandle
 */

const { NotImplementedError } = require('./lib/errors')
const server = require('./lib/server')
const golden = require('./lib/golden')
const snapshots = require('./lib/snapshots')
const reaper = require('./lib/reaper')
const slots = require('./lib/slots')
const config = require('./lib/config')
const properties = require('./lib/properties')
const profiles = require('./lib/profiles')
const docker = require('./lib/docker')
const { Console } = require('./lib/console')

const DEFAULT_PORT = 19132

/**
 * Start a server (or use `opts.server`) and connect a bot to it. Resolves after the bot spawned.
 *
 * @param {object} [opts]
 * @param {ServerHandle} [opts.server] existing server (not stopped by `stop()`)
 * @param {object} [opts.serverOptions] startServer options when no server is given
 * @param {(options: object) => object} opts.createBot e.g. `require('mineflayer-bedrock').createBot`
 * @param {string} [opts.username] default `flatbot` (random suffix on shared external servers)
 * @param {object} [opts.botOptions] extra createBot options
 * @param {(bot: object, server: ServerHandle) => (void|Promise<void>)} [opts.onCreate] called synchronously
 *   right after createBot (before any packet is processed), e.g. to inject test helpers
 * @param {(bot: object, server: ServerHandle) => Promise<void>} [opts.waitForSpawn] default: the bot's `spawn` event
 * @param {number} [opts.timeout] spawn timeout (ms), default 60000
 * @returns {Promise<{ bot: object, server: ServerHandle, stop: () => Promise<void> }>}
 */
async function createTestBot (opts = {}) {
  if (typeof opts.createBot !== 'function') {
    throw new TypeError('createTestBot needs opts.createBot (e.g. require("mineflayer-bedrock").createBot)')
  }
  const ownsServer = !opts.server
  const srv = opts.server ?? await server.startServer(opts.serverOptions)
  const username = opts.username ?? (srv.external ? `flatbot${Math.floor(Math.random() * 1e4)}` : 'flatbot')
  let bot
  try {
    bot = opts.createBot({ host: srv.host, port: srv.port, username, ...opts.botOptions })
    if (opts.onCreate) await opts.onCreate(bot, srv)
    const wait = opts.waitForSpawn ?? defaultWaitForSpawn
    await withTimeout(wait(bot, srv), opts.timeout ?? 60000, `${username} did not spawn on ${srv.host}:${srv.port}`)
  } catch (err) {
    try { bot?.end?.('createTestBot failed') } catch {}
    if (ownsServer) await srv.stop().catch(() => {})
    throw err
  }
  const stop = async () => {
    try { bot.end?.('test done') } catch {}
    if (ownsServer) await srv.stop()
  }
  return { bot, server: srv, stop }
}

function defaultWaitForSpawn (bot) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => { cleanup(); resolve() }
    const onEnd = (reason) => { cleanup(); reject(new Error(`bot ended before spawning: ${reason}`)) }
    const onKick = (reason) => { cleanup(); reject(new Error(`bot kicked before spawning: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`)) }
    const cleanup = () => {
      bot.removeListener('spawn', onSpawn)
      bot.removeListener('end', onEnd)
      bot.removeListener('kicked', onKick)
    }
    bot.once('spawn', onSpawn)
    bot.once('end', onEnd)
    bot.once('kicked', onKick)
  })
}

function withTimeout (promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${message} within ${ms} ms`)), ms) })
  ]).finally(() => clearTimeout(timer))
}

module.exports = {
  startServer: server.startServer,
  createTestBot,
  externalServer: server.externalServer,
  attachServer: server.attachServer,
  downServer: server.downServer,
  pull: golden.pull,
  reap: reaper.reap,
  clean: reaper.clean,
  listSlots: slots.listSlots,
  listSnapshots: snapshots.listSnapshots,
  readSnapshot: snapshots.readSnapshot,
  deleteSnapshot: snapshots.deleteSnapshot,
  BdsServer: server.BdsServer,
  PortInUseError: server.PortInUseError,
  Console,
  NotImplementedError,
  config,
  properties,
  profiles,
  docker,
  DEFAULT_PORT
}
