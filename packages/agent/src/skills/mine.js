// owner: U17 (agent core & overworld milestones)
'use strict'
const { stubSkill } = require('../skill')

/**
 * Find and mine ores/blocks (branch mining when none are visible) with the right tool tier.
 *
 * args:   { block: string | string[], count: number, maxDistance?: number } (+ `signal`: AbortSignal from the runner)
 * result: { mined: { [block]: number }, collected: { [item]: number } }
 */
module.exports = stubSkill('U17', 'mine')
