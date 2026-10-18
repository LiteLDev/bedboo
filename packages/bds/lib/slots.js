// owner: U1 (BDS harness & e2e infra)
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { paths, limits, slotPorts, selfIdentity, isProcessAlive } = require('./config')

/**
 * Host-wide BDS slot registry: `<cache>/slots/<n>.lock`, n in [0, BEDBOO_MAX_SERVERS).
 *
 * - Every change to the registry (take, replace a dead owner's lock, release) happens in a short
 *   synchronous section holding the registry mutex `<cache>/slots/registry.lock`, created with
 *   O_CREAT|O_EXCL (`open(…, 'wx')`). The mutex records its holder; a mutex whose holder process is
 *   dead is stolen with an atomic rename, one stealer at a time (steal lock `registry.lock.steal`, see
 *   stealDeadMutex). Inside the mutex the caps are exact; nothing slow (docker) runs while it is held.
 * - `<n>.lock` (JSON: slot, token, pid, pid start time, boot id, host, owner, container, persistent,
 *   ports, createdAt) is created with O_EXCL too. A lock is *live* while its owner process runs (pid
 *   + start time + boot id) or, once the owner is gone, while the container it names still exists (a
 *   crashed owner's BDS keeps binding the slot's ports until the reaper removes it); a persistent
 *   (`bds up`) lock while its container exists. Locks that are not live are replaced.
 * - Per-worker cap: at most BEDBOO_WORKER_SLOTS non-persistent locks of running processes with the same
 *   owner key (git worktree). Persistent `bds up` servers count only against BEDBOO_MAX_SERVERS.
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

/** Create `file` with O_CREAT|O_EXCL and write `content`. @returns {boolean} false if it already exists */
function createExclusive (file, content) {
  let fd
  try {
    fd = fs.openSync(file, 'wx')
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
  try {
    fs.writeSync(fd, content)
  } finally {
    fs.closeSync(fd)
  }
  return true
}

// ---------------------------------------------------------------------------------------------
// registry mutex

/** Try to take the mutex once. @returns {string|null} our token */
function tryMutex (dir) {
  const file = path.join(dir, MUTEX)
  const token = crypto.randomBytes(8).toString('hex')
  if (createExclusive(file, JSON.stringify({ ...selfIdentity(), token, at: Date.now() }))) return token
  stealDeadMutex(file)
  return null
}

/** A mutex holder that will never release it: its process is gone, or the file stayed empty/corrupt for 5 s. */
function isDeadHolder (holder, mtimeMs) {
  return holder.corrupt ? Date.now() - mtimeMs > 5000 : !isProcessAlive(holder)
}

/** stat + parsed content of a file, or null if it does not exist. */
function readWithStat (file) {
  let st
  try { st = fs.statSync(file) } catch { return null }
  const content = readJson(file)
  return content ? { st, content } : null
}

/**
 * Remove the mutex if its holder is dead.
 *
 * Stealing is serialized by a second O_EXCL lock, `registry.lock.steal`: without it, two processes that both
 * saw the same dead holder could race — the first moves the dead mutex away, a live process takes a fresh
 * one, and the second (still acting on its stale read) moves that live mutex aside, letting a third process
 * in next to the live holder. Inside the steal lock the mutex is re-read and moved only while it still
 * carries the dead holder's token; nothing but a stealer (serialized) or its live holder (only on release)
 * removes a mutex, and nobody can create one while it exists, so the file moved is the one checked.
 * The steal lock is held for a few synchronous file operations; one older than STEAL_STALE_MS was left by
 * a process that died inside that section and is removed.
 *
 * @param {string} file the mutex path
 * @param {{ beforeSteal?: () => void }} [hooks] tests: runs between the unlocked check and the steal lock
 */
function stealDeadMutex (file, hooks = {}) {
  const seen = readWithStat(file)
  if (!seen || !isDeadHolder(seen.content, seen.st.mtimeMs)) return
  hooks.beforeSteal?.()
  const stealFile = `${file}.steal`
  const stealToken = tryStealLock(stealFile)
  if (!stealToken) return
  try {
    const current = readWithStat(file)
    if (!current || current.content.token !== seen.content.token || !isDeadHolder(current.content, current.st.mtimeMs)) return
    const junk = `${file}.dead-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    try {
      fs.renameSync(file, junk)
    } catch {
      return
    }
    const moved = readJson(junk)
    if (moved && moved.token !== seen.content.token) {
      // cannot happen while every stealer holds the steal lock; never drop a mutex we did not check
      try { fs.linkSync(junk, file) } catch {}
    }
    fs.rmSync(junk, { force: true })
  } finally {
    releaseStealLock(stealFile, stealToken)
  }
}

const STEAL_STALE_MS = 5000

/** Take the steal lock once (O_EXCL). @returns {string|null} our token */
function tryStealLock (file) {
  const token = crypto.randomBytes(8).toString('hex')
  if (createExclusive(file, token)) return token
  removeStaleStealLock(file)
  return null
}

/**
 * Remove a steal lock older than STEAL_STALE_MS (its holder died inside the steal section). The file is
 * first pinned with a hard link — its inode number cannot be reused by a fresh lock while the pin exists —
 * and checked to be stale, then moved aside; if what was moved is not the pinned inode (the stale lock was
 * removed and a fresh one taken meanwhile), it is put back.
 * Residual risk, accepted: if two processes remove the same stale lock at once and a third takes a fresh
 * one in between, the put-back can lose that fresh lock to a fourth process. This needs a stealer to crash
 * inside its few-syscall section and three more stealers within microseconds of each other.
 */
function removeStaleStealLock (file) {
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const pin = `${file}.dead-${tag}-pin`
  try {
    fs.linkSync(file, pin)
  } catch {
    return // gone already
  }
  try {
    const pinned = fs.statSync(pin)
    if (Date.now() - pinned.mtimeMs < STEAL_STALE_MS) return // held right now
    const moved = `${file}.dead-${tag}`
    try {
      fs.renameSync(file, moved)
    } catch {
      return
    }
    let st = null
    try { st = fs.statSync(moved) } catch {}
    if (st && (st.ino !== pinned.ino || st.dev !== pinned.dev)) {
      try { fs.linkSync(moved, file) } catch {} // a fresh lock: put it back
    }
    fs.rmSync(moved, { force: true })
  } finally {
    fs.rmSync(pin, { force: true })
  }
}

function releaseStealLock (file, token) {
  let current = null
  try { current = fs.readFileSync(file, 'utf8') } catch {}
  if (current === token) fs.rmSync(file, { force: true })
}

function releaseMutex (dir, token) {
  const file = path.join(dir, MUTEX)
  const current = readJson(file)
  if (current && current.token === token) fs.rmSync(file, { force: true })
}

/**
 * Run the synchronous `fn` holding the registry mutex, waiting (asynchronously) for it.
 * `fn` must not be async: nothing else of this process can run while the mutex is held.
 */
async function withRegistry (dir, fn) {
  fs.mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + MUTEX_TIMEOUT_MS
  let token
  while (!(token = tryMutex(dir))) {
    if (Date.now() > deadline) throw new Error(`slot registry mutex ${path.join(dir, MUTEX)} held for more than ${MUTEX_TIMEOUT_MS} ms: ${JSON.stringify(readJson(path.join(dir, MUTEX)))}`)
    await sleep(5 + Math.random() * 20)
  }
  try {
    return fn()
  } finally {
    releaseMutex(dir, token)
  }
}

/** Synchronous variant (exit handlers); runs unlocked after `timeout` ms rather than hang. */
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

const isYoung = (info) => Date.now() - Date.parse(info.createdAt) < PERSISTENT_GRACE_MS

/**
 * Liveness without I/O beyond /proc: `containers` maps container names to whether they exist (checked
 * outside the mutex by {@link lockContainers}).
 * - persistent (`bds up`) lock: live while its container exists (young locks, unknown: live);
 * - other locks: live while the owner process runs — or, once it is gone, while the container it names
 *   still exists: a crashed owner's BDS keeps running and binding the slot's ports until the reaper
 *   removes it, so the slot must not be handed out before (unknown: dead).
 */
function isLockAliveSync (info, { containers, isProcessAlive: alive = isProcessAlive } = {}) {
  if (!info || info.corrupt) return false
  if (info.persistent) {
    if (!info.container) return false
    // the container is created a moment after the lock: young locks are alive
    if (isYoung(info)) return true
    return containers?.get(info.container) ?? true
  }
  if (alive(info)) return true
  return !!info.container && containers?.get(info.container) === true
}

/**
 * Existence of the containers that decide liveness (checked outside the mutex): those of old persistent
 * locks and of non-persistent locks whose owner process is gone.
 */
async function lockContainers (infos, deps = {}) {
  const exists = deps.containerExists ?? defaultContainerExists
  const alive = deps.isProcessAlive ?? isProcessAlive
  const out = new Map()
  for (const info of infos) {
    if (!info || info.corrupt || !info.container || out.has(info.container)) continue
    if (info.persistent ? isYoung(info) : alive(info)) continue
    try {
      out.set(info.container, await exists(info.container))
    } catch {
      // docker unavailable: cannot tell; keep a persistent lock, but a dead owner's container cannot be
      // running without docker either (a port-in-use start then moves on)
      out.set(info.container, !!info.persistent)
    }
  }
  return out
}

/**
 * @param {object} info lock content
 * @param {{ containerExists?: (name: string) => Promise<boolean>, isProcessAlive?: Function }} deps
 * @returns {Promise<boolean>}
 */
async function isLockAlive (info, deps = {}) {
  return isLockAliveSync(info, { containers: await lockContainers([info], deps), isProcessAlive: deps.isProcessAlive })
}

async function defaultContainerExists (name) {
  const docker = require('./docker')
  return (await docker.inspect(name)) !== null
}

/** Create `<n>.lock` with O_EXCL; false if it exists. */
function tryCreate (dir, slot, info) {
  return createExclusive(lockPath(dir, slot), JSON.stringify(info, null, 2) + '\n')
}

/**
 * Snapshot of all slots.
 * @returns {Promise<Array<{ slot: number, ports: object, info: object|null, alive: boolean }>>}
 */
async function listSlots (opts = {}) {
  const dir = opts.dir ?? paths().slots
  const { maxServers, portBase } = { ...limits(), ...opts.limits }
  const infos = []
  for (let slot = 0; slot < maxServers; slot++) infos.push(fs.existsSync(dir) ? readLock(dir, slot) : null)
  const containers = await lockContainers(infos, opts.deps)
  const processAlive = opts.deps?.isProcessAlive ?? isProcessAlive
  return infos.map((info, slot) => ({
    slot,
    ports: slotPorts(slot, portBase),
    info,
    alive: info ? isLockAliveSync(info, { containers, isProcessAlive: processAlive }) : false,
    ownerGone: !!info && !info.persistent && !info.corrupt && !processAlive(info)
  }))
}

function describeHolders (states) {
  return states.filter((s) => s.info).map((s) => {
    const i = s.info
    const who = i.persistent ? 'persistent' : `pid ${i.pid}`
    const flag = !s.alive ? ' [stale]' : s.ownerGone ? ' [owner gone, container not reaped yet]' : ''
    return `  slot ${s.slot} (port ${s.ports.v4}): ${i.container ?? '?'} ${who} owner ${i.owner ?? '?'}${flag}`
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
 * @param {() => Promise<void>} [opts.onWait] called before each wait (e.g. reap dead owners' containers,
 *   which frees the slots their locks keep busy)
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
  fs.mkdirSync(dir, { recursive: true })

  const started = Date.now()
  let lastReport = 0
  const processAlive = opts.deps?.isProcessAlive ?? isProcessAlive
  for (;;) {
    // slow checks (docker) before taking the mutex
    const preview = []
    for (let slot = 0; slot < lim.maxServers; slot++) preview.push(readLock(dir, slot))
    const containers = await lockContainers(preview, opts.deps)
    const liveness = { containers, isProcessAlive: processAlive }

    const attempt = await withRegistry(dir, () => {
      const states = []
      let ownLive = 0
      for (let slot = 0; slot < lim.maxServers; slot++) {
        const info = readLock(dir, slot)
        const alive = info ? isLockAliveSync(info, liveness) : false
        const ownerGone = !!info && !info.persistent && !info.corrupt && !processAlive(info)
        // the worker cap counts running owners only (a crashed run's leftover container is reaped soon)
        if (info && alive && !ownerGone && !info.persistent && info.owner === identity.owner) ownLive++
        states.push({ slot, info, alive, ownerGone, ports: slotPorts(slot, lim.portBase) })
      }
      if (!opts.persistent && ownLive >= lim.workerSlots) return { states, ownLive }
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
    const why = !opts.persistent && ownLive >= lim.workerSlots
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
  isLockAliveSync,
  describeHolders,
  lockPath,
  withRegistry,
  withRegistrySync,
  stealDeadMutex,
  MUTEX,
  STEAL_STALE_MS
}
