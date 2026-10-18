// owner: U3 (parity tooling)
'use strict'
/**
 * The mineflayer 4.39.0 reference surface, built from upstream itself (never by hand):
 *
 * 1. runtime: real `mineflayer.createBot({ client })` with a fake minecraft-protocol client for the
 *    latest supported Java version; plugins are injected, then a `login` (+ registry_data,
 *    update_health) is replayed to see the members created on login (bot.entity, bot.game.*, …);
 * 2. windows: every window kind is opened through mineflayer's own openers (./windows.js);
 * 3. static scan of mineflayer's lib/: members assigned only on later packets (bot.player, bot.vehicle,
 *    bot.oxygenLevel, bot.game.serverBrand, …) and every emitted event name;
 * 4. docs/upstream/index.d.ts read with the TypeScript compiler (./dts.js): Bot members, BotEvents,
 *    exports, window classes;
 * 5. master's abilities plugin (docs/upstream/abilities.master.js): bot.abilities + 'abilities';
 * 6. tests: docs/upstream/externalTests/*.js and every describe/it of docs/upstream/internalTest.js.
 *
 * d.ts declarations that do not exist at runtime (drift) are listed in `excluded` and not required:
 * `bot.connect`, `bot.chatPatterns`, the PhysicsOptions fields, the window 'open' event, ….
 */
const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')
const { EventEmitter } = require('events')
const { snapshot, namespace, describeValue, describeProperty, unrefTimers } = require('./surface')
const { probeWindows } = require('./windows')
const { readDts } = require('./dts')

const REPO_ROOT = path.join(__dirname, '../../../../..')
const UPSTREAM_DOCS = path.join(REPO_ROOT, 'docs/upstream')
const MINEFLAYER_DIR = path.dirname(require.resolve('mineflayer/package.json'))
const mfRequire = createRequire(path.join(MINEFLAYER_DIR, 'index.js'))
const MINEFLAYER_VERSION = '4.39.0'

/** Fake minecraft-protocol client: enough for every mineflayer 4.39.0 plugin to inject. */
function fakeJavaClient (version) {
  const client = new EventEmitter()
  client.setMaxListeners(0)
  client.version = version
  client.wait_connect = false
  client.state = 'play'
  client.username = 'ConformanceBot'
  client.uuid = '00000000-0000-4000-8000-000000000001'
  client.write = () => {}
  client.writeChannel = () => {}
  client.registerChannel = () => {}
  client.unregisterChannel = () => {}
  client.end = (reason) => client.emit('end', reason)
  return client
}

async function upstreamRuntime () {
  const restoreTimers = unrefTimers()
  try {
    return await upstreamRuntimeInner()
  } finally {
    restoreTimers()
  }
}

async function upstreamRuntimeInner () {
  const pkg = require('mineflayer/package.json')
  if (pkg.version !== MINEFLAYER_VERSION) throw new Error(`reference must be mineflayer ${MINEFLAYER_VERSION}, found ${pkg.version}`)
  const mineflayer = require('mineflayer')
  const version = mineflayer.latestSupportedVersion
  const client = fakeJavaClient(version)
  const bot = mineflayer.createBot({ client, username: 'ConformanceBot', logErrors: false, hideErrors: true })
  const errors = []
  bot.on('error', (err) => errors.push(err))
  // plugin_loader injects on the first 'inject_allowed' (a `once` listener); emitting it now makes the
  // injection synchronous — the loader's own deferred emit then finds no listener.
  bot.emit('inject_allowed')
  const inject = snapshot(bot)

  const windows = await probeWindows(bot, { require: mfRequire, tradeListPacket: 'trade_list' })

  const loginPacket = bot.registry.loginPacket
  for (const key in loginPacket.dimensionCodec) client.emit('registry_data', loginPacket.dimensionCodec[key])
  client.emit('login', { ...loginPacket, entityId: 0 })
  client.emit('update_health', { health: 20, food: 20, foodSaturation: 5 })
  const login = snapshot(bot)
  const entity = bot.entity ? namespace(bot.entity, 'bot.entity', 'entity') : {}
  bot.end('conformance reference done')
  if (errors.length) throw new Error(`upstream reference bot errored: ${errors.map(e => e.message).join('; ')}`)

  const exports = {}
  for (const [name, value] of Object.entries(mineflayer)) exports[name] = describeValue(value)
  return { version, inject, login, entity, windows, exports }
}

/** Static facts from mineflayer's lib/ sources. */
function staticScan () {
  const pluginDir = path.join(MINEFLAYER_DIR, 'lib/plugins')
  const files = [path.join(MINEFLAYER_DIR, 'lib/loader.js'), ...fs.readdirSync(pluginDir).filter(f => f.endsWith('.js')).map(f => path.join(pluginDir, f))]
  const assigned = new Set()
  const gameKeys = new Set()
  const events = new Set()
  const templated = new Set()
  const windowEvents = new Set()
  const read = (f) => fs.readFileSync(f, 'utf8')
  for (const file of files) {
    const src = read(file)
    for (const m of src.matchAll(/\bbot\.([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) assigned.add(m[1])
    for (const m of src.matchAll(/Object\.defineProperty\(\s*bot\s*,\s*'([^']+)'/g)) assigned.add(m[1])
    for (const m of src.matchAll(/\bbot\.game\.([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) gameKeys.add(m[1])
    for (const m of src.matchAll(/\bbot\.emit\(\s*'([^']+)'/g)) events.add(m[1])
    for (const m of src.matchAll(/\bbot\.emit\(\s*`([^`]+)`/g)) templated.add(m[1])
    for (const m of src.matchAll(/\b(?:window|furnace|enchantmentTable|villager|anvil)\.emit\(\s*'([^']+)'/g)) windowEvents.add(m[1])
  }
  // Events emitted through lookup tables (entities.js animation / entity_status, blocks.js forwarding).
  const entitiesSrc = read(path.join(pluginDir, 'entities.js'))
  for (const table of ['animationEvents', 'entityStatusEvents']) {
    const m = new RegExp(`const ${table} = \\{([^}]*)\\}`).exec(entitiesSrc)
    if (!m) throw new Error(`mineflayer entities.js: table ${table} not found`)
    for (const v of m[1].matchAll(/'([^']+)'/g)) events.add(v[1])
  }
  const fwd = /const forwardedEvents = \[([^\]]*)\]/.exec(read(path.join(pluginDir, 'blocks.js')))
  if (!fwd) throw new Error('mineflayer blocks.js: forwardedEvents not found')
  for (const v of fwd[1].matchAll(/'([^']+)'/g)) events.add(v[1])
  return { assigned, gameKeys, events, templated, windowEvents }
}

/** bot.abilities shape and events of mineflayer master's abilities plugin (run against a stub bot). */
function masterAbilities () {
  const file = path.join(UPSTREAM_DOCS, 'abilities.master.js')
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  require(file)(bot)
  const src = fs.readFileSync(file, 'utf8')
  const events = [...src.matchAll(/\bbot\.emit\(\s*'([^']+)'/g)].map(m => m[1])
  const members = { 'bot.abilities': describeProperty(bot, 'abilities'), ...namespace(bot.abilities, 'bot.abilities', 'abilities') }
  return { members, events }
}

/** describe/it titles of mineflayer's test/internalTest.js → ['describe › … › it', …] (root describe dropped). */
function internalTests (file = path.join(UPSTREAM_DOCS, 'internalTest.js')) {
  const src = fs.readFileSync(file, 'utf8')
  const out = []
  const stack = []
  const re = /^(\s*)(describe|it)(?:\.skip|\.only)?\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`([^`]*)`)/
  for (const line of src.split('\n')) {
    const m = re.exec(line)
    if (!m) continue
    const indent = m[1].length
    const title = (m[3] ?? m[4] ?? m[5]).replace(/\\(.)/g, '$1')
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    if (m[2] === 'describe') {
      stack.push({ indent, title })
    } else {
      out.push(stack.slice(1).map(s => s.title).concat(title).join(' › '))
    }
  }
  return out
}

function externalTests () {
  return fs.readdirSync(path.join(UPSTREAM_DOCS, 'externalTests')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort()
}

/**
 * Upstream function facts. `srcKind` is what the source shows (./surface.js fnKind); `fnKind` is the
 * semantic kind: 'promise' when the source shows it or index.d.ts declares a Promise return
 * (e.g. `creative.clearSlot` is `return setInventorySlot(…)`, typed Promise<void>).
 */
function fnInfo (d, dtsReturnsPromise = false) {
  const promise = d.kind === 'promise' || d.kind === 'promise?' || dtsReturnsPromise
  return { arity: d.arity, srcKind: d.kind, fnKind: promise ? 'promise' : 'sync' }
}

/** d.ts type text → runtime value type (only used when runtime gives no evidence). */
function dtsType (typeText) {
  if (!typeText) return null
  const parts = typeText.split(' | ')
  if (parts.length === 1 && ['number', 'string', 'boolean'].includes(parts[0])) return parts[0]
  return null
}

/** Namespaces whose d.ts interface describes runtime members: d.ts name → bot path. */
const DTS_NAMESPACES = {
  creativeMethods: 'bot.creative',
  simpleClick: 'bot.simpleClick',
  GameSettings: 'bot.settings',
  SkinParts: 'bot.settings.skinParts',
  Experience: 'bot.experience',
  PhysicsOptions: 'bot.physics',
  Time: 'bot.time',
  ControlStateStatus: 'bot.controlState',
  GameState: 'bot.game',
  Tablist: 'bot.tablist'
}

let cached = null
/** @returns {Promise<object>} the reference surface (memoised per process) */
function buildReference () {
  if (!cached) cached = build()
  return cached
}

async function build () {
  const rt = await upstreamRuntime()
  const st = staticScan()
  const dts = readDts(path.join(UPSTREAM_DOCS, 'index.d.ts'))
  const abilities = masterAbilities()
  const excluded = []

  // ---- bot members --------------------------------------------------------------------------
  const members = {}
  const add = (p, d, phase, source) => {
    if (!d || d.type === 'undefined') return
    if (members[p]) { members[p].sources.add(source); return }
    const m = { path: p, kind: d.type === 'function' ? 'method' : 'property', phase, type: d.type, sources: new Set([source]) }
    if (d.type === 'function') Object.assign(m, fnInfo(d))
    if (d.type === 'object') m.ctor = d.ctor
    members[p] = m
  }
  for (const [p, d] of Object.entries(rt.inject)) add(p, d, 'inject', 'runtime')
  for (const [p, d] of Object.entries(rt.login)) if (!rt.inject[p]) add(p, d, 'login', 'runtime')
  for (const [p, d] of Object.entries(rt.entity)) add(p, d, 'login', 'runtime')
  for (const [p, d] of Object.entries(abilities.members)) add(p, d, 'inject', 'master')
  for (const key of st.assigned) {
    const p = `bot.${key}`
    if (!members[p]) members[p] = { path: p, kind: 'property', phase: 'runtime', type: null, sources: new Set(['static']) }
  }
  for (const key of st.gameKeys) {
    const p = `bot.game.${key}`
    if (!members[p]) members[p] = { path: p, kind: 'property', phase: 'runtime', type: null, sources: new Set(['static']) }
  }
  // d.ts Bot + namespaces
  const dtsMember = (p, m) => {
    if (members[p]) {
      members[p].sources.add('dts')
      members[p].dts = m
      if (members[p].kind === 'method' && m.kind === 'method' && m.returnsPromise) members[p].fnKind = 'promise'
      if (members[p].type === null && m.kind === 'property') members[p].type = dtsType(m.typeText)
      if (members[p].type === null && m.kind === 'method') Object.assign(members[p], { kind: 'method', type: 'function', arity: m.params, srcKind: null, fnKind: m.returnsPromise ? 'promise' : 'sync' })
    } else {
      excluded.push({ kind: m.kind, name: p, reason: 'declared in mineflayer index.d.ts but never defined at runtime' })
    }
  }
  for (const m of dts.interfaces.Bot.members) dtsMember(`bot.${m.name}`, m)
  for (const [iface, prefix] of Object.entries(DTS_NAMESPACES)) {
    for (const m of dts.interfaces[iface].members) dtsMember(`${prefix}.${m.name}`, m)
  }

  // ---- events ---------------------------------------------------------------------------------
  const events = {}
  const addEvent = (name, source) => { (events[name] = events[name] || { name, sources: new Set() }).sources.add(source) }
  for (const m of dts.interfaces.BotEvents.members) addEvent(m.name, 'dts')
  for (const name of st.events) addEvent(name, 'runtime')
  for (const name of abilities.events) addEvent(name, 'master')
  for (const t of st.templated) {
    if (/^chat:\$\{/.test(t)) addEvent('chat:name', 'runtime')
    else excluded.push({ kind: 'event', name: t, reason: 'internal event (window/transaction plumbing), not public API' })
  }

  // ---- windows --------------------------------------------------------------------------------
  const windows = {}
  const probes = rt.windows
  for (const [cls, res] of Object.entries(probes)) {
    if (res.status !== 'ok') throw new Error(`upstream window probe failed for ${cls}: ${res.reason}`)
  }
  const base = probes.Chest.members
  const addWin = (name, entry) => {
    const prev = windows[name]
    if (prev) {
      for (const s of entry.sources) prev.sources.add(s)
      return
    }
    windows[name] = entry
  }
  const winMember = (cls, key, d, source) => {
    const entry = { name: `${cls}.${key}`, cls, member: key, kind: d.type === 'function' ? 'method' : 'property', type: d.type, sources: new Set([source]) }
    if (d.type === 'function') Object.assign(entry, fnInfo(d))
    addWin(entry.name, entry)
  }
  for (const [key, d] of Object.entries(base)) winMember('Window', key, d, 'runtime')
  for (const [cls, res] of Object.entries(probes)) {
    for (const [key, d] of Object.entries(res.members)) if (!base[key]) winMember(cls, key, d, 'runtime')
  }
  for (const [cls, decl] of Object.entries(dts.classes)) {
    if (!probes[cls]) continue
    const added = probes[cls].members
    for (const m of decl.members) {
      const d = added[m.name]
      if (d) {
        winMember(cls, m.name, d, 'dts')
        if (m.kind === 'method' && m.returnsPromise) {
          windows[`${cls}.${m.name}`].fnKind = 'promise'
          // the base member the class inherits (Chest.close: Promise<void> → Window.close)
          if (base[m.name] && windows[`Window.${m.name}`]) windows[`Window.${m.name}`].fnKind = 'promise'
        }
      } else excluded.push({ kind: m.kind, name: `${cls}.${m.name}`, reason: 'declared in mineflayer index.d.ts but not added to the window at runtime' })
    }
  }
  // window events: base StorageEvents + the class-specific event interfaces
  const storage = dts.interfaces.StorageEvents.members.map(m => m.name)
  const emitted = new Set([...st.windowEvents, 'updateSlot']) // updateSlot: emitted by prismarine-windows
  for (const ev of storage) {
    if (emitted.has(ev)) addWin(`Window:${ev}`, { name: `Window:${ev}`, cls: 'Window', member: ev, kind: 'event', sources: new Set(['dts']) })
    else excluded.push({ kind: 'event', name: `Window:${ev}`, reason: 'declared in mineflayer index.d.ts (StorageEvents) but never emitted' })
  }
  for (const [cls, decl] of Object.entries(dts.classes)) {
    if (!probes[cls] || !decl.typeArg || !dts.interfaces[decl.typeArg]) continue
    for (const m of dts.interfaces[decl.typeArg].members) {
      if (!storage.includes(m.name)) addWin(`${cls}:${m.name}`, { name: `${cls}:${m.name}`, cls, member: m.name, kind: 'event', sources: new Set(['dts']) })
    }
  }

  // ---- exports --------------------------------------------------------------------------------
  const exportsRef = {}
  for (const [name, d] of Object.entries(rt.exports)) {
    exportsRef[name] = { name, type: d.type, arity: d.arity, sources: new Set(['runtime']) }
  }
  for (const name of [...dts.functions, ...dts.variables, ...Object.keys(dts.classes)]) {
    if (exportsRef[name]) {
      exportsRef[name].sources.add('dts')
    } else {
      excluded.push({
        kind: 'export',
        name,
        reason: probes[name]
          ? 'window class: a class in index.d.ts, only a type at runtime (its members are window items)'
          : 'a class in mineflayer index.d.ts but not exported at runtime (type only)'
      })
    }
  }

  return {
    meta: { mineflayer: MINEFLAYER_VERSION, javaVersion: rt.version },
    exports: exportsRef,
    members,
    events,
    windows,
    tests: { external: externalTests(), internal: internalTests() },
    dts,
    excluded
  }
}

/**
 * Flat list of reference items in parity form: { kind, name, display, category }.
 * `name` is the canonical parity name (scripts/parity/lib/items.js).
 */
function referenceItems (ref) {
  const { displayItem } = require('../../../../../scripts/parity/lib/items')
  const out = []
  for (const e of Object.values(ref.exports)) out.push({ kind: 'export', name: e.name, display: displayItem('export', e.name), category: 'export' })
  for (const m of Object.values(ref.members)) out.push({ kind: m.kind, name: m.path, display: displayItem(m.kind, m.path), category: m.kind })
  for (const e of Object.values(ref.events)) out.push({ kind: 'event', name: e.name, display: displayItem('event', e.name), category: 'event' })
  for (const w of Object.values(ref.windows)) {
    const args = w.kind === 'method' ? '' : null
    out.push({ kind: w.kind, name: w.name, display: displayItem(w.kind, w.name, { args }), category: 'window' })
  }
  for (const t of ref.tests.external) out.push({ kind: 'test', name: t, display: displayItem('test', t), category: 'test' })
  for (const t of ref.tests.internal) {
    const name = `internalTest › ${t}`
    out.push({ kind: 'test', name, display: displayItem('test', name), category: 'internal-test' })
  }
  return out
}

module.exports = { buildReference, referenceItems, internalTests, externalTests, fakeJavaClient, MINEFLAYER_VERSION, UPSTREAM_DOCS, REPO_ROOT }
