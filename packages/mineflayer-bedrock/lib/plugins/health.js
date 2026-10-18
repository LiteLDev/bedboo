// owner: U9 (player state, world extras & dimensions)
// Adapted from mineflayer 4.39.0 lib/plugins/health.js (MIT, Copyright (c) 2013 Andrew Kelley): same members,
// events, `respawn` option and bot.respawn(); the Java update_health/respawn/client_command packets are replaced by
// the Bedrock ones below.
// Surface: bot.isAlive, bot.health, bot.food, bot.foodSaturation (upstream: undefined until the first update; typed
//   defaults here), bot.respawn(); option `respawn` (auto-respawn, default true — set by the loader)
// Events: 'health', 'death', 'respawn' — NEVER 'spawn' (lib/bedrock/lifecycle.js is the only emitter)
//
// Bedrock (BDS 1.26.51.1, observed live):
// - health / food / saturation: update_attributes of the local player (`minecraft:health` current,
//   `minecraft:player.hunger`, `minecraft:player.saturation`) and set_health → 'health' per packet (upstream: one per
//   update_health).
// - death: own entity_event `death_animation` → death_info → text → update_attributes health 0 → respawn state 0
//   (searching, at the death position). The first of death_animation / health ≤ 0 makes the bot dead:
//   bot.health = 0, 'health', isAlive = false, 'death', lifecycle 'dead'; with the `respawn` option bot.respawn().
// - 3-step respawn: bot.respawn() = the death screen's respawn button: client `respawn` state 2 (client_ready) — only
//   once the server's state 0 arrived, an earlier one is ignored by BDS — then lifecycle 'respawning' → server
//   respawn state 0 (y 32767) + state 1 (ready, eye-level spawn position; lifecycle.js moves the bot) → 'respawn'
//   (mineflayer's respawn packet) + client player_action `respawn` → server entity_event `respawn` + set_health 20
//   → 'health', isAlive = true, lifecycle.markSpawned('respawn') → 'spawn'.
//   A respawn into another dimension (death in the nether, overworld spawn) gets a change_dimension (without
//   loading_screen_id) between the client state 2 and the server state 1: the lifecycle completes it without
//   'spawn' (it resumes 'respawning') and the respawn above spawns once; 'respawn' is emitted once per death.
//   With `respawn: false` the bot stays dead (death screen) until bot.respawn() is called.
// - dimension change (change_dimension, mineflayer: a Java respawn packet to another dimension): isAlive = false +
//   'respawn' at the change, isAlive = true when the lifecycle spawns in the new dimension (upstream sets isAlive back
//   on the next update_health, then 'spawn').
// - the join's respawn packets (state 0 ×2 + state 1 before the spawn) and the End exit's (state 0/1 after
//   show_credits) are not deaths: ignored here (the lifecycle answers the join).
'use strict'

module.exports = inject

/** ms to wait for the set_health / update_attributes that follows the server's entity_event respawn */
const REVIVE_FALLBACK_MS = 500

function inject (bot, options) {
  bot.isAlive = true
  bot.health = 20
  bot.food = 20
  bot.foodSaturation = 5

  const lifecycle = () => bot._bedrock?.lifecycle
  const ids = () => bot._bedrock?.ids
  const isSelf = (runtimeId) => !!ids()?.isSelf(runtimeId)
  const selfRuntimeId = () => ids()?.selfRuntimeId() ?? 0n
  const ZERO = { x: 0, y: 0, z: 0 }

  // respawn handshake of the current death
  let dead = false // a death was seen and the server has not revived the player yet
  let screen = false // the server's respawn state 0 arrived: the respawn button may be pressed
  let requested = false // bot.respawn() was called for this death
  let readySent = false // client respawn state 2 sent
  let actionSent = false // client player_action respawn sent: waiting for the server to revive the player
  let respawnEmitted = false
  let reviveTimer = null
  let changingDimension = false // isAlive = false for a dimension change (not a death)

  function setLifecycle (state, onlyFrom) {
    const lc = lifecycle()
    if (!lc || lc.state === 'ended' || lc.state === 'connecting') return
    if (onlyFrom && !onlyFrom.includes(lc.state)) return
    lc.setState(state)
  }

  function onHealthUpdate () {
    bot.emit('health')
    if (bot.health <= 0) {
      die()
    } else if (dead && actionSent) {
      revive()
    }
  }

  function die () {
    if (!dead) {
      dead = true
      screen = false
      requested = false
      readySent = false
      actionSent = false
      respawnEmitted = false
      changingDimension = false
      clearTimeout(reviveTimer)
      // (a dimension change in progress keeps its state: the lifecycle completes it first)
      setLifecycle('dead', ['spawned', 'respawning'])
    }
    if (bot.isAlive) {
      bot.isAlive = false
      bot.emit('death')
    }
    if (!options.respawn) return
    bot.respawn()
  }

  function revive () {
    if (!dead) return
    clearTimeout(reviveTimer)
    reviveTimer = null
    dead = false
    screen = requested = readySent = actionSent = false
    bot.isAlive = true
    const lc = lifecycle()
    if (lc && lc.state !== 'ended') lc.markSpawned('respawn')
  }

  /** mineflayer's 'respawn' (Java respawn packet): once per death / dimension change */
  function emitRespawn (dimensionChange) {
    if (dead) {
      if (respawnEmitted) return
      respawnEmitted = true
    }
    lifecycle()?.events?.emit('respawn', { dimensionChange: !!dimensionChange })
    bot.emit('respawn')
  }

  function sendReady () {
    if (!dead || !requested || readySent || !screen) return
    readySent = true
    setLifecycle('respawning', ['dead'])
    bot._client.queue('respawn', { position: ZERO, state: 2, runtime_entity_id: selfRuntimeId() })
  }

  function sendRespawnAction () {
    if (actionSent) return
    actionSent = true
    bot._client.queue('player_action', {
      runtime_entity_id: selfRuntimeId(),
      action: 'respawn',
      position: ZERO,
      result_position: ZERO,
      face: -1
    })
  }

  bot._client.on('update_attributes', (packet) => {
    if (!isSelf(packet.runtime_entity_id)) return
    let changed = false
    for (const attr of packet.attributes ?? []) {
      if (attr.name === 'minecraft:health') {
        bot.health = attr.current
        changed = true
      } else if (attr.name === 'minecraft:player.hunger') {
        bot.food = attr.current
        changed = true
      } else if (attr.name === 'minecraft:player.saturation') {
        bot.foodSaturation = attr.current
        changed = true
      }
    }
    if (changed) onHealthUpdate()
  })

  // set_health is only ever about the local player
  bot._client.on('set_health', (packet) => {
    bot.health = packet.health
    onHealthUpdate()
  })

  bot._client.on('entity_event', (packet) => {
    if (!isSelf(packet.runtime_entity_id)) return
    if (packet.event_id === 'death_animation') {
      if (dead) return
      bot.health = 0
      bot.emit('health')
      die()
    } else if (packet.event_id === 'respawn' && dead && actionSent) {
      // the server revived the player; its health update follows in the same batch
      clearTimeout(reviveTimer)
      reviveTimer = setTimeout(revive, REVIVE_FALLBACK_MS)
    }
  })

  bot._client.on('respawn', (packet) => {
    if (!dead) return // the join and the End exit are not deaths
    if (packet.state === 0) {
      screen = true
      sendReady()
    } else if (packet.state === 1) {
      // ready to spawn: answered once the respawn was asked for (else bot.respawn() asks again later)
      if (!requested) return
      emitRespawn(false)
      sendRespawnAction()
    }
  })

  const lc = lifecycle()
  if (lc?.events) {
    lc.events.on('dimensionChange', () => {
      if (dead) {
        emitRespawn(true)
        return
      }
      changingDimension = true
      bot.isAlive = false
      emitRespawn(true)
    })
    lc.events.on('spawned', (reason) => {
      if (reason === 'dimension' && changingDimension) {
        changingDimension = false
        bot.isAlive = true
      }
    })
  }

  bot.on('end', () => {
    clearTimeout(reviveTimer)
    reviveTimer = null
  })

  /** When the `respawn` option is disabled: respawn after a death (upstream: no-op while alive). */
  function respawn () {
    if (bot.isAlive) return
    if (!dead) return // not dead (e.g. isAlive false during a dimension change): nothing to answer
    requested = true
    sendReady()
  }

  bot.respawn = respawn
}
