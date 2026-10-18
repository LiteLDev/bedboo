// owner: U1 (BDS harness & e2e infra)
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { paths, limits, slotPorts, selfIdentity, isProcessAlive } = require('./config')

/**
 * Host-wide BDS slot registry: `<cache>/slots/<n>.lock`, n in [0, BEDBOO_MAX_SERVERS).
 *
 * - Every change to the registry (take, reclaim, release) happens while holding the registry mutex
 *   `<cache>/slots/registry.lock`, created with O_CREAT|O_EXCL (`open(…, 'wx')`). The mutex records
 *   its holder; a mutex whose holder process is dead is stolen with an atomic rename. Inside the
 *   mutex the caps are exact.
 * - `<n>.lock` (JSON: slot, token, pid, pid start time, boot id, host, owner, container, persistent,
 *   ports, createdAt) is also created with O_EXCL. A lock is *live* while its owner process runs (pid
 *   + start time + boot id), or, for persistent servers (`bds up`), while its container exists.
 *   Locks of dead owners are replaced.
 * - Per-worker cap: at most BEDBOO_WORKER_SLOTS live locks with the same owner key (git worktree).
 * - When nothing is free, acquire() queues (polls every ~1 s) until BEDBOO_SLOT_TIMEOUT and reports
 *   who holds the slots.
 * Slot n uses ports BEDBOO_PORT_BASE + 2n (IPv4) and + 2n + 1 (IPv6).
 */

const POLL_MS = 1000
const PERSISTENT_GRACE_MS = 3 * 60 * 1000
const MUTEX = 'registry.lock'
const MUTEX_TIMEOUT_MS = 30000

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function lockPath (dir, slot) {
  return path.join(dir, `${slot}.lock`)
}

function readJson (file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(text)
  } catch {
    return { corrupt: true, token: `corrupt-${text.length}` }
  }
}

/** @returns {object|null} parsed lock content (null if missing) */
function readLock (dir, slot) {
  return readJson(lockPath(dir, slot))
}

// ---------------------------------------------------------------------------------------------
// registry mutex

/** Try to take the mutex once. @returns {string|null} our token */
function tryMutex (dir) {
  const file = path.join(dir, MUTEX)
  const token = crypto.randomBytes(8).toString('hex')
  let fd
  try {
    fd = fs.openSync(file, 'wx')
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    stealDeadMutex(file)
    return null
  }
  try {
    fs.writeSync(fd, JSON.stringify({ ...selfIdentity(), token, at: Date.now() }))
  } finally {
    fs.closeSync(fd)
  }
  return token
}

/** Remove the mutex if its holder is dead (or it stayed empty/corrupt for 5 s). */
function stealDeadMutex (file) {
  let st
  try { st = fs.statSync(file) } catch { return }
  const holder = readJson(file)
  if (!holder) return
  const dead = holder.corrupt ? Date.now() - st.mtimeMs > 5000 : !isProcessAlive(holder)
  if (!dead) return
  // atomic: exactly one stealer moves this inode away; verify it is the dead holder's file
  const junk = `${file}.dead-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  try {
    fs.renameSync(file, junk)
  } catch {
    return
  }
  const moved = readJson(junk)
  if (moved && moved.token !== holder.token) {
    // raced with a fresh holder: put its mutex back
    try { fs.linkSync(junk, file) } catch {}
  }
  fs.rmSync(junk, { force: true })
}

function releaseMutex (dir, token) {
  const file = path.join(dir, MUTEX)
  const current = readJson(file)
  if (current && current.token === token) fs.rmSync(file, { force: true })
}

/** Run `fn` (sync or async) holding the registry mutex. */
async function withRegistry (dir, fn) {
  fs.mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + MUTEX_TIMEOUT_MS
  let token
  while (!(token = tryMutex(dir))) {
    if (Date.now() > deadline) throw new Error(`slot registry mutex ${path.join(dir, MUTEX)} held for more than ${MUTEX_TIMEOUT_MS} ms: ${JSON.stringify(readJson(path.join(dir, MUTEX)))}`)
    await sleep(5 + Math.random() * 20)
  }
  try {
    return await fn()
  } finally {
    releaseMutex(dir, token)
  }
}

/** Synchronous variant (exit handlers); falls back to running unlocked after `timeout` ms. */
function withRegistrySync (dir, fn, timeout = 5000) {
  if (!fs.existsSync(dir)) return fn()
  const deadline = Date.now() + timeout
  let token
  while (!(token = tryMutex(dir))) {
    if (Date.now() > deadline) return fn()
    sleepSync(5 + Math.random() * 20)
  }
  try {
    return fn()
  } finally {
    releaseMutex(dir, token)
  }
}

// ---------------------------------------------------------------------------------------------
// locks

/**
 * @param {object} info lock content
 * @param {{ containerExists?: (name: string) => Promise<boolean>, isProcessAlive?: Function }} deps
 * @returns {Promise<boolean>}
 */
async function isLockAlive (info, deps = {}) {
  if (!info || info.corrupt) return false
  if (info.persistent) {
    if (!info.container) return false
    // the container is created a moment after the lock: young locks are alive
    if (Date.now() - Date.parse(info.createdAt) < PERSISTENT_GRACE_MS) return true
    const exists = deps.containerExists ?? defaultContainerExists
    try {
      return await exists(info.container)
    } catch {
      return true // docker unavailable: cannot tell, keep the lock
    }
  }
  return (deps.isProcessAlive ?? isProcessAlive)(info)
}

async function defaultContainerExists (name) {
  const docker = require('./docker')
  return (await docker.inspect(name)) !== null
}

/** Create `<n>.lock` with O_EXCL; false if it exists. */
function tryCreate (dir, slot, info) {
  let fd
  try {
    fd = fs.openSync(lockPath(dir, slot), 'wx')
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
  try {
    fs.writeSync(fd, JSON.stringify(info, null, 2) + '\n')
  } finally {
    fs.closeSync(fd)
  }
  return true
}

/**
 * Snapshot of all slots.
 * @returns {Promise<Array<{ slot: number, ports: object, info: object|null, alive: boolean }>>}
 */
async function listSlots (opts = {}) {
  const dir = opts.dir ?? paths().slots
  const { maxServers, portBase } = { ...limits(), ...opts.limits }
  const out = []
  for (let slot = 0; slot < maxServers; slot++) {
    const info = fs.existsSync(dir) ? readLock(dir, slot) : null
    out.push({ slot, ports: slotPorts(slot, portBase), info, alive: info ? await isLockAlive(info, opts.deps) : false })
  }
  return out
}

function describeHolders (states) {
  return states.filter((s) => s.info).map((s) => {
    const i = s.info
    const who = i.persistent ? 'persistent' : `pid ${i.pid}`
    return `  slot ${s.slot} (port ${s.ports.v4}): ${i.container ?? '?'} ${who} owner ${i.owner ?? '?'}${s.alive ? '' : ' [stale]'}`
  }).join('\n')
}

/**
 * Acquire a slot (queueing while none is free).
 * @param {object} [opts]
 * @param {string} [opts.container] container name stored in the lock
 * @param {boolean} [opts.persistent] lock lives as long as the container (`bds up`)
 * @param {number} [opts.timeout] queue timeout (ms), default BEDBOO_SLOT_TIMEOUT
 * @param {Set<number>|number[]} [opts.exclude] slots not to use (e.g. port found occupied)
 * @param {(msg: string) => void} [opts.log] queue progress messages (default console.error)
 * @param {() => Promise<void>} [opts.onWait] called before each wait (e.g. reap dead owners' containers)
 * @param {string} [opts.dir] registry dir (tests)
 * @param {object} [opts.limits] { maxServers, workerSlots, portBase } overrides (tests)
 * @param {object} [opts.identity] { pid, pidStart, boot, host, owner } overrides (tests)
 * @param {object} [opts.deps] { isProcessAlive, containerExists } (tests)
 * @returns {Promise<{ slot: number, ports: { v4: number, v6: number }, token: string, info: object,
 *   release: () => void, update: (fields: object) => void }>}
 */
async function acquire (opts = {}) {
  const dir = opts.dir ?? paths().slots
  const lim = { ...limits(), ...opts.limits }
  const identity = { ...selfIdentity(), ...opts.identity }
  const timeout = opts.timeout ?? lim.slotTimeout
  const exclude = new Set(opts.exclude ?? [])
  const log = opts.log ?? ((msg) => console.error(msg))
  if (lim.maxServers < 1) throw new Error('BEDBOO_MAX_SERVERS must be >= 1')
  if (lim.workerSlots < 1) throw new Error('BEDBOO_WORKER_SLOTS must be >= 1')

  const started = Date.now()
  let lastReport = 0
  for (;;) {
    const attempt = await withRegistry(dir, async () => {
      const states = []
      let ownLive = 0
      for (let slot = 0; slot < lim.maxServers; slot++) {
        const info = readLock(dir, slot)
        const alive = info ? await isLockAlive(info, opts.deps) : false
        if (info && alive && info.owner === identity.owner) ownLive++
        states.push({ slot, info, alive, ports: slotPorts(slot, lim.portBase) })
      }
      if (ownLive >= lim.workerSlots) return { states, ownLive }
      for (const s of states) {
        if (exclude.has(s.slot) || (s.info && s.alive)) continue
        if (s.info) fs.rmSync(lockPath(dir, s.slot), { force: true }) // dead owner
        const info = {
          slot: s.slot,
          token: `${identity.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
          pid: opts.persistent ? null : identity.pid,
          pidStart: opts.persistent ? null : identity.pidStart,
          boot: identity.boot,
          host: identity.host,
          owner: identity.owner,
          container: opts.container ?? null,
          persistent: !!opts.persistent,
          ports: s.ports,
          createdAt: new Date().toISOString()
        }
        if (tryCreate(dir, s.slot, info)) return { handle: makeHandle(dir, s.slot, info) }
      }
      return { states, ownLive }
    })
    if (attempt.handle) return attempt.handle

    const { states, ownLive } = attempt
    const why = ownLive >= lim.workerSlots
      ? `this worker (${identity.owner}) already holds ${ownLive}/${lim.workerSlots} slots (BEDBOO_WORKER_SLOTS)`
      : `all ${lim.maxServers} slots are busy (BEDBOO_MAX_SERVERS)`
    const waited = Date.now() - started
    if (waited >= timeout) throw new Error(`No BDS slot after ${Math.round(waited / 1000)} s: ${why}\n${describeHolders(states)}`)
    if (Date.now() - lastReport >= 60000) {
      lastReport = Date.now()
      log(`[bedboo] waiting for a BDS slot: ${why}; holders:\n${describeHolders(states)}`)
    }
    if (opts.onWait) await opts.onWait().catch(() => {})
    await sleep(Math.min(POLL_MS + Math.random() * 500, Math.max(1, timeout - (Date.now() - started))))
  }
}

function makeHandle (dir, slot, info) {
  let released = false
  return {
    slot,
    ports: info.ports,
    token: info.token,
    info,
    /** rewrite the lock with extra fields (same token) */
    update (fields) {
      if (released) return
      withRegistrySync(dir, () => {
        const current = readLock(dir, slot)
        if (!current || current.token !== info.token) return
        Object.assign(info, fields, { token: info.token })
        const tmp = path.join(dir, `.${slot}.lock.${process.pid}.update`)
        fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n')
        fs.renameSync(tmp, lockPath(dir, slot))
      })
    },
    release () {
      if (released) return
      released = true
      releaseSlot(dir, slot, info.token)
    }
  }
}

/** Remove a lock if it carries `token` (null: whatever it carries). Synchronous (exit handlers). */
function releaseSlot (dir, slot, token) {
  return withRegistrySync(dir, () => {
    const current = readLock(dir, slot)
    if (!current) return false
    if (token !== null && current.token !== token) return false
    fs.rmSync(lockPath(dir, slot), { force: true })
    return true
  })
}

module.exports = {
  acquire,
  listSlots,
  readLock,
  releaseSlot,
  isLockAlive,
  describeHolders,
  lockPath,
  withRegistry,
  withRegistrySync,
  MUTEX
}
