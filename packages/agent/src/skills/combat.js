// owner: U18 (agent combat & dimensions)
'use strict'
const { stubSkill } = require('../skill')

/**
 * Fight nearby hostile mobs with mineflayer-pvp (melee / bow / shield).
 *
 * args:   { targets?: string[], radius?: number, weapon?: 'melee'|'bow' } (+ `signal`: AbortSignal from the runner)
 * result: { killed: { [mob]: number } }
 */
module.exports = stubSkill('U18', 'combat')
