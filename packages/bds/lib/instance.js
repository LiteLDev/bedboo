// owner: U1 (BDS harness & e2e infra)
'use strict'
const fs = require('fs')
const path = require('path')
const { SERVER_BINARY, paths } = require('./config')
const { requireGolden, MARKER } = require('./golden')
const properties = require('./properties')

/**
 * Per-instance `/data` directory: `<cache>/instances/<container>/data`.
 *
 * The 245 MB server binary is hardlinked from the golden cache (it must be a real file inside /data:
 * itzg's `VERSION=EXISTING` and console helpers look for `/data/bedrock_server-*`); everything else
 * (~75 MB of packs and definitions, which BDS may rewrite) is copied. The directory is created by the
 * host user, so itzg's `entrypoint-demoter --match /data` runs BDS as that user and every file it
 * writes can be removed without sudo.
 */

function instanceDir (container, p = paths()) {
  return path.join(p.instances, container)
}

/**
 * Create the instance dir (fails if it exists).
 * @param {string} container
 * @param {object} propOpts options for properties.resolve (ports, gamemode, …)
 * @param {{ snapshotWorld?: string }} [extra] copy this world dir into worlds/<level-name>
 * @returns {{ dir: string, dataDir: string, properties: Record<string,string> }}
 */
function createInstance (container, propOpts, extra = {}, p = paths()) {
  requireGolden(p)
  const dir = instanceDir(container, p)
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(p.instances, { recursive: true })
  fs.mkdirSync(dir) // throws EEXIST: never reuse another instance's dir
  try {
    fs.mkdirSync(dataDir)
    for (const entry of fs.readdirSync(p.golden)) {
      if (entry === MARKER) continue
      const src = path.join(p.golden, entry)
      const dest = path.join(dataDir, entry)
      if (entry === SERVER_BINARY) {
        try {
          fs.linkSync(src, dest)
        } catch (err) {
          if (err.code !== 'EXDEV' && err.code !== 'EPERM') throw err
          fs.copyFileSync(src, dest)
          fs.chmodSync(dest, 0o755)
        }
      } else {
        fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true })
      }
    }
    const template = fs.readFileSync(path.join(p.golden, 'server.properties'), 'utf8')
    const values = properties.resolve(propOpts)
    fs.writeFileSync(path.join(dataDir, 'server.properties'), properties.render(template, values))
    if (extra.snapshotWorld) {
      const worldDir = path.join(dataDir, 'worlds', values['level-name'])
      fs.mkdirSync(path.dirname(worldDir), { recursive: true })
      fs.cpSync(extra.snapshotWorld, worldDir, { recursive: true })
    }
    return { dir, dataDir, properties: values }
  } catch (err) {
    removeInstance(dir, p)
    throw err
  }
}

/** @returns {string|null} `dir` resolved if it lies inside the instances root, else null */
function safeInstanceDir (dir, p = paths()) {
  if (!dir) return null
  const resolved = path.resolve(dir)
  const root = path.resolve(p.instances) + path.sep
  return resolved.startsWith(root) ? resolved : null
}

/** Remove an instance dir (ignores missing; never touches anything outside the instances root). */
function removeInstance (dir, p = paths()) {
  const safe = safeInstanceDir(dir, p)
  if (!safe) return false
  fs.rmSync(safe, { recursive: true, force: true, maxRetries: 3 })
  return true
}

/** Path of the world dir of an instance. */
function worldDir (dataDir, levelName) {
  return path.join(dataDir, 'worlds', levelName)
}

module.exports = { instanceDir, createInstance, removeInstance, safeInstanceDir, worldDir }
