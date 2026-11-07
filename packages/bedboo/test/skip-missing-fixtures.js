'use strict'
// Preloaded by the test script (node --require): on a run for another Bedrock family (BEDBOO_VERSION, see
// ./version.js) a test whose packet capture does not exist for that family yet is skipped with the reason instead of
// failing. Covers a FixtureMissingError (code BEDBOO_FIXTURE_MISSING, thrown by test/fixtures load()) raised in a test
// body, in a before/beforeEach hook (every test below that suite is skipped) or while a describe body registers its
// tests. On the default family (1.26.51) a missing capture still fails: its fixtures must exist.
const nodeTest = require('node:test')
const { DEFAULT_VERSION } = require('./version')

const CODE = 'BEDBOO_FIXTURE_MISSING'
const skippable = (err) => err?.code === CODE && err.version !== DEFAULT_VERSION

/** suites whose hooks hit a missing capture: [{ filePath, fullName, reason }] */
const missingIn = []

function inheritedSkip (t) {
  const hit = missingIn.find(m => m.filePath === t.filePath && (t.fullName === m.fullName || t.fullName.startsWith(m.fullName + ' > ')))
  return hit?.reason
}

/** split node:test's (name?, options?, fn?) arguments; wrap fn with `wrap` when it is there */
function wrapArgs (args, wrap) {
  const i = args.findIndex(a => typeof a === 'function')
  if (i === -1) return args
  const fn = args[i]
  // callback-style tests/hooks (fn.length >= 2: (t, done)) are left alone
  if (fn.length >= 2) return args
  const out = args.slice()
  out[i] = wrap(fn)
  return out
}

function wrapTest (fn) {
  return async function (t) {
    const reason = inheritedSkip(t)
    if (reason) return t.skip(reason)
    try {
      return await fn.call(this, t)
    } catch (err) {
      if (skippable(err)) return t.skip(err.message)
      throw err
    }
  }
}

function wrapHook (fn) {
  return async function (t) {
    if (inheritedSkip(t)) return
    try {
      return await fn.call(this, t)
    } catch (err) {
      // a file-level hook runs on the root test shared by every file (--test-isolation=none): no suite to skip
      if (!skippable(err) || !t.fullName) throw err
      missingIn.push({ filePath: t.filePath, fullName: t.fullName, reason: err.message })
    }
  }
}

function wrapSuite (fn) {
  return function (...args) {
    const missing = (err) => {
      if (!skippable(err)) throw err
      nodeTest.it('packet capture', { skip: err.message })
    }
    try {
      const out = fn.apply(this, args)
      return out && typeof out.then === 'function' ? out.catch(missing) : out
    } catch (err) {
      missing(err)
    }
  }
}

function patch (orig, wrap) {
  const patched = function (...args) { return orig.apply(this, wrapArgs(args, wrap)) }
  for (const key of ['skip', 'todo', 'only', 'expectFailure']) {
    if (typeof orig[key] === 'function') patched[key] = (...args) => orig[key](...wrapArgs(args, wrap))
  }
  return patched
}

const it = patch(nodeTest.it, wrapTest)
const describe = patch(nodeTest.describe, wrapSuite)
nodeTest.it = it
nodeTest.test = it
nodeTest.describe = describe
nodeTest.suite = describe
for (const hook of ['before', 'beforeEach', 'after', 'afterEach']) {
  const orig = nodeTest[hook]
  nodeTest[hook] = (...args) => orig(...wrapArgs(args, wrapHook))
}
