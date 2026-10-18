// owner: U18 (agent combat & dimensions)
'use strict'
const { stubSkill } = require('../skill')

/**
 * Enter The End (cheat-assisted setup), fight endermen, exit back to the overworld.
 *
 * args:   { fight?: boolean } (+ `signal`: AbortSignal from the runner)
 * result: { entered: boolean, killed: { [mob]: number }, exited: boolean }
 */
module.exports = stubSkill('U18', 'end')
