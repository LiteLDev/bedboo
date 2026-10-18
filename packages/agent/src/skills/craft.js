// owner: U17 (agent core & overworld milestones)
'use strict'
const { stubSkill } = require('../skill')

/**
 * Craft an item (placing/using a crafting table when needed) via bot.recipesFor/bot.craft.
 *
 * args:   { item: string, count?: number } (+ `signal`: AbortSignal from the runner)
 * result: { crafted: { [item]: number } }
 */
module.exports = stubSkill('U17', 'craft')
