// owner: U1 (BDS harness & e2e infra)
'use strict'
const fs = require('fs')
const path = require('path')
const { BDS_VERSION, paths } = require('./config')

/**
 * World snapshots: `<cache>/snapshots/<name>/{world/, meta.json}`, shared by every worker on the host
 * (Wave 6 milestone scenarios start from them).
 *
 * Taking one (BdsServer#snapshot): graceful `docker stop` (BDS saves everything on shutdown) → copy
 * the world dir → start again; connected players are disconnected. The online backup protocol
 * (`save hold` / `save query` / `save resume`) is not used: on BDS 1.26.51.1 modified chunks reach
 * LevelDB only 5–10 s after the change and `save hold` does not flush them, so an online copy
 * silently misses recent changes (see docs/testing.md).
 *
 * Restoring needs the server stopped too (BDS keeps the LevelDB open): the world dir is replaced and
 * the server restarted (BdsServer#restore), or a new server starts from it (`startServer({ snapshot })`).
 */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

function validateName (name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Invalid snapshot name ${JSON.stringify(name)} (letters, digits, . _ -)`)
  }
}

function snapshotDir (name, p = paths()) {
  validateName(name)
  return path.join(p.snapshots, name)
}

/** @returns {object|null} meta of a snapshot (+ `dir`, `world`) */
function readSnapshot (name, p = paths()) {
  const dir = snapshotDir(name, p)
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
    return { ...meta, dir, world: path.join(dir, 'world') }
  } catch {
    return null
  }
}

function requireSnapshot (name, p = paths()) {
  const snap = readSnapshot(name, p)
  if (!snap) throw new Error(`Snapshot ${name} not found in ${p.snapshots}`)
  return snap
}

function listSnapshots (p = paths()) {
  if (!fs.existsSync(p.snapshots)) return []
  return fs.readdirSync(p.snapshots)
    .filter((n) => NAME_RE.test(n))
    .map((n) => readSnapshot(n, p))
    .filter(Boolean)
}

function deleteSnapshot (name, p = paths()) {
  fs.rmSync(snapshotDir(name, p), { recursive: true, force: true })
}

function countFiles (dir) {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).length
}

/**
 * Store a copy of `worldDir` as snapshot `name` (atomic: temp dir renamed into place).
 * @param {string} worldDir
 * @param {string} name
 * @param {object} meta extra meta fields
 * @param {{ overwrite?: boolean }} [opts]
 */
function saveWorld (worldDir, name, meta, opts = {}, p = paths()) {
  const dest = snapshotDir(name, p)
  if (fs.existsSync(dest) && !opts.overwrite) throw new Error(`Snapshot ${name} exists (pass overwrite: true)`)
  const tmp = `${dest}.tmp-${process.pid}`
  fs.rmSync(tmp, { recursive: true, force: true })
  try {
    fs.cpSync(worldDir, path.join(tmp, 'world'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({
      name,
      bdsVersion: BDS_VERSION,
      createdAt: new Date().toISOString(),
      ...meta,
      files: countFiles(path.join(tmp, 'world'))
    }, null, 2) + '\n')
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(tmp, dest)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return requireSnapshot(name, p)
}

/**
 * Snapshot a harness server's world: graceful stop → copy → start (players are disconnected).
 * @param {import('./server').BdsServer} server harness server (local data dir)
 * @param {string} name
 * @param {{ overwrite?: boolean, description?: string }} [opts]
 * @returns {Promise<object>} the snapshot meta (+ `dir`, `world`)
 */
async function takeSnapshot (server, name, opts = {}) {
  validateName(name)
  if (server.external || !server.dataDir) throw new Error('snapshot() needs a harness server (local data dir)')
  if (fs.existsSync(snapshotDir(name)) && !opts.overwrite) throw new Error(`Snapshot ${name} exists (pass overwrite: true)`)
  const props = server.properties ?? {}
  const worldDir = path.join(server.dataDir, 'worlds', server.levelName)
  await server._stopContainer()
  let snap
  try {
    snap = saveWorld(worldDir, name, {
      source: server.container ?? null,
      levelName: server.levelName,
      levelType: props['level-type'] ?? null,
      seed: props['level-seed'] ?? null,
      gamemode: props.gamemode ?? null,
      difficulty: props.difficulty ?? null,
      description: opts.description ?? null
    }, opts)
  } finally {
    await server._startContainer()
  }
  return snap
}

module.exports = {
  snapshotDir,
  readSnapshot,
  requireSnapshot,
  listSnapshots,
  deleteSnapshot,
  saveWorld,
  takeSnapshot,
  validateName
}
