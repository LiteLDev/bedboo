'use strict'
/**
 * Be.D.D. v2 endpoint discovery and the `bedd` options.
 *
 * While its WebSocket server listens, every BeDD game (and BeDD-server) writes `<BeDD home>\run\<pid>.json` and
 * deletes it at exit; the home is `%LOCALAPPDATA%\BeDD`, or $BEDD_HOME:
 *
 *   { "protocol": 2, "kind": "client" | "server", "pid": 1234, "url": "ws://127.0.0.1:53021/v1",
 *     "token": "<64 hex>", "instance": "<instance folder name>", "instanceDir": "C:\\…", "label": "…",
 *     "modVersion": "…", "startedAt": "RFC3339" }
 *
 * A file whose pid is gone is stale (a game that crashed): it is skipped. bedboo drives clients, so only
 * `kind: "client"` endpoints are picked.
 *
 *   resolveEndpoint({ url, token })   // as given
 *   resolveEndpoint({ pid: 1234 })    // that game's run file
 *   resolveEndpoint({ instance: '1.26.60.05-2' })
 *   resolveEndpoint({})               // the only running client, else an error listing them
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

/** protocol family of the game BeDD v2 runs (Minecraft Bedrock 1.26.60 GDK): `transport: 'bedd'`'s default version */
const BEDD_VERSION = '1.26.60'

function discoveryError (message, extra) {
  return Object.assign(new Error(message), { code: 'ERR_BEDD_DISCOVERY' }, extra)
}

/** BeDD's home folder: $BEDD_HOME, else %LOCALAPPDATA%\BeDD */
function beddHome (env = process.env) {
  const home = env.BEDD_HOME?.trim()
  if (home) return path.resolve(home)
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'BeDD')
}

/** is the process `pid` alive? (EPERM: it exists, it is just not ours to signal) */
function isAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * The endpoints announced under `<home>\run`, oldest first; unreadable files and files of dead processes are
 * skipped.
 * @param {{ home?: string, alive?: (pid: number) => boolean }} [opts]
 * @returns {Array<{ protocol: number, kind: string, pid: number, url: string, token: string, instance?: string, instanceDir?: string, label?: string, modVersion?: string, startedAt?: string, file: string }>}
 */
function listEndpoints ({ home = beddHome(), alive = isAlive } = {}) {
  const dir = path.join(home, 'run')
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const endpoints = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const file = path.join(dir, name)
    let ep
    try {
      ep = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue // being written or deleted right now
    }
    if (!ep || typeof ep !== 'object' || typeof ep.url !== 'string' || !ep.url || !Number.isInteger(ep.pid)) continue
    if (!alive(ep.pid)) continue
    endpoints.push({ ...ep, file }) // `kind` is always written: a file without it is never taken for a client
  }
  endpoints.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')))
  return endpoints
}

function describeEndpoint (ep) {
  return `pid ${ep.pid}${ep.instance ? ` instance ${ep.instance}` : ''}${ep.label ? ` (${ep.label})` : ''}`
}

/**
 * The endpoint for `bedd` options: `{ url, token }` as given, else a run file picked by `pid`, `instance`, or the
 * only running client.
 * @param {{ url?: string, token?: string, pid?: number, instance?: string, home?: string }} bedd
 * @returns {{ url: string, token: string, pid?: number, instance?: string, label?: string, protocol?: number }}
 */
function resolveEndpoint (bedd = {}, { alive } = {}) {
  if (bedd.url !== undefined) {
    checkUrl(bedd)
    return { url: bedd.url, token: bedd.token }
  }
  const home = bedd.home ?? beddHome()
  const all = listEndpoints({ home, alive })
  const clients = all.filter(ep => ep.kind === 'client')
  const where = path.join(home, 'run')
  let picked
  if (bedd.pid !== undefined) {
    picked = all.find(ep => ep.pid === Number(bedd.pid))
    if (!picked) throw discoveryError(`no running BeDD game with pid ${bedd.pid} (no live ${path.join(where, `${bedd.pid}.json`)})`)
  } else if (bedd.instance !== undefined) {
    const wanted = String(bedd.instance).toLowerCase()
    const matches = clients.filter(ep => String(ep.instance ?? '').toLowerCase() === wanted)
    if (matches.length === 0) throw discoveryError(`no running BeDD game of instance '${bedd.instance}'${clients.length ? `; running: ${clients.map(describeEndpoint).join(', ')}` : ` (nothing announced in ${where})`}`)
    if (matches.length > 1) throw discoveryError(`${matches.length} BeDD games of instance '${bedd.instance}' run (${matches.map(describeEndpoint).join(', ')}): pass bedd.pid`)
    picked = matches[0]
  } else {
    if (clients.length === 0) throw discoveryError(`no BeDD game is running (nothing announced in ${where}); start one with \`BeDD.exe launch --slot 2\`, or pass bedd: { url, token }`)
    if (clients.length > 1) throw discoveryError(`${clients.length} BeDD games are running (${clients.map(describeEndpoint).join(', ')}): pass bedd.pid or bedd.instance`)
    picked = clients[0]
  }
  if (picked.kind !== 'client') throw discoveryError(`BeDD ${describeEndpoint(picked)} is a ${picked.kind}, not a game client: bedboo drives a client`)
  if (typeof picked.token !== 'string' || !picked.token) throw discoveryError(`${picked.file} has no token`)
  return { url: picked.url, token: picked.token, pid: picked.pid, instance: picked.instance, label: picked.label, protocol: picked.protocol }
}

/** throws a TypeError unless `bedd.url` is a ws:// URL with a `bedd.token` */
function checkUrl (bedd) {
  if (typeof bedd.url !== 'string' || !/^wss?:\/\//i.test(bedd.url)) throw new TypeError(`bedd.url must be a ws:// URL (got ${JSON.stringify(bedd.url)})`)
  if (typeof bedd.token !== 'string' || !bedd.token) throw new TypeError('bedd.url needs bedd.token (the token in the game\'s run file)')
}

/** options BeDD v1 had (named pipes) */
const REMOVED_OPTIONS = Object.freeze(['pipe', 'tapPipe', 'connect'])

/**
 * Resolved `bedd` options. Discovery runs later (createBeddClient) so a missing game is an 'error' event, not a
 * throw from createBot; malformed options throw here.
 * @param {object} options createBot options
 */
function beddOptions (options) {
  const given = options.bedd ?? {}
  if (typeof given !== 'object') throw new TypeError('bedd options must be an object')
  for (const key of REMOVED_OPTIONS) {
    if (given[key] !== undefined) {
      throw new TypeError(`bedd.${key} was removed: BeDD v2 has no named pipes. Pass bedd: { url, token } (from the game's %LOCALAPPDATA%\\BeDD\\run\\<pid>.json), bedd: { pid }, bedd: { instance }, or bedd: {} when one game runs`)
    }
  }
  if (given.url !== undefined && (given.pid !== undefined || given.instance !== undefined)) throw new TypeError('bedd: pass either { url, token }, { pid } or { instance }')
  if (given.url !== undefined) checkUrl(given)
  return { ...given }
}

module.exports = { BEDD_VERSION, beddHome, isAlive, listEndpoints, resolveEndpoint, beddOptions, REMOVED_OPTIONS }
