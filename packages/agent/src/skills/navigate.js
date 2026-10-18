// owner: U17 (agent core & overworld milestones)
'use strict'
const { stubSkill } = require('../skill')

/**
 * Walk to a position or goal with mineflayer-pathfinder.
 *
 * args:   { position?: {x,y,z}, goal?: 'near'|'xz'|'y'|'block', range?: number } (+ `signal`: AbortSignal from the runner)
 * result: { reached: boolean, position: {x,y,z} }
 */
module.exports = stubSkill('U17', 'navigate')
