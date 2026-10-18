// owner: U17 (agent core & overworld milestones)
'use strict'

/** Same contract as mineflayer-bedrock's lib/bedrock/errors.js NotImplementedError. */
class NotImplementedError extends Error {
  constructor (unit, feature) {
    super(`${feature ?? 'This feature'} is not implemented yet in @bedboo/agent (owner: ${unit})`)
    this.name = 'NotImplementedError'
    this.code = 'ERR_NOT_IMPLEMENTED'
    this.notImplemented = true
    this.unit = unit
    this.feature = feature
  }
}

module.exports = { NotImplementedError }
