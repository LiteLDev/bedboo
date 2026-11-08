'use strict'

/**
 * Pinned upstream sources of every data version, keyed by the data version (`data/<version>/`, a
 * minecraft-data Bedrock version key). `fetch-sources.js --version <v>` downloads them into the source cache
 * and verifies their sha256 (`sources.lock.json`, keyed by version); `generate.js --version <v>` builds
 * `data/<v>/*` from them.
 *
 * Adding a version: add an entry to PINS with the commits whose files describe that BDS (and the BDS build
 * the live probe ran against), run `fetch-sources.js --version <v> --update-lock`, probe a server
 * (effect / enchantment ids, entity sizes, biome order → probe/<v>.json), then `generate.js --version <v>`.
 *
 * Licenses: minecraft-data PR #1335 is MIT (PrismarineJS/minecraft-data, fork mc-zuri/minecraft-data);
 * CloudburstMC/Data is Apache-2.0; Sandertv/gophertunnel is MIT; pmmp/BedrockData is CC0-1.0. See ../NOTICE.md.
 */
const os = require('os')
const path = require('path')
const { compareDotted } = require('../install')

/** Data version the scripts use without `--version`. */
const DEFAULT_VERSION = '1.26.51'

/**
 * version → { bds, mcdata, cloudburst, gophertunnel, pmmp }:
 *   bds          the BDS build whose facts probe/<version>.json records
 *   mcdata       minecraft-data commit (and directory) with blocks, blockStates, blockCollisionShapes, items, materials
 *   cloudburst   CloudburstMC/Data commit with the BDS dumps of that version (`files`: upstream file names that
 *                differ from the current ones, e.g. { 'blocks.json': 'block_properties.json' } before 26.50)
 *   gophertunnel commit with the level sound event identifiers of that protocol
 *   pmmp         pmmp/BedrockData commit with the vanilla numeric biome ids
 */
const PINS = {
  '1.26.40': {
    bds: '1.26.44.3',
    // minecraft-data 3.119.0 (the npm dependency): data/bedrock/1.26.40 (also what bedrock_1.26.45 inherits)
    mcdata: { repo: 'PrismarineJS/minecraft-data', sha: 'bd8b5c6048e5af9694374b83f25f5b4aade619cc', dir: 'data/bedrock/1.26.40', license: 'MIT' },
    // last commit before 26.50 ("Add missing recipe data" on top of "Add missing data from 1.26.40 (2168)"); the
    // per-state block dump was still called block_properties.json (same schema and palette order as blocks.json)
    cloudburst: { repo: 'CloudburstMC/Data', sha: '040a6cc9f96d5c3b131467b81a7939f94a5a8432', license: 'Apache-2.0', files: { 'blocks.json': 'block_properties.json' } },
    gophertunnel: { repo: 'Sandertv/gophertunnel', sha: '4794743244247a9395360bced1f294d4882c4df0', license: 'MIT' }, // CurrentProtocol 2168 / 1.26.44
    pmmp: { repo: 'pmmp/BedrockData', sha: 'bdb44a48fb6beffb6e9f6864f06d2232eb62b6a3', license: 'CC0-1.0' } // "Updated from 1.26.30" (latest before BDS 1.26.4x)
  },
  // 1.26.45 (protocol 2169) is a hotfix of 1.26.40: minecraft-data 3.119.0 points its blocks / items / materials at
  // data/bedrock/1.26.40 (its protocol.json equals 1.26.40's) and CloudburstMC has no separate 2169 dump; every fact the
  // generator keeps was checked against a live BDS 1.26.45.1 (probe/1.26.45.json).
  '1.26.45': {
    bds: '1.26.45.1',
    mcdata: { repo: 'PrismarineJS/minecraft-data', sha: 'bd8b5c6048e5af9694374b83f25f5b4aade619cc', dir: 'data/bedrock/1.26.40', license: 'MIT' },
    cloudburst: { repo: 'CloudburstMC/Data', sha: '040a6cc9f96d5c3b131467b81a7939f94a5a8432', license: 'Apache-2.0', files: { 'blocks.json': 'block_properties.json' } },
    gophertunnel: { repo: 'Sandertv/gophertunnel', sha: '7f058e5ddc393eaa0480dae338c5eee2feb323e6', license: 'MIT' }, // "Updated for 1.26.45" (CurrentProtocol 2169)
    pmmp: { repo: 'pmmp/BedrockData', sha: 'bdb44a48fb6beffb6e9f6864f06d2232eb62b6a3', license: 'CC0-1.0' } // "Updated from 1.26.30" (latest before BDS 1.26.45)
  },
  '1.26.51': {
    bds: '1.26.51.1',
    mcdata: {
      repo: 'mc-zuri/minecraft-data',
      pr: 'https://github.com/PrismarineJS/minecraft-data/pull/1335',
      sha: 'b34f7dfed829098a34f16046c9e3f2bd8632bcd6',
      dir: 'data/bedrock/1.26.51',
      license: 'MIT'
    },
    // last commit before 26.60 (BDS 1.26.51 data)
    cloudburst: { repo: 'CloudburstMC/Data', sha: '659ce1e2eee3a67045693f4fd5515c6ccf571953', license: 'Apache-2.0' },
    gophertunnel: { repo: 'Sandertv/gophertunnel', sha: '80c811b6186016b3860c358368cfa47e507f26e9', license: 'MIT' }, // CurrentProtocol 2193 / 1.26.50
    pmmp: { repo: 'pmmp/BedrockData', sha: 'bdb44a48fb6beffb6e9f6864f06d2232eb62b6a3', license: 'CC0-1.0' } // "Updated from 1.26.30" (latest before BDS 1.26.51)
  }
}

/** Data versions with pinned sources (sorted oldest first). */
const VERSIONS = Object.keys(PINS).sort(compareDotted)

const raw = (repo, sha, file) => `https://raw.githubusercontent.com/${repo}/${sha}/${file}`

function pinsFor (version) {
  const pins = PINS[version]
  if (!pins) throw new Error(`no pinned sources for data version ${version} (known: ${VERSIONS.join(', ')}): add it to scripts/sources.js`)
  return pins
}

const cache = new Map()

/** id → { id, url, repo, sha, file, license } of one data version */
function sourcesFor (version = DEFAULT_VERSION) {
  if (cache.has(version)) return cache.get(version)
  const { mcdata, cloudburst, gophertunnel, pmmp } = pinsFor(version)
  const pr = file => ({ ...mcdata, file: `${mcdata.dir}/${file}` })
  const { files: renamed = {}, ...cloudburstPin } = cloudburst
  const cloudburstFile = file => ({ ...cloudburstPin, file: renamed[file] ?? file })
  const sources = {
    // minecraft-data (PR #1335 for 1.26.51) — data/bedrock/<version>
    'pr1335/blocks.json': pr('blocks.json'),
    'pr1335/blockStates.json': pr('blockStates.json'),
    'pr1335/blockCollisionShapes.json': pr('blockCollisionShapes.json'),
    'pr1335/items.json': pr('items.json'),
    'pr1335/materials.json': pr('materials.json'),
    // CloudburstMC/Data — BDS dumps
    'cloudburst/blocks.json': cloudburstFile('blocks.json'),
    'cloudburst/runtime_item_states.json': cloudburstFile('runtime_item_states.json'),
    'cloudburst/item_components.nbt': cloudburstFile('item_components.nbt'),
    'cloudburst/entity_identifiers.dat': cloudburstFile('entity_identifiers.dat'),
    'cloudburst/creative_items.json': cloudburstFile('creative_items.json'),
    // BDS biome definitions (climate, tags, water colour; no numeric ids: `id` is null for vanilla biomes)
    'cloudburst/stripped_biome_definitions.json': cloudburstFile('stripped_biome_definitions.json'),
    // gophertunnel — level sound event identifiers (strings on the wire since 1.26.40)
    'gophertunnel/level_sound_event.go': { ...gophertunnel, file: 'minecraft/protocol/packet/level_sound_event.go' },
    // pmmp/BedrockData — vanilla numeric biome ids (what chunk biome palettes carry)
    'pmmp/biome_id_map.json': { ...pmmp, file: 'biome_id_map.json' }
  }
  for (const [id, s] of Object.entries(sources)) {
    s.id = id
    s.url = raw(s.repo, s.sha, s.file)
  }
  cache.set(version, sources)
  return sources
}

function cacheDir () {
  return process.env.BEDBOO_DATA_SRC || path.join(os.homedir(), '.cache', 'bedboo', 'bedrock-data-src')
}

/** Local path of a source in the cache (keyed by commit so a re-pin never reuses stale files). */
function sourcePath (id, version = DEFAULT_VERSION) {
  const s = sourcesFor(version)[id]
  if (!s) throw new Error('unknown source ' + id)
  return path.join(cacheDir(), s.sha.slice(0, 12), s.file)
}

/**
 * The data versions a script run targets: `--version <v>` (repeatable; `all` = every pinned version) or
 * `--all`; without either, DEFAULT_VERSION.
 */
function versionsFromArgv (argv = process.argv) {
  if (argv.includes('--all')) return [...VERSIONS]
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--version') continue
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error('--version needs a value (a data version such as 1.26.51, or all)')
    if (v === 'all') return [...VERSIONS]
    pinsFor(v)
    if (!out.includes(v)) out.push(v)
  }
  return out.length ? out : [DEFAULT_VERSION]
}

/** The single data version of a script that targets exactly one. */
function versionFromArgv (argv = process.argv) {
  const list = versionsFromArgv(argv)
  if (list.length !== 1) throw new Error('this script takes a single --version')
  return list[0]
}

/** The default version's sources (pre-multiversion API). */
const SOURCES = sourcesFor(DEFAULT_VERSION)

module.exports = { DEFAULT_VERSION, PINS, VERSIONS, SOURCES, pinsFor, sourcesFor, cacheDir, sourcePath, versionsFromArgv, versionFromArgv }
