// owner: U9 (player state, world extras & dimensions)
// Adapted from mineflayer master lib/plugins/abilities.js (MIT, Copyright (c) 2013 Andrew Kelley; not in 4.39.0;
//   pinned copy in docs/upstream/abilities.master.js, master SHA 7b4bb8d2b56be9cdb832474af873acd37e609746)
// Surface: bot.abilities { invulnerable, flying, mayFly, instantBuild, flyingSpeed, walkingSpeed }
//   (also mirrors bot.entity.flying / bot.entity.flyingSpeed for physics, like master, and switches the physics
//   engine's flight with bot._bedrock.physics.setFlying when `flying` changes)
// Events: 'abilities' (abilities)
// Bedrock (docs/differences/U9.md#abilities):
// - update_abilities for the local player (entity_unique_id = own unique id): ability layers (base, spectator,
//   commands, editor, loading_screen), each with `allowed` / `enabled` flag sets and fly/walk speeds. A layer decides
//   a flag when it allows it, later layers override earlier ones (the client's layered abilities).
// - BDS 1.26.51.1 sends update_abilities at join (and on permission changes) but NOT on a game mode change: the
//   vanilla client derives the game mode's abilities itself. The same derivation as the Java server's
//   GameType.updatePlayerAbilities (what mineflayer receives on Java) is applied on update_player_game_type /
//   set_player_game_type: creative → mayFly, instantBuild, invulnerable (flying kept); spectator → mayFly,
//   flying, invulnerable; survival/adventure → none; speeds kept.
'use strict'
const { gameModeName } = require('../bedrock/constants')

module.exports = inject

/** ability layer order (bedrock-protocol AbilityLayers.type): later layers override earlier ones */
const LAYER_ORDER = ['cache', 'base', 'spectator', 'commands', 'editor', 'loading_screen']
const FLAGS = { invulnerable: 'invulnerable', flying: 'flying', mayFly: 'may_fly', instantBuild: 'instant_build' }

/** li64 [high, low] / bigint / number → BigInt */
function toBigInt (v) {
  if (Array.isArray(v)) return BigInt.asIntN(64, (BigInt(v[0]) << 32n) | BigInt(v[1] >>> 0))
  return BigInt(v)
}

/** abilities from update_abilities layers (starting from `current`) */
function fromLayers (layers, current) {
  const out = { ...current }
  const sorted = [...(layers ?? [])].sort((a, b) => LAYER_ORDER.indexOf(a.type) - LAYER_ORDER.indexOf(b.type))
  for (const layer of sorted) {
    const allowed = layer.allowed ?? {}
    const enabled = layer.enabled ?? {}
    for (const [key, flag] of Object.entries(FLAGS)) {
      if (allowed[flag]) out[key] = !!enabled[flag]
    }
    if (allowed.fly_speed && typeof layer.fly_speed === 'number') out.flyingSpeed = layer.fly_speed
    if (allowed.walk_speed && typeof layer.walk_speed === 'number') out.walkingSpeed = layer.walk_speed
  }
  return out
}

/** Java GameType.updatePlayerAbilities */
function forGameMode (gameMode, current) {
  const out = { ...current }
  if (gameMode === 'creative') {
    out.mayFly = true
    out.instantBuild = true
    out.invulnerable = true
  } else if (gameMode === 'spectator') {
    out.mayFly = true
    out.instantBuild = false
    out.invulnerable = true
    out.flying = true
  } else {
    out.mayFly = false
    out.instantBuild = false
    out.invulnerable = false
    out.flying = false
  }
  return out
}

function inject (bot) {
  // Abilities' defaults, until the server says otherwise (same as upstream).
  bot.abilities = {
    invulnerable: false,
    flying: false,
    mayFly: false,
    instantBuild: false,
    flyingSpeed: 0.05,
    walkingSpeed: 0.1
  }

  function setAbilities (abilities) {
    const wasFlying = bot.abilities.flying
    bot.abilities = abilities
    // prismarine-physics reads the flight state off the entity.
    if (bot.entity) {
      bot.entity.flying = bot.abilities.flying
      bot.entity.flyingSpeed = bot.abilities.flyingSpeed
    }
    // the Bedrock physics engine's flight hook (lib/loader.js: "creative/abilities flight"), when the server
    // starts / stops the flight (spectator, update_abilities)
    const setFlying = bot._bedrock?.physics?.setFlying
    if (wasFlying !== bot.abilities.flying && typeof setFlying === 'function' && !setFlying.notImplemented) {
      try {
        setFlying(bot.abilities.flying)
      } catch (err) {
        bot.emit('error', err)
      }
    }
    bot.emit('abilities', bot.abilities)
  }

  bot._client.on('update_abilities', (packet) => {
    const ids = bot._bedrock?.ids
    if (packet.entity_unique_id !== undefined && ids?.isSelfUnique && !ids.isSelfUnique(toBigInt(packet.entity_unique_id))) return
    setAbilities(fromLayers(packet.abilities, bot.abilities))
  })

  function onGameMode (packet) {
    if (packet.player_unique_id !== undefined && !bot._bedrock?.ids?.isSelfUnique(packet.player_unique_id)) return
    setAbilities(forGameMode(gameModeName(packet.gamemode, bot._bedrock?.startGame?.world_gamemode), bot.abilities))
  }
  bot._client.on('update_player_game_type', onGameMode)
  bot._client.on('set_player_game_type', onGameMode)
}

module.exports.fromLayers = fromLayers
module.exports.forGameMode = forGameMode
module.exports.toBigInt = toBigInt
