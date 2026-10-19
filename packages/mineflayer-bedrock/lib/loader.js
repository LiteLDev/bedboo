// owner: U4 (core runtime)
// Adapted from mineflayer 4.39.0 lib/loader.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer). Same createBot options, plugin selection and
// `inject_allowed` sequencing; the client is bedrock-protocol instead of minecraft-protocol.
'use strict'
const { EventEmitter } = require('events')
const pluginLoader = require('mineflayer/lib/plugin_loader')
const { createRegistry, attachRegistry } = require('./registry')
const { createClient } = require('./client')
const { createSupportFeature } = require('./bedrock/features')
const { testedVersions, latestSupportedVersion, oldestSupportedVersion } = require('./version')
const { VERSION } = require('./bedrock/constants')
const { createInputQueue } = require('./bedrock/input_queue')
const { createLifecycle } = require('./bedrock/lifecycle')
const { createStackRequestManager } = require('./bedrock/stack_request')
const { createWindowRegistry } = require('./bedrock/windows')
const { createIds } = require('./bedrock/ids')
const { createHeldItemProvider } = require('./bedrock/transactions')
const { stubSync } = require('./bedrock/errors')

// Every mineflayer 4.39.0 plugin name (41) + `abilities` (mineflayer master) + `sign` (Bedrock
// sign editing split out of blocks.js). Keep the upstream order; `abilities` and `sign` last.
const plugins = {
  bed: require('./plugins/bed'),
  title: require('./plugins/title'),
  block_actions: require('./plugins/block_actions'),
  blocks: require('./plugins/blocks'),
  book: require('./plugins/book'),
  boss_bar: require('./plugins/boss_bar'),
  breath: require('./plugins/breath'),
  chat: require('./plugins/chat'),
  chest: require('./plugins/chest'),
  command_block: require('./plugins/command_block'),
  craft: require('./plugins/craft'),
  creative: require('./plugins/creative'),
  digging: require('./plugins/digging'),
  enchantment_table: require('./plugins/enchantment_table'),
  entities: require('./plugins/entities'),
  experience: require('./plugins/experience'),
  explosion: require('./plugins/explosion'),
  fishing: require('./plugins/fishing'),
  furnace: require('./plugins/furnace'),
  game: require('./plugins/game'),
  health: require('./plugins/health'),
  inventory: require('./plugins/inventory'),
  kick: require('./plugins/kick'),
  physics: require('./plugins/physics'),
  place_block: require('./plugins/place_block'),
  rain: require('./plugins/rain'),
  ray_trace: require('./plugins/ray_trace'),
  resource_pack: require('./plugins/resource_pack'),
  scoreboard: require('./plugins/scoreboard'),
  team: require('./plugins/team'),
  settings: require('./plugins/settings'),
  simple_inventory: require('./plugins/simple_inventory'),
  sound: require('./plugins/sound'),
  spawn_point: require('./plugins/spawn_point'),
  tablist: require('./plugins/tablist'),
  time: require('./plugins/time'),
  villager: require('./plugins/villager'),
  anvil: require('./plugins/anvil'),
  place_entity: require('./plugins/place_entity'),
  generic_place: require('./plugins/generic_place'),
  particle: require('./plugins/particle'),
  abilities: require('./plugins/abilities'),
  sign: require('./plugins/sign')
}

module.exports = {
  createBot,
  Location: require('mineflayer/lib/location'),
  Painting: require('mineflayer/lib/painting'),
  ScoreBoard: require('mineflayer/lib/scoreboard'),
  BossBar: require('mineflayer/lib/bossbar'),
  Particle: require('./bedrock/particle'), // U6: adapted to Bedrock packets (docs/differences/U6.md#particles)
  latestSupportedVersion,
  oldestSupportedVersion,
  testedVersions,
  supportFeature
}

// mineflayer's module-level supportFeature(feature, version). The Bedrock feature table does not depend on a
// registry, so no registry is built per call (U2 note); other versions are answered by minecraft-data like upstream.
let tableSupportFeature = null
function supportFeature (feature, version) {
  const v = typeof version === 'string' ? version.replace(/^bedrock_/, '') : version
  if (!v || testedVersions.includes(v)) {
    tableSupportFeature ??= createSupportFeature(null)
    return tableSupportFeature(feature)
  }
  return require('minecraft-data')(version).supportFeature(feature)
}
// internal (tests / U3 conformance tooling); non-enumerable so the export names match mineflayer's
Object.defineProperty(module.exports, '_plugins', { value: plugins, enumerable: false })

/**
 * Bedrock-only internal state shared between plugins (`bot._bedrock`). Each namespace has one
 * owner (docs/CONTRIBUTING.md); plugins may replace a namespace's stub functions they own.
 */
function createBedrockState (bot, options) {
  return {
    /** tick clock + player_auth_input queue (lib/bedrock/input_queue.js) */
    input: createInputQueue(bot, { maxCatchupTicks: options.maxCatchupTicks }),
    /** physics hooks used outside physics.js (implemented by the physics plugin: U4 stub → U5) */
    physics: {
      /** set the feet position; `forced` = server teleport/correction (resets velocity, sends handled_teleport) */
      setPosition: stubSync('U4', 'bot._bedrock.physics.setPosition', 2),
      /** creative/abilities flight on/off */
      setFlying: stubSync('U4', 'bot._bedrock.physics.setFlying', 1)
    },
    /** spawn/respawn/dimension state machine; the only emitter of `spawn` (lib/bedrock/lifecycle.js) */
    lifecycle: createLifecycle(bot),
    /** item_stack_request manager (lib/bedrock/stack_request.js, U8) */
    stackRequests: createStackRequestManager(bot),
    /** Bedrock container type → Java window spec registry (lib/bedrock/windows.js, U8) */
    windows: createWindowRegistry(bot),
    /** () => wire Item currently held (exact server copy) for inventory_transaction held_item (U4 → U8) */
    heldNetworkItem: createHeldItemProvider(bot),
    /** runtime/unique entity ids, item network ids (lib/bedrock/ids.js) */
    ids: createIds(),
    /** the raw start_game packet params once received (U4), else null */
    startGame: null
  }
}

function endClient (client, reason) {
  if (!client) return
  if (typeof client.disconnect === 'function') {
    // bedrock-protocol: disconnect() sends the disconnect packet but is a no-op until the transport is
    // connected; close() (idempotent) also tears down a connection that is still being established.
    client.disconnect(reason)
    if (typeof client.close === 'function') client.close()
  } else if (typeof client.end === 'function') {
    client.end(reason)
  } else if (typeof client.close === 'function') {
    client.close()
  }
}

function createBot (options = {}) {
  options.username = options.username ?? 'Player'
  options.version = options.version || VERSION // mineflayer's `false` (auto) → the only supported version
  if (!testedVersions.includes(options.version)) {
    throw new Error(`Bedrock version '${options.version}' is not supported. Supported versions: ${testedVersions.join(', ')}.`)
  }
  options.plugins = options.plugins ?? {}
  options.hideErrors = options.hideErrors ?? false
  options.logErrors = options.logErrors ?? true
  options.loadInternalPlugins = options.loadInternalPlugins ?? true
  options.client = options.client ?? null
  options.brand = options.brand ?? 'vanilla'
  options.respawn = options.respawn ?? true
  const bot = new EventEmitter()
  bot._client = options.client
  /** Bedrock-only public extras (types/bedrock.d.ts); Java-only concepts keep their mineflayer property */
  bot.bedrock = {}
  let endReason
  bot.end = (reason) => {
    endReason = reason
    endClient(bot._client, reason)
  }
  bot._warn = function (...message) {
    if (options.hideErrors) return
    console.warn('[mineflayer-bedrock]', ...message)
  }
  if (options.logErrors) {
    bot.on('error', err => {
      if (!options.hideErrors) {
        console.log(err)
      }
    })
  }

  pluginLoader(bot, options)
  const internalPlugins = Object.keys(plugins)
    .filter(key => {
      if (typeof options.plugins[key] === 'function') return false
      if (options.plugins[key] === false) return false
      return options.plugins[key] || options.loadInternalPlugins
    }).map(key => plugins[key])
  const externalPlugins = Object.keys(options.plugins)
    .filter(key => {
      return typeof options.plugins[key] === 'function'
    }).map(key => options.plugins[key])
  bot.loadPlugins([...internalPlugins, ...externalPlugins])

  bot._client = bot._client ?? createClient(options)
  // every plugin listens to the client (more than 10 listeners for start_game, update_attributes, …)
  if (typeof bot._client.setMaxListeners === 'function') bot._client.setMaxListeners(0)
  // bedrock-protocol knows the version up front (no ping-based discovery): the registry exists before the
  // first packet. Its start_game / item_registry wiring is registered before every other client listener
  // (lifecycle, plugins), so they all see a registry with runtime ids.
  const registry = createRegistry(options.version)
  bot.registry = registry
  attachRegistry(bot)
  bot._client.on('start_game', (packet) => {
    bot._bedrock.startGame = packet
    bot._bedrock.ids.setSelf(packet)
  })
  bot._bedrock = createBedrockState(bot, options)

  let ended = false
  // mineflayer emits 'end' asynchronously: client.end() only ends the socket, 'end' follows on its close. bedrock-protocol
  // emits 'close' inside close() (so inside bot.end() / bot.quit()): the bot's 'end' is deferred the same way, so state
  // set right after bot.quit() is seen by 'end' listeners (FINAL-FIX-LIB). The lifecycle stops at once (lifecycle.js).
  const emitEnd = (reason) => {
    if (ended) return
    ended = true
    setImmediate(() => bot.emit('end', reason ?? 'socketClosed'))
  }
  // mineflayer's 'connect' = transport connected, before login. bedrock-protocol has no 'connect'
  // event; 'loggingIn' fires right after the RakNet connection + network settings, when the login
  // packet is sent. ('connect' is still forwarded for minecraft-protocol style / fake clients.)
  let connected = false
  const emitConnect = () => {
    if (connected) return
    connected = true
    bot.emit('connect')
  }
  bot._client.on('connect', emitConnect)
  bot._client.on('loggingIn', emitConnect)
  bot._client.on('error', (err) => {
    bot.emit('error', err)
  })
  // minecraft-protocol style clients (and test fakes) emit 'end' (reason); bedrock-protocol emits
  // 'close' without a reason, so the reason given to bot.end()/bot.quit() is used. U4 maps kicks.
  bot._client.on('end', (reason) => emitEnd(reason))
  bot._client.on('close', () => emitEnd(endReason ?? 'socketClosed'))

  // inject immediately (no version discovery)
  bot.protocolVersion = registry.version.version
  bot.majorVersion = registry.version.majorVersion
  bot.version = registry.version.minecraftVersion
  options.version = bot.version
  bot.supportFeature = createSupportFeature(registry)
  setTimeout(() => bot.emit('inject_allowed'), 0)
  return bot
}
