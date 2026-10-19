// owner: U18 (agent combat & dimensions); library helpers seeded by U16b (wave 5, mob combat matrix)
'use strict'
/**
 * Combat.
 *
 * The `combat` **skill** (`async (bot, args) → { killed }`) is U18's (wave 6) and is still a stub. U16b seeded this
 * module with a reusable, cheat-free **combat library** that the mob combat matrix
 * (packages/mineflayer-bedrock/test/external/combatMatrix.test.js) uses and the skill is meant to build on. It only
 * uses the public mineflayer API (no `bot._client`), so it runs unchanged on mineflayer (Java) too:
 * `nearestEntity`, `entities`, `lookAt`/`look`, `setControlState`/`clearControlStates`, `attack`,
 * `activateItem`/`deactivateItem` (bow, shield), `equip`, `inventory`, `health`, `waitForTicks` and the
 * `entityHurt` / `entityDead` / `entityGone` / `death` events. It does not depend on mineflayer-pvp (U15 pins and
 * patches that plugin; the agent runner loads it): U18 may build the skill on these helpers, on mineflayer-pvp, or
 * mix them (e.g. pvp for melee, `fight`'s bow aiming for flying mobs).
 *
 *   const combat = require('@bedboo/agent/src/skills/combat')
 *   await combat.equipForCombat(bot)                       // best weapon in hand, armor on, shield in the off-hand
 *   const target = combat.nearestHostile(bot, { radius: 16 })
 *   const r = await combat.fight(bot, target)              // { outcome: 'killed', byBot: true, attacks, shots, … }
 *   const all = await combat.fightAll(bot, { names: ['slime'] })   // until none is left (splits included)
 *
 * What `fight` does every tick: target the entity's body; out of reach → walk/sprint towards it (jump when blocked
 * or when it is above), or shoot it with a bow when it is far / flying out of reach and the bot has a bow and
 * arrows; in reach → attack once the target's 10-tick hurt cooldown is over (Bedrock has no attack cooldown, but a
 * hit during the invulnerability frames is wasted), strafing left/right; creepers are hit from the edge of the reach
 * and the bot backs off after each hit / runs when one is too close; low health → retreat (shield raised when
 * cornered) until it regenerates.
 */
const { stubSkill } = require('../skill')
const { Vec3 } = require('vec3')

/** Bedrock survival attack reach, from the eyes to the target's hitbox (Java: 3 as well) */
const DEFAULT_REACH = 3
/** a mob that was hurt cannot be hurt again for 10 ticks: attacking faster only wastes swings */
const DEFAULT_ATTACK_TICKS = 10
/** full bow draw (Java and Bedrock: 20 ticks) */
const BOW_DRAW_TICKS = 20
/** arrow launch speed at a full draw (blocks/tick), gravity and drag per tick (Java/Bedrock arrows) */
const ARROW = { speed: 3, gravity: 0.05, drag: 0.99 }

/** Hostile mobs by registry name (Java and Bedrock names), on top of minecraft-data's `Hostile mobs` category. */
const HOSTILE_MOBS = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'zombie_villager_v2', 'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'spider', 'cave_spider', 'creeper', 'enderman', 'endermite', 'silverfish', 'slime', 'magma_cube', 'witch',
  'pillager', 'vindicator', 'evoker', 'vex', 'ravager', 'illusioner', 'blaze', 'ghast', 'piglin', 'piglin_brute',
  'hoglin', 'zoglin', 'zombified_piglin', 'zombie_pigman', 'shulker', 'phantom', 'guardian', 'elder_guardian',
  'warden', 'breeze', 'creaking', 'wither', 'ender_dragon'
])
/** Hostile only once provoked: never picked by {@link nearestHostile} unless named */
const NEUTRAL_MOBS = new Set(['enderman', 'zombified_piglin', 'zombie_pigman', 'piglin'])
/** Mobs that fly (or float) out of melee reach: the bow is preferred when they are above the reach */
const FLYING_MOBS = new Set(['ghast', 'phantom', 'blaze', 'vex', 'wither', 'ender_dragon', 'breeze'])
/** Arrows never hurt them (endermen teleport away, breezes deflect them, closed shulkers bounce them): melee only */
const PROJECTILE_IMMUNE = new Set(['enderman', 'breeze', 'shulker'])

const MELEE_WEAPONS = [
  'netherite_sword', 'diamond_sword', 'netherite_axe', 'diamond_axe', 'iron_sword', 'iron_axe', 'stone_sword',
  'golden_sword', 'stone_axe', 'wooden_sword', 'golden_axe', 'wooden_axe'
]
const ARMOR = {
  head: ['netherite_helmet', 'diamond_helmet', 'iron_helmet', 'turtle_helmet', 'chainmail_helmet', 'golden_helmet', 'leather_helmet'],
  torso: ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'chainmail_chestplate', 'golden_chestplate', 'leather_chestplate'],
  legs: ['netherite_leggings', 'diamond_leggings', 'iron_leggings', 'chainmail_leggings', 'golden_leggings', 'leather_leggings'],
  feet: ['netherite_boots', 'diamond_boots', 'iron_boots', 'chainmail_boots', 'golden_boots', 'leather_boots']
}
/** mineflayer equipment slots of the armor destinations (bot.inventory.slots index) */
const ARMOR_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8 }

/**
 * Whether an entity is a hostile mob (players and the bot itself never are).
 * @param {object} entity mineflayer entity
 * @param {{ includeNeutral?: boolean }} [opts]
 */
function isHostile (entity, { includeNeutral = false } = {}) {
  if (!entity || entity.type === 'player') return false
  const name = entity.name
  if (!includeNeutral && NEUTRAL_MOBS.has(name)) return false
  return HOSTILE_MOBS.has(name) || entity.kind === 'Hostile mobs' || entity.type === 'hostile'
}

/**
 * The entity's hitbox size: Bedrock metadata `boundingbox_width/height` when the server sent them (slime and magma
 * cube sizes, babies), else the registry size.
 */
function hitboxSize (entity) {
  const m = entity.metadata
  const width = Number(m?.boundingbox_width) || entity.width || 0.6
  const height = Number(m?.boundingbox_height) || entity.height || 1.8
  return { width, height }
}

/** Distance from the bot's eyes to the closest point of the entity's hitbox. */
function hitboxDistance (bot, entity) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const { width, height } = hitboxSize(entity)
  const half = width / 2
  const p = entity.position
  const cx = Math.max(p.x - half, Math.min(eye.x, p.x + half))
  const cy = Math.max(p.y, Math.min(eye.y, p.y + height))
  const cz = Math.max(p.z - half, Math.min(eye.z, p.z + half))
  return eye.distanceTo(new Vec3(cx, cy, cz))
}

/**
 * Bow pitch (radians, mineflayer convention: positive = up) that lands an arrow `dy` blocks above the eyes at a
 * horizontal distance `d`, simulating the arrow tick by tick (gravity then drag). Returns `{ pitch, ticks }` (flight
 * time to the target), or null when the target is out of the bow's range.
 */
function bowAim (d, dy, arrow = ARROW) {
  const heightAt = (pitch) => {
    let x = 0
    let y = 0
    let vx = Math.cos(pitch) * arrow.speed
    let vy = Math.sin(pitch) * arrow.speed
    for (let t = 1; t <= 200; t++) {
      x += vx
      y += vy
      vx *= arrow.drag
      vy = vy * arrow.drag - arrow.gravity
      if (x >= d) return { y: y - vy * (x - d) / Math.max(vx, 1e-6), ticks: t }
      if (vx < 1e-3) break
    }
    return null
  }
  // the height reached at distance d grows with the pitch up to the maximum range angle (~45°): bisect below it
  let lo = -Math.PI / 2 + 0.01
  let hi = Math.PI / 4
  const top = heightAt(hi)
  if (!top || top.y < dy) return null
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    const h = heightAt(mid)
    if (h && h.y >= dy) hi = mid
    else lo = mid
  }
  return { pitch: hi, ticks: heightAt(hi)?.ticks ?? 0 }
}

/**
 * Nearest hostile mob around the bot.
 * @param {object} bot
 * @param {{ radius?: number, names?: string[], includeNeutral?: boolean, exclude?: (entity) => boolean }} [opts]
 *   `names`: only these mob names (neutral ones included); `exclude`: skip an entity (e.g. dying ones)
 */
function nearestHostile (bot, { radius = 16, names, includeNeutral = false, exclude } = {}) {
  const dead = deadEntities(bot)
  return bot.nearestEntity((e) => {
    if (e === bot.entity || dead.has(e)) return false
    if (names ? !names.includes(e.name) : !isHostile(e, { includeNeutral })) return false
    if (exclude && exclude(e)) return false
    return e.position.distanceTo(bot.entity.position) <= radius
  }) ?? null
}

const deadSets = new WeakMap()
/** Entities this bot saw die (they stay in bot.entities during the death animation). */
function deadEntities (bot) {
  let set = deadSets.get(bot)
  if (!set) {
    set = new WeakSet()
    deadSets.set(bot, set)
    bot.on('entityDead', (e) => set.add(e))
  }
  return set
}

function findItem (bot, names) {
  const items = bot.inventory.items()
  for (const name of names) {
    const item = items.find((i) => i.name === name)
    if (item) return item
  }
  return null
}

/** The best melee weapon in the inventory (or held), or null. */
function bestWeapon (bot) {
  const held = bot.heldItem
  const rank = (item) => item ? MELEE_WEAPONS.indexOf(item.name) : -1
  const best = findItem(bot, MELEE_WEAPONS)
  if (rank(held) >= 0 && (!best || rank(held) <= rank(best))) return held
  return best
}

function hasBowAndArrows (bot) {
  const items = bot.inventory.items()
  return items.some((i) => i.name === 'bow') && items.some((i) => i.name === 'arrow' || i.name === 'tipped_arrow' || i.name === 'spectral_arrow')
}

/**
 * Equip for a fight: best melee weapon in the hand, the best armor piece of each slot, a shield in the off-hand.
 * Already-equipped pieces are left alone. @returns {Promise<{ weapon: string|null, armor: string[], shield: boolean }>}
 */
async function equipForCombat (bot, { armor = true, shield = true } = {}) {
  deadEntities(bot) // start tracking deaths before the fight
  const out = { weapon: null, armor: [], shield: false }
  if (armor) {
    for (const [dest, names] of Object.entries(ARMOR)) {
      const worn = bot.inventory.slots[ARMOR_SLOTS[dest]]
      const wornRank = worn ? names.indexOf(worn.name) : -1
      const piece = findItem(bot, names)
      // the lists are best first: keep what is worn unless the inventory has something better
      if (piece && (wornRank < 0 || names.indexOf(piece.name) < wornRank)) {
        await bot.equip(piece, dest)
        out.armor.push(piece.name)
      } else if (wornRank >= 0) {
        out.armor.push(worn.name)
      }
    }
  }
  if (shield) {
    const offHand = bot.inventory.slots[45]
    if (offHand?.name === 'shield') out.shield = true
    else {
      const item = findItem(bot, ['shield'])
      if (item) {
        await bot.equip(item, 'off-hand')
        out.shield = true
      }
    }
  }
  const weapon = bestWeapon(bot)
  if (weapon && bot.heldItem !== weapon) await bot.equip(weapon, 'hand')
  out.weapon = weapon?.name ?? null
  return out
}

/**
 * Wait `ticks` physics ticks. mineflayer-bedrock emits no physicsTick while the bot is dead or its column is not
 * loaded (waitForTicks then rejects after 5 s): fall back to wall-clock ticks so the caller's checks keep running.
 */
function sleepTicks (bot, ticks) {
  const n = Math.max(1, Math.round(ticks))
  let timer
  const fallback = new Promise((resolve) => { timer = setTimeout(resolve, n * 50 + 1000) })
  return Promise.race([bot.waitForTicks(n), fallback]).catch(() => {}).finally(() => clearTimeout(timer))
}

/**
 * Fight one entity until it dies, disappears, the bot dies, the timeout passes or `signal` aborts.
 *
 * @param {object} bot
 * @param {object} target mineflayer entity
 * @param {object} [opts]
 * @param {number} [opts.reach=3] melee reach (eyes → hitbox)
 * @param {number} [opts.attackTicks=10] ticks between two attacks (the target's hurt cooldown)
 * @param {boolean} [opts.strafe=true] strafe left/right while in reach (not against creepers)
 * @param {boolean|'auto'} [opts.bow='auto'] shoot with a bow (when the bot has one and arrows): `'auto'` when the
 *   target is farther than `bowRange[0]` or flies out of reach; `true` whenever it is out of melee reach
 * @param {[number, number]} [opts.bowRange=[7, 40]] distances (blocks) where 'auto' shoots
 * @param {number} [opts.retreatHealth=6] retreat when the bot's health is at or below this…
 * @param {number} [opts.resumeHealth=12] …until it regenerated to this (or `retreatTicks` passed)
 * @param {number} [opts.retreatTicks=100] longest retreat
 * @param {boolean} [opts.hitAndRun] back off after each hit (default: for creepers)
 * @param {number} [opts.keepDistance] never get closer than this (feet to feet; default: 2.9 for creepers)
 * @param {number} [opts.timeout=60000] ms
 * @param {AbortSignal} [opts.signal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ outcome: 'killed'|'gone'|'died'|'timeout'|'aborted', byBot: boolean, targetDied: boolean, name: string,
 *   attacks: number, shots: number, hurts: number, ms: number, retreats: number, health: number }>}
 *   `byBot`: the target died within 1.5 s of one of the bot's hits (3 s of an arrow) after a hurt; `outcome` is
 *   'died' whenever the bot died, even if the target died too (`targetDied`)
 */
async function fight (bot, target, opts = {}) {
  const {
    reach = DEFAULT_REACH,
    attackTicks = DEFAULT_ATTACK_TICKS,
    bowRange = [7, 40],
    retreatHealth = 6,
    resumeHealth = 12,
    retreatTicks = 100,
    timeout = 60000,
    signal,
    log = () => {}
  } = opts
  const isCreeper = target.name === 'creeper'
  const strafe = opts.strafe ?? !isCreeper
  const hitAndRun = opts.hitAndRun ?? isCreeper
  const keepDistance = opts.keepDistance ?? (isCreeper ? 2.9 : 0)
  const bowMode = PROJECTILE_IMMUNE.has(target.name) ? false : (opts.bow ?? 'auto')

  const started = Date.now()
  const stats = { outcome: 'timeout', byBot: false, targetDied: false, name: target.name, attacks: 0, shots: 0, hurts: 0, ms: 0, retreats: 0, health: bot.health }
  const state = { dead: false, gone: false, botDied: false, lastHitAt: 0, lastShotAt: 0, lastHurtAt: 0 }
  const dead = deadEntities(bot)
  if (dead.has(target)) state.dead = true
  const onHurt = (e) => {
    if (e !== target) return
    stats.hurts++
    state.lastHurtAt = Date.now()
  }
  const onDead = (e) => {
    if (e !== target) return
    state.dead = true
    const now = Date.now()
    stats.byBot = stats.hurts > 0 && (now - state.lastHitAt < 1500 || now - state.lastShotAt < 3000)
  }
  const onGone = (e) => { if (e === target) state.gone = true }
  const onDeath = () => { state.botDied = true }
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)
  bot.on('death', onDeath)

  let tick = 0
  let nextAttackTick = 0
  let strafeDir = 'left'
  let strafeSwitchTick = 20
  let backOffUntil = -1
  let retreatUntil = -1
  let retreatAgainAt = 0 // after a retreat that ran out (still low), fight a while before retreating again
  let bowUsable = true
  let stuckTicks = 0
  let lastPos = bot.entity.position.clone()
  let usingBow = false

  const setControls = (controls) => {
    for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) {
      const on = !!controls[c]
      if (bot.controlState[c] !== on) bot.setControlState(c, on)
    }
  }
  const aimPoint = () => target.position.offset(0, hitboxSize(target).height * (isCreeper ? 0.5 : 0.6), 0)
  const done = () => state.dead || state.gone || state.botDied || !bot.entities[target.id] || signal?.aborted || Date.now() - started > timeout

  /** attack once the target's hurt cooldown is over */
  function tryAttack () {
    if (dist() > reach || tick < nextAttackTick) return false
    bot.attack(target)
    stats.attacks++
    state.lastHitAt = Date.now()
    nextAttackTick = tick + attackTicks
    return true
  }
  const dist = () => hitboxDistance(bot, target)

  async function equipMelee () {
    const weapon = bestWeapon(bot)
    if (weapon && bot.heldItem !== weapon) await bot.equip(weapon, 'hand').catch((err) => log(`equip ${weapon.name}: ${err.message}`))
  }

  /** draw, aim every tick (leading the target), release; switches back to melee when the target closes in */
  async function shoot () {
    const bow = findItem(bot, ['bow'])
    if (!bow) return
    setControls({})
    if (bot.heldItem?.name !== 'bow') await bot.equip(bow, 'hand')
    usingBow = true
    bot.activateItem()
    let drawn = 0
    let lastVel = null
    let lastTargetPos = target.position.clone()
    for (; drawn < BOW_DRAW_TICKS + 2 && !done(); drawn++) {
      // target velocity per tick from its position updates (entity.velocity is not always sent)
      const vel = target.position.minus(lastTargetPos)
      lastTargetPos = target.position.clone()
      lastVel = lastVel ? lastVel.scaled(0.6).plus(vel.scaled(0.4)) : vel
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
      let aim = aimPoint()
      let solution = bowAim(eye.xzDistanceTo(aim), aim.y - eye.y)
      if (solution) {
        aim = aim.plus(lastVel.scaled(solution.ticks))
        solution = bowAim(eye.xzDistanceTo(aim), aim.y - eye.y) ?? solution
      }
      const delta = aim.minus(eye)
      const yaw = Math.atan2(-delta.x, -delta.z)
      const pitch = solution ? solution.pitch : Math.atan2(delta.y, Math.hypot(delta.x, delta.z))
      await bot.look(yaw, pitch, true)
      if (dist() < reach - 0.5 && drawn < BOW_DRAW_TICKS) break // too close: melee instead
      await sleepTicks(bot, 1)
      tick++
    }
    bot.deactivateItem()
    usingBow = false
    if (drawn >= 5) {
      stats.shots++
      state.lastShotAt = Date.now()
    }
    await sleepTicks(bot, 2)
    tick += 2
  }

  try {
    if (!state.dead) await equipMelee()
    while (!done()) {
      tick++
      const pos = bot.entity.position
      const distance = dist()
      const flat = pos.xzDistanceTo(target.position)
      const above = target.position.y - pos.y
      stats.health = bot.health

      // retreat when low
      if (bot.health <= retreatHealth && retreatUntil < tick && tick >= retreatAgainAt) {
        retreatUntil = tick + retreatTicks
        retreatAgainAt = retreatUntil + 60 // only matters if the retreat runs out (health recovered → reset below)
        stats.retreats++
        log(`retreating at ${bot.health} hp`)
      }
      if (retreatUntil >= tick) {
        if (bot.health >= resumeHealth) {
          retreatUntil = -1
          retreatAgainAt = 0
        } else {
          const from = pos.minus(target.position)
          const away = pos.plus(from.norm() > 1e-3 ? from.normalize().scaled(4) : new Vec3(4, 0, 0))
          await bot.lookAt(away.offset(0, bot.entity.eyeHeight ?? 1.62, 0), true)
          const cornered = bot.entity.isCollidedHorizontally
          const offHandShield = bot.inventory.slots[45]?.name === 'shield'
          if (cornered && offHandShield && distance < 4) {
            // nowhere to run: face the target behind the shield
            await bot.lookAt(aimPoint(), true)
            setControls({ sneak: true })
          } else {
            setControls({ forward: true, sprint: !cornered, jump: cornered })
          }
          await sleepTicks(bot, 1)
          continue
        }
      }

      const flying = FLYING_MOBS.has(target.name)
      const outOfReachAbove = above > reach + 0.5
      const wantBow = bowMode !== false && bowUsable && hasBowAndArrows(bot) && distance > reach &&
        (bowMode === true || (distance >= bowRange[0] && distance <= bowRange[1]) || (flying && outOfReachAbove && flat < bowRange[1]))
      if (wantBow) {
        try {
          await shoot()
        } catch (err) {
          // e.g. equipping the bow failed: melee for the rest of this fight
          log(`bow: ${err.message}`)
          bowUsable = false
          if (usingBow) bot.deactivateItem()
          usingBow = false
        }
        continue
      }
      if (bot.heldItem?.name === 'bow') await equipMelee()

      await bot.lookAt(aimPoint(), true)
      const moved = pos.xzDistanceTo(lastPos)
      lastPos = pos.clone()

      // creepers: run from a fusing / too close creeper, hit it from the edge of the reach
      if (backOffUntil >= tick || (keepDistance && flat < keepDistance)) {
        setControls({ back: true, jump: bot.entity.isCollidedHorizontally })
        tryAttack()
        await sleepTicks(bot, 1)
        continue
      }

      if (distance > reach - 0.2) {
        // approach (sprint when far, jump when blocked or when the target is above)
        stuckTicks = moved < 0.02 ? stuckTicks + 1 : 0
        const blocked = bot.entity.isCollidedHorizontally || stuckTicks > 6
        setControls({ forward: true, sprint: distance > 4 && !hitAndRun, jump: blocked || (above > 1 && flat < 2.5) })
      } else if (strafe) {
        if (tick >= strafeSwitchTick) {
          strafeDir = strafeDir === 'left' ? 'right' : 'left'
          strafeSwitchTick = tick + 15 + Math.floor(Math.random() * 15)
        }
        setControls({ [strafeDir]: true, jump: above > 1.2 && flat < 2 })
      } else {
        setControls({ jump: above > 1.2 && flat < 2 })
      }

      if (tryAttack() && hitAndRun) backOffUntil = tick + 8
      await sleepTicks(bot, 1)
    }
  } finally {
    if (usingBow) bot.deactivateItem()
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('entityDead', onDead)
    bot.removeListener('entityGone', onGone)
    bot.removeListener('death', onDeath)
    try { bot.clearControlStates() } catch {}
  }
  stats.ms = Date.now() - started
  stats.health = bot.health
  stats.targetDied = state.dead
  if (state.botDied) stats.outcome = 'died'
  else if (state.dead) stats.outcome = 'killed'
  else if (state.gone || !bot.entities[target.id]) stats.outcome = 'gone'
  else if (signal?.aborted) stats.outcome = 'aborted'
  return stats
}

/**
 * Fight every matching hostile around until none is left for `settleMs` (slime / magma cube splits included).
 * @param {object} bot
 * @param {object} [opts] {@link fight} options plus `names`, `radius` (16), `includeNeutral`, `settleMs` (1500),
 *   `timeout` for everything (120000), `fightTimeout` per target (60000)
 * @returns {Promise<{ killed: Record<string, number>, fights: object[], outcome: 'cleared'|'died'|'timeout'|'aborted' }>}
 */
async function fightAll (bot, opts = {}) {
  const { names, radius = 16, includeNeutral = false, settleMs = 1500, timeout = 120000, fightTimeout = 60000, signal } = opts
  const started = Date.now()
  deadEntities(bot)
  const result = { killed: {}, fights: [], outcome: 'cleared' }
  let quietSince = null
  while (true) {
    if (signal?.aborted) { result.outcome = 'aborted'; break }
    if (Date.now() - started > timeout) { result.outcome = 'timeout'; break }
    const target = nearestHostile(bot, { radius, names, includeNeutral })
    if (!target) {
      quietSince ??= Date.now()
      if (Date.now() - quietSince >= settleMs) break
      await sleepTicks(bot, 2)
      continue
    }
    quietSince = null
    const r = await fight(bot, target, { ...opts, timeout: Math.min(fightTimeout, timeout - (Date.now() - started)) })
    result.fights.push(r)
    if (r.outcome === 'killed') result.killed[r.name] = (result.killed[r.name] ?? 0) + 1
    if (r.outcome === 'died') { result.outcome = 'died'; break }
  }
  return result
}

// The skill itself is U18's (wave 6); these helpers are its building blocks.
const skill = stubSkill('U18', 'combat')
module.exports = Object.assign(skill, {
  fight,
  fightAll,
  nearestHostile,
  equipForCombat,
  isHostile,
  hitboxDistance,
  hitboxSize,
  bowAim,
  bestWeapon,
  hasBowAndArrows,
  deadEntities,
  HOSTILE_MOBS,
  NEUTRAL_MOBS,
  FLYING_MOBS,
  PROJECTILE_IMMUNE,
  ARROW
})
