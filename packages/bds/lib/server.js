// owner: U1 (BDS harness & e2e infra)
'use strict'
const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { EventEmitter } = require('events')
const config = require('./config')
const docker = require('./docker')
const slots = require('./slots')
const instance = require('./instance')
const profiles = require('./profiles')
const snapshots = require('./snapshots')
const { reap, readInstanceMeta } = require('./reaper')
const { Console } = require('./console')

const { LABELS, CONTAINER_PREFIX, IMAGE } = config

/** BDS prints this when it is ready for connections. */
const READY_RE = /^Server started\.$/
/** Fatal startup line (fail fast): BDS exits right after printing it. */
const PORT_IN_USE_RE = /^Port \[(\d+)\] may be in use by another process/
/** Known harmless ERROR lines at startup: the RakNet "TRANSPORT TYPE ERROR" block (RakNet clients connect fine). */
const STARTUP_ERROR_WHITELIST = [
  /TRANSPORT TYPE ERROR/,
  /connection type is not set to NetherNet/,
  /Players will not be able to connect to your game without NetherNet/,
  /set 'transport=nethernet'/,
  /bedrock_server_how_to\.html/,
  /^=+$/,
  /^$/
]

/**
 * transport=nethernet (U16b): BDS serves NetherNet HTTP signalling on TCP `server-port` and prints this line before
 * `Server started.`. When the TCP port is still held (e.g. TIME_WAIT connections of the previous server on the
 * slot), BDS silently runs without the listener and every client gets ECONNREFUSED.
 */
const NETHERNET_LISTEN_RE = /Accepting clients on /

class TcpPortHeldError extends Error {
  constructor (port, slot) {
    super(`TCP port ${port} (slot ${slot}) is still held (NetherNet HTTP signalling needs it)`)
    this.code = 'EBDSTCPHELD'
    this.port = port
    this.slot = slot
  }
}

/** How long a slot whose TCP port was held is skipped (TIME_WAIT lasts 60 s on Linux). */
const TCP_HELD_RETRY_MS = 65000

/** Whether any TCP socket (listening, connected or TIME_WAIT) of this host uses local port `port`. */
function tcpPortHeld (port) {
  const hex = ':' + port.toString(16).toUpperCase().padStart(4, '0')
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n').slice(1)) {
      const local = line.trim().split(/\s+/)[1]
      if (local && local.endsWith(hex)) return true
    }
  }
  return false
}

class PortInUseError extends Error {
  constructor (port, slot) {
    super(`BDS port ${port} (slot ${slot}) is in use by a process outside the harness`)
    this.code = 'EBDSPORTINUSE'
    this.port = port
    this.slot = slot
  }
}

let counter = 0
/** servers started (owned) by this process: removed on exit / signals */
const active = new Set()
let cleanupInstalled = false

function slug (str) {
  return String(str).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(-24) || 'x'
}

/** Synchronous best-effort cleanup of every server owned by this process (exit / signal handlers). */
function cleanupSync () {
  const servers = [...active]
  active.clear()
  if (!servers.length) return
  for (const s of servers) s.console?.detach()
  const names = servers.map((s) => s.container).filter(Boolean)
  if (names.length) {
    try { execFileSync('docker', ['rm', '-f', '-v', ...names], { stdio: 'ignore', timeout: 60000 }) } catch {}
  }
  for (const s of servers) {
    try { instance.removeInstance(s.dir) } catch {}
    try { s._releaseSlot() } catch {}
  }
}

function installCleanup () {
  if (cleanupInstalled) return
  cleanupInstalled = true
  process.on('exit', cleanupSync)
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(sig, () => {
      cleanupSync()
      // if nobody else handles the signal, exit like the default action would
      if (process.listenerCount(sig) === 1) process.exit(code)
    })
  }
}

/**
 * Handle of a BDS instance.
 *
 * - harness servers started by this process (`owned`): console attached with `docker start -a -i`
 *   (stdin + stdout); removed when the process exits;
 * - harness servers of other processes / persistent `bds up` servers (`attachServer`): console via
 *   `docker exec` + `docker logs -f`;
 * - `external` (BDS_HOST/BDS_PORT): console only if BDS_CONTAINER is set; `stop()` only detaches.
 *
 * @property {string} host
 * @property {number} port IPv4 port
 * @property {number} portV6
 * @property {string|null} container
 * @property {number|null} slot
 * @property {boolean} external
 * @property {boolean} owned
 * @property {boolean} persistent
 * @property {string|null} dataDir host path mounted as /data
 * @property {string|null} levelName
 * @property {Record<string,string>|null} properties server.properties values
 * @property {Record<string, boolean|number>} gamerules applied by the profile
 * @property {string[]} startupErrors unexpected ERROR lines printed while starting
 * @property {Console} console
 */
class BdsServer extends EventEmitter {
  constructor (fields) {
    super()
    Object.assign(this, {
      host: '127.0.0.1',
      port: null,
      portV6: null,
      container: null,
      slot: null,
      external: false,
      owned: false,
      persistent: false,
      dir: null,
      dataDir: null,
      levelName: null,
      properties: null,
      gamerules: {},
      startupErrors: [],
      stopped: false,
      _slot: null
    }, fields)
    if (!this.console) this.console = new Console({ name: this.container ?? `${this.host}:${this.port}`, echo: echoFromEnv() })
  }

  /**
   * Run a console command (no leading '/'); resolves with the time it was sent — pass it as
   * `waitForLog(re, { since })` to match the command's output. Commands that print nothing (`say`,
   * `tellraw`, …) resolve once written.
   * @returns {Promise<Date>}
   */
  async command (cmd) {
    const sentAt = new Date()
    await this._console().write(cmd)
    return sentAt
  }

  /**
   * Run a console command and resolve with the message (log prefix stripped) of its first output line
   * matching `matcher` (string = substring, RegExp, or `(message, line) => boolean`). Serialized with
   * other commandWithOutput calls so outputs never interleave.
   * @param {string} cmd
   * @param {string|RegExp|Function} matcher
   * @param {{ timeout?: number }} [opts] default 30 s
   * @returns {Promise<string>}
   */
  async commandWithOutput (cmd, matcher, opts = {}) {
    const { line } = await this._console().commandWithOutput(cmd, matcher, opts)
    return line.message
  }

  /**
   * Run a console command and resolve with ALL messages it printed (log prefix stripped; `[]` for
   * silent commands): the lines between the command and a console marker written right after it.
   * Serialized with the other output-reading calls.
   * @param {string} cmd
   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<string[]>}
   */
  async commandOutput (cmd, opts = {}) {
    const lines = await this._console().commandOutput(cmd, opts)
    return lines.map((l) => l.message)
  }

  /**
   * Resolve with the first log line (raw, with prefix) matching `re` printed at/after `since`
   * (a Date, default now).
   * @returns {Promise<string>}
   */
  async waitForLog (re, { timeout = 30000, since = new Date() } = {}) {
    const t = since instanceof Date ? since.getTime() : Number(since)
    const con = this._console(new Date(t))
    if (this._consoleSince && this._consoleSince.getTime() > t) {
      // the exec console started following the log after `since`: ask docker for the older lines
      return docker.waitForLog(this.container, re, { timeout, since: new Date(t) })
    }
    let seq = con.seq
    for (let i = con.lines.length - 1; i >= 0 && con.lines[i].time >= t; i--) seq = con.lines[i].seq - 1
    const { line } = await con.waitFor(re, { since: seq, timeout })
    return line.raw
  }

  /** Resolve once all console commands written before have been executed (console marker). */
  awaitCommandsProcessed (opts) {
    return this._console().marker(opts)
  }

  /** Last `n` console lines (raw). */
  logs (n = 50) {
    return this.console.tail(n)
  }

  /**
   * Save the world as snapshot `name`: graceful stop (BDS saves everything), copy, start again.
   * Connected players are disconnected (reconnect them afterwards).
   * @param {string} name letters, digits, `.`, `_`, `-`
   * @param {{ overwrite?: boolean, description?: string }} [opts]
   * @returns {Promise<object>} snapshot meta (`name`, `levelName`, `levelType`, `seed`, `files`, `dir`, `world`, …)
   */
  snapshot (name, opts) {
    return snapshots.takeSnapshot(this, name, opts)
  }

  /**
   * Replace the world with snapshot `name`: stops the server (players are disconnected), swaps the
   * world dir, starts it again and waits for "Server started.". Gamerules come from the snapshot.
   */
  async restore (name) {
    this._requireLocal('restore()')
    const snap = snapshots.requireSnapshot(name)
    await this._stopContainer()
    const world = instance.worldDir(this.dataDir, this.levelName)
    fs.rmSync(world, { recursive: true, force: true })
    fs.cpSync(snap.world, world, { recursive: true })
    await this._startContainer()
  }

  /** Graceful stop (world saved) and start again (players are disconnected). */
  async restart () {
    this._requireLocal('restart()')
    await this._stopContainer()
    await this._startContainer()
  }

  /**
   * Stop and remove the container, its instance dir and its slot. External (BDS_HOST) servers are
   * only detached.
   */
  async stop () {
    if (this.stopped) return
    this.stopped = true
    active.delete(this)
    this.console.detach()
    if (this.external) return
    try {
      if (this.container) await docker.removeContainers([this.container])
    } finally {
      instance.removeInstance(this.dir)
      this._releaseSlot()
    }
  }

  /** Stop following the console; the server keeps running. */
  detach () {
    this.console.detach()
  }

  _requireLocal (what) {
    if (this.external || !this.dataDir || !this.container) throw new Error(`${what} needs a harness server (local data dir)`)
  }

  _releaseSlot () {
    if (this._slot) return this._slot.release()
    if (this.slot === null || this.slot === undefined) return
    const dir = config.paths().slots
    const info = slots.readLock(dir, this.slot)
    if (info && info.container === this.container) slots.releaseSlot(dir, this.slot, info.token)
  }

  /** The console, attaching an exec console (log lines from `since`, default now) if needed. */
  _console (since) {
    if (!this.console.hasInput()) this._attachExecConsole(since)
    return this.console
  }

  /**
   * exec-mode console: input via docker exec (lib/docker.sendCommand), output via `docker logs -f`
   * from `since` (default now).
   */
  _attachExecConsole (since = new Date()) {
    if (!this.container) throw new Error('This server has no container (set BDS_CONTAINER) — console commands are unavailable')
    const container = this.container
    this.console.setInput(async (line) => { await docker.sendCommand(container, line) })
    const child = spawn('docker', ['logs', '-f', '--since', since.toISOString(), container], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.unref()
    child.stdout.unref?.()
    child.stderr.unref?.()
    this.console.attachProcess(child)
    this._consoleSince = since
  }

  async _stopContainer () {
    // keep an attached console until the container is down: closing its stdin first would cut the
    // path itzg's entrypoint uses to send "stop" (graceful save) on SIGTERM
    const closed = this.console.child ? new Promise((resolve) => this.console.once('close', resolve)) : null
    await docker.docker(['stop', '-t', '30', this.container], { timeout: 60000 })
    if (closed) await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))])
    this.console.detach()
  }

  /**
   * Start the (created or stopped) container and wait for "Server started.". Owned servers get an
   * attached console (`docker start -a -i`: stdin + stdout, attached before the server starts, in its
   * own process group so terminal signals do not reach it); others an exec console.
   * Rejects with PortInUseError if BDS cannot bind its ports.
   */
  async _startContainer (opts = {}) {
    const timeout = opts.timeout ?? 120000
    const con = this.console
    const nethernet = this.properties?.transport === 'nethernet'
    if (nethernet) {
      // restart / restore / snapshot reuse the port: let the previous run's TIME_WAIT connections clear first
      const until = Date.now() + TCP_HELD_RETRY_MS + 10000
      while (tcpPortHeld(this.port) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    const since = con.seq
    // unexpected ERROR lines up to "Server started." (the RakNet transport block that follows it is
    // harmless; later ERROR lines are command answers, not startup problems)
    const errors = []
    const onLine = (line) => {
      if (line.seq <= since || line.level !== 'ERROR') return
      if (STARTUP_ERROR_WHITELIST.some((re) => re.test(line.message))) return
      errors.push(line.message)
    }
    con.on('line', onLine)
    try {
      if (this.owned) {
        const child = spawn('docker', ['start', '-a', '-i', this.container], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
        child.unref()
        con.attachProcess(child, { useStdin: true })
        for (const s of [child.stdin, child.stdout, child.stderr]) s.unref?.()
        this._consoleSince = null // attached before the server started: every line is there
      } else {
        const startedAt = new Date() // only this run's lines (same host clock as the docker daemon)
        await docker.docker(['start', this.container], { timeout: 60000 })
        this._attachExecConsole(startedAt)
      }
      const { line } = await con.waitFor((msg) => READY_RE.test(msg) || PORT_IN_USE_RE.test(msg), { since, timeout })
      const port = PORT_IN_USE_RE.exec(line.message)
      if (port) throw new PortInUseError(Number(port[1]), this.slot)
      // NetherNet: the HTTP signalling listener is logged before "Server started." — or silently missing
      if (nethernet && !con.linesSince(since).some((l) => NETHERNET_LISTEN_RE.test(l.message))) {
        throw new TcpPortHeldError(this.port, this.slot)
      }
    } catch (err) {
      if (err instanceof PortInUseError || err instanceof TcpPortHeldError) throw err
      const state = await docker.inspect(this.container).catch(() => null)
      throw new Error(`BDS ${this.container} did not start (${state ? `container ${state.State.Status}, exit ${state.State.ExitCode}` : 'container gone'}): ${err.message.split('\n')[0]}\n${con.tail(40).join('\n')}`)
    } finally {
      con.removeListener('line', onLine)
    }
    this.startupErrors = errors
  }

  toJSON () {
    return { host: this.host, port: this.port, portV6: this.portV6, container: this.container, slot: this.slot, external: this.external, persistent: this.persistent }
  }
}

function echoFromEnv () {
  return process.env.BEDBOO_BDS_LOG === '1' || process.env.BEDBOO_BDS_LOG === 'true'
}

/** @returns {BdsServer|null} handle for BDS_HOST/BDS_PORT, or null when unset */
function externalServer (env = process.env) {
  if (!env.BDS_HOST && !env.BDS_PORT) return null
  const host = env.BDS_HOST || '127.0.0.1'
  const port = Number(env.BDS_PORT || 19132)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid BDS_PORT: ${env.BDS_PORT}`)
  return new BdsServer({ host, port, external: true, container: env.BDS_CONTAINER || null })
}

/** `bedboo-<name>` for a short name, the name itself if it already is a container name. */
function containerName (name) {
  return name.startsWith(CONTAINER_PREFIX) ? name : CONTAINER_PREFIX + name
}

/**
 * Handle for an existing harness container (any process, e.g. `bds up` servers) by short name or
 * container name. Console in exec mode; `stop()` removes it, `detach()` leaves it running.
 * @returns {Promise<BdsServer>}
 */
async function attachServer (name) {
  const container = containerName(name)
  let info = await docker.inspect(container)
  let actual = container
  if (!info && name !== container) {
    info = await docker.inspect(name)
    actual = name
  }
  if (!info) throw new Error(`No container ${container}`)
  const labels = info.Config.Labels ?? {}
  const env = Object.fromEntries((info.Config.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
  const managed = labels[LABELS.managed] === '1'
  // never trust a label pointing outside the instances root (stop() deletes `dir`)
  const dir = managed ? instance.safeInstanceDir(labels[LABELS.dir]) : null
  const dataDir = dir ? path.join(dir, 'data') : null
  let props = null
  if (dataDir) {
    try {
      props = require('./properties').toObject(fs.readFileSync(path.join(dataDir, 'server.properties'), 'utf8'))
    } catch {}
  }
  return new BdsServer({
    host: '127.0.0.1',
    port: Number(env.SERVER_PORT || 19132),
    portV6: Number(env.SERVER_PORT_V6 || 19133),
    container: actual,
    slot: managed && labels[LABELS.slot] !== '' ? Number(labels[LABELS.slot]) : null,
    external: !managed, // foreign containers are never removed by stop()
    owned: false,
    persistent: labels[LABELS.persistent] === '1',
    dir,
    dataDir,
    properties: props,
    levelName: props?.['level-name'] ?? null,
    running: info.State.Running
  })
}

/**
 * `bds down`: remove a harness server by name — its container, instance dir and slot. Also cleans up
 * after a container that was removed outside the harness (`docker rm`), so the name can be reused.
 * @returns {Promise<{ container: string, removed: boolean }>} `removed`: a container existed
 */
async function downServer (name) {
  const container = containerName(name)
  if (await docker.inspect(container)) {
    const srv = await attachServer(container)
    if (srv.external) throw new Error(`${container} is not a bedboo harness container`)
    await srv.stop()
    return { container, removed: true }
  }
  const p = config.paths()
  const dir = instance.instanceDir(container, p)
  if (!fs.existsSync(dir)) throw new Error(`No container ${container}`)
  instance.removeInstance(dir, p)
  for (const s of await slots.listSlots()) {
    if (s.info?.container === container) slots.releaseSlot(p.slots, s.slot, s.info.token)
  }
  return { container, removed: false }
}

/**
 * Start an isolated BDS (or return the BDS_HOST/BDS_PORT server).
 *
 * @param {object} [opts]
 * @param {string} [opts.name] instance name → container `bedboo-<name>` (default: unique per process)
 * @param {'flat'|'default'|'seeded'} [opts.world] world generator (default flat; `seed` implies seeded)
 * @param {string|number} [opts.seed] level seed
 * @param {string} [opts.snapshot] start from this world snapshot
 * @param {'survival'|'creative'|'adventure'} [opts.gamemode] default creative
 * @param {'peaceful'|'easy'|'normal'|'hard'} [opts.difficulty] default peaceful
 * @param {string} [opts.levelName] default `bedboo`
 * @param {Record<string, string|number|boolean>} [opts.properties] server.properties overrides
 * @param {'raknet'|'nethernet'} [opts.transport] server transport (default raknet; `nethernet`: BDS's default
 *   transport, joined with `createBot({ transport: 'nethernet' })` over HTTP signalling on the server port)
 * @param {'deterministic'|'none'} [opts.profile] gamerule profile (default deterministic)
 * @param {Record<string, boolean|number>} [opts.gamerules] gamerule overrides on top of the profile
 * @param {boolean} [opts.persistent] keep running after this process exits (`bds up`)
 * @param {number} [opts.slotTimeout] ms to queue for a slot (default BEDBOO_SLOT_TIMEOUT, 15 min)
 * @param {number} [opts.startTimeout] ms to wait for "Server started." (default 120 s)
 * @param {boolean} [opts.useExternal] use BDS_HOST/BDS_PORT when set (default true)
 * @param {(msg: string) => void} [opts.log] progress messages (default console.error)
 * @returns {Promise<BdsServer>}
 */
async function startServer (opts = {}) {
  if (opts.useExternal !== false) {
    const external = externalServer()
    if (external) {
      const rules = profiles.resolveGamerules(opts.profile, opts.gamerules)
      if (external.container && Object.keys(rules).length) await applyGamerules(external, rules)
      return external
    }
  }
  const log = typeof opts.log === 'function' ? opts.log : (msg) => console.error(msg)
  const gamerules = profiles.resolveGamerules(opts.profile, opts.gamerules)
  const snap = opts.snapshot ? snapshots.requireSnapshot(opts.snapshot) : null
  require('./golden').requireGolden()
  if (!opts.persistent) installCleanup()
  // every start (one `docker ps`, shared by concurrent starts of this process): other processes may have
  // died since this one last looked; their containers keep their slots busy until reaped
  const reapNow = () => reapShared((m) => log(`[bedboo] ${m}`))
  await reapNow().catch((err) => log(`[bedboo] reaper failed: ${err.message}`))

  const identity = config.selfIdentity()
  const container = CONTAINER_PREFIX + (opts.name ? validateName(opts.name) : `${slug(path.basename(identity.owner))}-${process.pid}-${++counter}`)
  if (await docker.inspect(container)) throw new Error(`Container ${container} already exists (bds down ${container.slice(CONTAINER_PREFIX.length)})`)
  const leftover = instance.instanceDir(container)
  if (fs.existsSync(leftover)) {
    // no container with this name: a dir left by a removed `bds up` container or a dead process
    const meta = readInstanceMeta(leftover)
    if (meta && !meta.persistent && config.isProcessAlive(meta)) throw new Error(`${leftover} is being used by pid ${meta.pid}`)
    log(`[bedboo] removing stale instance dir ${leftover}`)
    instance.removeInstance(leftover)
  }

  // while queueing, reap dead owners' containers now and then (frees their slots and ports)
  let lastReap = Date.now()
  const onWait = async () => {
    if (Date.now() - lastReap < 10000) return
    lastReap = Date.now()
    await reapNow()
  }
  const exclude = new Set()
  const retried = new Set() // slots retried once their port was free again
  // NetherNet: slots whose TCP port was held → when to try them again (TIME_WAIT clears by itself)
  const tcpHeld = new Map()
  const deadline = Date.now() + (opts.slotTimeout ?? config.limits().slotTimeout)
  for (let attempt = 0; ; attempt++) {
    for (const [s, at] of tcpHeld) if (at <= Date.now()) tcpHeld.delete(s)
    const nextRetry = tcpHeld.size ? Math.min(...tcpHeld.values()) : Infinity
    // while slots are skipped for a held TCP port, queue only until the first of them may be retried
    const timeout = Math.max(1000, Math.min(deadline, nextRetry) - Date.now())
    let slot
    try {
      slot = await slots.acquire({ container, persistent: !!opts.persistent, timeout, exclude: new Set([...exclude, ...tcpHeld.keys()]), log, onWait })
    } catch (err) {
      if (tcpHeld.size && Date.now() < deadline && /^No BDS slot/.test(err.message)) continue
      throw err
    }
    let server
    try {
      server = await launch(container, slot, identity, opts, snap)
    } catch (err) {
      slot.release()
      if (err instanceof TcpPortHeldError && Date.now() < deadline) {
        log(`[bedboo] ${err.message}; trying another slot`)
        tcpHeld.set(slot.slot, Date.now() + TCP_HELD_RETRY_MS)
        continue
      }
      if (err instanceof PortInUseError && attempt < config.limits().maxServers * 2) {
        // a process that died after the last reap may have left its BDS on the port: reap (here or in another
        // process) and try the slot again (once) if the port is free now; otherwise it is used outside the harness
        await reapNow().catch(() => {})
        if (!retried.has(slot.slot) && await udpPortFree(err.port, err.port === slot.ports.v6)) {
          retried.add(slot.slot)
          log(`[bedboo] ${err.message}; the port is free now (a dead owner's server was removed), retrying`)
          continue
        }
        log(`[bedboo] ${err.message}; trying another slot`)
        exclude.add(slot.slot)
        continue
      }
      throw err
    }
    try {
      await applyGamerules(server, gamerules)
      if (snap) server.snapshotName = snap.name
      return server
    } catch (err) {
      await server.stop().catch(() => {})
      throw err
    }
  }
}

let reapInFlight = null
/** reap(), sharing one run between concurrent callers of this process. */
function reapShared (log) {
  if (!reapInFlight) reapInFlight = reap({ log }).finally(() => { reapInFlight = null })
  return reapInFlight
}

/**
 * Whether a UDP port can be bound right now (BDS binds its RakNet ports on every interface; `v6`: probe
 * with an IPv6 socket). Errors other than EADDRINUSE (e.g. no IPv6) count as free.
 */
function udpPortFree (port, v6 = false) {
  return new Promise((resolve) => {
    const socket = require('dgram').createSocket(v6 ? 'udp6' : 'udp4')
    socket.once('error', (err) => {
      try { socket.close() } catch {}
      resolve(err.code !== 'EADDRINUSE')
    })
    socket.bind(port, () => socket.close(() => resolve(true)))
  })
}

function validateName (name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)) {
    throw new Error(`Invalid server name ${JSON.stringify(name)} (letters, digits, _ . -)`)
  }
  return name
}

async function launch (container, slot, identity, opts, snap) {
  const ports = slot.ports
  if (opts.transport === 'nethernet' && tcpPortHeld(ports.v4)) throw new TcpPortHeldError(ports.v4, slot.slot)
  const propOpts = {
    ports,
    serverName: container,
    gamemode: opts.gamemode,
    difficulty: opts.difficulty,
    world: opts.world ?? (snap?.levelType === 'DEFAULT' ? 'default' : undefined),
    seed: opts.seed,
    levelName: opts.levelName,
    transport: opts.transport,
    properties: opts.properties
  }
  const inst = instance.createInstance(container, propOpts, { snapshotWorld: snap?.world })
  const persistent = !!opts.persistent
  const meta = { ...identity, container, slot: slot.slot, persistent, createdAt: new Date().toISOString() }
  if (persistent) Object.assign(meta, { pid: null, pidStart: null })
  fs.writeFileSync(path.join(inst.dir, 'instance.json'), JSON.stringify(meta, null, 2) + '\n')

  const labels = {
    [LABELS.managed]: '1',
    [LABELS.owner]: identity.owner,
    [LABELS.pid]: persistent ? '' : String(identity.pid),
    [LABELS.pidStart]: persistent ? '' : String(identity.pidStart ?? ''),
    [LABELS.host]: identity.host,
    [LABELS.boot]: identity.boot,
    [LABELS.slot]: String(slot.slot),
    [LABELS.dir]: inst.dir,
    [LABELS.persistent]: persistent ? '1' : '0',
    [LABELS.name]: container.slice(CONTAINER_PREFIX.length)
  }
  const args = ['create', '-i', '--name', container, '--network', 'host', '--no-healthcheck', '--stop-timeout', '30']
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`)
  args.push('-v', `${inst.dataDir}:/data`,
    '-e', 'EULA=TRUE', '-e', 'VERSION=EXISTING',
    // itzg's entrypoint rewrites server-port(v6) from these (image defaults 19132/19133)
    '-e', `SERVER_PORT=${ports.v4}`, '-e', `SERVER_PORT_V6=${ports.v6}`,
    IMAGE)

  const server = new BdsServer({
    host: '127.0.0.1',
    port: ports.v4,
    portV6: ports.v6,
    container,
    slot: slot.slot,
    // `bds up` exits right away: an attached stdin would close the server's stdin when it does
    owned: !persistent,
    persistent,
    dir: inst.dir,
    dataDir: inst.dataDir,
    levelName: inst.properties['level-name'],
    properties: inst.properties,
    _slot: slot
  })
  try {
    await docker.docker(args, { timeout: 60000 })
    if (!persistent) active.add(server)
    await server._startContainer({ timeout: opts.startTimeout })
    return server
  } catch (err) {
    active.delete(server)
    server.console.detach()
    await docker.removeContainers([container]).catch(() => {})
    instance.removeInstance(inst.dir)
    throw err
  }
}

/** Apply gamerules through the console, verifying each answer. */
async function applyGamerules (server, rules) {
  for (const { command, expect, failure } of profiles.gameruleCommands(rules)) {
    const msg = await server.commandWithOutput(command, (m) => expect.test(m) || failure.test(m), { timeout: 15000 })
    if (!expect.test(msg)) throw new Error(`${command} failed: ${msg}`)
  }
  server.gamerules = { ...server.gamerules, ...rules }
}

module.exports = {
  BdsServer,
  PortInUseError,
  TcpPortHeldError,
  tcpPortHeld,
  NETHERNET_LISTEN_RE,
  startServer,
  externalServer,
  attachServer,
  downServer,
  containerName,
  applyGamerules,
  cleanupSync,
  READY_RE,
  PORT_IN_USE_RE,
  STARTUP_ERROR_WHITELIST,
  udpPortFree,
  _active: active
}
