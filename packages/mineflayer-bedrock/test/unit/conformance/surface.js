// owner: U3 (parity tooling)
'use strict'
/**
 * Runtime surface snapshots of a bot (mineflayer or mineflayer-bedrock): which members exist, their
 * value type, function arity and sync/promise kind. Used for both the upstream reference and the
 * Bedrock bot, so both sides are described by exactly the same rules.
 */

/** EventEmitter internals, never part of the API surface. */
const EMITTER_INTERNALS = new Set(['_events', '_eventsCount', '_maxListeners', 'domain'])

/**
 * Plain-object namespaces whose members are part of the surface (one level deep), e.g. bot.creative.*,
 * bot.physics.*. Maps keyed by runtime data (entities, players, scoreboards, …) are empty at inject time
 * and contribute nothing; `registry` is excluded (minecraft-data, not mineflayer API).
 */
const SKIP_NAMESPACES = new Set(['registry', '_client', 'entities', 'players', 'uuidToUsername', 'scoreboards', 'teams', 'teamMap'])
/** Namespaces described two levels deep. */
const DEEP_NAMESPACES = new Set(['settings.skinParts'])

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function ctorName (v) {
  const proto = v && Object.getPrototypeOf(v)
  return (proto && proto.constructor && proto.constructor.name) || null
}

/**
 * Sync/promise kind of a function.
 * - 'promise': an async function, or a function whose body returns `new Promise(…)`
 * - 'promise?': a plain function that mentions promises (may return one; cannot tell statically)
 * - 'sync': anything else
 * - 'unknown': native/bound functions (no source)
 * notImplemented stubs are called once (they only throw or return a rejected promise).
 */
function fnKind (fn) {
  if (fn.notImplemented === true) {
    try {
      const r = fn()
      if (r && typeof r.then === 'function') {
        r.then(() => {}, () => {})
        return 'promise'
      }
      return 'sync'
    } catch (err) {
      return 'sync'
    }
  }
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') return 'promise'
  const src = Function.prototype.toString.call(fn)
  if (/\[native code\]/.test(src)) return 'unknown'
  if (/\breturn\s+new\s+Promise\b/.test(src)) return 'promise'
  if (/\bPromise\b|\.then\(|\bawait\b|\bonce\(/.test(src)) return 'promise?'
  return 'sync'
}

/**
 * Describe one own property of `obj` without invoking getters.
 * @returns {{ type: string, ctor?: string|null, arity?: number, kind?: string, stub?: boolean, unit?: string }|null}
 */
function describeProperty (obj, key) {
  const desc = Object.getOwnPropertyDescriptor(obj, key)
  if (!desc) return null
  if (desc.get || desc.set) return { type: 'accessor' }
  return describeValue(desc.value)
}

function describeValue (v) {
  if (v === null) return { type: 'null' }
  if (v === undefined) return { type: 'undefined' }
  if (typeof v === 'function') {
    const out = { type: 'function', arity: v.length, kind: fnKind(v) }
    if (v.notImplemented === true) {
      out.stub = true
      out.unit = v.unit ?? null
    }
    return out
  }
  if (Array.isArray(v)) return { type: 'array' }
  if (typeof v === 'object') return { type: 'object', ctor: ctorName(v) }
  return { type: typeof v }
}

/**
 * Snapshot of a bot's surface: { 'bot.x': descriptor, 'bot.ns.y': descriptor, … }.
 * @param {object} bot
 * @param {{ prefix?: string }} [opts]
 */
function snapshot (bot, { prefix = 'bot' } = {}) {
  const out = {}
  for (const key of Object.getOwnPropertyNames(bot)) {
    if (EMITTER_INTERNALS.has(key)) continue
    const d = describeProperty(bot, key)
    out[`${prefix}.${key}`] = d
    if (SKIP_NAMESPACES.has(key) || d.type !== 'object') continue
    const value = bot[key]
    if (!isPlainObject(value)) continue
    Object.assign(out, namespace(value, `${prefix}.${key}`, key))
  }
  return out
}

function namespace (obj, path, rel) {
  const out = {}
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (EMITTER_INTERNALS.has(key)) continue
    const d = describeProperty(obj, key)
    out[`${path}.${key}`] = d
    if (d.type === 'object' && DEEP_NAMESPACES.has(`${rel}.${key}`) && isPlainObject(obj[key])) {
      Object.assign(out, namespace(obj[key], `${path}.${key}`, `${rel}.${key}`))
    }
  }
  return out
}

/** Members of `obj` (e.g. a window) that are not own members of `pristine` (the same class, untouched). */
function addedMembers (obj, pristine) {
  const base = new Set(Object.getOwnPropertyNames(pristine))
  const out = {}
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (base.has(key) || EMITTER_INTERNALS.has(key)) continue
    out[key] = describeProperty(obj, key)
  }
  return out
}

const realSetTimeout = setTimeout
const realSetInterval = setInterval
/**
 * While bot code runs under the probes, make its timers not keep the process alive: mineflayer's
 * promise_utils.once() starts a 20 s sleep() that is never cleared, physics starts intervals, ….
 * Returns `restore()`. The probes' own timers use the real functions (`realSetTimeout`).
 */
function unrefTimers () {
  const wrap = (real) => function (...args) {
    const t = real.apply(this, args)
    if (t && typeof t.unref === 'function') t.unref()
    return t
  }
  global.setTimeout = wrap(realSetTimeout)
  global.setInterval = wrap(realSetInterval)
  return () => {
    global.setTimeout = realSetTimeout
    global.setInterval = realSetInterval
  }
}

module.exports = { unrefTimers, realSetTimeout, snapshot, namespace, describeProperty, describeValue, addedMembers, fnKind, isPlainObject, ctorName, EMITTER_INTERNALS }
