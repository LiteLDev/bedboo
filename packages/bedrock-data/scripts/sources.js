// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * Pinned upstream sources of the bedrock_1.26.51 overlay. `fetch-sources.js` downloads them into the
 * source cache and verifies their sha256; `generate.js` builds `data/1.26.51/*` from them.
 *
 * Licenses: minecraft-data PR #1335 is MIT (PrismarineJS/minecraft-data, fork mc-zuri/minecraft-data);
 * CloudburstMC/Data is Apache-2.0; Sandertv/gophertunnel is MIT. See ../NOTICE.md.
 */
const os = require('os')
const path = require('path')

const MCDATA_PR = {
  repo: 'mc-zuri/minecraft-data',
  pr: 'https://github.com/PrismarineJS/minecraft-data/pull/1335',
  sha: 'b34f7dfed829098a34f16046c9e3f2bd8632bcd6',
  license: 'MIT'
}
const CLOUDBURST = {
  repo: 'CloudburstMC/Data',
  sha: '659ce1e2eee3a67045693f4fd5515c6ccf571953',
  license: 'Apache-2.0'
}

const GOPHERTUNNEL = {
  repo: 'Sandertv/gophertunnel',
  sha: '80c811b6186016b3860c358368cfa47e507f26e9', // CurrentProtocol 2193 / 1.26.50
  license: 'MIT'
}

const raw = (repo, sha, file) => `https://raw.githubusercontent.com/${repo}/${sha}/${file}`

/** id → { url, repo, sha, license, sha256 } */
const SOURCES = {
  // minecraft-data PR #1335 — data/bedrock/1.26.51
  'pr1335/blocks.json': { ...MCDATA_PR, file: 'data/bedrock/1.26.51/blocks.json' },
  'pr1335/blockStates.json': { ...MCDATA_PR, file: 'data/bedrock/1.26.51/blockStates.json' },
  'pr1335/blockCollisionShapes.json': { ...MCDATA_PR, file: 'data/bedrock/1.26.51/blockCollisionShapes.json' },
  'pr1335/items.json': { ...MCDATA_PR, file: 'data/bedrock/1.26.51/items.json' },
  'pr1335/materials.json': { ...MCDATA_PR, file: 'data/bedrock/1.26.51/materials.json' },
  // CloudburstMC/Data — last commit before 26.60 (BDS 1.26.51 data)
  'cloudburst/blocks.json': { ...CLOUDBURST, file: 'blocks.json' },
  'cloudburst/runtime_item_states.json': { ...CLOUDBURST, file: 'runtime_item_states.json' },
  'cloudburst/item_components.nbt': { ...CLOUDBURST, file: 'item_components.nbt' },
  'cloudburst/entity_identifiers.dat': { ...CLOUDBURST, file: 'entity_identifiers.dat' },
  'cloudburst/creative_items.json': { ...CLOUDBURST, file: 'creative_items.json' },
  // gophertunnel — level sound event identifiers (strings on the wire since 1.26.40)
  'gophertunnel/level_sound_event.go': { ...GOPHERTUNNEL, file: 'minecraft/protocol/packet/level_sound_event.go' }
}
for (const [id, s] of Object.entries(SOURCES)) {
  s.id = id
  s.url = raw(s.repo, s.sha, s.file)
}

function cacheDir () {
  return process.env.BEDBOO_DATA_SRC || path.join(os.homedir(), '.cache', 'bedboo', 'bedrock-data-src')
}

/** Local path of a source in the cache (keyed by commit so a re-pin never reuses stale files). */
function sourcePath (id) {
  const s = SOURCES[id]
  if (!s) throw new Error('unknown source ' + id)
  return path.join(cacheDir(), s.sha.slice(0, 12), s.file)
}

module.exports = { SOURCES, MCDATA_PR, CLOUDBURST, GOPHERTUNNEL, cacheDir, sourcePath }
