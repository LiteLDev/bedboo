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

/**
 * A skill failed. `code` says why (callers branch on it, never on the message):
 * - `NO_PATH`     pathfinder found no way (or kept getting stuck)
 * - `NOT_FOUND`   no matching block / entity / station, even after exploring
 * - `NO_PLAN`     obtain(): no recipe, furnace recipe, block or mob gives the item
 * - `MISSING`     an ingredient / tool / fuel the step needs is not in the inventory
 * - `UNSAFE`      the only way on is through lava / a long drop
 * - `DIED`        the bot died during the skill
 * - `TIMEOUT`     the step's time budget ran out
 * - `ABORTED`     the runner aborted the skill (`args.signal`)
 * - `FAILED`      anything else (the server refused an action, …)
 */
class SkillError extends Error {
  constructor (message, { code = 'FAILED', cause, details } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'SkillError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

class AbortError extends SkillError {
  constructor (message = 'aborted') {
    super(message, { code: 'ABORTED' })
    this.name = 'AbortError'
  }
}

/** throw an AbortError when `signal` is aborted */
function checkAbort (signal) {
  if (signal?.aborted) throw new AbortError(typeof signal.reason === 'string' ? signal.reason : signal.reason?.message)
}

function isAbort (err) {
  return err?.code === 'ABORTED' || err?.name === 'AbortError'
}

module.exports = { NotImplementedError, SkillError, AbortError, checkAbort, isAbort }
