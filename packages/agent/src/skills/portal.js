// owner: U18 (agent combat & dimensions)
'use strict'
const { stubSkill } = require('../skill')

/**
 * Obtain obsidian (lava+water bucket or diamond pickaxe), build and ignite a Nether portal.
 *
 * args:   { origin?: {x,y,z}, method?: 'bucket'|'mine' } (+ `signal`: AbortSignal from the runner)
 * result: { frame: Array<{x,y,z}>, lit: boolean }
 */
module.exports = stubSkill('U18', 'portal')
