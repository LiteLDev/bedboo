// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * Waiting out the night, U18's minimal version (U17's survive.shelter is used instead when it exists): an unarmored
 * bot that bucket-casts obsidian next to a lava pool at night is shot, blown up or pushed into the lava (N1M3 from
 * U17's M3 snapshot starts ≈ 200 s before nightfall: 0/2 runs survived it). Like a player it stays out of the mobs'
 * reach until the morning:
 *
 * - underground (a mine, a tunnel): it walls in the 1×2 cell it stands in (every open side at the feet and the head,
 *   and the cell above the head) with its scaffolding blocks;
 * - under the open sky: it digs down two blocks (never next to lava or water) and closes the hole above its head;
 * - then waits until the day (bot.time: no night within `needMs`) or `maxMs`, eating (the guard / auto-eat) — and is
 *   left where it is: the caller climbs out (U17's survive.surface / the pathfinder digs).
 */
const { Vec3 } = require('vec3')
const u = require('./util')

const DIRS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const UP = new Vec3(0, 1, 0)

/**
 * ticks to nightfall (12800), 0 from then to sunrise (24000 ≡ 0: the dawn's mobs are still out, skeletons in the shade
 * do not burn at all — N1M5 #1 left its shelter at 23220 and was shot), Infinity without a daylight cycle / time
 */
function ticksToNight (bot) {
  const t = bot.time?.timeOfDay
  if (t === null || t === undefined || bot.time?.doDaylightCycle === false) return Infinity
  if (t >= 12800) return 0
  return 12800 - t
}

/** armor pieces the bot wears */
function armorWorn (bot) {
  return [5, 6, 7, 8].filter((slot) => /_(helmet|chestplate|leggings|boots)$/.test(bot.inventory?.slots?.[slot]?.name ?? '')).length
}

/** whether the next `ms` of work outside would run into the night for an unarmored bot */
function nightAhead (bot, ms) {
  return armorWorn(bot) < 2 && ticksToNight(bot) * 50 < ms
}

/** place a scaffolding block into the empty cell `p` against any solid neighbour */
async function fill (bot, p, { signal } = {}) {
  const here = bot.blockAt(p)
  if (!here || u.isSolid(here)) return true
  if (!u.isClear(here) && !u.isWater(here)) return false
  const faces = [new Vec3(0, -1, 0), UP.scaled(1), ...DIRS]
  for (const f of faces) {
    const ref = bot.blockAt(p.plus(f))
    if (!u.isSolid(ref)) continue
    try {
      await u.equipItem(bot, u.SCAFFOLD_BLOCKS)
      await bot.placeBlock(ref, f.scaled(-1))
      await u.waitForBlock(bot, p, (b) => u.isSolid(b), { timeout: 2000, signal })
      return true
    } catch (err) {
      if (signal?.aborted) throw err
    }
  }
  return false
}

/** wall in the 1×2 cell of the bot's feet; @returns {Promise<number>} cells still open */
async function seal (bot, { signal } = {}) {
  const feet = bot.entity.position.floored()
  let open = 0
  // the walls at the feet first (they are what the head-level walls stand on), then the head, then the roof
  const cells = [...DIRS.map((d) => feet.plus(d)), ...DIRS.map((d) => feet.plus(d).offset(0, 1, 0)), feet.offset(0, 2, 0)]
  for (const c of cells) {
    u.throwIfAborted(signal)
    // the roof over an open column: a wall block one up first, then the roof against it
    if (c.equals(feet.offset(0, 2, 0)) && !u.isSolid(bot.blockAt(c)) && !DIRS.some((d) => u.isSolid(bot.blockAt(c.plus(d))))) {
      await fill(bot, c.plus(DIRS[0]), { signal })
    }
    if (!await fill(bot, c, { signal })) open++
  }
  return open
}

/** dig two blocks down where the bot stands (none next to lava / water / a drop), into the pit */
async function digPit (bot, { signal } = {}) {
  const feet = bot.entity.position.floored()
  for (const dy of [1, 2]) {
    const p = feet.offset(0, -dy, 0)
    const b = bot.blockAt(p)
    if (!b || !u.isSolid(b) || /obsidian|bedrock|chest|furnace|crafting_table|portal/.test(b.name)) return false
    if (u.nearLava(bot, p, 1)) return false
    for (const d of [...DIRS, new Vec3(0, -1, 0)]) if (u.isWater(bot.blockAt(p.plus(d)))) return false
  }
  if (!u.isSolid(bot.blockAt(feet.offset(0, -3, 0)))) return false
  for (const dy of [1, 2]) {
    const p = feet.offset(0, -dy, 0)
    await u.digBlock(bot, bot.blockAt(p), { signal })
    await u.waitForBlock(bot, p, (b) => b.boundingBox === 'empty', { timeout: 3000, signal })
    await u.waitFor(() => bot.entity.position.y < p.y + 0.6 && bot.entity.onGround, { timeout: 3000, interval: 50, signal }).catch(() => {})
  }
  return true
}

/**
 * Stay out of the mobs' reach until the day: U17's survive.shelter when it exists, else a sealed pocket / pit.
 * @returns {Promise<{ waited: number, how: string }>}
 */
async function untilDay (bot, { signal, guard, maxMs = 10 * 60 * 1000, needMs = 0, why = 'night' } = {}) {
  const t = Date.now()
  let survive = null
  try { survive = require('../skills/survive') } catch {}
  if (typeof survive?.shelter === 'function') {
    await survive.shelter(bot, { signal, timeout: maxMs })
    return { waited: Date.now() - t, how: 'survive.shelter' }
  }
  u.stopMoving(bot)
  if (!u.findItem(bot, u.SCAFFOLD_BLOCKS)) {
    u.log(bot, `shelter: no blocks to wall in with (${why}): going on`)
    return { waited: 0, how: 'none' }
  }
  let how = 'pocket'
  const sky = (() => {
    const f = bot.entity.position.floored()
    for (let y = f.y + 2; y < f.y + 24; y++) if (u.isSolid(bot.blockAt(new Vec3(f.x, y, f.z)))) return false
    return true
  })()
  if (sky) {
    how = await digPit(bot, { signal }) ? 'pit' : 'walls'
  }
  const open = await seal(bot, { signal })
  u.log(bot, `shelter (${why}): ${how} at ${bot.entity.position.floored()}${open ? `, ${open} side(s) left open` : ''}; waiting for the day (time ${bot.time?.timeOfDay})`)
  // through the night, and through the evening before it when the work ahead (`needMs`) would not fit
  while (ticksToNight(bot) * 50 <= needMs && Date.now() - t < maxMs) {
    if (guard) await guard.idle()
    await u.sleep(2000, signal)
  }
  u.log(bot, `shelter: out after ${Math.round((Date.now() - t) / 1000)} s (time ${bot.time?.timeOfDay})`)
  return { waited: Date.now() - t, how }
}

module.exports = { ticksToNight, armorWorn, nightAhead, untilDay, seal, digPit }
