// owner: U3 (parity tooling)
'use strict'
/**
 * mineflayer-bedrock's surface, collected the same way as the upstream reference (./reference.js):
 *
 * - inject: `createBot({ client: fakeBedrockClient })`, after `inject_allowed` (no server);
 * - windows: the same window probe as upstream (./windows.js);
 * - postJoin: the recorded BDS join (test/fixtures join_flat) is replayed into the fake client up to
 *   `play_status player_spawn` (+ the bedrock-protocol `join`/`spawn` events), then the surface is
 *   snapshot again (bot.entity, bot.username, bot.player, bot.game.*, …). Errors thrown by plugins
 *   while handling the replay are collected, not thrown;
 * - dts: mineflayer-bedrock's own index.d.ts (./dts.js).
 */
const path = require('path')
const { EventEmitter } = require('events')
const { snapshot, namespace, describeValue, unrefTimers, realSetTimeout } = require('./surface')
const { probeWindows } = require('./windows')
const { readDts } = require('./dts')

const PKG_DIR = path.join(__dirname, '../../..')

/** Stand-in for a bedrock-protocol Client (no network): on/queue/write/disconnect/close. */
function fakeBedrockClient ({ username = 'ConformanceBot' } = {}) {
  const client = new EventEmitter()
  client.setMaxListeners(0)
  client.version = '1.26.51'
  client.username = username
  client.options = { version: '1.26.51', username, offline: true }
  client.written = []
  client.queue = (name, params) => client.written.push(['queue', name, params])
  client.write = (name, params) => client.written.push(['write', name, params])
  client.disconnect = (reason) => client.close(reason)
  client.close = () => {
    if (client.closed) return
    client.closed = true
    client.emit('close')
  }
  return client
}

function waitInjected (bot, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = realSetTimeout(() => reject(new Error('mineflayer-bedrock bot never emitted inject_allowed')), timeoutMs)
    bot.once('inject_allowed', () => setImmediate(() => { clearTimeout(timer); resolve() }))
  })
}

async function createInjectedBot (options = {}) {
  const mineflayerBedrock = require(PKG_DIR)
  const client = fakeBedrockClient(options)
  const errors = []
  const bot = mineflayerBedrock.createBot({ client, username: client.username, logErrors: false, hideErrors: true, ...options })
  bot.on('error', (err) => errors.push(err))
  await waitInjected(bot)
  return { bot, client, errors }
}

/** Close a probe bot and drop every listener (its timers are unref'd, see ./surface.js unrefTimers). */
function dispose (created) {
  if (!created) return
  const { bot, client } = created
  bot.removeAllListeners('error')
  bot.on('error', () => {})
  try { bot.end('conformance done') } catch (err) {}
  client.removeAllListeners()
}

const bedrockRequire = (id) => require(require.resolve(id, { paths: [PKG_DIR] }))

/** inject-time snapshot + window probe of a fresh bot */
async function injectSurface () {
  const restoreTimers = unrefTimers()
  const created = []
  try {
    created.push(await createInjectedBot())
    const { bot } = created[0]
    const inject = snapshot(bot)
    const exports = {}
    for (const [name, value] of Object.entries(require(PKG_DIR))) exports[name] = describeValue(value)
    const freshBot = async () => {
      created.push(await createInjectedBot())
      return created[created.length - 1].bot
    }
    const windows = await probeWindows(bot, { require: bedrockRequire, freshBot })
    const errors = created.flatMap(c => c.errors.map(e => e.message))
    return { inject, exports, windows, errors }
  } finally {
    created.forEach(dispose)
    restoreTimers()
  }
}

/**
 * Replay the join_flat capture into a fresh bot and snapshot the surface after spawn.
 * @returns {Promise<{ post: object, entity: object, spawned: boolean, errors: string[], replayed: number }>}
 */
async function postJoinSurface ({ settleMs = 100 } = {}) {
  const fixtures = require(path.join(PKG_DIR, 'test/fixtures'))
  const cap = fixtures.load('join_flat')
  const restoreTimers = unrefTimers()
  let created
  try {
    created = await createInjectedBot({ username: cap.meta.username })
    const { bot, client, errors } = created
    const thrown = []
    let spawned = false
    let replayed = 0
    bot.once('spawn', () => { spawned = true })
    client.emit('loggingIn')
    const spawnIndex = cap.records.findIndex(r => r.dir === 'in' && r.name === 'play_status' && cap.parse(r).status === 'player_spawn')
    for (let i = 0; i <= spawnIndex; i++) {
      const r = cap.records[i]
      if (r.dir !== 'in') continue
      const params = cap.parse(r)
      if (r.name === 'start_game') {
        client.startGameData = params
        client.entityId = params.runtime_entity_id
      }
      // the same sequence bedrock-protocol's Client#readPacket produces: 'packet', then the lifecycle
      // events of its switch ('join' on server_to_client_handshake, 'spawn' on play_status
      // player_spawn), then the packet's own event
      try {
        client.emit('packet', { data: { name: r.name, params } })
        if (r.name === 'server_to_client_handshake') client.emit('join')
        if (r.name === 'play_status' && params.status === 'player_spawn') client.emit('spawn')
        client.emit(r.name, params)
      } catch (err) {
        thrown.push(`${r.name}: ${err.message}`)
      }
      replayed++
      if (replayed % 50 === 0) await new Promise(resolve => setImmediate(resolve))
    }
    await new Promise(resolve => realSetTimeout(resolve, settleMs))
    const post = snapshot(bot)
    const entity = bot.entity && typeof bot.entity === 'object' ? namespace(bot.entity, 'bot.entity', 'entity') : {}
    return { post, entity, spawned, replayed, errors: [...thrown, ...errors.map(e => `'error' event: ${e.message}`)] }
  } finally {
    dispose(created)
    restoreTimers()
  }
}

function dtsSurface () {
  return readDts(path.join(PKG_DIR, 'index.d.ts'))
}

module.exports = { injectSurface, postJoinSurface, dtsSurface, fakeBedrockClient, createInjectedBot }
