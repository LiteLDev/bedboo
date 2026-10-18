// owner: U17 (agent core & overworld milestones)
'use strict'
const { stubSkill } = require('../skill')

/**
 * Smelt items in a furnace (placing one if needed) via bot.openFurnace.
 *
 * args:   { input: string, count: number, fuel?: string } (+ `signal`: AbortSignal from the runner)
 * result: { smelted: { [item]: number } }
 */
module.exports = stubSkill('U17', 'smelt')
