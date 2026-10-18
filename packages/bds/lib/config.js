// owner: U1 (BDS harness & e2e infra)
'use strict'
const os = require('os')
const path = require('path')
const fs = require('fs')

/**
 * Pinned versions, host paths and environment knobs of the harness. Everything is computed lazily
 * from `process.env` so tests can point the harness at a temporary cache.
 */

/** BDS build under test (bedrock-protocol 3.60.1 `1.26.51`, protocol 2193). */
const BDS_VERSION = '1.26.51.1'
/** Official Linux zip of {@link BDS_VERSION}, pinned by size + sha256 (verified with the server's Content-MD5). */
const BDS_ZIP = {
  url: `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${BDS_VERSION}.zip`,
  size: 94926669,
  sha256: 'ad91d3b824e51ea50b5bb601c295cbd8f543a29b14315c2ad89ff27311e2d860'
}
/** itzg/minecraft-bedrock-server (MIT), pinned by tag + digest. Only its entrypoint is used (VERSION=EXISTING). */
const IMAGE = 'itzg/minecraft-bedrock-server:2026.10.1@sha256:6ff3abf645a88c5aafd88b7cf96d35cdfb1e0977a0c45c465a5b536cb1f1c4f9'
/** Name of the server binary inside /data (itzg's `VERSION=EXISTING` and `send-command` look for `bedrock_server-*`). */
const SERVER_BINARY = `bedrock_server-${BDS_VERSION}`

/** Host-network ports of slot n: `PORT_BASE + 2n` (IPv4) and `+1` (IPv6). 40100–40121 are manual (pre-harness) ports. */
const DEFAULT_PORT_BASE = 41000
const DEFAULT_MAX_SERVERS = 6
const DEFAULT_WORKER_SLOTS = 2

/** Docker labels set on every harness container. */
const LABELS = {
  managed: 'bedboo.managed',
  owner: 'bedboo.owner',
  pid: 'bedboo.pid',
  pidStart: 'bedboo.pidstart',
  host: 'bedboo.host',
  boot: 'bedboo.boot',
  slot: 'bedboo.slot',
  dir: 'bedboo.dir',
  persistent: 'bedboo.persistent',
  name: 'bedboo.name'
}
const CONTAINER_PREFIX = 'bedboo-'

function intFromEnv (name, fallback, env = process.env) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${name}: ${raw}`)
  return n
}

/** Root of every harness file: `$BEDBOO_CACHE` or `${XDG_CACHE_HOME:-~/.cache}/bedboo`. */
function cacheRoot (env = process.env) {
  if (env.BEDBOO_CACHE) return path.resolve(env.BEDBOO_CACHE)
  const base = env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(os.homedir(), '.cache')
  return path.join(base, 'bedboo')
}

function paths (env = process.env) {
  const root = cacheRoot(env)
  return {
    root,
    /** golden, read-only BDS install (extracted zip) */
    golden: path.join(root, 'bds', BDS_VERSION),
    downloads: path.join(root, 'downloads'),
    zip: path.join(root, 'downloads', `bedrock-server-${BDS_VERSION}.zip`),
    /** host-wide slot registry (`<n>.lock`) */
    slots: path.join(root, 'slots'),
    /** per-instance /data dirs (`<container>/data`) */
    instances: path.join(root, 'instances'),
    /** world snapshots (`<name>/world`, `<name>/meta.json`) */
    snapshots: path.join(root, 'snapshots')
  }
}

function limits (env = process.env) {
  return {
    portBase: intFromEnv('BEDBOO_PORT_BASE', DEFAULT_PORT_BASE, env),
    maxServers: intFromEnv('BEDBOO_MAX_SERVERS', DEFAULT_MAX_SERVERS, env),
    workerSlots: intFromEnv('BEDBOO_WORKER_SLOTS', DEFAULT_WORKER_SLOTS, env),
    /** how long startServer() queues for a free slot (ms) */
    slotTimeout: intFromEnv('BEDBOO_SLOT_TIMEOUT', 15 * 60 * 1000, env)
  }
}

/** @returns {{ v4: number, v6: number }} */
function slotPorts (slot, portBase = limits().portBase) {
  return { v4: portBase + 2 * slot, v6: portBase + 2 * slot + 1 }
}

/**
 * Owner key of this process: `$BEDBOO_OWNER`, else the git worktree containing the cwd (each worker
 * has its own worktree), else the cwd. Used for the per-worker slot cap and `bds clean`.
 */
function ownerKey (env = process.env, cwd = process.cwd()) {
  if (env.BEDBOO_OWNER) return env.BEDBOO_OWNER
  let dir = path.resolve(cwd)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(cwd)
    dir = parent
  }
}

/** Linux boot id (pids are only comparable within one boot). */
function bootId () {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Start time of a process in clock ticks since boot (field 22 of /proc/<pid>/stat), or null if it
 * does not exist. Together with the pid it identifies a process even when pids are reused.
 */
function processStartTime (pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // the command name (field 2) may contain spaces and parentheses: split after the last ')'
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] // field 22 overall = index 19 after "pid (comm)"
  } catch {
    return null
  }
}

/**
 * Whether the process identified by (pid, start time, boot id) is still alive on this host.
 * Without /proc (non-Linux) only `kill(pid, 0)` is used.
 */
function isProcessAlive ({ pid, pidStart, boot, host }) {
  pid = Number(pid)
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (host && host !== os.hostname()) return true // another host sharing the cache: cannot tell, assume alive
  if (boot && boot !== 'unknown' && bootId() !== 'unknown' && boot !== bootId()) return false
  if (fs.existsSync('/proc/self/stat')) {
    const start = processStartTime(pid)
    if (start === null) return false
    return !pidStart || String(pidStart) === String(start)
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** Identity of the current process, stored in slot locks and container labels. */
function selfIdentity () {
  return {
    pid: process.pid,
    pidStart: processStartTime(process.pid),
    boot: bootId(),
    host: os.hostname(),
    owner: ownerKey()
  }
}

module.exports = {
  BDS_VERSION,
  BDS_ZIP,
  IMAGE,
  SERVER_BINARY,
  DEFAULT_PORT_BASE,
  DEFAULT_MAX_SERVERS,
  DEFAULT_WORKER_SLOTS,
  LABELS,
  CONTAINER_PREFIX,
  cacheRoot,
  paths,
  limits,
  slotPorts,
  ownerKey,
  bootId,
  processStartTime,
  isProcessAlive,
  selfIdentity
}
