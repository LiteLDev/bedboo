// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * What the agent remembers between skills (per bot, in memory): its nether portals on both sides, so the nether
 * skill finds its way home without being told. Skills also return these positions in their results (plain JSON), and
 * accept them back as arguments, so a runner can persist them.
 */
const store = new WeakMap()

function memoryOf (bot) {
  let m = store.get(bot)
  if (!m) {
    m = { portals: [] }
    store.set(bot, m)
  }
  return m
}

/**
 * Remember a portal: `{ dimension, position: {x,y,z} (a portal block), frame?: object }`. A portal of the same
 * dimension within 8 blocks is replaced.
 */
function rememberPortal (bot, portal) {
  const m = memoryOf(bot)
  const p = portal.position
  m.portals = m.portals.filter((q) => q.dimension !== portal.dimension || Math.hypot(q.position.x - p.x, q.position.y - p.y, q.position.z - p.z) > 8)
  m.portals.push({ ...portal, position: { x: p.x, y: p.y, z: p.z }, at: Date.now() })
}

/** the most recently remembered portal in `dimension` (or null) */
function portalIn (bot, dimension) {
  const list = memoryOf(bot).portals.filter((q) => q.dimension === dimension)
  return list.length ? list[list.length - 1] : null
}

module.exports = { memoryOf, rememberPortal, portalIn }
