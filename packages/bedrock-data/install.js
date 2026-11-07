'use strict'

/**
 * Injects the Bedrock data overlays into minecraft-data: every `data/<version>/` directory (a minecraft-data
 * Bedrock version key such as `1.26.51`) is overlaid onto minecraft-data's `bedrock_<version>` entry.
 *
 * INJECTION CONTRACT
 * - Must run before anything calls `require('minecraft-data')('bedrock_<version>')` for a version shipped in
 *   data/: minecraft-data caches the version object on first use, and bedrock-protocol / prismarine-registry /
 *   prismarine-chunk / prismarine-block call it while loading. bedboo's `index.js` calls
 *   `install()` as its very first statement; tests and tools that use bedrock-protocol or prismarine-*
 *   directly must call it first too. (If a version object was already built, install() detects it and
 *   refreshes that cached object in place, so late callers still see the overlay; data copied out of it
 *   before that — e.g. an existing prismarine-registry — keeps the old values.)
 * - Idempotent: a second call is a no-op and returns the same result.
 * - It builds minecraft-data's `bedrock_<version>` object of every overlaid version (so the datasets are
 *   parsed then, not lazily) to relax its version comparators for Java versions (relaxVersionComparisons):
 *   the comparators live on the cached object, so a version built later would keep the strict ones. The cost
 *   grows with the number of data versions shipped (each one's blocks, states and items are parsed once).
 *   bedboo builds the bot's version at require time anyway (lib/registry.js aliasBotVersion).
 * - Mechanism: minecraft-data keeps every version in `data.js` as an object of lazy getters
 *   (`data.bedrock['1.26.51'].blocks` → `require('…/bedrock/1.26.30/blocks.json')`). install() redefines
 *   the getters of each `bedrock` `<version>` entry for every dataset file found in `data/<version>/`
 *   (`<dataset>.json` or `<dataset>.json.gz`, auto-discovered; other files there, e.g. `features.js`, are not
 *   datasets), so every consumer — including copies required from other packages' directories, since pnpm
 *   `overrides` guarantee a single minecraft-data instance — gets the overlay. Datasets stay lazy (parsed on
 *   first access).
 * - Never touches Java (`pc`) data or Bedrock versions without a `data/<version>/` directory.
 *
 * @returns {{ installed: boolean, version: string, datasets: string[], versions: string[],
 *   datasetsByVersion: Object<string, string[]> }} `version` / `datasets` describe the default version (VERSION)
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

/** Default data version: what the single-version API (VERSION, DATA_DIR, features) describes. */
const VERSION = '1.26.51'
const DATA_ROOT = path.join(__dirname, 'data')
const DATA_DIR = path.join(DATA_ROOT, VERSION)
const DATASET_FILE = /^([A-Za-z0-9]+)\.json(\.gz)?$/
const VERSION_DIR = /^\d+(\.\d+)+$/

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

/** The data versions under `root` (directories named like a version), sorted oldest first. */
function listVersions (root = DATA_ROOT) {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && VERSION_DIR.test(d.name))
    .map(d => d.name)
    .sort(compareDotted)
}

/** dataset name → file in `dir` (auto-discovered) */
function discover (dir) {
  const files = {}
  for (const file of fs.readdirSync(dir).sort()) {
    const m = DATASET_FILE.exec(file)
    if (m) files[m[1]] = file
  }
  return files
}

/** Parses one dataset file (gunzips `.json.gz`) of `dir` (default: the default version's directory). */
function readDataset (file, dir = DATA_DIR) {
  const buf = fs.readFileSync(path.join(dir, file))
  return JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8'))
}

/**
 * An install() for the data versions under `root`. The package's own install() uses `data/`; tests build
 * one over a temporary root (in a child process: the getters it defines are global to minecraft-data).
 */
function createInstaller (root = DATA_ROOT) {
  let result = null
  const patched = {} // version → datasets, once its getters are defined (they are never redefined)

  return function install () {
    if (result) return result
    // Resolve minecraft-data relative to this package: with the workspace `overrides` this is the single
    // minecraft-data instance every other package (bedrock-protocol, prismarine-*, mineflayer,
    // mineflayer-pathfinder, …) loads.
    const data = require('minecraft-data/data.js')
    const dataPaths = require('minecraft-data/minecraft-data/data/dataPaths.json')
    const versions = listVersions(root)
    for (const version of versions) {
      if (!data.bedrock?.[version]) throw new Error(`minecraft-data has no bedrock ${version} entry (data/${version}/ needs a newer minecraft-data)`)
    }

    for (const version of versions) {
      const entry = data.bedrock[version]
      // Was the bedrock_<version> object already built (and cached) by minecraft-data? Building it always
      // reads this version's version.json, which nothing else loads. (Module systems that bypass require.cache
      // — e.g. Jest's registry — are not detected: install() must then simply come first.)
      const alreadyBuilt = Boolean(require.cache[versionJsonPath(dataPaths, version)])

      if (!patched[version]) {
        const dir = path.join(root, version)
        const files = discover(dir)
        const cache = {}
        for (const [name, file] of Object.entries(files)) {
          Object.defineProperty(entry, name, {
            configurable: true,
            enumerable: true,
            get () {
              if (!(name in cache)) cache[name] = readDataset(file, dir)
              return cache[name]
            }
          })
        }
        patched[version] = Object.keys(files)
      }

      // If this throws, `result` stays unset: the next install() retries the refresh (the getters stay as they are).
      if (alreadyBuilt) refreshCachedVersion(version, entry)
      relaxVersionComparisons(require('minecraft-data')('bedrock_' + version).version)
    }
    result = {
      installed: true,
      version: VERSION,
      datasets: patched[VERSION] ?? [],
      versions,
      datasetsByVersion: { ...patched }
    }
    return result
  }
}

const install = createInstaller()

/** Resolved path of the version.json minecraft-data's `bedrock_<version>` entry loads (null when it has none). */
function versionJsonPath (dataPaths, version) {
  const dir = dataPaths.bedrock?.[version]?.version // e.g. 'bedrock/1.26.51'
  if (!dir) return null
  try {
    return require.resolve(`minecraft-data/minecraft-data/data/${dir}/version.json`)
  } catch {
    return null
  }
}

const COMPARATORS = {
  '>=': (c) => c >= 0,
  '>': (c) => c > 0,
  '<': (c) => c < 0,
  '<=': (c) => c <= 0,
  '==': (c) => c === 0
}

/**
 * Code written for Java compares the registry version with Java versions —
 * `bot.registry.isNewerOrEqualTo('1.9')` (mineflayer's examples/inventory.js and test exampleInventory),
 * `registry.version['>=']('1.16')` (@nxg-org/mineflayer-util-plugin, loaded by mineflayer-auto-eat). minecraft-data
 * only knows the Bedrock versions for a Bedrock version object and throws a RangeError for any other; a version it
 * does not know is compared numerically (major.minor.patch) with this version instead (1.26.x is newer than every
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
function refreshCachedVersion (version, entry) {
  const mcData = require('minecraft-data')
  const cached = mcData('bedrock_' + version)
  const fresh = require('minecraft-data/lib/loader')(entry)
  for (const key of Object.keys(fresh)) {
    if (key === 'version') continue // keeps the Version object (comparators) minecraft-data attached
    cached[key] = fresh[key]
  }
}

/** Data versions shipped in data/ (sorted oldest first). */
const versions = Object.freeze(listVersions())

module.exports = { install, createInstaller, VERSION, versions, DATA_ROOT, DATA_DIR, DATASET_FILE, readDataset, listVersions, compareDotted, relaxVersionComparisons }
