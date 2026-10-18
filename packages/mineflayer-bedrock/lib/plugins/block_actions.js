// owner: U9 (player state, world extras & dimensions)
// Adapted from mineflayer 4.39.0 lib/plugins/block_actions.js (MIT, Copyright (c) 2013 Andrew Kelley): same events
//   and arguments, the per-position open count of chestLidMove, one event per double chest.
// Surface: none (events only)
// Events: 'noteHeard' (block, instrument, pitch), 'pistonMove' (block, isPulling, direction),
//   'chestLidMove' (block, isOpen, block2), 'blockBreakProgressObserved' (block, destroyStage, entity),
//   'blockBreakProgressEnd' (block, entity)
// Bedrock (BDS 1.26.51.1, observed live; docs/differences/U9.md#block-actions):
// - note blocks: block_event { type: instrument id (bedrock-protocol maps 0/1 to 'sound'/'change_state'), data:
//   pitch 0..24 } → noteHeard(block, registry.instruments[type], pitch) (Bedrock instrument ids, e.g. 6 bell).
// - chests & other lidded containers: block_event { type: 'change_state' (1), data: open count } at the opened
//   chest → chestLidMove(block, openCount, block2). Bedrock double chests are two `chest` blocks paired through
//   their block entities (pairx/pairz): block2 = the other half (null for a single chest); one event per change
//   for the pair.
// - pistons send no block event: their PistonArm block entity (block_entity_data) goes NewState 0 → 1 (pushing)
//   → 2 → 3 (pulling) → 0. pistonMove(block, 0, direction) when it starts pushing, (block, 1, direction) when it
//   starts pulling; direction = the Java face index (0 down, 1 up, 2 north, 3 south, 4 west, 5 east) from the
//   piston's `facing_direction` (Bedrock pistons: 2 south, 3 north, 4 east, 5 west).
// - break progress of other players: level_event block_start_break (3600, data = progress per tick × 65535),
//   block_break_speed (3602, new speed), block_stop_break (3601, aborted or done). Bedrock sends no stage and no
//   breaker: the destroy stage 0..9 is advanced locally from the speed (one blockBreakProgressObserved per new
//   stage, like Java's block_break_animation), the entity is the nearest other player within 8 blocks (or
//   undefined). BDS also sends these to the breaking player: positions the bot digs itself
//   (bot.targetDigBlock) are skipped, as Java never tells the breaker. blockBreakProgressEnd on stop_break or when
//   the block changes.
'use strict'
const { Vec3 } = require('vec3')

module.exports = inject

const BLOCK_EVENT_TYPES = { sound: 0, change_state: 1 }
/** Bedrock piston facing_direction → Java face index */
const PISTON_FACING = { 0: 0, 1: 1, 2: 3, 3: 2, 4: 5, 5: 4 }
const PISTON_PUSHING = 1
const PISTON_PULLING = 3
const BREAK_SCALE = 65535
const BREAKER_RANGE = 8
const TICK_MS = 50

function inject (bot) {
  const key = (p) => `${p.x},${p.y},${p.z}`
  const vec = (p) => new Vec3(p.x, p.y, p.z)

  // ---- block_event: note blocks, chests ------------------------------------------------------------------
  // Stores how many players have currently open a container at a certain position (the pair's lead for doubles)
  const openCountByPos = {}

  function pairedChest (block) {
    const entity = block.blockEntity
    if (!entity || entity.pairx === undefined || entity.pairz === undefined) return null
    const other = bot.blockAt(new Vec3(entity.pairx, block.position.y, entity.pairz))
    return other && other.name === block.name ? other : null
  }

  bot._client.on('block_event', (packet) => {
    const pt = vec(packet.position)
    const block = bot.blockAt(pt)
    if (block === null) return

    const type = BLOCK_EVENT_TYPES[packet.type] ?? Number(packet.type)
    if (block.name === 'noteblock' || block.name === 'note_block') {
      bot.emit('noteHeard', block, bot.registry.instruments?.[type], packet.data)
    } else if (block.name === 'piston' || block.name === 'sticky_piston') {
      // (Bedrock pistons report through their block entity; kept for servers that send block events)
      bot.emit('pistonMove', block, type, packet.data)
    } else {
      const block2 = pairedChest(block)
      // one event for the pair, stored under the lower position
      const where = block2 && key(block2.position) < key(block.position) ? block2.position : block.position
      if (openCountByPos[where] !== packet.data) {
        bot.emit('chestLidMove', block, packet.data, block2)
        if (packet.data > 0) {
          openCountByPos[where] = packet.data
        } else {
          delete openCountByPos[where]
        }
      }
    }
  })

  // ---- pistons: PistonArm block entity ---------------------------------------------------------------
  const pistonStates = {}
  bot._client.on('block_entity_data', (packet) => {
    const tag = packet.nbt?.value
    if (tag?.id?.value !== 'PistonArm') return
    const k = key(packet.position)
    const state = tag.NewState?.value ?? tag.State?.value
    const previous = pistonStates[k]
    pistonStates[k] = state
    if (state === previous || (state !== PISTON_PUSHING && state !== PISTON_PULLING)) return
    const block = bot.blockAt(vec(packet.position))
    if (!block) return
    const facing = block.getProperties?.().facing_direction
    bot.emit('pistonMove', block, state === PISTON_PULLING ? 1 : 0, PISTON_FACING[facing] ?? facing)
  })

  // ---- break progress of other players ----------------------------------------------------------------
  /** 'x,y,z' → { position, speed, progress, stage, entity } */
  const breaking = new Map()
  let breakTimer = null

  function breakerNear (position) {
    let best
    let bestDistance = BREAKER_RANGE
    for (const entity of Object.values(bot.entities ?? {})) {
      if (!entity || entity === bot.entity || entity.type !== 'player' || !entity.position) continue
      const d = entity.position.distanceTo(position.offset(0.5, 0.5, 0.5))
      if (d <= bestDistance) {
        best = entity
        bestDistance = d
      }
    }
    return best
  }

  function ownDig (position) {
    return !!bot.targetDigBlock?.position && bot.targetDigBlock.position.equals(position)
  }

  function endBreak (k) {
    const state = breaking.get(k)
    if (!state) return
    breaking.delete(k)
    if (breaking.size === 0) stopTimer()
    bot.emit('blockBreakProgressEnd', bot.blockAt(state.position), state.entity)
  }

  function tick () {
    for (const state of breaking.values()) {
      state.progress += state.speed / BREAK_SCALE
      const stage = Math.min(9, Math.floor(state.progress * 10))
      if (stage > state.stage) {
        state.stage = stage
        bot.emit('blockBreakProgressObserved', bot.blockAt(state.position), stage, state.entity)
      }
    }
  }

  function startTimer () {
    if (breakTimer) return
    breakTimer = setInterval(tick, TICK_MS)
    breakTimer.unref?.()
  }

  function stopTimer () {
    if (!breakTimer) return
    clearInterval(breakTimer)
    breakTimer = null
  }

  function clearBreaks () {
    breaking.clear()
    stopTimer()
  }

  bot._client.on('level_event', (packet) => {
    if (packet.event !== 'block_start_break' && packet.event !== 'block_stop_break' && packet.event !== 'block_break_speed') return
    const position = new Vec3(Math.floor(packet.position.x), Math.floor(packet.position.y), Math.floor(packet.position.z))
    const k = key(position)
    if (packet.event === 'block_stop_break') {
      endBreak(k)
      return
    }
    if (ownDig(position)) return
    const speed = Math.max(0, Number(packet.data) || 0)
    let state = breaking.get(k)
    if (packet.event === 'block_break_speed') {
      if (state) state.speed = speed
      return
    }
    if (state) {
      // a restart: keep the observed stage, new speed
      state.speed = speed
      return
    }
    state = { position, speed, progress: 0, stage: 0, entity: breakerNear(position) }
    breaking.set(k, state)
    startTimer()
    bot.emit('blockBreakProgressObserved', bot.blockAt(position), 0, state.entity)
  })

  // the block broke (or changed): the animation ends like Java's stage -1
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!newBlock || breaking.size === 0) return
    const k = key(newBlock.position)
    if (breaking.has(k) && oldBlock?.type !== newBlock.type) endBreak(k)
  })

  // positions belong to the old world after a dimension change
  bot._bedrock?.lifecycle?.events?.on('dimensionChange', () => {
    clearBreaks()
    for (const k of Object.keys(pistonStates)) delete pistonStates[k]
    for (const k of Object.keys(openCountByPos)) delete openCountByPos[k]
  })
  bot.on('end', clearBreaks)
}
