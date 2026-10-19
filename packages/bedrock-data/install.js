// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4); U15 (wave 5): relaxVersionComparisons
'use strict'

/**
 * Injects the Bedrock 1.26.51 data overlay into minecraft-data.
 *
 * INJECTION CONTRACT
 * - Must run before anything calls `require('minecraft-data')('bedrock_1.26.51')`: minecraft-data
 *   caches the version object on first use, and bedrock-protocol / prismarine-registry /
 *   prismarine-chunk / prismarine-block call it while loading. mineflayer-bedrock's `index.js` calls
 *   `install()` as its very first statement; tests and tools that use bedrock-protocol or prismarine-*
 *   directly must call it first too. (If the version object was already built, install() detects it and
 *   refreshes that cached object in place, so late callers still see the overlay; data copied out of it
 *   before that — e.g. an existing prismarine-registry — keeps the old values.)
 * - Idempotent: a second call is a no-op and returns the same result.
 * - It builds minecraft-data's `bedrock_1.26.51` version object (so the datasets are parsed then, not lazily) to relax its
 *   version comparators for Java versions (relaxVersionComparisons, U15); mineflayer-bedrock builds it at require
 *   time anyway (lib/registry.js aliasBotVersion).
 * - Mechanism: minecraft-data 3.117.0 keeps every version in `data.js` as an object of lazy getters
 *   (`data.bedrock['1.26.51'].blocks` → `require('…/bedrock/1.26.30/blocks.json')`). install() redefines
 *   the getters of the `bedrock` `1.26.51` entry for every dataset file found in `data/1.26.51/`
 *   (`<dataset>.json` or `<dataset>.json.gz`, auto-discovered), so every consumer — including copies
 *   required from other packages' directories, since pnpm `overrides` guarantee a single
 *   minecraft-data@3.117.0 instance — gets the overlay. Datasets stay lazy (parsed on first access).
 * - Never touches Java (`pc`) data or other Bedrock versions.
 *
 * @returns {{ installed: boolean, version: string, datasets: string[] }}
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const VERSION = '1.26.51'
const DATA_DIR = path.join(__dirname, 'data', VERSION)
let result = null
let patched = null // { datasets } once the getters are defined (they are never redefined)

/** dataset name → file in DATA_DIR (auto-discovered) */
function discover () {
  const files = {}
  for (const file of fs.readdirSync(DATA_DIR).sort()) {
    const m = /^([A-Za-z0-9]+)\.json(\.gz)?$/.exec(file)
    if (m) files[m[1]] = file
  }
  return files
}

/** Parses one dataset file (gunzips `.json.gz`). */
function readDataset (file) {
  const buf = fs.readFileSync(path.join(DATA_DIR, file))
  return JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8'))
}

function install () {
  if (result) return result
  // Resolve minecraft-data relative to this package: with the workspace `overrides` this is the single
  // minecraft-data@3.117.0 instance every other package (bedrock-protocol, prismarine-*, mineflayer,
  // mineflayer-pathfinder, …) loads.
  const data = require('minecraft-data/data.js')
  const entry = data.bedrock?.[VERSION]
  if (!entry) throw new Error(`minecraft-data has no bedrock ${VERSION} entry`)

  // Was the bedrock_1.26.51 version object already built (and cached) by minecraft-data? Building it
  // always reads this version's version.json, which nothing else loads. (Module systems that bypass
  // require.cache — e.g. Jest's registry — are not detected: install() must then simply come first.)
  const versionJson = require.resolve(`minecraft-data/minecraft-data/data/bedrock/${VERSION}/version.json`)
  const alreadyBuilt = Boolean(require.cache[versionJson])

  if (!patched) {
    const files = discover()
    const cache = {}
    for (const [name, file] of Object.entries(files)) {
      Object.defineProperty(entry, name, {
        configurable: true,
        enumerable: true,
        get () {
          if (!(name in cache)) cache[name] = readDataset(file)
          return cache[name]
        }
      })
    }
    patched = { datasets: Object.keys(files) }
  }

  // If this throws, `result` stays unset: the next install() retries the refresh (the getters stay as they are).
  if (alreadyBuilt) refreshCachedVersion(entry)
  relaxVersionComparisons(require('minecraft-data')('bedrock_' + VERSION).version)
  result = { installed: true, version: VERSION, datasets: patched.datasets }
  return result
}

const COMPARATORS = {
  '>=': (c) => c >= 0,
  '>': (c) => c > 0,
  '<': (c) => c < 0,
  '<=': (c) => c <= 0,
  '==': (c) => c === 0
}

/** numeric comparison of two dotted versions ('1.26.51' vs '1.9' → 1), or null when one is not plain numeric */
function compareDotted (a, b) {
  if (!/^\d+(\.\d+)*$/.test(a) || !/^\d+(\.\d+)*$/.test(b)) return null
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

/**
 * U15 (wave 5): code written for Java compares the registry version with Java versions —
 * `bot.registry.isNewerOrEqualTo('1.9')` (mineflayer's examples/inventory.js and test exampleInventory),
 * `registry.version['>=']('1.16')` (@nxg-org/mineflayer-util-plugin, loaded by mineflayer-auto-eat). minecraft-data
 * only knows the Bedrock versions for a Bedrock version object and throws a RangeError for any other; a version it
 * does not know is compared numerically (major.minor.patch) with this version instead (1.26.51 is newer than every
 * Java 1.x release and older than Java 26.x). Bedrock versions compare exactly as before; anything else still throws.
 * Mutates the cached Version object, which `registry.version`, `isNewerOrEqualTo` / `isOlderThan` and the
 * `require('minecraft-data')(bot.version)` alias all share. Idempotent.
 */
function relaxVersionComparisons (version) {
  if (!version || version.relaxedJavaComparisons) return
  const own = String(version.minecraftVersion ?? VERSION)
  for (const [op, test] of Object.entries(COMPARATORS)) {
    const strict = version[op]
    if (typeof strict !== 'function') continue
    version[op] = (other) => {
      try {
        return strict(other)
      } catch (err) {
        const c = err instanceof RangeError ? compareDotted(own, String(other)) : null
        if (c === null) throw err
        return test(c)
      }
    }
  }
  Object.defineProperty(version, 'relaxedJavaComparisons', { value: true })
}

/**
 * minecraft-data caches the version object it built from `entry`; rebuild it from the overlaid entry and
 * copy the result onto the cached object so holders of that object see the overlay too.
 */
function refreshCachedVersion (entry) {
  const mcData = require('minecraft-data')
  const cached = mcData('bedrock_' + VERSION)
  const fresh = require('minecraft-data/lib/loader')(entry)
  for (const key of Object.keys(fresh)) {
    if (key === 'version') continue // keeps the Version object (comparators) minecraft-data attached
    cached[key] = fresh[key]
  }
}

module.exports = { install, VERSION, DATA_DIR, readDataset, relaxVersionComparisons }
