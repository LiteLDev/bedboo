// owner: U18 (agent combat & dimensions; the safety integration: FINAL-FIX-AGENT-A); library helpers seeded by U16b
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
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const util = require('../dims/util')

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
 * Whether moving with `controls` (forward/back/left/right, the bot's yaw) would take the bot into lava / fire, or off a
 * ledge with no solid ground within 3 blocks below (cliffs, the End's void, lava pits). Checked 0.8 and 1.3 blocks
 * ahead.
 */
function hazardAhead (bot, controls) {
  if (typeof bot.blockAt !== 'function') return false
  const yaw = bot.entity.yaw
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  const rx = Math.cos(yaw)
  const rz = -Math.sin(yaw)
  let dx = 0
  let dz = 0
  if (controls.forward) { dx += fx; dz += fz }
  if (controls.back) { dx -= fx; dz -= fz }
  if (controls.right) { dx += rx; dz += rz }
  if (controls.left) { dx -= rx; dz -= rz }
  const len = Math.hypot(dx, dz)
  if (len < 1e-6) return false
  dx /= len
  dz /= len
  const pos = bot.entity.position
  // lava, fire & co., and portals (a fight next to the End's exit fountain must not end in the overworld)
  const bad = (b) => !!b && (util.isLava(b) || /fire|magma|campfire|sweet_berry|cactus|wither_rose|powder_snow|portal|end_gateway/.test(b.name))
  for (const step of [0.8, 1.3]) {
    const p = new Vec3(pos.x + dx * step, pos.y, pos.z + dz * step).floored()
    if (bad(bot.blockAt(p)) || bad(bot.blockAt(p.offset(0, 1, 0)))) return true
    const below = bot.blockAt(p.offset(0, -1, 0))
    if (below === null) return true
    if (bad(below)) return true
    if (below.boundingBox !== 'empty') continue
    // a drop: some solid ground (or water) within 3 blocks below?
    let ground = false
    for (let d = 2; d <= 4; d++) {
      const b = bot.blockAt(p.offset(0, -d, 0))
      if (!b) break
      if (bad(b)) return true
      if (b.boundingBox !== 'empty' || util.isWater(b)) { ground = true; break }
    }
    if (!ground) return true
  }
  return false
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
 * @param {boolean} [opts.safe=false] never step into lava / fire / portals or off a ledge higher than 3 blocks
 * @param {number} [opts.maxChase=Infinity] end the fight ('escaped') when the target is this far from the fight's start
 * @param {number} [opts.giveUpMs=Infinity] end the fight ('unreachable') after this long without a hit or getting closer
 * @param {boolean} [opts.eat=false] eat while retreating when the target is out of reach
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
    safe = false,
    maxChase = Infinity,
    giveUpMs = Infinity,
    eat = false,
    log = () => {}
  } = opts
  const isCreeper = target.name === 'creeper'
  const strafe = opts.strafe ?? !isCreeper
  const hitAndRun = opts.hitAndRun ?? isCreeper
  const keepDistance = opts.keepDistance ?? (isCreeper ? 2.9 : 0)
  const bowMode = PROJECTILE_IMMUNE.has(target.name) ? false : (opts.bow ?? 'auto')

  const started = Date.now()
  const stats = { outcome: 'timeout', byBot: false, targetDied: false, name: target.name, attacks: 0, shots: 0, hurts: 0, ms: 0, retreats: 0, health: bot.health, hazardStops: 0, eaten: 0 }
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
  let eating = null // the meal in progress (a promise)
  let equipRetryTick = 0

  const anchor = bot.entity.position.clone()
  const setControls = (controls) => {
    // never step into lava / fire / off a ledge higher than 3 blocks (or the void) while fighting
    if (safe && (controls.forward || controls.back || controls.left || controls.right) && hazardAhead(bot, controls)) {
      controls = { sneak: controls.sneak }
      stats.hazardStops++
    }
    for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) {
      const on = !!controls[c]
      if (bot.controlState[c] !== on) bot.setControlState(c, on)
    }
  }
  const aimPoint = () => target.position.offset(0, hitboxSize(target).height * (isCreeper ? 0.5 : 0.6), 0)
  const escaped = () => target.position.distanceTo(anchor) > maxChase
  // unreachable (across lava, up a wall): no hit and no closer for `giveUpMs`
  const progress = { best: Infinity, at: Date.now(), hits: 0 }
  const unreachable = () => {
    const d = hitboxDistance(bot, target)
    if (d < progress.best - 0.5 || stats.hurts > progress.hits) {
      progress.best = Math.min(progress.best, d)
      progress.hits = stats.hurts
      progress.at = Date.now()
    }
    return Date.now() - progress.at > giveUpMs
  }
  const done = () => state.dead || state.gone || state.botDied || !bot.entities[target.id] || signal?.aborted || Date.now() - started > timeout || escaped() || unreachable()

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
    if (!weapon || bot.heldItem === weapon || tick < equipRetryTick) return
    await bot.equip(weapon, 'hand').catch((err) => {
      // e.g. no inventory screen right after a portal: fight with what is in the hand, try again in 2 s
      equipRetryTick = tick + 40
      log(`equip ${weapon.name}: ${err.message}`)
    })
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

      if (eating) {
        // a meal in progress: keep away from the target, leave the hand alone
        const from = pos.minus(target.position)
        const away = pos.plus(from.norm() > 1e-3 ? from.normalize().scaled(4) : new Vec3(4, 0, 0))
        await bot.lookAt(away.offset(0, bot.entity.eyeHeight ?? 1.62, 0), true)
        setControls({ forward: true, jump: bot.entity.isCollidedHorizontally })
        await sleepTicks(bot, 1)
        continue
      }

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
          if (eat && distance > 5 && bot.food < 20 && !eating) {
            // out of reach: eat while running (the meal heals over time with a full food bar)
            setControls({ forward: true, sprint: false })
            eating = util.eatIfNeeded(bot, { minFood: 20, minHealth: 20 })
              .then((food) => { if (food) stats.eaten++ })
              .catch((err) => log(`eat: ${err.message}`))
              .finally(() => { eating = null })
          }
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
      if (bot.heldItem?.name === 'bow' || (!eating && bestWeapon(bot) && bot.heldItem !== bestWeapon(bot))) await equipMelee()

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
    if (eating) await eating
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
  else if (escaped()) stats.outcome = 'escaped'
  else if (Date.now() - progress.at > giveUpMs) stats.outcome = 'unreachable'
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

// ---------------------------------------------------------------------------------------------------------------
// U18 (wave 6): the agent-level combat skill built on the helpers above

/** projectiles a melee hit sends back (ghast fireballs) — Bedrock and Java names */
const DEFLECTABLE = new Set(['fireball', 'large_fireball'])

/**
 * The mob that most likely hurt the bot: the nearest living mob within 5 blocks (melee), else the nearest hostile
 * with a ranged attack within 24 blocks (skeletons, pillagers, ghasts, blazes, …).
 */
const RANGED_MOBS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'ghast', 'blaze', 'witch', 'piglin', 'drowned', 'breeze', 'shulker'])

function likelyAttacker (bot, { exclude, swings } = {}) {
  // fire, lava, a fall: no mob to blame (never provoke a neutral mob for it)
  const feet = bot.blockAt?.(bot.entity.position.floored())
  if (bot.entity.onFire || util.isLava(feet) || /fire/.test(feet?.name ?? '')) return null
  const dead = deadEntities(bot)
  const pos = bot.entity.position
  const mobs = Object.values(bot.entities).filter((e) => e !== bot.entity && e.type !== 'player' && e.type !== 'object' &&
    e.name !== 'item' && e.name !== 'xp_orb' && !dead.has(e) && e.position.distanceTo(pos) <= 24)
  mobs.sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
  // a neutral mob (piglin, zombified piglin, enderman) is only blamed when it swung its arm just before: provoking one
  // by mistake turns its whole group against the bot
  const swung = (e) => !swings || (swings.get(e) ?? 0) > Date.now() - 1500
  const melee = mobs.find((e) => hitboxDistance(bot, e) <= 4 && (isHostile(e) || (NEUTRAL_MOBS.has(e.name) && swung(e)) || (!NEUTRAL_MOBS.has(e.name) && e.kind === 'Hostile mobs')))
  if (melee) return exclude && exclude(melee) ? null : melee
  const ranged = mobs.find((e) => RANGED_MOBS.has(e.name) && (!NEUTRAL_MOBS.has(e.name) || swung(e)))
  // the nearest shooter is one the caller ignores (a ghast without a bow): blame nobody else
  return ranged && !(exclude && exclude(ranged)) ? ranged : null
}

/**
 * Background safety behaviour (meant for a runner while other skills move the bot): fights hostile mobs that come
 * within `radius` (and any mob that hurt the bot: retaliation, neutral mobs included), knocks ghast fireballs back,
 * eats when hungry. While it fights (`busy`), it stops mineflayer-pathfinder and any digging; the interrupted skill
 * waits with `await guard.idle()` and retries.
 *
 *   const guard = combat.defend(bot, { radius: 12 })
 *   …  await guard.idle()  …
 *   const stats = await guard.stop()   // { killed: { zombie: 2 }, fights, retaliations, deflected, eaten, deaths }
 *
 * @param {object} bot
 * @param {object} [opts]
 * @param {number} [opts.radius=12] engage hostiles this close (and at most `maxDy` blocks above / below)
 * @param {number} [opts.maxDy=4]
 * @param {string[]} [opts.names] only these hostile names (retaliation is not restricted)
 * @param {boolean} [opts.includeNeutral=false] engage neutral mobs (endermen, piglins, …) too, not only when they hurt the bot
 * @param {boolean} [opts.retaliate=true]
 * @param {boolean} [opts.eat=true] eat when the food level drops below `minFood` (or hurt and not full)
 * @param {number} [opts.minFood=14]
 * @param {boolean} [opts.deflect=true] hit ghast fireballs coming within 4 blocks
 * @param {(entity) => boolean} [opts.ignore] never engage these
 * @param {number} [opts.interval=200] ms between threat checks
 * @param {number} [opts.fightTimeout=45000]
 * @param {number} [opts.maxChase=24] give up a target that ran this far from where the fight started
 * @param {number} [opts.giveUpMs=12000] give up a target the bot neither hit nor got closer to for this long (it is
 *   then left alone for 30 s)
 * @param {(target) => void} [opts.onEngage] called before a fight (default: stop pathfinder and digging)
 * @param {AbortSignal} [opts.signal] stops the guard
 * @param {object} [opts.fight] extra {@link fight} options (bow, retreatHealth, …)
 * @returns {Guard}
 */
function defend (bot, opts = {}) {
  return new Guard(bot, opts).start()
}

class Guard extends EventEmitter {
  constructor (bot, opts = {}) {
    super()
    this.bot = bot
    this.opts = {
      radius: 12,
      maxDy: 4,
      includeNeutral: false,
      retaliate: true,
      eat: true,
      minFood: 14,
      deflect: true,
      interval: 200,
      fightTimeout: 45000,
      maxChase: 24,
      ...opts
    }
    this.busy = false
    this.paused = false
    this.running = false
    this.stats = { killed: {}, fights: 0, retaliations: 0, deflected: 0, eaten: 0, deaths: 0, escaped: 0, lost: [] }
    this.attackers = new Map() // entity → until (ms)
    this.unreachable = new Map() // entity → until (ms): fights given up, not engaged again for a while
    this._idleWaiters = []
    this._abort = new AbortController()
    this.swings = new WeakMap() // entity → time of its last arm swing (mob melee attacks)
    this._onSwing = (entity) => { if (entity !== bot.entity) this.swings.set(entity, Date.now()) }
    this._onHurt = (entity) => {
      if (entity !== bot.entity || !this.opts.retaliate) return
      const attacker = likelyAttacker(bot, { exclude: this.opts.ignore, swings: this.swings })
      if (attacker) {
        this.unreachable.delete(attacker) // it reached the bot after all
        this.attackers.set(attacker, Date.now() + 20000)
      }
    }
    this._onDeath = () => { this.stats.deaths++ }
    deadEntities(bot)
  }

  start () {
    if (this.running) return this
    this.running = true
    this.bot.on('entityHurt', this._onHurt)
    this.bot.on('entitySwingArm', this._onSwing)
    this.bot.on('death', this._onDeath)
    this.opts.signal?.addEventListener('abort', () => this.stop(), { once: true })
    util.setGuard(this.bot, this)
    this._loop = this._run().catch((err) => {
      // never an unhandled 'error' event: the guard just stops guarding
      util.log(this.bot, `guard stopped: ${err.message}`)
      this.running = false
      this._setBusy(false)
    })
    return this
  }

  /** stop guarding (the current fight is aborted); resolves with the stats */
  async stop () {
    if (!this.running) return this.stats
    this.running = false
    this._abort.abort()
    this.bot.removeListener('entityHurt', this._onHurt)
    this.bot.removeListener('entitySwingArm', this._onSwing)
    this.bot.removeListener('death', this._onDeath)
    if (util.guardOf(this.bot) === this) util.setGuard(this.bot, null)
    await this._loop
    this._setBusy(false)
    return this.stats
  }

  pause () { this.paused = true }
  resume () { this.paused = false }

  /** resolves when the guard is not fighting / eating */
  idle () {
    if (!this.busy) return Promise.resolve()
    return new Promise((resolve) => this._idleWaiters.push(resolve))
  }

  _setBusy (busy) {
    if (this.busy === busy) return
    this.busy = busy
    this.emit(busy ? 'busy' : 'idle')
    if (!busy) {
      const waiters = this._idleWaiters.splice(0)
      for (const w of waiters) w()
    }
  }

  /** the next thing to deal with: a fireball, an attacker, a hostile close by */
  threat () {
    const { bot } = this
    if (!bot.entity || bot.health <= 0) return null
    const pos = bot.entity.position
    const o = this.opts
    if (o.deflect) {
      for (const e of Object.values(bot.entities)) {
        if (!DEFLECTABLE.has(e.name)) continue
        if (hitboxDistance(bot, e) <= 4) return { kind: 'fireball', entity: e }
      }
    }
    const dead = deadEntities(bot)
    const now = Date.now()
    for (const [e, until] of this.unreachable) if (until < now) this.unreachable.delete(e)
    const skip = (e) => this.unreachable.has(e)
    for (const e of [...this.attackers.keys()]) if (skip(e)) this.attackers.delete(e)
    for (const [e, until] of this.attackers) {
      if (until < now || dead.has(e) || !bot.entities[e.id] || e.position.distanceTo(pos) > o.radius + 12) this.attackers.delete(e)
    }
    const attacker = [...this.attackers.keys()].sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0]
    if (attacker) return { kind: 'attacker', entity: attacker }
    const hostile = nearestHostile(bot, {
      radius: o.radius,
      names: o.names,
      includeNeutral: o.includeNeutral,
      exclude: (e) => Math.abs(e.position.y - pos.y) > o.maxDy || skip(e) || (o.ignore && o.ignore(e))
    })
    if (hostile) return { kind: 'hostile', entity: hostile }
    return null
  }

  _interrupt (target) {
    if (this.opts.onEngage) return this.opts.onEngage(target)
    util.stopMoving(this.bot)
    try { if (this.bot.targetDigBlock) this.bot.stopDigging() } catch {}
  }

  async _run () {
    const { bot } = this
    while (this.running) {
      await util.sleep(this.opts.interval).catch(() => {})
      if (!this.running) break
      if (this.paused || !bot.entity || bot.health <= 0 || bot.isAlive === false) continue
      const t = this.threat()
      if (t?.kind === 'fireball') {
        try {
          await bot.lookAt(t.entity.position, true)
          bot.attack(t.entity)
          this.stats.deflected++
          util.log(bot, 'guard: deflected a fireball')
        } catch {}
        continue
      }
      if (t) {
        this._setBusy(true)
        try {
          this._interrupt(t.entity)
          if (t.kind === 'attacker') this.stats.retaliations++
          this.stats.fights++
          util.log(bot, `guard: fighting ${t.entity.name} (${t.kind}) at ${t.entity.position.floored()}, health ${bot.health}`)
          const r = await fight(bot, t.entity, {
            bow: 'auto',
            safe: true,
            ...this.opts.fight,
            timeout: this.opts.fightTimeout,
            maxChase: this.opts.maxChase,
            giveUpMs: this.opts.giveUpMs ?? 12000,
            eat: this.opts.eat,
            signal: this._abort.signal,
            log: (m) => util.log(bot, `guard: ${m}`)
          })
          this.attackers.delete(t.entity)
          if (r.outcome === 'killed') this.stats.killed[r.name] = (this.stats.killed[r.name] ?? 0) + 1
          else if (r.outcome === 'escaped' || r.outcome === 'gone' || r.outcome === 'unreachable') this.stats.escaped++
          else if (r.outcome !== 'aborted') this.stats.lost.push(`${r.name}: ${r.outcome}`)
          if (r.outcome === 'unreachable' || r.outcome === 'escaped') this.unreachable.set(t.entity, Date.now() + 30000)
          util.log(bot, `guard: ${r.name} → ${r.outcome} (${r.attacks} hits, ${r.shots} shots, ${(r.ms / 1000).toFixed(1)} s, health ${bot.health})`)
          this.emit('fight', r)
        } catch (err) {
          util.log(bot, `guard: fight error ${err.message}`)
        } finally {
          try { bot.clearControlStates() } catch {}
          this._setBusy(false)
        }
        continue
      }
      if (this.opts.eat && (bot.food < this.opts.minFood || (bot.health < 14 && bot.food < 20)) && util.findItem(bot, util.FOODS)) {
        this._setBusy(true)
        try {
          this._interrupt(null)
          const food = await util.eatIfNeeded(bot, { minFood: this.opts.minFood })
          if (food) {
            this.stats.eaten++
            util.log(bot, `guard: ate ${food} (food ${bot.food}, health ${bot.health})`)
          }
        } catch (err) {
          util.log(bot, `guard: eat ${err.message}`)
        } finally {
          this._setBusy(false)
        }
      }
    }
  }
}

/**
 * The guard a skill runs under: the running Agent's safety behaviours (src/safety.js, U17) when the skill runs inside
 * an Agent — one background fighter, not two —, else a {@link defend} guard of its own. Both have `busy`, `idle()`,
 * `pause()` / `resume()`, `stop()` and 'busy' / 'idle' events.
 */
function guardFor (bot, opts = {}) {
  const safety = require('../skill').agentOf(bot)?.safety
  if (safety?.enabled) return new SafetyGuard(bot, safety, opts)
  return defend(bot, opts)
}

/**
 * {@link guardFor}'s adapter around the Agent's Safety. The guard options the skill asked for (`radius`, `maxDy`,
 * `ignore`, `includeNeutral`, `retaliate`, `deflect`) are pushed onto the Safety until `stop()` (or the `signal`), so
 * under an Agent the skill keeps what its own {@link defend} guard would do: safe fights, retaliation against neutral
 * attackers, fireball deflection, ghasts ignored without a bow, unreachable mobs dropped, eating.
 */
class SafetyGuard extends EventEmitter {
  constructor (bot, safety, opts = {}) {
    super()
    this.bot = bot
    this.safety = safety
    this.delegated = true
    this.stats = { delegated: 'agent safety' }
    this._paused = null
    this._stopped = false
    this._onBusy = (type) => this.emit('busy', type)
    this._onIdle = () => this.emit('idle')
    safety.on('busy', this._onBusy)
    safety.on('idle', this._onIdle)
    const { signal, onEngage, fight, interval, ...guardOpts } = opts
    this._token = typeof safety.pushGuard === 'function' ? safety.pushGuard(guardOpts) : null
    util.setGuard(bot, this)
    if (signal) {
      if (signal.aborted) this.stop()
      else signal.addEventListener('abort', () => { this.stop() }, { once: true })
    }
  }

  get busy () { return !!this.safety.busy }
  idle () { return this.safety.idle() }
  pause () {
    if (this._paused !== null) return
    this._paused = this.safety.enabled
    this.safety.enabled = false
  }

  resume () {
    if (this._paused === null) return
    this.safety.enabled = this._paused
    this._paused = null
  }

  async stop () {
    this.resume()
    if (!this._stopped) {
      this._stopped = true
      if (this._token) this.safety.popGuard(this._token)
      this.safety.removeListener('busy', this._onBusy)
      this.safety.removeListener('idle', this._onIdle)
    }
    if (util.guardOf(this.bot) === this) util.setGuard(this.bot, null)
    return { delegated: 'agent safety', interventions: this.safety.interventions?.length ?? 0 }
  }
}

/**
 * Run `fn` (an async action that moves / digs), pausing it while the guard fights: when `fn` fails while (or right
 * after) the guard interrupted it, wait for the guard and run `fn` again (at most `retries` times).
 */
async function guarded (guard, fn, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (guard) await guard.idle()
    let interrupted = false
    const onBusy = () => { interrupted = true }
    guard?.on('busy', onBusy)
    try {
      return await fn()
    } catch (err) {
      if (!guard || (!interrupted && !guard.busy) || attempt >= retries) throw err
    } finally {
      guard?.removeListener('busy', onBusy)
    }
  }
}

/**
 * Fight every hostile around (equips first). @returns {Promise<{ killed, outcome, fights }>} see {@link fightAll}
 * @param {object} bot
 * @param {{ radius?: number, names?: string[], includeNeutral?: boolean, timeout?: number, signal?: AbortSignal }} [opts]
 */
async function fightNearby (bot, opts = {}) {
  await equipForCombat(bot)
  const r = await fightAll(bot, { radius: 16, safe: true, eat: true, ...opts, log: (m) => util.log(bot, `fight: ${m}`) })
  return { killed: r.killed, outcome: r.outcome, fights: r.fights.map((f) => ({ name: f.name, outcome: f.outcome, attacks: f.attacks, shots: f.shots, ms: f.ms })) }
}

/**
 * Follow `entity` with mineflayer-pathfinder (GoalFollow, dynamic: its goto never resolves) until the bot is within
 * `range` (+1) of its hitbox, it is gone, or `timeout`. @returns {Promise<boolean>} reached
 */
async function approachEntity (bot, entity, { range = 3, timeout = 30000, signal, goals } = {}) {
  goals = goals ?? util.ensurePathfinder(bot).goals
  const dead = deadEntities(bot)
  bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true)
  const until = Date.now() + timeout
  try {
    while (Date.now() < until) {
      util.throwIfAborted(signal)
      if (!bot.entities[entity.id] || dead.has(entity)) return false
      if (hitboxDistance(bot, entity) <= range + 1) return true
      await util.sleep(150, signal)
    }
    return false
  } finally {
    util.stopMoving(bot)
  }
}

/**
 * Find and kill `count` mobs named `mob` (walking around with mineflayer-pathfinder to find them).
 * @param {object} bot
 * @param {string} mob entity name (e.g. 'enderman', 'zombie')
 * @param {number} [count=1]
 * @param {{ radius?: number, timeout?: number, signal?: AbortSignal, explore?: number, filter?: (entity) => boolean,
 *   guard?: Guard, exploreTo?: (bot, hop: number) => Vec3 }} [opts] `radius` of the search (48), `explore` blocks per
 *   random exploration hop (24), `exploreTo` the next exploration waypoint instead of a random hop
 * @returns {Promise<{ killed: number, fights: object[], ms: number }>}
 */
async function huntFor (bot, mob, count = 1, opts = {}) {
  const { radius = 48, timeout = 600000, signal, explore = 24, filter = () => true } = opts
  const started = Date.now()
  await equipForCombat(bot)
  const { goals } = util.ensurePathfinder(bot)
  const dead = deadEntities(bot)
  const fights = []
  let killed = 0
  let hops = 0
  const failedTargets = new WeakSet()
  while (killed < count) {
    util.throwIfAborted(signal)
    if (Date.now() - started > timeout) throw new Error(`hunt for ${count} ${mob}: only ${killed} killed in ${timeout} ms`)
    if (bot.health <= 0) throw new Error(`the bot died hunting ${mob}`)
    if (opts.guard) await opts.guard.idle()
    const target = bot.nearestEntity((e) => e.name === mob && !dead.has(e) && !failedTargets.has(e) && filter(e) &&
      e.position.distanceTo(bot.entity.position) <= radius)
    if (!target) {
      // explore: a hop in a random direction (or to `exploreTo(bot)`), then look again
      hops++
      const a = Math.random() * Math.PI * 2
      const p = bot.entity.position
      const to = opts.exploreTo?.(bot, hops) ?? new Vec3(p.x + Math.cos(a) * explore, p.y, p.z + Math.sin(a) * explore)
      util.log(bot, `hunt: no ${mob} within ${radius}, exploring towards ${to.floored()} (hop ${hops})`)
      await util.goto(bot, new goals.GoalNearXZ(to.x, to.z, 3), { signal, timeout: 30000, retries: 0 }).catch(() => {})
      await util.sleep(500, signal)
      continue
    }
    // get close with the pathfinder (the fight itself only walks straight at the target)
    if (hitboxDistance(bot, target) > 6) {
      await guarded(opts.guard, () => approachEntity(bot, target, { range: 3, timeout: 45000, signal, goals }))
      if (opts.guard) await opts.guard.idle()
      if (hitboxDistance(bot, target) > 8) {
        failedTargets.add(target)
        continue
      }
    }
    util.log(bot, `hunt: fighting ${mob} at ${target.position.floored()} (health ${bot.health})`)
    // the hunt fights itself: the guard (if any) must not take the controls meanwhile
    opts.guard?.pause()
    let r
    try {
      r = await fight(bot, target, { timeout: 60000, eat: true, safe: true, maxChase: 32, signal, log: (m) => util.log(bot, `hunt: ${m}`) })
    } finally {
      opts.guard?.resume()
    }
    fights.push({ name: r.name, outcome: r.outcome, attacks: r.attacks, shots: r.shots, ms: r.ms, health: r.health })
    util.log(bot, `hunt: ${mob} → ${r.outcome} (${r.attacks} hits, ${(r.ms / 1000).toFixed(1)} s, health ${bot.health})`)
    if (r.outcome === 'died') throw new Error(`the bot died fighting a ${mob}`)
    if (r.outcome === 'killed') killed++
    else failedTargets.add(target)
    await util.eatIfNeeded(bot, { minFood: 16 }).catch(() => {})
  }
  return { killed, fights, ms: Date.now() - started }
}

/**
 * Survive for `durationMs` where the bot stands (night, mobs spawning): {@link defend} does the fighting, and the bot
 * walks back to its post after each fight. @returns {Promise<{ survived: boolean, stats: object, ms: number }>}
 */
async function survive (bot, { durationMs = 180000, radius = 16, signal, post, ...guardOpts } = {}) {
  await equipForCombat(bot)
  const { goals } = util.ensurePathfinder(bot)
  const home = post ? util.vec(post) : bot.entity.position.floored()
  // standing guard is this skill's own job: an Agent's safety behaviours step back meanwhile
  const agentSafety = require('../skill').agentOf(bot)?.safety
  const safetyWas = agentSafety?.enabled
  if (agentSafety) agentSafety.enabled = false
  // the bow for mobs 10+ blocks away, melee (shield when cornered) closer
  const guard = defend(bot, { radius, retaliate: true, ...guardOpts, fight: { bowRange: [10, 40], ...guardOpts.fight } })
  const started = Date.now()
  const state = { died: false }
  const onDeath = () => { state.died = true }
  bot.on('death', onDeath)
  try {
    while (Date.now() - started < durationMs && !state.died) {
      util.throwIfAborted(signal)
      await util.sleep(1000, signal)
      if (!guard.busy && bot.entity.position.distanceTo(home) > 4) {
        await guarded(guard, () => util.goto(bot, new goals.GoalNear(home.x, home.y, home.z, 2), { signal, timeout: 20000, retries: 0 }), { retries: 1 }).catch(() => {})
      }
    }
  } finally {
    bot.removeListener('death', onDeath)
    await guard.stop()
    if (agentSafety) agentSafety.enabled = safetyWas
  }
  return { survived: !state.died, stats: guard.stats, ms: Date.now() - started }
}

/**
 * The combat skill.
 * args: `{ mode?: 'nearby' | 'hunt' | 'survive', radius?, names?, includeNeutral?, mob?, count?, durationMs? }` + `signal`
 *  - nearby (default): fight every hostile within `radius` until none is left;
 *  - hunt: find and kill `count` × `mob`;
 *  - survive: stand guard for `durationMs` (night / mob-spawning scenarios).
 * result: `{ mode, killed, … }` (see fightNearby / huntFor / survive)
 */
async function combatSkill (bot, args) {
  args = args ?? {}
  const mode = args.mode ?? (args.mob ? 'hunt' : args.durationMs ? 'survive' : 'nearby')
  if (mode === 'hunt') {
    if (!args.mob) throw new Error('combat hunt needs args.mob')
    // one fighter at a time: the guard (the Agent's safety under an Agent) is paused while the hunt fights, and the
    // hunt's walks wait for it otherwise
    const own = !args.guard && require('../skill').agentOf(bot)?.safety?.enabled
    const guard = args.guard ?? (own ? guardFor(bot, { radius: 8, retaliate: true, signal: args.signal }) : null)
    try {
      const r = await huntFor(bot, args.mob, args.count ?? 1, { ...args, guard })
      return { mode, killed: { [args.mob]: r.killed }, fights: r.fights, ms: r.ms }
    } finally {
      if (own) await guard.stop()
    }
  }
  if (mode === 'survive') {
    const r = await survive(bot, args)
    if (!r.survived) throw new Error(`the bot died standing guard (${JSON.stringify(r.stats.killed)})`)
    return { mode, survived: r.survived, killed: r.stats.killed, stats: r.stats, ms: r.ms }
  }
  if (mode === 'nearby') {
    // fightAll fights every hostile itself: an Agent's safety must not start a second fight on the same mob
    const agentSafety = require('../skill').agentOf(bot)?.safety
    const safetyWas = agentSafety?.enabled
    if (agentSafety) agentSafety.enabled = false
    try {
      const r = await fightNearby(bot, args)
      if (r.outcome === 'died') throw new Error('the bot died fighting')
      return { mode, ...r }
    } finally {
      if (agentSafety) agentSafety.enabled = safetyWas
    }
  }
  throw new Error(`unknown combat mode ${mode}`)
}

module.exports = Object.assign(combatSkill, {
  // U18 (wave 6) skill API
  defend,
  guardFor,
  Guard,
  SafetyGuard,
  guarded,
  approachEntity,
  fightNearby,
  huntFor,
  survive,
  hazardAhead,
  likelyAttacker,
  // U16b's helpers
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
