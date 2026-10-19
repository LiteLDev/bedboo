// owner: FINAL-FIX-AGENT-A (agent core robustness)
'use strict'
/**
 * Down to a level where the bot stands: a safe vertical shaft (src/dig.js `shaftTo`: a column with no liquid in or
 * around it, never into a cave deeper than 3, a staircase step aside where the cell below is unsafe) — how a player
 * goes down to the diamond level before looking for diamonds.
 *
 * Skill `descend` — args: { y, timeout? }   result: { from, to, ms }
 */
const { Vec3 } = require('vec3')
const { SkillError } = require('../errors')
const { defineSkill, log } = require('../skill')

async function descend (bot, { y, signal } = {}) {
  if (typeof y !== 'number') throw new SkillError('descend needs args.y', { code: 'FAILED' })
  const started = Date.now()
  const from = Math.floor(bot.entity.position.y)
  if (from <= y) return { from, to: from, ms: 0 }
  const feet = bot.entity.position.floored()
  log(bot, `descend: from y ${from} to y ${y}`)
  const dig = require('../dig')
  // a column next to the bot that is dry all the way down; none (a cave, an aquifer on the way): straight down from
  // here, stepping aside around what is unsafe
  await dig.shaftTo(bot, new Vec3(feet.x, y, feet.z), { signal }).catch((err) => {
    if (signal?.aborted || err.code === 'ABORTED') throw err
    log(bot, `descend: ${err.message}`)
  })
  if (Math.floor(bot.entity.position.y) > y + 4) await dig.digDown(bot, y, { signal })
  const to = Math.floor(bot.entity.position.y)
  if (to > y + 4) throw new SkillError(`descend: stopped at y ${to} (wanted ${y})`, { code: 'UNSAFE' })
  return { from, to, ms: Date.now() - started }
}

module.exports = defineSkill('descend', (bot, args) => descend(bot, args), { description: 'go down a safe shaft to a level (the diamond level)' })
module.exports.descend = descend
