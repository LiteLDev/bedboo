// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Blueprints and the blueprint compiler (pure: no bot).
 *
 * A blueprint is data:
 *   {
 *     name, description,
 *     palette: { <char>: spec },   spec = 'block_name' | ['alt_a', 'alt_b'] | { block: name|[names], phase?, tall?, upper? }
 *                                  | 'air' (must be empty) | null (don't care); ' ' is always "don't care"
 *     layers: [ [row, …], … ]      bottom layer first; a row runs west → east (+x), rows run north → south (+z)
 *   }
 * Specs: a list of names accepts any of them (the first is the one the agent obtains when it has none); `phase: 2`
 * places the block after the structure (furniture); `tall: true` is a two-block item (a door: placed in its lower
 * cell, the cell above must be `upper`); `upper: true` is the upper half of a tall block (verified, never placed).
 *
 * compile(blueprint, origin) → {
 *   placements: [{ pos, names, item, phase, tall }]   in a buildable order: bottom-up, each block touching one placed
 *                                                    before it (or the ground under the bottom layer)
 *   air:        [pos]                                cells that must be empty
 *   checks:     [{ pos, names }]                     what verify() compares (placements + upper halves)
 *   materials:  [{ names, item, count }]             one entry per distinct spec
 *   bounds:     { min, max }                          inclusive
 * }
 */
const { Vec3 } = require('vec3')

const AIR = Object.freeze({ air: true })

function normalizeSpec (spec, char) {
  if (spec === null || spec === undefined) return null
  if (spec === 'air') return AIR
  if (typeof spec === 'string') return { names: [spec], phase: 1 }
  if (Array.isArray(spec)) {
    if (!spec.length) throw new Error(`palette '${char}': empty list`)
    return { names: spec.slice(), phase: 1 }
  }
  if (typeof spec === 'object') {
    if (spec.air) return AIR
    const names = [].concat(spec.block ?? [])
    if (!names.length) throw new Error(`palette '${char}': no block`)
    return { names, phase: spec.phase ?? 1, tall: !!spec.tall, upper: !!spec.upper, item: spec.item }
  }
  throw new Error(`palette '${char}': bad spec ${JSON.stringify(spec)}`)
}

/**
 * @param {object} blueprint
 * @param {{x:number,y:number,z:number}} origin world position of the blueprint's (0, 0, 0): bottom layer, first row,
 *   first column (the north-west corner of the bottom layer)
 */
function compile (blueprint, origin = { x: 0, y: 0, z: 0 }) {
  if (!blueprint || !Array.isArray(blueprint.layers) || !blueprint.layers.length) throw new Error('blueprint has no layers')
  const palette = {}
  for (const [char, spec] of Object.entries(blueprint.palette ?? {})) palette[char] = normalizeSpec(spec, char)
  palette[' '] = null
  const o = new Vec3(origin.x, origin.y, origin.z)
  const cells = new Map() // "x,y,z" (relative) → { rel, spec }
  const key = (x, y, z) => `${x},${y},${z}`
  let maxX = 0
  let maxZ = 0
  blueprint.layers.forEach((layer, y) => {
    if (!Array.isArray(layer)) throw new Error(`layer ${y} is not a list of rows`)
    layer.forEach((row, z) => {
      maxZ = Math.max(maxZ, z)
      ;[...row].forEach((char, x) => {
        maxX = Math.max(maxX, x)
        if (!Object.hasOwn(palette, char)) throw new Error(`layer ${y} row ${z}: '${char}' is not in the palette`)
        const spec = palette[char]
        if (spec) cells.set(key(x, y, z), { rel: new Vec3(x, y, z), spec, char })
      })
    })
  })

  // tall blocks need their upper cell
  for (const cell of cells.values()) {
    if (!cell.spec.tall) continue
    const up = cells.get(key(cell.rel.x, cell.rel.y + 1, cell.rel.z))
    if (!up || !up.spec.upper) throw new Error(`tall block '${cell.char}' at ${cell.rel} needs an upper-half cell above it`)
  }

  const solid = [...cells.values()].filter((c) => c.spec !== AIR && !c.spec.upper)
  const isPlacedSolid = new Set()
  const order = []
  // phase 1 then phase 2; within a phase bottom-up, each layer grown from supported cells (BFS)
  for (const phase of [...new Set(solid.map((c) => c.spec.phase))].sort((a, b) => a - b)) {
    const inPhase = solid.filter((c) => c.spec.phase === phase)
    const layers = [...new Set(inPhase.map((c) => c.rel.y))].sort((a, b) => a - b)
    for (const y of layers) {
      const pending = new Map(inPhase.filter((c) => c.rel.y === y).map((c) => [key(c.rel.x, y, c.rel.z), c]))
      const supported = (c) => y === 0 || isPlacedSolid.has(key(c.rel.x, y - 1, c.rel.z))
      const queue = [...pending.values()].filter(supported)
      for (const c of queue) pending.delete(key(c.rel.x, y, c.rel.z))
      for (let i = 0; i < queue.length; i++) {
        const c = queue[i]
        order.push(c)
        isPlacedSolid.add(key(c.rel.x, y, c.rel.z))
        if (c.spec.tall) isPlacedSolid.add(key(c.rel.x, y + 1, c.rel.z))
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = key(c.rel.x + dx, y, c.rel.z + dz)
          const n = pending.get(k)
          if (n && !n.spec.tall && phase === 1) { pending.delete(k); queue.push(n) }
        }
      }
      if (pending.size) {
        throw new Error(`blueprint ${blueprint.name ?? ''}: unsupported block(s) in layer ${y}: ${[...pending.values()].map((c) => `${c.char}@${c.rel}`).join(' ')}`)
      }
    }
  }

  // doors (tall blocks) close the structure: always last
  order.sort((a, b) => (a.spec.phase - b.spec.phase) || ((a.spec.tall ? 1 : 0) - (b.spec.tall ? 1 : 0)))
  const placements = order.map((c) => ({
    pos: o.plus(c.rel),
    rel: c.rel,
    names: c.spec.names,
    item: c.spec.item ?? c.spec.names[0],
    phase: c.spec.phase,
    tall: !!c.spec.tall
  }))
  const air = [...cells.values()].filter((c) => c.spec === AIR).map((c) => o.plus(c.rel))
  const checks = [...cells.values()].filter((c) => c.spec !== AIR).map((c) => ({ pos: o.plus(c.rel), names: c.spec.names, upper: !!c.spec.upper }))
  const materials = []
  for (const p of placements) {
    const k = p.names.join('|')
    let m = materials.find((x) => x.key === k)
    if (!m) { m = { key: k, names: p.names, item: p.item, count: 0 }; materials.push(m) }
    m.count++
  }
  return {
    name: blueprint.name ?? 'blueprint',
    origin: o,
    placements,
    air,
    checks,
    materials: materials.map(({ key, ...m }) => m),
    bounds: { min: o.clone(), max: o.offset(maxX, blueprint.layers.length - 1, maxZ) },
    size: { x: maxX + 1, y: blueprint.layers.length, z: maxZ + 1 }
  }
}

/**
 * Compare the world with the compiled blueprint.
 * @param {ReturnType<typeof compile>} compiled
 * @param {(pos: Vec3) => ({ name: string, boundingBox?: string } | null)} blockAt
 * @returns {{ ok: boolean, checked: number, mismatches: Array<{ pos, expected, actual }> }}
 */
function verify (compiled, blockAt) {
  const mismatches = []
  for (const c of compiled.checks) {
    const b = blockAt(c.pos)
    if (!b || !c.names.includes(b.name)) mismatches.push({ pos: c.pos, expected: c.names, actual: b?.name ?? null })
  }
  for (const pos of compiled.air) {
    const b = blockAt(pos)
    if (!b || b.boundingBox !== 'empty' || /water|lava/.test(b.name)) mismatches.push({ pos, expected: ['air'], actual: b?.name ?? null })
  }
  return { ok: mismatches.length === 0, checked: compiled.checks.length + compiled.air.length, mismatches }
}

/** whether a world position is inside the compiled blueprint's bounds */
function inBounds (compiled, pos, margin = 0) {
  const { min, max } = compiled.bounds
  return pos.x >= min.x - margin && pos.x <= max.x + margin && pos.y >= min.y - margin && pos.y <= max.y + margin && pos.z >= min.z - margin && pos.z <= max.z + margin
}

const PLANKS = ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks', 'poplar_planks']
const WOODEN_DOORS = ['wooden_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door', 'pale_oak_door', 'poplar_door']
const STONE = ['cobblestone', 'cobbled_deepslate']

/** Named blueprints. */
const BLUEPRINTS = {
  /**
   * 5×5 house: cobblestone floor, 3-high cobblestone walls with a door in the middle of the south wall, a flat plank
   * roof, a crafting table and a chest inside (98 blocks + 3 items). Origin = the north-west floor corner; the floor
   * lies on the ground (origin.y = the feet level outside).
   */
  house5x5: {
    name: 'house5x5',
    description: '5×5 cobblestone house with a plank roof, a wooden door, a crafting table and a chest',
    palette: {
      '#': STONE,
      P: PLANKS,
      D: { block: WOODEN_DOORS, phase: 2, tall: true },
      d: { block: WOODEN_DOORS, upper: true },
      T: { block: ['crafting_table'], phase: 2 },
      C: { block: ['chest'], phase: 2 },
      '.': 'air'
    },
    layers: [
      ['#####', '#####', '#####', '#####', '#####'],
      ['#####', '#T.C#', '#...#', '#...#', '##D##'],
      ['#####', '#...#', '#...#', '#...#', '##d##'],
      ['#####', '#...#', '#...#', '#...#', '#####'],
      ['PPPPP', 'PPPPP', 'PPPPP', 'PPPPP', 'PPPPP']
    ]
  }
}

module.exports = { compile, verify, inBounds, BLUEPRINTS, PLANKS, WOODEN_DOORS, STONE }
