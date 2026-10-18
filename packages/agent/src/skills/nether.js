// owner: U18 (agent combat & dimensions)
'use strict'
const { stubSkill } = require('../skill')

/**
 * Enter the Nether, mine quartz / nether gold / ancient debris, return through the portal.
 *
 * args:   { targets?: { [block]: number } } (+ `signal`: AbortSignal from the runner)
 * result: { mined: { [block]: number }, returned: boolean }
 */
module.exports = stubSkill('U18', 'nether')
