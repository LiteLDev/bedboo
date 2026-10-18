// owner: U1 (BDS harness & e2e infra)
'use strict'

/** Same contract as mineflayer-bedrock's lib/bedrock/errors.js NotImplementedError. */
class NotImplementedError extends Error {
  constructor (unit, feature) {
    super(`${feature ?? 'This feature'} is not implemented yet in @bedboo/bds (owner: ${unit})`)
    this.name = 'NotImplementedError'
    this.code = 'ERR_NOT_IMPLEMENTED'
    this.notImplemented = true
    this.unit = unit
    this.feature = feature
  }
}

module.exports = { NotImplementedError }
