'use strict'
/**
 * Conformance test mode.
 *
 * Non-strict: members that are still `notImplemented`
 * stubs, members that cannot be observed yet (created on join, window members behind an unimplemented
 * opener) and events without an asserting test are reported as PENDING and do not fail. Missing members,
 * wrong arity, wrong sync/promise kind, wrong value types, extra top-level members, missing exports
 * and index.d.ts gaps always FAIL.
 *
 * Strict: every pending item fails.
 *
 * The default is strict. `BEDBOO_CONFORMANCE_STRICT=1` (or `=0`)
 * overrides it per run.
 */
const STRICT = true

function isStrict (env = process.env) {
  const v = env.BEDBOO_CONFORMANCE_STRICT
  if (v === undefined || v === '') return STRICT
  return v === '1' || v.toLowerCase() === 'true'
}

module.exports = { STRICT, isStrict }
