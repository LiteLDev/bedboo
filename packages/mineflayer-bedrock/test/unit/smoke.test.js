'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const mineflayerBedrock = require('../..')
const { NotImplementedError, isStub } = require('../../lib/bedrock/errors')

const UPSTREAM_PLUGIN_DIR = path.join(path.dirname(require.resolve('mineflayer/package.json')), 'lib', 'plugins')
const PLUGIN_DIR = path.join(__dirname, '../../lib/plugins')

/** Minimal stand-in for a bedrock-protocol client (no network). */
function fakeClient () {
  const client = new EventEmitter()
  client.version = '1.26.51'
  client.written = []
  client.queue = (name, params) => client.written.push(['queue', name, params])
  client.write = (name, params) => client.written.push(['write', name, params])
  client.end = (reason) => { client.ended = reason; client.emit('end', reason) }
  return client
}

/** createBot with a fake client; resolves once every plugin has been injected. */
function createInjectedBot (options = {}) {
  const client = fakeClient()
  const bot = mineflayerBedrock.createBot({ client, username: 'SmokeBot', logErrors: false, ...options })
  return new Promise((resolve, reject) => {
    bot.once('error', reject)
    bot.once('inject_allowed', () => setImmediate(() => resolve({ bot, client })))
  })
}

// Functions the loader / plugin_loader / EventEmitter define (implemented, not stubs).
const IMPLEMENTED = new Set(['end', '_warn', 'loadPlugin', 'loadPlugins', 'hasPlugin', 'supportFeature'])

function pluginFunctions (bot) {
  const out = []
  for (const key of Object.getOwnPropertyNames(bot)) {
    if (key.startsWith('_events') || key === '_maxListeners' || IMPLEMENTED.has(key)) continue
    const desc = Object.getOwnPropertyDescriptor(bot, key)
    if (desc.get) continue // getters (heldItem, bossBars) are data accessors
    if (typeof desc.value === 'function') out.push(['bot.' + key, desc.value])
  }
  for (const [ns, obj] of [['bot.creative', bot.creative], ['bot.simpleClick', bot.simpleClick]]) {
    for (const [key, value] of Object.entries(obj)) if (typeof value === 'function') out.push([`${ns}.${key}`, value])
  }
  for (const key of ['simulatePlayer', 'adjustPositionHeight']) out.push(['bot.physics.' + key, bot.physics[key]])
  return out
}

describe('mineflayer-bedrock skeleton (U0)', function () {
  it('exports the same names as mineflayer 4.39.0', () => {
    const upstream = require('mineflayer')
    assert.deepStrictEqual(Object.keys(mineflayerBedrock).sort(), Object.keys(upstream).sort())
    assert.deepStrictEqual(mineflayerBedrock.testedVersions, ['1.26.51'])
    assert.strictEqual(mineflayerBedrock.latestSupportedVersion, '1.26.51')
    assert.strictEqual(mineflayerBedrock.oldestSupportedVersion, '1.26.51')
    assert.strictEqual(typeof mineflayerBedrock.supportFeature('itemRegistryPacket', '1.26.51'), 'boolean')
  })

  it('registers every mineflayer 4.39.0 plugin plus abilities and sign (43 files)', () => {
    const upstream = fs.readdirSync(UPSTREAM_PLUGIN_DIR).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3))
    const expected = [...upstream, 'abilities', 'sign'].sort()
    assert.strictEqual(expected.length, 43)
    assert.deepStrictEqual(Object.keys(mineflayerBedrock._plugins).sort(), expected)
    const files = fs.readdirSync(PLUGIN_DIR).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort()
    assert.deepStrictEqual(files, expected)
  })

  it('every plugin and lib/bedrock file names its owner unit in the header', () => {
    const dirs = [PLUGIN_DIR, path.join(__dirname, '../../lib/bedrock'), path.join(__dirname, '../../lib/physics')]
    for (const dir of dirs) {
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
        const firstLine = fs.readFileSync(path.join(dir, file), 'utf8').split('\n')[0]
        assert.match(firstLine, /^\/\/ owner: U\d+/, `${path.basename(dir)}/${file}`)
      }
    }
  })

  it('createBot({ client }) injects every plugin without throwing', async () => {
    const { bot } = await createInjectedBot()
    assert.strictEqual(bot.version, '1.26.51')
    assert.strictEqual(bot.majorVersion, '1.26')
    assert.strictEqual(bot.protocolVersion, 2193)
    assert.strictEqual(bot.registry.type, 'bedrock')
    assert.strictEqual(typeof bot.supportFeature, 'function')
    for (const plugin of Object.values(mineflayerBedrock._plugins)) assert.ok(bot.hasPlugin(plugin))
  })

  it('defines the mineflayer data surface with typed defaults', async () => {
    const { bot } = await createInjectedBot()
    assert.deepStrictEqual(bot.entities, {})
    assert.deepStrictEqual(bot.players, {})
    assert.deepStrictEqual(bot.game, {})
    assert.deepStrictEqual(bot.teams, {})
    assert.ok(Array.isArray(bot.inventory.slots))
    assert.deepStrictEqual(bot.inventory.items(), [])
    assert.strictEqual(bot.currentWindow, null)
    assert.strictEqual(bot.quickBarSlot, null)
    assert.strictEqual(bot.QUICK_BAR_START, 36)
    assert.strictEqual(bot.usingHeldItem, false)
    assert.strictEqual(typeof bot.physics.gravity, 'number')
    assert.strictEqual(bot.physicsEnabled, true)
    assert.strictEqual(bot.isAlive, true)
    assert.strictEqual(bot.isRaining, false)
    assert.strictEqual(bot.isSleeping, false)
    assert.strictEqual(bot.targetDigBlock, null)
    assert.deepStrictEqual(bot.bossBars, [])
    assert.strictEqual(bot.tablist.header.toString(), '')
    assert.strictEqual(bot.settings.mainHand, 'right')
    assert.strictEqual(typeof bot.world.getBlock, 'function')
    assert.strictEqual(bot.abilities.flying, false)
    assert.deepStrictEqual(bot.experience, { level: null, points: null, progress: null })
    assert.ok('clocks' in bot.time)
    assert.ok(bot.spawnPoint && typeof bot.spawnPoint.x === 'number')
    assert.deepStrictEqual(bot.bedrock, {})
  })

  it('creates bot._bedrock with every contract namespace', async () => {
    const { bot } = await createInjectedBot()
    for (const ns of ['input', 'physics', 'lifecycle', 'stackRequests', 'windows', 'heldNetworkItem', 'ids']) {
      assert.ok(bot._bedrock[ns], `bot._bedrock.${ns}`)
    }
    assert.strictEqual(bot._bedrock.startGame, null)
    assert.strictEqual(typeof bot._bedrock.input.queueBlockAction, 'function')
    assert.strictEqual(typeof bot._bedrock.physics.setPosition, 'function')
    assert.strictEqual(typeof bot._bedrock.lifecycle.markSpawned, 'function')
    assert.strictEqual(typeof bot._bedrock.stackRequests.create, 'function')
    assert.strictEqual(typeof bot._bedrock.windows.register, 'function')
  })

  it('every plugin method is a stub flagged notImplemented with its owner unit', async () => {
    const { bot } = await createInjectedBot()
    const fns = pluginFunctions(bot)
    assert.ok(fns.length > 90, `expected the full method surface, got ${fns.length}`)
    for (const [name, fn] of fns) {
      assert.ok(isStub(fn), `${name} should be a notImplemented stub`)
      assert.match(fn.unit, /^U\d+$/, `${name}.unit`)
    }
  })

  it('stubs throw (sync APIs) or reject (promise APIs) with NotImplementedError', async () => {
    const { bot } = await createInjectedBot()
    assert.throws(() => bot.chat('hi'), (err) => err instanceof NotImplementedError && err.notImplemented && err.unit === 'U4')
    const p = bot.equip(null, 'hand')
    assert.ok(p instanceof Promise, 'async stubs return a promise instead of throwing')
    await assert.rejects(p, (err) => err.notImplemented === true && err.unit === 'U8')
    await assert.rejects(bot.creative.flyTo(null), (err) => err.unit === 'U8')
    assert.doesNotThrow(() => bot.stopDigging(), 'stopDigging is a no-op while idle, like upstream')
    assert.throws(() => { bot.controlState.forward = true }, (err) => err.notImplemented === true)
  })

  it('end() closes the client and forwards end/error events', async () => {
    const { bot, client } = await createInjectedBot()
    const ended = new Promise(resolve => bot.once('end', resolve))
    const errored = new Promise(resolve => bot.once('error', resolve))
    client.emit('error', new Error('boom'))
    assert.strictEqual((await errored).message, 'boom')
    bot.end('bye')
    assert.strictEqual(client.ended, 'bye')
    assert.strictEqual(await ended, 'bye')
  })

  it('end() with a bedrock-protocol style client: close() even before connect, reason kept for "end"', async () => {
    const client = fakeClient()
    delete client.end
    client.disconnect = (reason) => { client.disconnectCalls = (client.disconnectCalls ?? 0) + 1 } // no-op before connect
    client.close = () => { if (client.closed) return; client.closed = true; client.emit('close') }
    const bot = mineflayerBedrock.createBot({ client, logErrors: false })
    const ended = new Promise(resolve => bot.once('end', resolve))
    bot.end('bye')
    assert.strictEqual(client.disconnectCalls, 1)
    assert.strictEqual(client.closed, true)
    assert.strictEqual(await ended, 'bye')
  })

  it('emits "connect" once the bedrock-protocol client starts logging in', async () => {
    const { bot, client } = await createInjectedBot()
    let connects = 0
    bot.on('connect', () => connects++)
    client.emit('loggingIn')
    client.emit('loggingIn')
    assert.strictEqual(connects, 1)
  })

  it('rejects unsupported versions like mineflayer', () => {
    assert.throws(() => mineflayerBedrock.createBot({ client: fakeClient(), version: '1.21.50' }), /not supported/)
  })

  it('honours plugins / loadInternalPlugins options like mineflayer', async () => {
    let injected = null
    const external = (bot) => { injected = bot }
    const { bot } = await createInjectedBot({ loadInternalPlugins: false, plugins: { chat: true, myPlugin: external } })
    assert.strictEqual(injected, bot)
    assert.ok(bot.hasPlugin(mineflayerBedrock._plugins.chat))
    assert.ok(!bot.hasPlugin(mineflayerBedrock._plugins.inventory))
    assert.strictEqual(bot.inventory, undefined)
  })
})
