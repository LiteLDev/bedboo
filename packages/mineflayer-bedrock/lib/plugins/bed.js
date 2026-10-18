// owner: U9 (wave 3, bed state: isSleeping, isABed, parseBedMetadata, spawnReset) → U14 (wave 4, sleep/wake)
// Adapted from mineflayer 4.39.0 lib/plugins/bed.js (MIT, Copyright (c) 2013 Andrew Kelley): isABed,
//   parseBedMetadata (same result shape), isSleeping + 'sleep' / 'wake', 'spawnReset'.
// Surface: bot.isSleeping, bot.isABed(block), bot.parseBedMetadata(bedBlock), bot.sleep(bedBlock) (U14),
//   bot.wake() (U14)
// U14 (wave 4): sleep / wake adapted from upstream (same checks, order and error messages):
// - sleep: night (12541..23458) or thunderstorm, not already sleeping, a bed, not occupied, both halves, clickable
//   (bot.canDigBlock, or upstream's reach check while digging.js is a stub), within the click range, no hostile mob
//   in the monster range; then bot.activateBlock(bed) (item_use click_block) and resolve on 'sleep' (BDS:
//   set_entity_data player_flags bit 1 + player_bed_position, the player is moved into the bed with a
//   correct_player_move_prediction), 'bot is not sleeping' after 3 s.
// - wake: player_action stop_sleeping (Java: entity_action leave_bed); BDS answers animate wake_up + player_flags 0
//   → 'wake' (docs/differences/U14.md#beds).
// Events: 'sleep', 'wake' (from entitySleep / entityWake of bot.entity, emitted from the sleeping metadata — BDS:
//   player_flags bit 1 for players — by the entity data code), 'spawnReset'
// Bedrock (docs/differences/U9.md#beds):
// - beds are one block `bed` (colour in the block entity; plus `straw_bed`) with states `direction` (0 south,
//   1 west, 2 north, 3 east — the head's side, like Java's facing index), `head_piece_bit`, `occupied_bit`
//   (`straw_bed`: `minecraft:cardinal_direction`).
// - spawnReset: BDS answers a respawn whose bed / respawn anchor is gone or obstructed with the
//   `tile.bed.notValid` / `tile.respawn_anchor.notValid` message (Java: game event no_respawn_block_available).
'use strict'
const { Vec3 } = require('vec3')
const { isStub } = require('../bedrock/errors')

module.exports = inject

/** facing index (upstream: 0 south, 1 west, 2 north, 3 east) → head offset from the foot */
const HEAD_OFFSETS = [new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1), new Vec3(1, 0, 0)]
const CARDINALS = { south: 0, west: 1, north: 2, east: 3 }
const SPAWN_RESET = /^tile\.(bed|respawn_anchor)\.notValid$/
const CARDINAL_DIRECTIONS = ['south', 'west', 'north', 'east']
/** ms upstream waits for the 'sleep' event after clicking the bed */
const SLEEP_TIMEOUT = 3000

function inject (bot) {
  bot.isSleeping = false

  function isABed (block) {
    return !!block && (block.name === 'bed' || block.name.endsWith('_bed'))
  }

  function parseBedMetadata (bedBlock) {
    const metadata = {
      part: false, // true: head, false: foot
      occupied: 0,
      facing: 0, // 0: south, 1: west, 2: north, 3 east
      headOffset: new Vec3(0, 0, 1)
    }
    const props = bedBlock.getProperties?.() ?? bedBlock._properties ?? {}
    metadata.part = !!props.head_piece_bit
    metadata.occupied = !!props.occupied_bit
    let facing = props.direction
    if (facing === undefined && props['minecraft:cardinal_direction'] !== undefined) facing = CARDINALS[props['minecraft:cardinal_direction']]
    facing = ((Number(facing) || 0) % 4 + 4) % 4
    metadata.facing = facing
    metadata.headOffset = HEAD_OFFSETS[facing].clone()
    return metadata
  }

  // the server's translated message (json rawtext `translate` or a translation text), never text a player wrote
  function isSpawnReset (packet) {
    if (packet.type === 'translation') return SPAWN_RESET.test(String(packet.message ?? '').replace(/^%/, ''))
    if (packet.type !== 'json') return false
    let json
    try { json = JSON.parse(packet.message) } catch { return false }
    const keys = []
    const walk = (node) => {
      if (Array.isArray(node)) node.forEach(walk)
      else if (node && typeof node === 'object') {
        if (typeof node.translate === 'string') keys.push(node.translate)
        walk(node.rawtext)
      }
    }
    walk(json)
    return keys.some(k => SPAWN_RESET.test(k))
  }

  bot._client.on('text', (packet) => {
    if (isSpawnReset(packet)) {
      // occurs when you can't spawn in your bed and your spawn point gets reset
      bot.emit('spawnReset')
    }
  })

  bot.on('entitySleep', (entity) => {
    if (entity === bot.entity) {
      bot.isSleeping = true
      bot.emit('sleep')
    }
  })

  bot.on('entityWake', (entity) => {
    if (entity === bot.entity) {
      bot.isSleeping = false
      bot.emit('wake')
    }
  })

  /** upstream canDigBlock (digging.js): a diggable block whose center is within 5.1 of the eyes */
  function canClickBlock (block) {
    if (typeof bot.canDigBlock === 'function' && !isStub(bot.canDigBlock)) return bot.canDigBlock(block)
    return !!(
      block &&
      block.diggable &&
      block.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1
    )
  }

  async function wake () {
    if (!bot.isSleeping) {
      throw new Error('already awake')
    } else {
      // Java: entity_action leave_bed; Bedrock: player_action stop_sleeping
      bot._client.queue('player_action', {
        runtime_entity_id: bot._bedrock?.ids?.selfRuntimeId?.() ?? bot.entity?.runtimeId ?? 0n,
        action: 'stop_sleeping',
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0
      })
    }
  }

  async function sleep (bedBlock) {
    const thunderstorm = bot.isRaining && (bot.thunderState > 0)
    if (!thunderstorm && !(bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458)) {
      throw new Error("it's not night and it's not a thunderstorm")
    } else if (bot.isSleeping) {
      throw new Error('already sleeping')
    } else if (!isABed(bedBlock)) {
      throw new Error('wrong block : not a bed block')
    } else {
      const botPos = bot.entity.position.floored()
      const metadata = parseBedMetadata(bedBlock)
      let headPoint = bedBlock.position

      if (metadata.occupied) {
        throw new Error('the bed is occupied')
      }

      if (!metadata.part) { // Is foot
        const upperBlock = bot.blockAt(bedBlock.position.plus(metadata.headOffset))

        if (isABed(upperBlock)) {
          headPoint = upperBlock.position
        } else {
          const lowerBlock = bot.blockAt(bedBlock.position.plus(metadata.headOffset.scaled(-1)))

          if (isABed(lowerBlock)) {
            // If there are 2 foot parts, minecraft only lets you sleep if you click on the lower one
            headPoint = bedBlock.position
            bedBlock = lowerBlock
          } else {
            throw new Error("there's only half bed")
          }
        }
      }

      if (!canClickBlock(bedBlock)) {
        throw new Error('cant click the bed')
      }

      const clickRange = [2, -3, -3, 2] // [south, west, north, east]
      const monsterRange = [7, -8, -8, 7]
      const oppositeCardinal = (metadata.facing + 2) % CARDINAL_DIRECTIONS.length

      if (clickRange[oppositeCardinal] < 0) {
        clickRange[oppositeCardinal]--
      } else {
        clickRange[oppositeCardinal]++
      }

      const nwClickCorner = headPoint.offset(clickRange[1], -2, clickRange[2]) // North-West lower corner
      const seClickCorner = headPoint.offset(clickRange[3], 2, clickRange[0]) // South-East upper corner
      if (botPos.x > seClickCorner.x || botPos.x < nwClickCorner.x || botPos.y > seClickCorner.y || botPos.y < nwClickCorner.y || botPos.z > seClickCorner.z || botPos.z < nwClickCorner.z) {
        throw new Error('the bed is too far')
      }

      if (bot.game.gameMode !== 'creative' || bot.supportFeature('creativeSleepNearMobs')) { // If in creative mode the bot should be able to sleep even if there are monster nearby (starting in 1.13)
        const nwMonsterCorner = headPoint.offset(monsterRange[1], -6, monsterRange[2]) // North-West lower corner
        const seMonsterCorner = headPoint.offset(monsterRange[3], 4, monsterRange[0]) // South-East upper corner

        for (const key of Object.keys(bot.entities)) {
          const entity = bot.entities[key]
          if (entity.kind === 'Hostile mobs') {
            const entityPos = entity.position.floored()
            if (entityPos.x <= seMonsterCorner.x && entityPos.x >= nwMonsterCorner.x && entityPos.y <= seMonsterCorner.y && entityPos.y >= nwMonsterCorner.y && entityPos.z <= seMonsterCorner.z && entityPos.z >= nwMonsterCorner.z) {
              throw new Error('there are monsters nearby')
            }
          }
        }
      }

      // We need to register the listener before actually going to sleep to avoid race conditions
      const waitingPromise = waitUntilSleep()
      // Bedrock: activateBlock is async (it waits for the look and queues the click); the 3 s may run out meanwhile
      waitingPromise.catch(() => {})
      try {
        await bot.activateBlock(bedBlock)
      } catch (err) {
        waitingPromise.cancel()
        throw err
      }
      await waitingPromise
    }
  }

  function waitUntilSleep () {
    let cancel
    const promise = new Promise((resolve, reject) => {
      const timeoutForSleep = setTimeout(() => {
        bot.removeListener('sleep', onSleep)
        reject(new Error('bot is not sleeping'))
      }, SLEEP_TIMEOUT)

      function onSleep () {
        clearTimeout(timeoutForSleep)
        resolve()
      }
      cancel = () => {
        clearTimeout(timeoutForSleep)
        bot.removeListener('sleep', onSleep)
      }
      bot.once('sleep', onSleep)
    })
    promise.cancel = cancel
    return promise
  }

  bot.parseBedMetadata = parseBedMetadata
  bot.isABed = isABed
  bot.sleep = sleep
  bot.wake = wake
}
