// owner: U0 (skeleton) — shared by every unit; change only with the coordinator's approval.
'use strict'

/**
 * Thrown (or used to reject) by every API that is not implemented yet.
 *
 * Contract (relied on by the conformance test of U3 and by the smoke tests):
 * - `err.notImplemented === true`
 * - `err.unit` is the owning unit id, e.g. `'U8'`
 * - `err.feature` is the public name, e.g. `'bot.equip'`
 * - `err.code === 'ERR_NOT_IMPLEMENTED'`
 */
class NotImplementedError extends Error {
  /**
   * @param {string} unit owning unit id, e.g. 'U8'
   * @param {string} [feature] public name of the missing API, e.g. 'bot.equip'
   */
  constructor (unit, feature) {
    super(`${feature ?? 'This feature'} is not implemented yet in mineflayer-bedrock (owner: ${unit})`)
    this.name = 'NotImplementedError'
    this.code = 'ERR_NOT_IMPLEMENTED'
    this.notImplemented = true
    this.unit = unit
    this.feature = feature
  }
}

/**
 * Creates a stub function for a not-yet-implemented API.
 *
 * The returned function:
 * - throws `NotImplementedError` synchronously (sync APIs), or returns a rejected promise
 *   (`async: true`, for APIs that upstream mineflayer exposes as promise-returning),
 *   or does nothing (`noop: true`, only where upstream's idle behaviour is a no-op);
 * - carries `fn.notImplemented = true`, `fn.unit` and `fn.feature`;
 * - has `fn.length` equal to upstream's arity (`length`) and `fn.name` = last path segment.
 *
 * Owners replace the stub by assigning the real implementation to the same property; the real
 * function must not carry `notImplemented`.
 *
 * @param {string} unit owning unit id, e.g. 'U8'
 * @param {string} feature public name, e.g. 'bot.equip'
 * @param {{ async?: boolean, noop?: boolean, length?: number }} [opts]
 * @returns {Function & { notImplemented: true, unit: string, feature: string }}
 */
function stub (unit, feature, opts = {}) {
  const { async = false, noop = false, length = 0 } = opts
  let fn
  if (noop) {
    fn = function () {}
  } else if (async) {
    fn = function () { return Promise.reject(new NotImplementedError(unit, feature)) }
  } else {
    fn = function () { throw new NotImplementedError(unit, feature) }
  }
  Object.defineProperty(fn, 'name', { value: String(feature).split('.').pop() })
  Object.defineProperty(fn, 'length', { value: length })
  fn.notImplemented = true
  fn.unit = unit
  fn.feature = feature
  return fn
}

/** Sync stub with upstream arity. */
const stubSync = (unit, feature, length = 0) => stub(unit, feature, { length })
/** Promise-returning stub with upstream arity (rejects, never throws synchronously). */
const stubAsync = (unit, feature, length = 0) => stub(unit, feature, { async: true, length })

/** @returns {boolean} whether `fn` is an unimplemented stub created by {@link stub} */
function isStub (fn) {
  return typeof fn === 'function' && fn.notImplemented === true
}

module.exports = { NotImplementedError, stub, stubSync, stubAsync, isStub }
