'use strict'
const { describe, it } = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const bedboo = require('../..')
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
  const bot = bedboo.createBot({ client, username: 'SmokeBot', logErrors: false, ...options })
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

describe('bedboo skeleton', () => {
  it('exports the same names as mineflayer 4.39.0', () => {
    const upstream = require('mineflayer')
    assert.deepStrictEqual(Object.keys(bedboo).sort(), Object.keys(upstream).sort())
    assert.deepStrictEqual(bedboo.testedVersions, ['1.26.51'])
    assert.strictEqual(bedboo.latestSupportedVersion, '1.26.51')
    assert.strictEqual(bedboo.oldestSupportedVersion, '1.26.51')
    assert.strictEqual(typeof bedboo.supportFeature('itemRegistryPacket', '1.26.51'), 'boolean')
  })

  it('registers every mineflayer 4.39.0 plugin plus abilities and sign (43 files)', () => {
    const upstream = fs.readdirSync(UPSTREAM_PLUGIN_DIR).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3))
    const expected = [...upstream, 'abilities', 'sign'].sort()
    assert.strictEqual(expected.length, 43)
    assert.deepStrictEqual(Object.keys(bedboo._plugins).sort(), expected)
    const files = fs.readdirSync(PLUGIN_DIR).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort()
    assert.deepStrictEqual(files, expected)
  })

  it('createBot({ client }) injects every plugin without throwing', async () => {
    const { bot } = await createInjectedBot()
    assert.strictEqual(bot.version, '1.26.51')
    assert.strictEqual(bot.majorVersion, '1.26')
    assert.strictEqual(bot.protocolVersion, 2193)
    assert.strictEqual(bot.registry.type, 'bedrock')
    assert.strictEqual(typeof bot.supportFeature, 'function')
    for (const plugin of Object.values(bedboo._plugins)) assert.ok(bot.hasPlugin(plugin))
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
    // Bedrock-only extras (types/bedrock.d.ts) are added by the plugins, e.g. gameRules
    assert.ok(bot.bedrock && typeof bot.bedrock === 'object' && !Array.isArray(bot.bedrock))
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

  const CORE_IMPLEMENTED = [
    'bot.blockAt', 'bot.findBlocks', 'bot.findBlock', 'bot.canSeeBlock', 'bot.waitForChunksToLoad',
    'bot._updateBlockState', 'bot._getDimensionName', 'bot.chat', 'bot.quit', 'bot.setControlState',
    'bot.getControlState', 'bot.clearControlStates', 'bot.look', 'bot.lookAt', 'bot.waitForTicks',
    'bot.acceptResourcePack', 'bot.denyResourcePack', 'bot.setSettings', 'bot.physics.simulatePlayer',
    'bot.physics.adjustPositionHeight'
  ]

  it('every plugin method is implemented or a stub flagged notImplemented with its feature name', async () => {
    const { bot } = await createInjectedBot()
    const fns = pluginFunctions(bot)
    assert.ok(fns.length > 90, `expected the full method surface, got ${fns.length}`)
    for (const [name, fn] of fns) {
      if (CORE_IMPLEMENTED.includes(name)) {
        assert.ok(!isStub(fn), `${name} is implemented`)
        continue
      }
      if (!isStub(fn)) continue
      assert.strictEqual(fn.feature, name, `${name}.feature`)
    }
    for (const name of CORE_IMPLEMENTED) assert.ok(fns.some(([n]) => n === name), `${name} is part of the surface`)
  })

  it('stubs throw (sync APIs) or reject (promise APIs) with NotImplementedError', async () => {
    const { bot } = await createInjectedBot()
    // whichever plugin APIs are still stubs
    for (const [name, fn] of pluginFunctions(bot).filter(([, f]) => isStub(f))) {
      let result
      try {
        result = fn.call(bot)
      } catch (err) {
        assert.ok(err instanceof NotImplementedError && err.notImplemented && err.feature === fn.feature, `${name} throws NotImplementedError`)
        continue
      }
      if (result instanceof Promise) await assert.rejects(result, (err) => err.notImplemented === true && err.feature === fn.feature, `${name} rejects`)
      else assert.strictEqual(result, undefined, `${name}: a no-op stub returns nothing`)
    }
    assert.doesNotThrow(() => bot.stopDigging(), 'stopDigging is a no-op while idle, like upstream')
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
    const bot = bedboo.createBot({ client, logErrors: false })
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
    assert.throws(() => bedboo.createBot({ client: fakeClient(), version: '1.21.50' }), /not supported/)
    assert.throws(() => bedboo.createBot({ client: fakeClient(), version: '1.26.53.1' }), /not supported\. Supported versions: .*1\.26\.51\.1/)
  })

  it('honours plugins / loadInternalPlugins options like mineflayer', async () => {
    let injected = null
    const external = (bot) => { injected = bot }
    const { bot } = await createInjectedBot({ loadInternalPlugins: false, plugins: { chat: true, myPlugin: external } })
    assert.strictEqual(injected, bot)
    assert.ok(bot.hasPlugin(bedboo._plugins.chat))
    assert.ok(!bot.hasPlugin(bedboo._plugins.inventory))
    assert.strictEqual(bot.inventory, undefined)
  })
})
