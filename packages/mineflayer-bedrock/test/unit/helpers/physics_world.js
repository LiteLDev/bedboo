// owner: U5 (physics & movement) — offline worlds for the physics engine tests
'use strict'
/**
 * A minimal `world` ({ getBlock(pos) }) over the Bedrock 1.26.51 registry: the default flat world (bedrock -64,
 * dirt -63/-62, grass_block -61, air above) plus blocks set by tests or by replaying the console commands of a
 * recorded trace (`fill` / `setblock` with Bedrock block states).
 *
 *   const { createWorld } = require('./helpers/physics_world')
 *   const world = createWorld()
 *   world.fill(3, -60, -1, 3, -60, 1, 'smooth_stone_slab', { 'minecraft:vertical_half': 'bottom' })
 *   world.command('setblock 4 -61 0 soul_sand')
 */
const { Vec3 } = require('vec3')
const { createRegistry } = require('../../../lib/registry')

let shared = null
function registryAndBlock () {
  if (!shared) {
    const registry = createRegistry()
    shared = { registry, Block: require('prismarine-block')(registry) }
  }
  return shared
}

function parseStates (str) {
  if (!str) return undefined
  const props = {}
  for (const m of str.matchAll(/"([^"]+)"\s*=\s*("[^"]*"|[^,\]]+)/g)) {
    let v = m[2].trim()
    if (v.startsWith('"')) v = v.slice(1, -1)
    else if (v === 'true') v = 1
    else if (v === 'false') v = 0
    props[m[1]] = v
  }
  return props
}

function createWorld ({ flat = true } = {}) {
  const { registry, Block } = registryAndBlock()
  const blocks = new Map()
  const stateCache = new Map()
  const key = (x, y, z) => `${x},${y},${z}`

  function stateOf (name, props) {
    const cacheKey = name + JSON.stringify(props ?? {})
    if (stateCache.has(cacheKey)) return stateCache.get(cacheKey)
    const block = registry.blocksByName[name]
    if (!block) throw new Error(`unknown block ${name}`)
    let state = block.defaultState
    if (props) {
      state = null
      for (let s = block.minStateId; s <= block.maxStateId; s++) {
        const p = Block.fromStateId(s, 0).getProperties()
        if (Object.entries(props).every(([k, v]) => String(p[k]) === String(v))) { state = s; break }
      }
      if (state === null) throw new Error(`no state of ${name} with ${JSON.stringify(props)}`)
    }
    stateCache.set(cacheKey, state)
    return state
  }

  function defaultName (y) {
    if (!flat) return 'air'
    if (y === -64) return 'bedrock'
    if (y === -63 || y === -62) return 'dirt'
    if (y === -61) return 'grass_block'
    return 'air'
  }

  const world = {
    registry,
    set (x, y, z, name, props) {
      blocks.set(key(x, y, z), stateOf(name, props))
      return world
    },
    fill (x1, y1, z1, x2, y2, z2, name, props) {
      const state = stateOf(name, props)
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) blocks.set(key(x, y, z), state)
        }
      }
      return world
    },
    /** apply a recorded console command (`fill` / `setblock`, optionally `execute in … run`) */
    command (cmd) {
      let m = /^(?:execute in \w+ run )?fill (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (\w+)\s*(\[.*\])?/.exec(cmd)
      if (m) {
        const n = m.slice(1, 7).map(Number)
        return world.fill(n[0], n[1], n[2], n[3], n[4], n[5], m[7], parseStates(m[8]))
      }
      m = /^(?:execute in \w+ run )?setblock (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (\w+)\s*(\[.*\])?/.exec(cmd)
      if (m) {
        const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])]
        world.set(x, y, z, m[4], parseStates(m[5]))
        // BDS turns the water above soul sand / magma into a bubble column (up / down)
        if (m[4] === 'soul_sand' || m[4] === 'magma') {
          for (let cy = y + 1; ['water', 'bubble_column'].includes(world.getBlock(new Vec3(x, cy, z)).name); cy++) {
            world.set(x, cy, z, 'bubble_column', { drag_down: m[4] === 'magma' ? 1 : 0 })
          }
        }
      }
      return world
    },
    getBlock (pos) {
      const x = Math.floor(pos.x)
      const y = Math.floor(pos.y)
      const z = Math.floor(pos.z)
      let state = blocks.get(key(x, y, z))
      if (state === undefined) state = stateOf(defaultName(y))
      const block = Block.fromStateId(state, 0)
      block.position = new Vec3(x, y, z)
      return block
    }
  }
  return world
}

/** an engine state (prismarine-physics PlayerState shape) at `pos`, standing, with `control` */
function playerState (pos, control = {}, extra = {}) {
  return {
    pos: pos.clone(),
    vel: new Vec3(0, 0, 0),
    onGround: true,
    isInWater: false,
    isInLava: false,
    isInWeb: false,
    isCollidedHorizontally: false,
    isCollidedVertically: false,
    elytraFlying: false,
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    attributes: {},
    yaw: 0,
    pitch: 0,
    control: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, ...control },
    jumpBoost: 0,
    speed: 0,
    slowness: 0,
    dolphinsGrace: 0,
    slowFalling: 0,
    levitation: 0,
    depthStrider: 0,
    elytraEquipped: false,
    ...extra
  }
}

/** mineflayer yaw facing +x (east) / -x (west) / -z (north) / +z (south) */
const YAW = { east: -Math.PI / 2, west: Math.PI / 2, north: 0, south: Math.PI }

module.exports = { createWorld, playerState, registryAndBlock, parseStates, YAW }
