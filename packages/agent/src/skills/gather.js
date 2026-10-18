// owner: U17 (agent core & overworld milestones)
'use strict'
const { stubSkill } = require('../skill')

/**
 * Collect surface resources (logs, sand, ...) with mineflayer-collectblock.
 *
 * args:   { item: string, count: number, maxDistance?: number } (+ `signal`: AbortSignal from the runner)
 * result: { collected: { [item]: number } }
 */
module.exports = stubSkill('U17', 'gather')
