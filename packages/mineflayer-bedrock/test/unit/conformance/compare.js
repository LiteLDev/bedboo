// owner: U3 (parity tooling)
'use strict'
/**
 * Compare mineflayer-bedrock's surface (./bedrock.js) with the mineflayer reference (./reference.js).
 *
 * Every finding is `{ area, item, kind, severity, unit, message }`:
 * - severity 'fail'    → the conformance test fails now (missing member, wrong arity / sync-promise
 *                        kind / value type, extra top-level member, missing export, d.ts gap, …);
 * - severity 'pending' → fails only in strict mode (./config.js): notImplemented stubs, members only
 *                        observable after join that the join replay did not produce, window members of
 *                        openers that cannot be probed, events without an asserting test.
 */
const path = require('path')
const { WINDOW_SPECS } = require('./windows')
const { PLACEHOLDER_RE } = require(path.join(__dirname, '../../../../../scripts/parity/lib/items'))

/** Values whose class legitimately differs (Java vs Bedrock protocol client). */
const CTOR_EXEMPT = new Set(['bot._client'])

/** Parity row (assembled matrix) for an item, or null. */
function rowOf (parity, kind, name) {
  return (parity && parity.byKey.get(`${kind}|${name}`)) || null
}
function firstOwner (row) {
  return row && row.owners.length ? row.owners[0] : null
}
/** n.a. rows document an inherent difference: the member may legitimately never be observed. */
function isNotApplicable (row) {
  return !!row && row.status === 'n.a.'
}
/** A row that proves the item: done/adapted with an asserting test, or n.a. */
function isAsserted (row) {
  if (!row) return false
  if (row.status === 'n.a.') return true
  return (row.status === 'done' || row.status === 'adapted') && !!row.test && !PLACEHOLDER_RE.test(row.test)
}

function describeKind (k) {
  return k === 'promise' ? 'returns a promise' : 'is synchronous'
}

/**
 * Method checks shared by bot members and window members.
 * @returns {{ severity: string, message: string }[]}
 */
function checkMethod (ref, ours) {
  const out = []
  if (ours.type !== 'function') {
    out.push({ severity: 'fail', message: `must be a function (upstream: method with arity ${ref.arity}), found ${ours.type}` })
    return out
  }
  if (ref.arity !== undefined && ours.arity !== ref.arity) {
    out.push({ severity: 'fail', message: `arity ${ours.arity}, upstream ${ref.arity} (keep upstream's parameter list; fn.length counts parameters before the first default)` })
  }
  if (ref.fnKind) {
    if (ours.stub || ours.kind === 'promise') {
      if (ours.kind !== ref.fnKind) out.push({ severity: 'fail', message: `${describeKind(ours.kind)}, upstream ${describeKind(ref.fnKind)}` })
    } else if (ours.kind === 'sync' && ref.fnKind === 'promise' && ref.srcKind !== 'sync') {
      out.push({ severity: 'fail', message: 'looks synchronous, upstream returns a promise (make it `async` or return the promise)' })
    }
  }
  if (ours.stub) out.push({ severity: 'pending', message: 'notImplemented stub', unit: ours.unit })
  return out
}

/** Value-type compatibility of a property. */
function checkProperty (ref, ours) {
  if (ref.type === 'accessor') {
    return ours.type === 'accessor' ? [] : [{ severity: 'fail', message: `must be a getter like upstream (a live value), found a ${ours.type} data property` }]
  }
  if (ours.type === 'accessor' || ref.type === null || ref.type === undefined) return []
  if (ours.type === 'function') return [{ severity: 'fail', message: `must not be a function (upstream: ${ref.type})` }]
  if (ref.type === 'null') return ours.type === 'undefined' ? [{ severity: 'fail', message: 'is undefined (upstream: null until known)' }] : []
  if (ours.type !== ref.type) return [{ severity: 'fail', message: `is ${ours.type}, upstream ${ref.type}` }]
  if (ref.type === 'object' && ref.ctor && ref.ctor !== 'Object' && !CTOR_EXEMPT.has(ref.path) && ours.ctor !== ref.ctor) {
    return [{ severity: 'fail', message: `is a ${ours.ctor} instance, upstream ${ref.ctor}` }]
  }
  return []
}

function checkMember (ref, ours) {
  return ref.kind === 'method' ? checkMethod(ref, ours) : checkProperty(ref, ours)
}

/** A null/undefined value: a placeholder until the member is known (e.g. set on join). */
function isEmpty (d) {
  return !d || d.type === 'null' || d.type === 'undefined'
}

/**
 * @param {object} ref buildReference()
 * @param {{ inject: object, exports: object, windows: object, post: object|null, dts: object|null }} bed
 * @param {{ parity: { byKey: Map }|null }} [opts]
 */
function compare (ref, bed, { parity = null } = {}) {
  const findings = []
  const push = (area, item, kind, f, defaultUnit = null) => findings.push({ area, item, kind, severity: f.severity, unit: f.unit ?? defaultUnit, message: f.message })

  // ---- exports ----------------------------------------------------------------------------------
  for (const e of Object.values(ref.exports)) {
    const ours = bed.exports[e.name]
    if (!ours) { push('exports', e.name, 'export', { severity: 'fail', message: 'missing export' }); continue }
    if (ours.type !== e.type) push('exports', e.name, 'export', { severity: 'fail', message: `is ${ours.type}, upstream ${e.type}` })
    else if (e.type === 'function' && ours.arity !== e.arity) push('exports', e.name, 'export', { severity: 'fail', message: `arity ${ours.arity}, upstream ${e.arity}` })
  }
  for (const name of Object.keys(bed.exports)) {
    if (!ref.exports[name]) push('exports', name, 'export', { severity: 'fail', message: 'not a mineflayer export' })
  }

  // ---- bot members --------------------------------------------------------------------------------
  const post = bed.post && !bed.post.failed ? bed.post : null
  for (const m of Object.values(ref.members)) {
    const row = rowOf(parity, m.kind, m.path)
    if (m.phase === 'inject') {
      const area = m.kind === 'method' ? 'methods' : 'properties'
      const ours = bed.inject[m.path]
      if (!ours) push(area, m.path, m.kind, { severity: 'fail', message: 'missing (mineflayer defines it when the plugins are injected)' })
      else for (const f of checkMember(m, ours)) push(area, m.path, m.kind, f, firstOwner(row))
      continue
    }
    // Created on login/packets upstream: judge the value after the join replay; an inject-time value
    // is only a fallback, and null/undefined placeholders count as "not produced yet".
    const after = post ? (post.post[m.path] ?? post.entity[m.path]) : undefined
    const before = bed.inject[m.path]
    const ours = [after, before].find(d => d && !isEmpty(d)) ?? after ?? before
    const upstreamEmpty = m.type === null || m.type === 'null'
    if (ours && (!isEmpty(ours) || upstreamEmpty)) {
      for (const f of checkMember(m, ours)) push('join', m.path, m.kind, f, firstOwner(row))
    } else if (!isNotApplicable(row)) {
      const why = post
        ? `${ours ? `still ${ours.type}` : 'not defined'} after the join replay (${post.replayed} packets of test/fixtures join_flat${post.spawned ? ', spawn emitted' : ', no spawn'})`
        : `not checked: the join replay failed (${bed.post && bed.post.failed ? bed.post.failed.message : 'not run'})`
      push('join', m.path, m.kind, { severity: 'pending', message: why }, firstOwner(row))
    }
  }

  // plugins must inject (and open windows) without emitting 'error' — upstream's reference build throws on it
  for (const e of bed.errors || []) push('inject', 'createBot', 'test', { severity: 'fail', message: `'error' emitted while injecting plugins / probing windows: ${e}` })

  // extra top-level members (Bedrock extras belong under bot.bedrock.*)
  const excluded = new Set(ref.excluded.map(e => e.name))
  const topLevel = new Set([...Object.keys(bed.inject), ...(post ? Object.keys(post.post) : [])].filter(p => p.split('.').length === 2))
  for (const p of topLevel) {
    const key = p.slice(4)
    if (ref.members[p] || excluded.has(p) || key.startsWith('_') || key === 'bedrock') continue
    push('extras', p, 'property', { severity: 'fail', message: 'not a mineflayer member: Bedrock-only extras go under bot.bedrock.* (docs/CONTRIBUTING.md)' })
  }

  if (bed.post && bed.post.failed) {
    push('join', 'join replay', 'test', { severity: 'pending', message: `the join_flat replay failed: ${bed.post.failed.message}` })
  } else if (post && post.errors.length) {
    for (const e of post.errors) push('join', 'join replay', 'test', { severity: 'pending', message: `plugin error while replaying join_flat: ${e}` })
  }

  // ---- windows -------------------------------------------------------------------------------------
  const probes = bed.windows || {}
  const classes = ['Window', ...WINDOW_SPECS.map(s => s.cls)]
  for (const cls of classes) {
    const probe = cls === 'Window' ? probes.Chest : probes[cls]
    const opener = cls === 'Window' ? 'bot.openBlock/openContainer' : `bot.${WINDOW_SPECS.find(s => s.cls === cls).opener}`
    for (const w of Object.values(ref.windows).filter(w => w.cls === cls && w.kind !== 'event')) {
      const row = rowOf(parity, w.kind, w.name)
      if (!probe || probe.status === 'stub') {
        push('windows', w.name, w.kind, { severity: 'pending', message: `${opener} is a notImplemented stub` }, probe ? probe.unit : firstOwner(row))
        continue
      }
      if (probe.status === 'unverified') {
        if (!isAsserted(row)) push('windows', w.name, w.kind, { severity: 'pending', message: `cannot be probed without a server (${probe.reason}); needs an asserting test in its parity row` }, firstOwner(row))
        continue
      }
      const ours = probe.members[w.member]
      if (!ours) { push('windows', w.name, w.kind, { severity: 'fail', message: `not added to the window returned by ${opener}` }, firstOwner(row)); continue }
      for (const f of checkMember(w, ours)) push('windows', w.name, w.kind, f, firstOwner(row))
    }
  }

  // ---- events (bot + window): need a parity row with an asserting test -----------------------------
  const events = [
    ...Object.values(ref.events).map(e => ({ name: e.name, display: e.name })),
    ...Object.values(ref.windows).filter(w => w.kind === 'event').map(w => ({ name: w.name, display: w.name }))
  ]
  if (parity) {
    for (const e of events) {
      const row = rowOf(parity, 'event', e.name)
      if (!row) push('events', e.display, 'event', { severity: 'fail', message: 'no parity row (docs/parity/*.md) lists this event' })
      else if (!isAsserted(row)) push('events', e.display, 'event', { severity: 'pending', message: `no asserting test yet (parity status ${row.status})` }, firstOwner(row))
    }
  }

  // ---- index.d.ts -----------------------------------------------------------------------------------
  if (bed.dts) findings.push(...compareDts(ref, bed.dts))
  return findings
}

/** mineflayer-bedrock's index.d.ts must declare everything mineflayer's does (plus Bedrock extras). */
function compareDts (ref, ours) {
  const out = []
  const fail = (item, message) => out.push({ area: 'dts', item, kind: 'type', severity: 'fail', unit: null, message })
  const up = ref.dts
  for (const name of up.declarations) if (!ours.declarations.includes(name)) fail(name, 'declaration missing from index.d.ts')
  const compareMembers = (label, upMembers, ourMembers) => {
    const mine = new Map((ourMembers || []).map(m => [m.name, m]))
    for (const m of upMembers) {
      const o = mine.get(m.name)
      if (!o) { fail(`${label}.${m.name}`, 'member missing from index.d.ts'); continue }
      if (m.kind !== o.kind) { fail(`${label}.${m.name}`, `declared as a ${o.kind}, upstream a ${m.kind}`); continue }
      if (m.kind !== 'method') continue
      if (o.params !== m.params || o.required !== m.required) {
        fail(`${label}.${m.name}`, `${o.params} parameter(s) (${o.required} required) in index.d.ts, upstream ${m.params} (${m.required} required)`)
      }
      if (o.returnsPromise !== m.returnsPromise) fail(`${label}.${m.name}`, `index.d.ts ${o.returnsPromise ? 'returns' : 'does not return'} a Promise, upstream ${m.returnsPromise ? 'does' : 'does not'}`)
    }
  }
  for (const [name, iface] of Object.entries(up.interfaces)) compareMembers(name, iface.members, ours.interfaces[name] && ours.interfaces[name].members)
  for (const [name, cls] of Object.entries(up.classes)) compareMembers(name, cls.members, ours.classes[name] && ours.classes[name].members)
  // Bot interface extras: only runtime members of the reference (e.g. findPlayer, abilities) or `bedrock`
  if (ours.interfaces.Bot) {
    const upNames = new Set(up.interfaces.Bot.members.map(m => m.name))
    for (const m of ours.interfaces.Bot.members) {
      if (upNames.has(m.name) || m.name === 'bedrock' || ref.members[`bot.${m.name}`]) continue
      fail(`Bot.${m.name}`, 'not a mineflayer member: declare Bedrock-only extras in types/bedrock.d.ts (bot.bedrock)')
    }
  }
  return out
}

module.exports = { compare, compareDts, checkMethod, checkProperty, isAsserted }
