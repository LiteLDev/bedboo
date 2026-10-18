// owner: U3 (parity tooling)
'use strict'
/**
 * Conformance test mode.
 *
 * Non-strict (default until the switch below is flipped): members that are still `notImplemented`
 * stubs, members that cannot be observed yet (created on join, window members behind an unimplemented
 * opener) and events without an asserting test are reported as PENDING and do not fail. Missing members,
 * wrong arity, wrong sync/promise kind, wrong value types, extra top-level members, missing exports
 * and index.d.ts gaps always FAIL.
 *
 * Strict: every pending item fails.
 *
 * COORDINATOR: set STRICT to true when the conformance test switches to failing mode (plan: U16's
 * parity audit, at the latest Wave 6). `BEDBOO_CONFORMANCE_STRICT=1` (or `=0`) overrides it per run.
 */
const STRICT = false

function isStrict (env = process.env) {
  const v = env.BEDBOO_CONFORMANCE_STRICT
  if (v === undefined || v === '') return STRICT
  return v === '1' || v.toLowerCase() === 'true'
}

module.exports = { STRICT, isStrict }
