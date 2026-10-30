// owner: BEDD-5 (bedd lifecycle, capability surface and BeddUnsupportedError)
'use strict'

/**
 * Thrown (or used to reject) by an API that cannot work with `transport: 'bedd'`: the real Minecraft client hosted by
 * Be.D.D. owns the packet the API would send, and the BeDD op that would ask the client to do it is not available
 * (or the API is fenced to v2). A separate class from lib/bedrock/errors.js (frozen).
 *
 * Contract:
 * - `err.code === 'ERR_BEDD_UNSUPPORTED'`, `err.bedd === true`
 * - `err.feature`: the API or packet, e.g. `'bot.craft'`, `'item_stack_request'`
 * - `err.missing`: the BeDD capabilities that would make it work (`['stack']`), or `['v2']` when no capability does yet
 */
class BeddUnsupportedError extends Error {
  /**
   * @param {string} feature public API or packet name
   * @param {{ missing?: string[], reason?: string }} [opts]
   */
  constructor (feature, { missing = [], reason } = {}) {
    const list = Array.isArray(missing) ? [...missing] : [String(missing)]
    super(`${feature} is not supported with transport 'bedd': ${reason ?? describe(list)}`)
    this.name = 'BeddUnsupportedError'
    this.code = 'ERR_BEDD_UNSUPPORTED'
    this.bedd = true
    this.feature = feature
    this.missing = list
  }
}

function describe (missing) {
  if (missing.includes('v2')) return 'the real client owns it and BeDD has no op for it yet (v2)'
  if (missing.length === 0) return 'the real client owns it'
  const ops = missing.map(m => `'${m}'`).join(', ')
  return missing.length > 1
    ? `none of the BeDD ops ${ops} is available (enable them in BeDD's config.json)`
    : `the BeDD op ${ops} is not available (enable it in BeDD's config.json)`
}

/** @returns {boolean} whether `err` is a {@link BeddUnsupportedError} (also across module copies) */
function isBeddUnsupported (err) {
  return !!err && typeof err === 'object' && err.code === 'ERR_BEDD_UNSUPPORTED' && err.bedd === true
}

module.exports = { BeddUnsupportedError, isBeddUnsupported }
