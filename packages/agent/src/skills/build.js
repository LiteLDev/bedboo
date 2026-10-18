// owner: U17 (agent core & overworld milestones)
'use strict'
const { stubSkill } = require('../skill')

/**
 * Build a structure from a blueprint (list of relative block placements).
 *
 * args:   { blueprint: Array<{ x, y, z, block }>, origin: {x,y,z} } (+ `signal`: AbortSignal from the runner)
 * result: { placed: number }
 */
module.exports = stubSkill('U17', 'build')
