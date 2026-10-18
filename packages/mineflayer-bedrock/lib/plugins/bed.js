// owner: U9 (wave 3, bed state: isSleeping, isABed, parseBedMetadata, spawnReset) → U14 (wave 4, sleep/wake)
// Adapted from mineflayer 4.39.0 lib/plugins/bed.js (MIT, Copyright (c) 2013 Andrew Kelley): isABed,
//   parseBedMetadata (same result shape), isSleeping + 'sleep' / 'wake', 'spawnReset'.
// Surface: bot.isSleeping, bot.isABed(block), bot.parseBedMetadata(bedBlock), bot.sleep(bedBlock) (U14),
//   bot.wake() (U14)
// Events: 'sleep', 'wake' (from entitySleep / entityWake of bot.entity, emitted by the entities plugin from the
//   `sleeping` metadata flag), 'spawnReset'
// Bedrock (docs/differences/U9.md#beds):
// - beds are one block `bed` (colour in the block entity; plus `straw_bed`) with states `direction` (0 south,
//   1 west, 2 north, 3 east — the head's side, like Java's facing index), `head_piece_bit`, `occupied_bit`
//   (`straw_bed`: `minecraft:cardinal_direction`).
// - spawnReset: BDS answers a respawn whose bed / respawn anchor is gone or obstructed with the
//   `tile.bed.notValid` / `tile.respawn_anchor.notValid` message (Java: game event no_respawn_block_available).
'use strict'
const { Vec3 } = require('vec3')
const { stubAsync } = require('../bedrock/errors')

module.exports = inject

/** facing index (upstream: 0 south, 1 west, 2 north, 3 east) → head offset from the foot */
const HEAD_OFFSETS = [new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1), new Vec3(1, 0, 0)]
const CARDINALS = { south: 0, west: 1, north: 2, east: 3 }
const SPAWN_RESET = /^tile\.(bed|respawn_anchor)\.notValid$/

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

  bot.parseBedMetadata = parseBedMetadata
  bot.isABed = isABed
  bot.sleep = stubAsync('U14', 'bot.sleep', 1)
  bot.wake = stubAsync('U14', 'bot.wake', 0)
}
