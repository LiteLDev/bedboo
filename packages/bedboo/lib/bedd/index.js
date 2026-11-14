'use strict'
/**
 * `transport: 'bedd'` entry point: createBeddClient(options) and the `client.bedd` surface.
 *
 *   client.bedd = {
 *     rpc: { call(op, args?, opts?), probe(op), supports(op) },   // control connection (lib/bedd/rpc.js)
 *     url, endpoint: { url, pid?, instance?, label? },             // the BeDD WebSocket (lib/bedd/discovery.js)
 *     caps: { [op]: 'present' | 'disabled' | 'absent' },           // filled by negotiate() before the tap opens
 *     sendAllow: number[] | null,                                  // the packet ids `send` accepts (its probe's `allow`)
 *     actions: string[] | null,                                    // the `action` names (its probe's `names`: drop, …, swing)
 *     joined: object | null,                                       // the `join` reply when createBot's host made the client join
 *     supports(op),                                                // caps[op] === 'present'
 *     ready,                                                       // Promise<caps> (never rejects)
 *     link: { state: 'unknown' | 'up' | 'down', type?, address?, reason? },
 *     hello, journal, replayed,                                    // tap HELLO / REPLAY_END details
 *     control: { protocol, pid, defaultMode, modes },              // ping
 *     capabilities: { ownsLogin, ownsLoadingScreen, ownsChunkRequests, ownsMovement },  // all true
 *     route(name, params),                                         // what the bot would send; default: drop + count
 *     dropped: { [name]: count },                                  // counts of the default route
 *     modules: { [name]: module },                                 // optional modules attach() loaded
 *     attach(bot)                                                  // called by the loader
 *   }
 *
 * Optional modules (the other bedd units) live in lib/bedd/<name>.js and export `attach(bot, client)`. attach()
 * requires each one with a guarded require: a missing file is skipped, any other error (a broken module, a missing
 * dependency of a present module) is thrown. They are attached once the bot's plugins are injected
 * ('inject_allowed'), in OPTIONAL_MODULES order; then the WebSockets are opened. A module replaces or wraps
 * `client.bedd.route` to translate what the bot sends.
 */
const path = require('path')
const { createBeddClient: createClientCore, beddOptions } = require('./client')
const { resolveEndpoint, listEndpoints, beddHome } = require('./discovery')
const { CONTROL_PROTOCOL, probeResult } = require('./rpc')

/** optional modules, in attach order (bedd-bedboo spec OVERRIDES) */
const OPTIONAL_MODULES = Object.freeze(['authority', 'router', 'router_actions', 'follower', 'surface', 'inventory', 'screens'])
/** ops negotiated with a no-argument call (wire protocol B "New ops" + BD9 `stack`; `join` and `ui` of BeDD v2) */
const PROBE_OPS = Object.freeze(['tap', 'world', 'look', 'input', 'slot', 'button', 'action', 'send', 'stack', 'join', 'ui', 'settings'])
/** probe arguments of ops whose read form would be expensive (`ui` reads the whole UI tree) */
const PROBE_ARGS = Object.freeze({ ui: { format: 'json', depth: 1, maxNodes: 1 } })
/** ops every BeDD build has (present once `ping` answers, unless `ping.modes` leaves one out) */
const BASE_OPS = Object.freeze(['ping', 'state', 'window', 'focus', 'key', 'text', 'mouse', 'raw', 'release', 'flush'])
/** per-probe timeout: an op that does not answer counts as absent */
const PROBE_TIMEOUT_MS = 2000

const CAPABILITIES = Object.freeze({ ownsLogin: true, ownsLoadingScreen: true, ownsChunkRequests: true, ownsMovement: true })

/**
 * Require lib/bedd/<name>.js if it exists. Only MODULE_NOT_FOUND for that exact file is swallowed (→ null).
 * @param {string} name
 * @param {string} [dir] directory to look in (tests)
 */
function loadOptionalModule (name, dir = __dirname) {
  const file = path.join(dir, `${name}.js`)
  try {
    return require(file)
  } catch (err) {
    if (err?.code === 'MODULE_NOT_FOUND' && String(err.message).split('\n')[0].includes(`'${file}'`)) return null
    throw err
  }
}

/**
 * Build `client.bedd` (used by createBeddClient).
 * @param {import('events').EventEmitter} client
 * @param {{ rpc: object, bedd: object }} ctx
 */
function createBeddApi (client, { rpc, bedd: opts }) {
  const caps = {}
  let attachRequested = false
  let attached = false

  const bedd = {
    url: opts.endpoint?.url,
    endpoint: opts.endpoint,
    rpc: {
      call: (op, args, callOpts) => rpc.call(op, args, callOpts),
      probe: (op, probeOpts) => rpc.probe(op, probeOpts),
      supports: (op) => caps[op] === 'present'
    },
    caps,
    sendAllow: null,
    actions: null,
    joined: null,
    supports: (op) => caps[op] === 'present',
    ready: null,
    link: { state: 'unknown' },
    hello: null,
    journal: null,
    replayed: null,
    control: null,
    capabilities: CAPABILITIES,
    dropped: {},
    route (name) {
      bedd.dropped[name] = (bedd.dropped[name] ?? 0) + 1
    },
    modules: {},
    negotiate,
    attach
  }
  let resolveReady
  bedd.ready = new Promise((resolve) => { resolveReady = resolve })
  client.once('close', () => resolveReady(caps))

  /**
   * `ping`, then every PROBE_OPS op once without arguments (`ping.modes` lists the ops the game has: one it does
   * not list is 'absent' without a probe; the probe still tells 'disabled' apart). Without a control connection
   * every op is 'absent' (the tap may still work: read-only observation). A BeDD that is not protocol 2 rejects.
   */
  async function negotiate () {
    let ping = null
    try {
      ping = await rpc.call('ping', {}, { timeoutMs: PROBE_TIMEOUT_MS })
    } catch (err) {
      client.emit('warning', Object.assign(new Error(`${err.message} — no actions, observation only`), { code: err.code ?? 'ERR_BEDD_RPC', cause: err }))
    }
    let listed = null
    if (ping) {
      if (typeof ping.protocol !== 'number' || ping.protocol < CONTROL_PROTOCOL) {
        throw Object.assign(new Error(`BeDD control protocol ${ping.protocol}: BeDD v1 uses named pipes; upgrade BeDD (bedboo speaks protocol ${CONTROL_PROTOCOL}, WebSocket)`), { code: 'ERR_BEDD_PROTOCOL' })
      }
      if (ping.protocol > CONTROL_PROTOCOL) {
        client.emit('warning', Object.assign(new Error(`BeDD control protocol ${ping.protocol} (bedboo speaks ${CONTROL_PROTOCOL})`), { code: 'ERR_BEDD_RPC' }))
      }
      bedd.control = { protocol: ping.protocol, pid: ping.pid, defaultMode: ping.defaultMode, modes: ping.modes }
      if (ping.modes && typeof ping.modes === 'object') {
        listed = new Set(['ping', 'state', 'tap', ...Object.values(ping.modes).flatMap(ops => Array.isArray(ops) ? ops : [])])
      }
      for (const op of BASE_OPS) caps[op] = !listed || listed.has(op) ? 'present' : 'absent'
      // every other op a mode lists (screenshot, ui, …): present; the probes below refine theirs
      for (const op of listed ?? []) caps[op] ??= 'present'
    }
    // one probe that does not answer means BeDD is stuck on it: the rest would only queue behind it
    let stuck = !ping
    for (const op of PROBE_OPS) {
      if (stuck || (listed && !listed.has(op))) {
        caps[op] = 'absent'
        continue
      }
      try {
        const reply = await rpc.call(op, { ...PROBE_ARGS[op] }, { timeoutMs: PROBE_TIMEOUT_MS })
        // the `tap` status read answers even with config tap:false (then a subscribe gets code 'disabled')
        caps[op] = op === 'tap' && reply.enabled === false ? 'disabled' : 'present'
        if (op === 'send' && Array.isArray(reply.allow)) bedd.sendAllow = reply.allow.filter(Number.isInteger)
        if (op === 'action' && Array.isArray(reply.names)) bedd.actions = reply.names.map(String)
      } catch (err) {
        caps[op] = probeResult(err)
        if (err.code === 'ERR_BEDD_RPC_TIMEOUT' || err.code === 'ERR_BEDD_RPC_CLOSED') stuck = true
      }
    }
    resolveReady(caps)
    return caps
  }

  /**
   * Called by the loader (`bot._client.bedd?.attach(bot)`): once the plugins are injected, attach the optional
   * modules, then open the WebSockets.
   * @param {object} bot
   */
  function attach (bot) {
    if (attachRequested) return
    attachRequested = true
    client.on('warning', (err) => bot._warn?.(err?.message ?? err))
    bot.once('inject_allowed', () => {
      attachModules(bot)
      client.start()
    })
  }

  function attachModules (bot) {
    if (attached) return
    attached = true
    for (const name of opts.modules ?? OPTIONAL_MODULES) {
      const mod = loadOptionalModule(name)
      if (!mod) continue
      bedd.modules[name] = mod
      if (typeof mod.attach === 'function') mod.attach(bot, client)
    }
  }

  // the control connection went away mid-session: nothing can be asked any more
  rpc.on('close', () => {
    if (!bedd.control) return
    for (const op of Object.keys(caps)) caps[op] = 'absent'
    client.emit('warning', Object.assign(new Error('BeDD control connection closed: no actions any more, observation only'), { code: 'ERR_BEDD_RPC_CLOSED' }))
  })

  // standalone use (no bot): open the WebSockets on the next turn unless attach() takes over
  setImmediate(() => { if (!attachRequested) client.start() })
  return bedd
}

/**
 * The `_client` for `createBot({ transport: 'bedd', bedd: { url, token } | { pid } | { instance } | {} })` (plus
 * `timeoutMs?`, `modules?`, `home?`, `WebSocket?`).
 * @param {object} options
 */
function createBeddClient (options = {}) {
  return createClientCore(options, { createApi: createBeddApi })
}

module.exports = {
  createBeddClient,
  createBeddApi,
  loadOptionalModule,
  beddOptions,
  resolveEndpoint,
  listEndpoints,
  beddHome,
  OPTIONAL_MODULES,
  PROBE_OPS,
  PROBE_ARGS,
  BASE_OPS,
  CAPABILITIES
}
