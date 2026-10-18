// owner: U1 (BDS harness & e2e infra)
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { LABELS, paths, isProcessAlive, selfIdentity } = require('./config')
const slots = require('./slots')
const { safeInstanceDir } = require('./instance')

/**
 * Reaper and cleaner.
 *
 * Every harness container carries labels with its owner process identity (`bedboo.pid`,
 * `bedboo.pidstart`, `bedboo.boot`, `bedboo.host`), its owner key (`bedboo.owner`, the worktree), its
 * slot and instance dir. {@link reap} removes the containers, instance dirs and slot locks of owners
 * that no longer run (crashed / killed test processes). Persistent containers (`bds up`) have no
 * owner process and are never reaped — only `bds down` / `bds clean` remove them; their instance dir
 * is reaped once the container is gone.
 */

/** A persistent instance dir is created a moment before its container. */
const PERSISTENT_GRACE_MS = 3 * 60 * 1000

function rmDir (dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}

/** Release the lock of `slot` if it belongs to `container`. */
function releaseSlotOf (container, slot, p) {
  if (slot === undefined || slot === '' || slot === null) return
  const info = slots.readLock(p.slots, Number(slot))
  if (info && info.container === container) slots.releaseSlot(p.slots, Number(slot), info.token)
}

/**
 * Remove containers/dirs/locks of dead owners.
 * @param {{ docker?: object, isAlive?: Function, log?: Function, env?: object }} [opts]
 * @returns {Promise<{ containers: string[], dirs: string[] }>}
 */
async function reap (opts = {}) {
  const docker = opts.docker ?? require('./docker')
  const isAlive = opts.isAlive ?? isProcessAlive
  const log = opts.log ?? (() => {})
  const p = paths(opts.env)
  const removed = { containers: [], dirs: [] }

  const containers = await docker.listManaged()
  const known = new Set()
  for (const c of containers) {
    known.add(c.name)
    const l = c.labels
    if (l[LABELS.persistent] === '1') continue
    if (l[LABELS.host] && l[LABELS.host] !== os.hostname()) continue
    if (isAlive({ pid: l[LABELS.pid], pidStart: l[LABELS.pidStart], boot: l[LABELS.boot], host: l[LABELS.host] })) continue
    log(`reaping ${c.name} (owner pid ${l[LABELS.pid]} is gone)`)
    await docker.removeContainers([c.name])
    removed.containers.push(c.name)
    known.delete(c.name)
    const dir = safeInstanceDir(l[LABELS.dir], p)
    if (dir) {
      rmDir(dir)
      removed.dirs.push(dir)
    }
    releaseSlotOf(c.name, l[LABELS.slot], p)
  }

  // orphan instance dirs (container already gone): instance.json holds the owner identity
  for (const dir of listInstanceDirs(p)) {
    const name = path.basename(dir)
    if (known.has(name)) continue
    const meta = readInstanceMeta(dir)
    if (meta && meta.host && meta.host !== os.hostname()) continue
    if (meta && meta.persistent) {
      // `bds up` dir whose container was removed outside the harness (docker rm, prune)
      if (Date.now() - Date.parse(meta.createdAt) < PERSISTENT_GRACE_MS) continue
    } else if (meta && isAlive(meta)) {
      continue
    }
    if (!meta && Date.now() - fs.statSync(dir).mtimeMs < 10 * 60 * 1000) continue // being created right now
    log(`removing orphan instance dir ${dir}`)
    rmDir(dir)
    removed.dirs.push(dir)
  }
  return removed
}

function listInstanceDirs (p) {
  if (!fs.existsSync(p.instances)) return []
  return fs.readdirSync(p.instances, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(p.instances, d.name))
}

function readInstanceMeta (dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * `bds clean`: reap dead owners, then remove this owner's containers (or every harness container
 * with `all`), their dirs and locks, plus stale slot locks.
 * @param {{ all?: boolean, owner?: string, docker?: object, log?: Function, env?: object }} [opts]
 */
async function clean (opts = {}) {
  const docker = opts.docker ?? require('./docker')
  const log = opts.log ?? (() => {})
  const p = paths(opts.env)
  const owner = opts.owner ?? selfIdentity().owner
  const result = await reap({ docker, log, env: opts.env, isAlive: opts.isAlive })

  const containers = await docker.listManaged()
  const targets = containers.filter((c) => opts.all || c.labels[LABELS.owner] === owner)
  if (targets.length) {
    log(`removing ${targets.map((c) => c.name).join(', ')}`)
    await docker.removeContainers(targets.map((c) => c.name))
  }
  for (const c of targets) {
    result.containers.push(c.name)
    const dir = safeInstanceDir(c.labels[LABELS.dir], p)
    if (dir) {
      rmDir(dir)
      result.dirs.push(dir)
    }
    releaseSlotOf(c.name, c.labels[LABELS.slot], p)
  }

  // stale locks (dead owner, container gone) and leftovers of crashed mutex holders
  if (fs.existsSync(p.slots)) {
    const stillThere = new Set((await docker.listManaged()).map((c) => c.name))
    const deps = { isProcessAlive: opts.isAlive, containerExists: async (name) => stillThere.has(name) }
    for (const entry of fs.readdirSync(p.slots)) {
      const m = /^(\d+)\.lock$/.exec(entry)
      if (m) {
        const slot = Number(m[1])
        const info = slots.readLock(p.slots, slot)
        if (!info || await slots.isLockAlive(info, deps)) continue
        if (slots.releaseSlot(p.slots, slot, info.token)) log(`released stale slot ${slot} (${info.container ?? 'no container'})`)
      } else if (/^registry\.lock\.dead-|^\.\d+\.lock\./.test(entry)) {
        const file = path.join(p.slots, entry)
        if (Date.now() - fs.statSync(file).mtimeMs > 60000) fs.rmSync(file, { force: true })
      }
    }
  }
  return result
}

module.exports = { reap, clean, safeInstanceDir, readInstanceMeta, listInstanceDirs }
