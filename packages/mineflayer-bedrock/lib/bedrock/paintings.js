// owner: U7 (entities & players)
'use strict'
const { Vec3 } = require('vec3')
const Painting = require('mineflayer/lib/painting')

/**
 * Paintings. Bedrock spawns paintings with `add_painting { entity_id_self, runtime_entity_id, coordinates,
 * direction, title }`; mineflayer exposes them as `Painting(id, position, name, direction)` (mineflayer/lib/painting)
 * tracked by the world (blocks.js `paintingsByPos` / `paintingsById`, registered through
 * `bot._bedrock.world.paintings` by entities.js).
 *
 * Observed on BDS 1.26.51.1 (a 1×1 painting hung on the south face of the stone block at (0, -59, -4)):
 * `coordinates (0.5, -58.5, -2.96875)` (the painting's center, 1/32 off the wall), `direction 0`, `title 'Kebab'`.
 * - `position`: the block the painting occupies — the floored center, like Java's painting block position.
 * - `direction`: Bedrock's 0..3 (south, west, north, east) is Java's 2D direction, mapped with upstream blocks.js
 *   `paintingFaceToVec` (the vector from the painting to the block it hangs on).
 * - `name`: Bedrock motive titles are the Java ≤ 1.12 titles (`Kebab`, `SkullAndRoses`, …); mineflayer-bedrock
 *   reports the modern Java painting variant name (`kebab`, `skull_and_roses`, …) — `MOTIVES`, else the title in
 *   snake case (motives added after 1.21 already use Java's ids).
 *
 * Contract:
 * - `fromAddPainting(packet) → Painting` (id = Number(runtime id), like every mineflayer entity id)
 * - `MOTIVES` Bedrock motive title → mineflayer painting name
 */

// mineflayer 4.39.0 lib/plugins/blocks.js (MIT, Copyright (c) 2013 Andrew Kelley)
const paintingFaceToVec = [
  new Vec3(0, 0, -1),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(1, 0, 0)
]

const MOTIVES = Object.freeze({
  Kebab: 'kebab',
  Aztec: 'aztec',
  Alban: 'alban',
  Aztec2: 'aztec2',
  Bomb: 'bomb',
  Plant: 'plant',
  Wasteland: 'wasteland',
  Wanderer: 'wanderer',
  Graham: 'graham',
  Pool: 'pool',
  Courbet: 'courbet',
  Sunset: 'sunset',
  Sea: 'sea',
  Creebet: 'creebet',
  Match: 'match',
  Bust: 'bust',
  Stage: 'stage',
  Void: 'void',
  SkullAndRoses: 'skull_and_roses',
  Wither: 'wither',
  Fighters: 'fighters',
  Skeleton: 'skeleton',
  DonkeyKong: 'donkey_kong',
  Pointer: 'pointer',
  Pigscene: 'pigscene',
  BurningSkull: 'burning_skull',
  Earth: 'earth',
  Wind: 'wind',
  Water: 'water',
  Fire: 'fire'
})

/** @param {string} title Bedrock motive title @returns {string} mineflayer (modern Java) painting name */
function motiveName (title) {
  const t = String(title ?? '')
  if (Object.prototype.hasOwnProperty.call(MOTIVES, t)) return MOTIVES[t]
  return t.replace(/^minecraft:/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/**
 * @param {{ runtime_entity_id: bigint|number, coordinates: {x:number,y:number,z:number}, direction: number, title: string }} packet
 * @returns {Painting}
 */
function fromAddPainting (packet) {
  const c = packet.coordinates
  const position = new Vec3(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z))
  const direction = paintingFaceToVec[((Number(packet.direction) % 4) + 4) % 4]
  return new Painting(Number(packet.runtime_entity_id), position, motiveName(packet.title), direction)
}

module.exports = {
  MOTIVES,
  motiveName,
  paintingFaceToVec,
  fromAddPainting
}
