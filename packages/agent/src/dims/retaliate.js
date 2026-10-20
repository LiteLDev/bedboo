// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * Retaliation next to U17's Agent. Under an Agent, combat.guardFor() hands the U18 skills the Agent's safety
 * behaviours as their guard (one background fighter). Those fight HOSTILE mobs; a NEUTRAL mob that attacks — an
 * enderman the bot looked at, a zombified piglin hit by mistake, a piglin angered by mined gold — is not one of them and
 * kills the bot unopposed (measured, E1A in seed 1234: slain by an enderman during the walk to the exit portal, four
 * hits in 4.5 s, no fight). combat.defend's own guard retaliates by itself; next to the Agent's safety this does: when
 * the bot is hurt and the safety did not take it on, the neutral mob that swung at it (or, Bedrock endermen sending no
 * swing, the neutral mob within reach) is fought THROUGH the safety (`safety.run('fight', …)`): still one fighter,
 * recorded in its interventions, the skill waits for it like for any fight.
 *
 *   const stop = retaliate(bot, guard)   // a no-op for combat.defend's guard / no Agent
 *   …
 *   stop()
 */
const u = require('./util')

/**
 * @param {object} bot
 * @param {object} guard combat.guardFor()'s result
 * @param {{ reach?: number, exclude?: (e) => boolean }} [opts] `reach`: blame a neutral mob this close (hitbox
 *   distance) when no swing was seen; `exclude`: mobs never blamed (piglins next to a bot in gold armor: one swinging
 *   at a hoglin beside the bot, or standing there when a fireball hits it, did not hurt it — and hitting one angers
 *   the group)
 * @returns {() => void} stop
 */
function retaliate (bot, guard, { reach = 3.5, exclude } = {}) {
  const safety = guard?.safety
  if (!guard?.delegated || !safety || typeof safety.run !== 'function' || typeof safety.fight !== 'function') return () => {}
  const combat = require('../skills/combat')
  const swings = new WeakMap()
  let stopped = false
  const onSwing = (e) => { if (e && e !== bot.entity) swings.set(e, Date.now()) }
  // falls: where the bot left the ground, and when it last landed from more than 3 blocks up (fall damage, no mob)
  const fall = { fromY: null, landedAt: 0 }
  const onMove = () => {
    const e = bot.entity
    if (!e) return
    if (!e.onGround) {
      if (fall.fromY === null || e.position.y > fall.fromY) fall.fromY = e.position.y
    } else if (fall.fromY !== null) {
      if (fall.fromY - e.position.y > 3) fall.landedAt = Date.now()
      fall.fromY = null
    }
  }
  const onHurt = (e) => {
    if (stopped || e !== bot.entity || bot.health <= 0) return
    // the safety's own hurt check (hostiles) goes first: it runs on the same event
    setImmediate(() => {
      if (stopped || safety.busy || !safety.enabled || !bot.entity || bot.health <= 0) return
      let attacker = combat.likelyAttacker(bot, { swings, exclude })
      if (attacker && !combat.NEUTRAL_MOBS.has(attacker.name)) return // a hostile: the safety's business
      if (!attacker && Date.now() - fall.landedAt > 1000) attacker = neutralInReach(bot, combat, reach, exclude)
      if (!attacker) return
      u.log(bot, `retaliating against ${attacker.name} at ${attacker.position.floored()} (health ${bot.health})`)
      safety.run('fight', () => safety.fight(attacker), attacker)
    })
  }
  bot.on('entitySwingArm', onSwing)
  bot.on('entityHurt', onHurt)
  bot.on('move', onMove)
  return () => {
    stopped = true
    bot.removeListener('entitySwingArm', onSwing)
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('move', onMove)
  }
}

/**
 * The nearest neutral mob within `reach` — not when something else explains the damage (no mob to blame): fire, lava,
 * starving, drowning, a block in the head, a cactus / berry bush at the feet (falls: the caller).
 */
function neutralInReach (bot, combat, reach, exclude) {
  const feet = bot.blockAt?.(bot.entity.position.floored())
  const head = bot.blockAt?.(bot.entity.position.offset(0, 1.62, 0).floored())
  if (bot.entity.onFire || u.isLava(feet) || /fire|cactus|sweet_berry/.test(feet?.name ?? '')) return null
  if (bot.food === 0 || (bot.oxygenLevel ?? 20) <= 0) return null
  if (head && head.boundingBox === 'block' && !u.isWater(head)) return null
  const dead = combat.deadEntities(bot)
  return Object.values(bot.entities)
    .filter((e) => e !== bot.entity && combat.NEUTRAL_MOBS.has(e.name) && !dead.has(e) && combat.hitboxDistance(bot, e) <= reach && !(exclude && exclude(e)))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null
}

module.exports = { retaliate, neutralInReach }
