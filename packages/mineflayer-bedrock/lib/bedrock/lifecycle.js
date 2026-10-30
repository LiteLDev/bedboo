// owner: U4 (core runtime)
'use strict'
const { EventEmitter } = require('events')
const { feetFromWire } = require('./conversions')

/**
 * Player lifecycle, exposed as `bot._bedrock.lifecycle`.
 *
 * This module is the ONLY emitter of mineflayer's `spawn` event (`markSpawned()`), which happens:
 *   1. after join (implemented here, see below);
 *   2. after a respawn reaches "ready" (3-step respawn: server respawn state 0 searching →
 *      client respawn state 2 client_ready → server respawn state 1 ready → client player_action
 *      respawn), driven by U9 (health.js `bot.respawn`): `setState('dead')` / `setState('respawning')`
 *      then `markSpawned('respawn')`;
 *   3. after a dimension change completes (change_dimension → … → play_status player_spawn), implemented
 *      here (see the dimension path below) so the world reloads; U9 owns everything around it.
 * health.js (U9) must never emit `spawn` itself.
 *
 * Join path (BDS 1.26.51.1, test/fixtures/1.26.51/join_flat.jsonl.gz):
 *   start_game (player_position.y = 32769.62, the spawn search height)       → state 'loading', clock anchored
 *   respawn state 0 ×2 (32769.62, 32768)                                     → ignored
 *   respawn state 1 at the real EYE-level position                          → bot position (forced, no
 *                                                                              handled_teleport) + reply
 *                                                                              respawn { state: 2, runtime_entity_id }
 *   chunks, set_health, play_status player_spawn (bedrock-protocol writes set_local_player_as_initialized)
 *                                                                            → serverbound_loading_screen type 1,
 *                                                                              then type 2 (without them BDS does
 *                                                                              not simulate the player at all) →
 *                                                                              markSpawned('join'): input clock
 *                                                                              starts, 'spawn' is emitted
 *   mineflayer order: 'login' + 'game' (game.js, on start_game) → 'spawn' (here).
 *
 * Dimension path (BDS 1.26.51.1, `/execute in nether run tp …`, observed live):
 *   change_dimension { dimension, position (FEET level, unlike move_player), respawn: false, loading_screen_id }
 *                    → `beginDimensionChange(packet)`: state 'changing_dimension' (input suspended), then the
 *                      'dimensionChange' lifecycle event (blocks.js resets the world, game.js switches
 *                      bot.game.dimension and emits 'game'), then the bot position (forced: move + forcedMove
 *                      already see the new dimension); the client answers player_action dimension_change_ack
 *   server player_action dimension_change_ack (~0.05–1 s later, once the new dimension is ready; BDS sends no
 *   play_status here) → `completeDimensionChange()`: serverbound_loading_screen type 1, 2 (with the
 *                      loading_screen_id) → markSpawned('dimension') ('spawn' fires again, as in mineflayer
 *                      where a dimension change toggles isAlive)
 *
 * Spawn search height (W3-FIX-A, observed live): the End exit's change_dimension carries y 32767 (BDS answers our
 *   ack at once; the real eye-level position follows ~50 ms later in respawn state 0 → state 1), and a respawn into
 *   another dimension can get a respawn state 1 — or a move_player / correction — at the search height (the real
 *   position follows). change_dimension / respawn search heights are not applied (no move / forcedMove there), and
 *   markSpawned('respawn' | 'dimension') waits while the bot's last server position is the search height, until the
 *   real one (the next forcedMove below it) — 'spawn' follows the position like upstream, where it comes after the
 *   position packet — at most SPAWN_POSITION_TIMEOUT_MS.
 *
 * States: 'connecting' → 'loading' (start_game received) → 'spawned' ⇄ 'dead' / 'respawning' /
 *         'changing_dimension' → 'ended'. The input clock (bot._bedrock.input) is suspended with reason
 *         'lifecycle' in 'connecting', 'loading', 'changing_dimension' and 'ended'.
 *
 * Lifecycle events (`lifecycle.events`, an EventEmitter; not bot events):
 *   'state' (state, previous), 'spawned' (reason), 'dimensionChange' ({ dimension, position, packet }),
 *   'dimensionChanged' ({ respawning: true }) — U9: a dimension change during a respawn completed without 'spawn'
 *   (the respawn spawns); health.js emits 'respawn' ({ dimensionChange }) before the bot's 'respawn' event.
 *   A change_dimension without loading_screen_id (respawn into another dimension) gets no loading screen acks.
 *
 * @typedef {object} Lifecycle
 * @property {string} state current state
 * @property {(reason: 'join'|'respawn'|'dimension') => void} markSpawned set state 'spawned' and emit `spawn`
 * @property {(state: string) => void} setState
 * @property {(state: string, opts?: { timeout?: number }) => Promise<void>} waitFor resolves when `state` is reached
 * @property {EventEmitter} events
 * @property {(loadingScreenId?: number) => void} sendLoadingScreenAck serverbound_loading_screen 1 then 2
 * @property {(packet: object) => void} beginDimensionChange
 * @property {() => void} completeDimensionChange
 * @property {() => void} markDead U9: death (deferred to the end of a dimension change in progress)
 */

const STATES = ['connecting', 'loading', 'spawned', 'dead', 'respawning', 'changing_dimension', 'ended']
/** feet y at or above this: the server's spawn search height (32767; the join's 32768), not a position */
const SPAWN_SEARCH_Y = 32766
/** longest wait for the real position after a search-height one before 'spawn' fires anyway */
const SPAWN_POSITION_TIMEOUT_MS = 2000
const SUSPENDED_STATES = new Set(['connecting', 'loading', 'changing_dimension', 'ended'])
const SPAWN_REASONS = ['join', 'respawn', 'dimension']

/** @returns {Lifecycle} */
function createLifecycle (bot) {
  const events = new EventEmitter()
  events.setMaxListeners(0)
  let joined = false
  let dimensionLoadingScreenId
  let resumeState = null // U9: lifecycle state to return to after a dimension change during a respawn
  let positionPending = false // the server sent the spawn search height: the real position has not arrived yet
  let deferredSpawn = null // { reason, timer }: markSpawned waiting for that position

  const input = () => bot._bedrock?.input
  const physics = () => bot._bedrock?.physics
  const selfRuntimeId = () => bot._bedrock?.ids?.selfRuntimeId() ?? 0n
  // BEDD-5: with transport 'bedd' the real client sends the loading screen acks, the dimension change ack and the
  // join's respawn reply itself (lib/bedd/surface.js); bedboo only follows the state
  const clientOwnsLoadingScreen = () => !!bot._client?.bedd && bot._client.bedd.capabilities?.ownsLoadingScreen !== false
  let spawnBeforeStartGame = false

  const lifecycle = {
    state: 'connecting',
    events,

    setState (state) {
      if (!STATES.includes(state)) throw new TypeError(`unknown lifecycle state '${state}' (${STATES.join(', ')})`)
      const previous = lifecycle.state
      lifecycle.state = state
      const queue = input()
      if (queue) {
        if (SUSPENDED_STATES.has(state)) queue.suspend('lifecycle')
        else queue.resume('lifecycle')
        if (state === 'ended') queue.stop()
      }
      if (previous !== state) events.emit('state', state, previous)
    },

    markSpawned (reason) {
      if (!SPAWN_REASONS.includes(reason)) throw new TypeError(`markSpawned(reason): reason must be one of ${SPAWN_REASONS.join(', ')}`)
      if (lifecycle.state === 'ended') return
      if (reason === 'join') {
        if (joined) return
        joined = true
      } else if (positionPending) {
        // the bot is still at the search height: 'spawn' once the real position arrived (the state, and with it the
        // input clock, stays as it is meanwhile)
        if (!deferredSpawn) {
          const timer = setTimeout(() => finishDeferredSpawn(), SPAWN_POSITION_TIMEOUT_MS)
          timer.unref?.()
          deferredSpawn = { reason, timer }
          // after every forcedMove listener registered so far (upstream: forcedMove, then 'spawn')
          bot.on('forcedMove', onDeferredPosition)
        }
        return
      }
      cancelDeferredSpawn()
      lifecycle.setState('spawned')
      input()?.start()
      events.emit('spawned', reason)
      bot.emit('spawn')
    },

    waitFor (state, { timeout } = {}) {
      if (lifecycle.state === state) return Promise.resolve()
      if (lifecycle.state === 'ended') return Promise.reject(new Error(`lifecycle ended while waiting for '${state}'`))
      return new Promise((resolve, reject) => {
        let timer = null
        const cleanup = () => {
          events.removeListener('state', onState)
          if (timer) clearTimeout(timer)
        }
        const onState = (s) => {
          if (s === state) {
            cleanup()
            resolve()
          } else if (s === 'ended') {
            cleanup()
            reject(new Error(`lifecycle ended while waiting for '${state}'`))
          }
        }
        events.on('state', onState)
        if (timeout !== undefined) {
          timer = setTimeout(() => {
            cleanup()
            reject(new Error(`timed out after ${timeout} ms waiting for lifecycle state '${state}' (now '${lifecycle.state}')`))
          }, timeout)
        }
      })
    },

    /** serverbound_loading_screen type 1 (start) then type 2 (end): BDS simulates the player only after them. */
    sendLoadingScreenAck (loadingScreenId) {
      if (clientOwnsLoadingScreen()) return
      const base = loadingScreenId === undefined || loadingScreenId === null ? {} : { loading_screen_id: loadingScreenId }
      bot._client.queue('serverbound_loading_screen', { type: 1, ...base })
      bot._client.queue('serverbound_loading_screen', { type: 2, ...base })
    },

    /**
     * Start of a dimension change (change_dimension). Called by the default change_dimension listener below.
     * Order: state 'changing_dimension' → 'dimensionChange' event (blocks.js resets the world, game.js switches
     * bot.game.dimension + emits 'game') → the new position (move / forcedMove see the new dimension) → ack.
     * @param {{ dimension: number, position: {x:number,y:number,z:number}, respawn?: boolean, loading_screen_id?: number }} packet
     */
    beginDimensionChange (packet) {
      dimensionLoadingScreenId = packet.loading_screen_id ?? undefined
      // U9: a respawn into another dimension (death in the nether → overworld spawn) changes the dimension while
      // the player is dead: completing it resumes the respawn (health.js spawns once the player is alive)
      if (lifecycle.state === 'dead' || lifecycle.state === 'respawning') resumeState = lifecycle.state
      else if (lifecycle.state !== 'changing_dimension') resumeState = null
      lifecycle.setState('changing_dimension')
      cancelDeferredSpawn()
      const position = { x: packet.position.x, y: packet.position.y, z: packet.position.z } // FEET level (unlike move_player)
      events.emit('dimensionChange', { dimension: packet.dimension, position, packet })
      // the End exit sends the spawn search height: the real position follows (respawn state 1)
      positionPending = position.y >= SPAWN_SEARCH_Y
      if (!positionPending) setPosition(position)
      if (clientOwnsLoadingScreen()) return
      bot._client.queue('player_action', {
        runtime_entity_id: selfRuntimeId(),
        action: 'dimension_change_ack',
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0
      })
    },

    /**
     * U9 (health.js): the player died. A dimension change in progress completes first — without 'spawn' — and then
     * resumes 'dead'; otherwise the state becomes 'dead' at once.
     */
    markDead () {
      // a spawn waiting for its position (W3-FIX-A) does not happen any more
      if (deferredSpawn) {
        cancelDeferredSpawn()
        positionPending = false
        lifecycle.setState('dead')
        return
      }
      if (lifecycle.state === 'changing_dimension') resumeState = 'dead'
      else if (lifecycle.state === 'spawned' || lifecycle.state === 'respawning') lifecycle.setState('dead')
    },

    /** End of a dimension change (the server's dimension_change_ack): loading screen acks, then 'spawn'. */
    completeDimensionChange () {
      if (lifecycle.state !== 'changing_dimension') return
      // U9 (observed on BDS 1.26.51.1): only a change_dimension with a loading_screen_id shows a loading screen.
      // The respawn-triggered one has none, and serverbound_loading_screen then gets the client disconnected
      // ('unexpected_packet').
      if (dimensionLoadingScreenId !== undefined) lifecycle.sendLoadingScreenAck(dimensionLoadingScreenId)
      dimensionLoadingScreenId = undefined
      if (resumeState) {
        const state = resumeState
        resumeState = null
        lifecycle.setState(state)
        events.emit('dimensionChanged', { respawning: true })
        return
      }
      lifecycle.markSpawned('dimension')
    }
  }

  function finishDeferredSpawn () {
    const deferred = deferredSpawn
    if (!deferred) return
    cancelDeferredSpawn()
    positionPending = false
    // still waiting in the state markSpawned was called in (not ended, no new dimension change since)
    if (lifecycle.state !== 'ended') lifecycle.markSpawned(deferred.reason)
  }

  function cancelDeferredSpawn () {
    if (!deferredSpawn) return
    clearTimeout(deferredSpawn.timer)
    bot.removeListener('forcedMove', onDeferredPosition)
    deferredSpawn = null
  }

  // the server moved the bot (respawn state 1 here, the physics plugin's move_player / correction): to the real
  // position, or still to the search height (a move_player / correction can carry it too)
  bot.on('forcedMove', () => {
    if (bot.entity) positionPending = bot.entity.position.y >= SPAWN_SEARCH_Y
  })
  function onDeferredPosition () {
    if (!positionPending) finishDeferredSpawn()
  }

  function setPosition (feet) {
    const p = physics()
    if (bot.entity && p && typeof p.setPosition === 'function' && !p.setPosition.notImplemented) {
      p.setPosition(feet, { forced: true, handledTeleport: false })
    }
  }

  const client = bot._client
  client.on('start_game', (packet) => {
    input()?.anchor(packet.current_tick ?? 0n)
    lifecycle.setState('loading')
    if (spawnBeforeStartGame) {
      // play_status player_spawn raced ahead of start_game (bedrock-protocol handles the same race): spawn once
      // every start_game listener (entity, game, world) has run
      spawnBeforeStartGame = false
      process.nextTick(() => {
        if (lifecycle.state !== 'loading') return
        lifecycle.sendLoadingScreenAck()
        lifecycle.markSpawned('join')
      })
    }
  })

  client.on('respawn', (packet) => {
    if (packet.state !== 1 || lifecycle.state === 'connecting' || lifecycle.state === 'ended') return
    // state 1 (ready_to_spawn) carries the real eye-level spawn position, at join, after a death and after the End
    // exit — except a respawn into another dimension may still carry the search height (the position follows)
    const feet = feetFromWire(packet.position)
    if (feet.y >= SPAWN_SEARCH_Y && lifecycle.state !== 'loading') positionPending = true
    else setPosition(feet)
    // join: answer like the vanilla client (client_ready). After a death the respawn handshake is U9's
    // (bot.respawn: client state 2 first, then player_action respawn after this state 1).
    if (lifecycle.state === 'loading' && !clientOwnsLoadingScreen()) client.queue('respawn', { position: packet.position, state: 2, runtime_entity_id: selfRuntimeId() })
  })

  client.on('change_dimension', (packet) => {
    if (lifecycle.state === 'connecting' || lifecycle.state === 'ended') return
    lifecycle.beginDimensionChange(packet)
  })

  client.on('play_status', (packet) => {
    if (packet.status !== 'player_spawn') return
    if (lifecycle.state === 'connecting') {
      spawnBeforeStartGame = true
    } else if (lifecycle.state === 'loading') {
      lifecycle.sendLoadingScreenAck()
      lifecycle.markSpawned('join')
    } else if (lifecycle.state === 'changing_dimension') {
      lifecycle.completeDimensionChange()
    }
  })

  client.on('player_action', (packet) => {
    if (packet.action !== 'dimension_change_ack') return
    if (packet.runtime_entity_id !== undefined && !bot._bedrock?.ids?.isSelf(packet.runtime_entity_id)) return
    lifecycle.completeDimensionChange()
  })

  // the connection is gone: stop at once — the bot's 'end' follows asynchronously, like mineflayer's (loader.js)
  const onEnded = () => {
    cancelDeferredSpawn()
    if (lifecycle.state !== 'ended') lifecycle.setState('ended')
  }
  client.on('close', onEnded)
  client.on('end', onEnded)
  bot.on('end', onEnded)

  return lifecycle
}

module.exports = { createLifecycle, STATES, SPAWN_REASONS, SPAWN_SEARCH_Y, SPAWN_POSITION_TIMEOUT_MS }
