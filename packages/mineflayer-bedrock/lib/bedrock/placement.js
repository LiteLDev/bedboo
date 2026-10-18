// owner: U11 (placing & placement-based parity)
'use strict'
const { Vec3 } = require('vec3')
const { RaycastIterator } = require('prismarine-world').iterators
const tx = require('./transactions')
const { EYE_HEIGHT } = require('./constants')
const { viewDirection } = require('./conversions')

/**
 * Bedrock placement internals shared by lib/plugins/generic_place.js (bot._genericPlace), place_entity.js and item use
 * on blocks (buckets, boats). Exposed as `bot._bedrock.placement` by generic_place.js.
 *
 * Wire protocol (measured on BDS 1.26.51.1, see docs/differences/U11.md#placement-protocol):
 * - a click on a block face is `player_action start_item_use_on` (clicked block, clicked block + face, face) →
 *   `inventory_transaction item_use click_block` (held item = the exact server copy, the clicked block's runtime id,
 *   the click position on the face, the hotbar slot, the hand, the EYE-level player position) → `player_action
 *   stop_item_use_on` (clicked block + face) 150 ms later, like the vanilla client (lib/bedrock/transactions.js builds
 *   the three packets). The stop of a click is sent before the start of the next one, so the pairs never interleave.
 * - BDS answers every click with update_block for the clicked block, the block across the face and their neighbours
 *   (clicked block first, then the block across the face), whatever the outcome — the same shape as Java's answer to
 *   block_place, so upstream's place_block logic works unchanged. The inventory (count, durability, new stack id) comes
 *   first as inventory_content.
 * - Using a block (opening a chest, toggling a door, …) wins over placing unless the player sneaks: the server must
 *   have processed a sneaking input before the click (set_entity_data `sneaking` acknowledges it; while flying the
 *   raw sneak keys of the input are enough).
 */

/** ms between start_item_use_on and stop_item_use_on (vanilla client) */
const STOP_DELAY_MS = tx.DEFAULT_STOP_DELAY_MS
/** survival block interaction range (Bedrock: 6 creative / 4.5 + margin survival — the client picks within 6) */
const PICK_RANGE = 6

/**
 * Blocks whose "use" action wins over placing a block against them (Bedrock names). A placement against one of them
 * needs the player to sneak, like on the vanilla client.
 */
const INTERACTIVE_BLOCKS = new Set([
  // containers
  'chest', 'trapped_chest', 'ender_chest', 'barrel', 'dispenser', 'dropper', 'hopper', 'crafter',
  'furnace', 'lit_furnace', 'blast_furnace', 'lit_blast_furnace', 'smoker', 'lit_smoker', 'brewing_stand', 'beacon',
  // stations
  'crafting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'deprecated_anvil', 'enchanting_table', 'grindstone',
  'stonecutter_block', 'loom', 'cartography_table', 'smithing_table', 'lectern', 'composter',
  // redstone & toggles
  'lever', 'noteblock', 'jukebox', 'unpowered_repeater', 'powered_repeater', 'unpowered_comparator',
  'powered_comparator', 'daylight_detector', 'daylight_detector_inverted', 'command_block', 'repeating_command_block',
  'chain_command_block', 'structure_block', 'jigsaw',
  // misc
  'bed', 'cake', 'respawn_anchor', 'bell', 'cauldron', 'flower_pot', 'frame', 'glow_frame', 'dragon_egg', 'campfire',
  'soul_campfire', 'decorated_pot', 'chiseled_bookshelf', 'sweet_berry_bush', 'cave_vines_body_with_berries',
  'cave_vines_head_with_berries'
])
const INTERACTIVE_PATTERNS = [
  /_shulker_box$/, // undyed_shulker_box, white_shulker_box, …
  /(^|_)door$/, // wooden_door, spruce_door, copper_door … (iron_door excluded below)
  /(^|_)trapdoor$/,
  /(^|_)fence_gate$/,
  /_button$/,
  /_(standing|wall|hanging)_sign$/, // signs open the editor on Bedrock
  /^(standing|wall)_sign$/,
  /(^|_)candle_cake$/,
  /copper_chest$/,
  /_shelf$/,
  /_bed$/
]
const NOT_INTERACTIVE = new Set(['iron_door', 'iron_trapdoor', 'stone_button_placeholder'])

/** @param {{name: string}|null} block @returns {boolean} the block's use action wins over placing against it */
function isInteractive (block) {
  const name = block?.name
  if (!name || NOT_INTERACTIVE.has(name)) return false
  if (INTERACTIVE_BLOCKS.has(name)) return true
  return INTERACTIVE_PATTERNS.some((re) => re.test(name))
}

const LIQUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava'])
const isLiquid = (block) => !!block && LIQUIDS.has(block.name)
/** a liquid source block (liquid_depth 0) */
function isLiquidSource (block) {
  if (!isLiquid(block)) return false
  const depth = block.getProperties?.()?.liquid_depth
  return depth === undefined || Number(depth) === 0
}

/** Items whose use targets the block the player looks at (Bedrock: a click_block; BDS ignores their click_air). */
const EMPTY_BUCKET = 'bucket'
const FILLED_BUCKETS = /^(water|lava|powder_snow|cod|salmon|tropical_fish|pufferfish|axolotl|tadpole|sulfur_cube)_bucket$/
const BOATS = /(^|_)(chest_)?(boat|raft)$/
/** boat and raft items (chest variants included) */
const isBoatItem = (name) => BOATS.test(name ?? '')

/**
 * How `activateItem` must target a block for `itemName` on Bedrock, or null when click_air is right.
 * - empty bucket: the first liquid source (picks it up) or solid block along the look;
 * - filled bucket: the first solid block (liquids are passed through), the liquid goes across the hit face;
 * - boat: the first liquid or solid block (boats float on water, Bedrock also places them on land).
 * @returns {null | { liquids: 'source' | 'any' | 'none' }}
 */
function blockTargetOf (itemName) {
  if (!itemName) return null
  if (itemName === EMPTY_BUCKET) return { liquids: 'source' }
  if (FILLED_BUCKETS.test(itemName)) return { liquids: 'none' }
  if (isBoatItem(itemName)) return { liquids: 'any' }
  return null
}

const FULL_CUBE = [[0, 0, 0, 1, 1, 1]]

/** `local` (relative to the block) inside one of `shapes` */
const insideShapes = (shapes, local) => shapes.some(([x0, y0, z0, x1, y1, z1]) =>
  local.x > x0 && local.x < x1 && local.y > y0 && local.y < y1 && local.z > z0 && local.z < z1)

/** the face a ray going `dir` enters through: the opposite of its dominant axis (Java's hit from inside a shape) */
function entryFace (dir) {
  const ax = Math.abs(dir.x)
  const ay = Math.abs(dir.y)
  const az = Math.abs(dir.z)
  if (ay >= ax && ay >= az) return dir.y > 0 ? 0 : 1
  if (ax >= az) return dir.x > 0 ? 4 : 5
  return dir.z > 0 ? 2 : 3
}

/**
 * Raycast from the bot's eyes along its look direction (mineflayer yaw/pitch) through the loaded world.
 * @param {object} bot
 * @param {{ maxDistance?: number, liquids?: 'source'|'any'|'none' }} [opts] which liquid blocks stop the ray (as full
 *   cubes); other blocks stop it on their collision shapes
 * @returns {null | { block: object, position: Vec3, face: number, cursor: Vec3 }} the hit block, the hit face (0-5) and
 *   the hit point relative to the block
 */
function raycast (bot, { maxDistance = PICK_RANGE, liquids = 'none' } = {}) {
  const entity = bot.entity
  if (!entity) return null
  const eye = entity.position.offset(0, entity.eyeHeight ?? EYE_HEIGHT, 0)
  const d = viewDirection(entity.yaw, entity.pitch)
  const dir = new Vec3(d.x, d.y, d.z)
  const iter = new RaycastIterator(eye, dir, maxDistance)
  let cell = { x: Math.floor(eye.x), y: Math.floor(eye.y), z: Math.floor(eye.z) }
  while (cell) {
    const position = new Vec3(cell.x, cell.y, cell.z)
    const block = bot.blockAt(position, false)
    if (!block) return null // unloaded
    let shapes = null
    if (isLiquid(block)) {
      if (liquids === 'any' || (liquids === 'source' && isLiquidSource(block))) shapes = FULL_CUBE
    } else if (block.boundingBox === 'block' && block.shapes?.length) {
      shapes = block.shapes
    }
    if (shapes) {
      // the eyes inside the shape (e.g. a bucket with the head in a water source): hit where they are (like Java's
      // clip from inside a shape); RaycastIterator would report a point behind them
      if (insideShapes(shapes, eye.minus(position))) return { block, position, face: entryFace(dir), cursor: eye.minus(position) }
      const hit = iter.intersect(shapes, position)
      if (hit) return { block, position, face: hit.face, cursor: hit.pos.minus(position) }
    }
    cell = iter.next()
  }
  return null
}

/**
 * Click sender with the vanilla start/stop pairing.
 * @param {object} bot
 */
function createPlacer (bot) {
  let pendingStop = null // { timer, packet }

  function send (name, params) {
    try {
      bot._client.queue(name, params)
    } catch (err) {
      bot.emit('error', err)
    }
  }

  /** send the pending stop_item_use_on now (before another click, or when its delay elapsed) */
  function flushStop () {
    if (!pendingStop) return
    clearTimeout(pendingStop.timer)
    const { packet } = pendingStop
    pendingStop = null
    send('player_action', packet)
  }

  /**
   * Click `face` of the block at `position` with the held item (queued now, returns synchronously).
   * @param {{ position: Vec3, face: number, cursor?: {x,y,z}, hand?: 'main_hand'|'off_hand', heldItem?: object,
   *   lifecycle?: boolean }} opts `heldItem` overrides the wire item (off-hand), `lifecycle: false` = bare click
   * @returns {object} the inventory_transaction params that were queued
   */
  function click ({ position, face, cursor, hand = 'main_hand', heldItem, lifecycle = true }) {
    flushStop()
    const { start, transaction, stop } = tx.buildUseItemOn(bot, { position, face, cursor, hand })
    if (heldItem) transaction.transaction.transaction_data.held_item = heldItem
    if (lifecycle) send('player_action', start)
    send('inventory_transaction', transaction)
    if (lifecycle) {
      const timer = setTimeout(flushStop, STOP_DELAY_MS)
      timer.unref?.()
      pendingStop = { timer, packet: stop }
    }
    return transaction
  }

  function reset () {
    if (pendingStop) clearTimeout(pendingStop.timer)
    pendingStop = null
  }

  return { click, flushStop, reset, hasPendingStop: () => pendingStop !== null }
}

module.exports = {
  INTERACTIVE_BLOCKS,
  INTERACTIVE_PATTERNS,
  isInteractive,
  isLiquid,
  isLiquidSource,
  blockTargetOf,
  isBoatItem,
  raycast,
  createPlacer,
  STOP_DELAY_MS,
  PICK_RANGE
}
