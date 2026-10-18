// owner: U1 (BDS harness & e2e infra)
'use strict'
/**
 * Shared e2e plumbing for test/external/*.test.js: servers, bots and the `bot.test.*` helpers.
 *
 *   const { useBot } = require('./common')
 *   describe('gamemode', function () {
 *     const ctx = useBot({ server: { gamemode: 'creative' } })   // before: server + bot, after: cleanup
 *     beforeEach(() => ctx.bot.test.resetState())
 *     it('change', async () => { await ctx.bot.test.becomeSurvival() })
 *   })
 *
 * Helpers mirror mineflayer 4.39.0 test/externalTests/plugins/testCommon.js (names, signatures,
 * semantics) but only use the BDS console (@bedboo/bds) and raw Bedrock packets on `bot._client` —
 * never plugin APIs — so they work while plugins are still stubs. They are installed from
 * `helpers/<area>.js`: base, world, inventory, entities first, then every other file alphabetically
 * (chat.js, place.js, … from later units), each `module.exports = function install (bot, ctx) {}`
 * may replace or wrap helpers installed before it.
 */
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const bds = require('@bedboo/bds')

const base = require('./helpers/base')
const { implemented } = base

const HELPERS_DIR = path.join(__dirname, 'helpers')
const HELPER_ORDER = ['base', 'world', 'inventory', 'entities']

/** helper files in load order */
function helperFiles () {
  const files = fs.readdirSync(HELPERS_DIR).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3))
  const rest = files.filter((f) => !HELPER_ORDER.includes(f)).sort()
  return [...HELPER_ORDER.filter((f) => files.includes(f)), ...rest]
}

/**
 * Install `bot.test` on a bot (mineflayer-bedrock bot or {@link RawBot}). Call it synchronously right
 * after creating the bot so the packet tracker sees start_game / item_registry.
 * @param {object} bot
 * @param {import('@bedboo/bds').BdsServer} server
 * @param {{ username?: string, autoRespawn?: boolean }} [opts]
 * @returns {object} ctx shared by the helper files
 */
function inject (bot, server, opts = {}) {
  const ctx = base.createContext(bot, server, opts)
  bot.test = {}
  for (const name of helperFiles()) {
    const install = require(path.join(HELPERS_DIR, name))
    if (typeof install !== 'function') throw new TypeError(`helpers/${name}.js must export install(bot, ctx)`)
    install(bot, ctx)
  }
  return ctx
}

/**
 * Minimal bot over a raw bedrock-protocol client (lib/client.js defaults): `_client`, `username`,
 * `entity` (undefined), `end()`/`quit()`, events `spawn` (after the join handshake done by the
 * helpers' raw client behaviour) and `end`.
 */
class RawBot extends EventEmitter {
  constructor (options) {
    super()
    require('@bedboo/bedrock-data').install()
    const { createClient } = require('../../../lib/client')
    this._rawBot = true
    this.username = options.username
    this.options = options
    this.entity = undefined
    this._client = createClient({ conLog: null, ...options })
    this._client.on('error', (err) => this.emit('error', err))
    this._client.on('close', () => this.emit('end', this._endReason ?? 'socketClosed'))
    this._client.on('kick', (packet) => this.emit('kicked', packet?.message ?? packet, true))
    // unhandled 'error' events would crash the test process
    this.on('error', () => {})
  }

  end (reason = 'end') {
    this._endReason = reason
    try { this._client.disconnect(reason) } catch {}
    try { this._client.close() } catch {}
  }

  quit (reason) {
    this.end(reason ?? 'disconnect.quitting')
  }
}

function createRawBot (options) {
  return new RawBot(options)
}

/**
 * Start a server (or use `opts.server`), create a bot, install `bot.test` and wait until it spawned.
 * @param {object} [opts]
 * @param {import('@bedboo/bds').BdsServer} [opts.server]
 * @param {object} [opts.serverOptions] startServer options when no server is given
 * @param {boolean} [opts.raw] use a {@link RawBot} instead of mineflayer-bedrock's createBot
 * @param {string} [opts.username]
 * @param {object} [opts.botOptions] extra createBot options
 * @param {boolean} [opts.autoRespawn] raw mode: answer death with the respawn handshake (default true)
 * @param {number} [opts.timeout]
 * @returns {Promise<{ bot: object, server: object, ctx: object, stop: () => Promise<void> }>}
 */
async function createTestBot (opts = {}) {
  let ctx
  const createBot = opts.raw ? createRawBot : (options) => require('../../../').createBot(options)
  const res = await bds.createTestBot({
    server: opts.server,
    serverOptions: opts.serverOptions,
    username: opts.username,
    botOptions: opts.botOptions,
    timeout: opts.timeout,
    createBot,
    onCreate (bot, server) {
      ctx = inject(bot, server, { autoRespawn: opts.autoRespawn })
      bot.test.port = server.port
      bot.test.host = server.host
    },
    waitForSpawn: (bot) => ctx.waitForSpawn()
  })
  return { ...res, ctx }
}

/**
 * Mocha convenience: `before` starts a server + bot, `after` stops both. Returns a context object
 * whose `bot`, `server` and `ctx` are filled in by the `before` hook.
 * @param {{ server?: object, raw?: boolean, username?: string, botOptions?: object, timeout?: number }} [opts]
 *   `server`: startServer options
 */
function useBot (opts = {}) {
  const state = { bot: null, server: null, ctx: null, stop: null }
  before(async function () {
    // queueing for a slot may take a while; startServer has its own timeouts
    this.timeout(0)
    const server = await bds.startServer(opts.server)
    state.server = server
    const res = await createTestBot({ ...opts, server })
    Object.assign(state, { bot: res.bot, ctx: res.ctx, stop: res.stop })
  })
  after(async function () {
    this.timeout(120000)
    try { state.bot?.test?.abortRunningExample?.() } catch {}
    try { state.bot?.end?.('test done') } catch {}
    if (state.server) await state.server.stop()
  })
  return state
}

/**
 * Mocha convenience for a server without a bot (raw clients, console only).
 * @param {object} [serverOptions]
 */
function useServer (serverOptions) {
  const state = { server: null }
  before(async function () {
    this.timeout(0)
    state.server = await bds.startServer(serverOptions)
  })
  after(async function () {
    this.timeout(120000)
    if (state.server) await state.server.stop()
  })
  return state
}

module.exports = {
  inject,
  createTestBot,
  createRawBot,
  RawBot,
  useBot,
  useServer,
  startServer: (opts) => bds.startServer(opts),
  implemented,
  helperFiles,
  bds
}
