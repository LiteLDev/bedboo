#!/usr/bin/env node
// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * Builds `packages/bedrock-data/data/1.26.51/*` (one file per minecraft-data dataset) from the pinned
 * sources (see sources.js; run fetch-sources.js first) and the tables in ./tables.js.
 *
 *   node packages/bedrock-data/scripts/fetch-sources.js
 *   node packages/bedrock-data/scripts/generate.js            # writes data/1.26.51 and test/fixtures
 *   node packages/bedrock-data/scripts/generate.js --check    # verifies the committed output is up to date
 *
 * Every deviation from the vendored minecraft-data PR #1335 files is either derived from the BDS dumps of
 * CloudburstMC/Data (allowlisted below, the generator fails on any other disagreement) or comes from a
 * documented table in tables.js. See docs/differences/U2.md.
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { createRequire } = require('module')
const { sourcePath, SOURCES } = require('./sources')
const tables = require('./tables')

const pkgRoot = path.join(__dirname, '..')
const requireFromPkg = createRequire(path.join(pkgRoot, 'package.json'))
const nbt = requireFromPkg('prismarine-nbt')
const mcDataRoot = path.dirname(requireFromPkg.resolve('minecraft-data/package.json'))
const MCD = path.join(mcDataRoot, 'minecraft-data', 'data')
const dataPaths = require(path.join(MCD, 'dataPaths.json'))

const VERSION = '1.26.51'
const OUT_DIR = path.join(pkgRoot, 'data', VERSION)
const FIXTURE_DIR = path.join(pkgRoot, 'test', 'fixtures')
/** Datasets larger than this are written gzip'd (`<name>.json.gz`); the loader decompresses them. */
const GZIP_THRESHOLD = 256 * 1024

/**
 * Collision allowlist: blocks whose per-state collision boxes are taken from CloudburstMC `blocks.json`
 * (BDS dump, `collisionShape`) where minecraft-data PR #1335 disagrees. Any disagreement on a block not
 * matched here fails the generation.
 */
const COLLISION_FROM_CLOUDBURST = [
  { match: /_door$/, why: 'doors are 3/16 = 0.1875 thick on BDS (PR #1335 has 0.1825)' },
  { match: /^end_portal_frame$/, why: 'a frame with an eye has the eye box (0.3125..0.6875, 0.8125..1) on top' }
]
/**
 * Block-state hash allowlist: states whose FNV-1a hash (name + sorted states, little-endian NBT) is not the
 * runtime id BDS uses. They get an explicit `hash` in blockStates.json, taken from Cloudburst (same index:
 * both lists use the BDS palette order).
 */
const HASH_FROM_CLOUDBURST = new Set(['unknown'])

const PROBE = require('./probe/1.26.51.json') // live BDS facts, see probe-bds.js

const readJson = id => JSON.parse(fs.readFileSync(sourcePath(id), 'utf8'))
const mcdata = (type, dataset, version = VERSION) => require(path.join(MCD, dataPaths[type][version][dataset], dataset + '.json'))
const round = (x, digits = 4) => Math.round(x * 10 ** digits) / 10 ** digits

function fnv1a32 (buf) {
  let h = 0x811c9dc5
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i] & 0xff
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)
  }
  return h & 0xffffffff // signed int32, as the wire (zigzag32 / varint) and prismarine-block use it
}

/** Same algorithm as prismarine-block `Block.getHash` (and BDS `block_network_ids_are_hashes`). */
function blockStateHash (name, states) {
  const sorted = {}
  for (const key of Object.keys(states).sort()) sorted[key] = states[key]
  const tag = nbt.comp({ name: nbt.string(name.includes(':') ? name : 'minecraft:' + name), states: nbt.comp(sorted) })
  return fnv1a32(nbt.writeUncompressed(tag, 'little'))
}

async function readNbt (id) {
  const { parsed } = await nbt.parse(fs.readFileSync(sourcePath(id)))
  return nbt.simplify(parsed)
}

const shapeKey = boxes => JSON.stringify((boxes || []).map(b => b.map(v => round(v, 6))))
/** collision equality: BDS dumps float32 values (0.817499 vs 0.8175), so compare at 1e-4 */
const sameShape = (a, b) => JSON.stringify((a || []).map(x => x.map(v => round(v, 4)))) === JSON.stringify((b || []).map(x => x.map(v => round(v, 4))))

// ---------------------------------------------------------------------------------------------------------
// Blocks: blocks, blockStates, blockCollisionShapes (+ Cloudburst friction / collision / hash fixes)
// ---------------------------------------------------------------------------------------------------------
function buildBlocks (report) {
  const blocks = readJson('pr1335/blocks.json')
  const blockStates = readJson('pr1335/blockStates.json')
  const collision = readJson('pr1335/blockCollisionShapes.json')
  const cloudburst = readJson('cloudburst/blocks.json')

  if (blockStates.length !== cloudburst.length) throw new Error(`blockStates ${blockStates.length} != Cloudburst ${cloudburst.length}`)
  const cbHashes = new Set(cloudburst.map(e => e.blockStateHash | 0))

  // 1. hashes: every state must hash to a Cloudburst runtime id (the BDS palette, same order)
  const hashes = new Array(blockStates.length)
  for (let i = 0; i < blockStates.length; i++) {
    const s = blockStates[i]
    const cb = cloudburst[i]
    if (cb.name !== 'minecraft:' + s.name) throw new Error(`state ${i}: ${s.name} vs Cloudburst ${cb.name} (palette order differs)`)
    let h = blockStateHash(s.name, s.states)
    if (!cbHashes.has(h)) {
      if (!HASH_FROM_CLOUDBURST.has(s.name)) throw new Error(`state ${i} ${s.name} ${JSON.stringify(s.states)}: hash ${h} not in Cloudburst`)
      h = cb.blockStateHash | 0
      blockStates[i] = { ...s, hash: h }
      report.push(`blockStates: ${s.name} uses the BDS runtime id ${h} (allowlisted, not its FNV-1a hash)`)
    } else if (h !== (cb.blockStateHash | 0)) {
      throw new Error(`state ${i} ${s.name}: hash ${h} is Cloudburst state ${[...cloudburst].findIndex(e => (e.blockStateHash | 0) === h)}, not ${i}`)
    }
    hashes[i] = h
  }

  // 2. per block: friction (Cloudburst), collision (PR #1335, Cloudburst for allowlisted blocks)
  const shapes = { ...collision.shapes }
  const shapeIdByKey = new Map(Object.entries(shapes).map(([id, boxes]) => [shapeKey(boxes), Number(id)]))
  let nextShapeId = Math.max(...Object.keys(shapes).map(Number)) + 1
  const shapeId = boxes => {
    const key = shapeKey(boxes)
    if (!shapeIdByKey.has(key)) {
      shapeIdByKey.set(key, nextShapeId)
      shapes[nextShapeId] = boxes.map(b => b.map(v => round(v, 6)))
      nextShapeId++
    }
    return shapeIdByKey.get(key)
  }
  const outCollisionBlocks = {}
  const overridden = {}
  for (const block of blocks) {
    const frictions = new Set()
    const ids = collision.blocks[block.name]
    const stateIds = []
    for (let s = block.minStateId; s <= block.maxStateId; s++) {
      const meta = s - block.minStateId
      const cb = cloudburst[s]
      frictions.add(round(cb.friction, 6))
      const prId = Array.isArray(ids) ? ids[meta] : ids
      const prBoxes = collision.shapes[prId]
      if (prBoxes === undefined) throw new Error(`${block.name}: no PR #1335 collision shape for state ${meta}`)
      if (sameShape(prBoxes, cb.collisionShape)) {
        stateIds.push(prId)
        continue
      }
      const rule = COLLISION_FROM_CLOUDBURST.find(r => r.match.test(block.name))
      if (!rule) throw new Error(`${block.name} state ${meta}: collision ${JSON.stringify(prBoxes)} vs Cloudburst ${JSON.stringify(cb.collisionShape)} (not allowlisted)`)
      overridden[block.name] = (overridden[block.name] || 0) + 1
      stateIds.push(shapeId(cb.collisionShape))
    }
    outCollisionBlocks[block.name] = stateIds.every(id => id === stateIds[0]) ? stateIds[0] : stateIds
    if (frictions.size !== 1) throw new Error(`${block.name}: friction varies per state ${[...frictions]}`)
    block.friction = [...frictions][0]
  }
  for (const [name, n] of Object.entries(overridden)) report.push(`blockCollisionShapes: ${name} ${n} state(s) from Cloudburst`)

  // 3. cross-checks (warnings only): hardness and the "requires correct tool" flag
  for (const block of blocks) {
    const cb = cloudburst[block.defaultState]
    if (Math.abs(cb.hardness - block.hardness) > 1e-3) report.push(`WARN ${block.name}: hardness ${block.hardness} vs Cloudburst ${cb.hardness}`)
  }

  return {
    blocks,
    blockStates,
    blockCollisionShapes: { blocks: outCollisionBlocks, shapes },
    hashes
  }
}

// ---------------------------------------------------------------------------------------------------------
// Items, materials, foods
// ---------------------------------------------------------------------------------------------------------
function buildItems (report, blocks, hashes) {
  const items = readJson('pr1335/items.json')
  const materials = readJson('pr1335/materials.json')
  const runtime = readJson('cloudburst/runtime_item_states.json')
  const byName = new Map(items.map(i => [i.name, i]))
  for (const r of runtime) {
    const it = byName.get(r.name.replace('minecraft:', ''))
    if (!it) throw new Error(`item ${r.name} (runtime_item_states) missing from PR #1335 items`)
    if (it.id !== r.id) throw new Error(`item ${r.name}: id ${it.id} vs runtime_item_states ${r.id}`)
  }
  if (runtime.length !== items.length) throw new Error(`items ${items.length} vs runtime_item_states ${runtime.length}`)
  report.push(`items: ${items.length}/${runtime.length} match runtime_item_states.json (name and id)`)

  // blockStateId: the block state a block item carries on the wire (ItemV4 block_runtime_id is that state's
  // runtime id). Truth: Cloudburst creative_items.json `block_state_b64` (identical to BDS creative_content);
  // items absent from the creative inventory fall back to the default state of the block with the same name.
  const stateByHash = new Map(hashes.map((h, i) => [h, i]))
  const creative = readJson('cloudburst/creative_items.json').items
  const fromCreative = new Map()
  for (const entry of creative) {
    const name = entry.id.replace('minecraft:', '')
    if (fromCreative.has(name)) continue
    if (!entry.block_state_b64) { fromCreative.set(name, null); continue }
    const { value } = nbt.protos.little.parsePacketBuffer('nbt', Buffer.from(entry.block_state_b64, 'base64')).data
    const stateId = stateByHash.get(blockStateHash(value.name.value, value.states.value))
    if (stateId === undefined) throw new Error(`creative item ${name}: unknown block state ${value.name.value}`)
    fromCreative.set(name, stateId)
  }
  const blocksByName = new Map(blocks.map(b => [b.name, b]))
  let creativeBlockItems = 0
  let fallback = 0
  for (const item of items) {
    let stateId = fromCreative.get(item.name)
    if (stateId === undefined) {
      stateId = blocksByName.get(item.name)?.defaultState ?? null
      if (stateId !== null) fallback++
    } else if (stateId !== null) creativeBlockItems++
    if (stateId !== null) item.blockStateId = stateId
  }
  report.push(`items: blockStateId for ${creativeBlockItems} creative block items + ${fallback} by block name`)
  return { items, materials }
}

async function buildFoods (items) {
  const components = await readNbt('cloudburst/item_components.nbt')
  const byName = new Map(items.map(i => [i.name, i]))
  const foods = []
  for (const [fullName, entry] of Object.entries(components)) {
    const food = entry.components?.['minecraft:food']
    if (!food) continue
    const item = byName.get(fullName.replace('minecraft:', ''))
    if (!item) throw new Error(`food ${fullName} is not an item`)
    // minecraft-data `foods` schema (Java field names). Bedrock: saturation = nutrition * modifier * 2, as Java.
    const foodPoints = food.nutrition
    const saturationRatio = round(food.saturation_modifier * 2, 2)
    const saturation = round(foodPoints * saturationRatio, 2)
    foods.push({
      id: item.id,
      name: item.name,
      stackSize: item.stackSize,
      displayName: item.displayName,
      foodPoints,
      saturation,
      effectiveQuality: round(foodPoints + saturation, 2),
      saturationRatio
    })
  }
  return foods.sort((a, b) => a.id - b.id)
}

// ---------------------------------------------------------------------------------------------------------
// Effects, enchantments, attributes (tables), entities, particles, sounds
// ---------------------------------------------------------------------------------------------------------
function buildEffects () {
  return tables.EFFECTS.map(([id, name, displayName, type, bedrockName]) => {
    if (PROBE.effects[bedrockName] !== id) throw new Error(`effect ${bedrockName}: table id ${id}, BDS ${PROBE.effects[bedrockName]}`)
    return { id, name, displayName, type, bedrockName }
  })
}

function buildEnchantments () {
  const bedrock = mcdata('bedrock', 'enchantments') // bedrock 1.19.1: ids 0..37 (Bedrock ids, Java-style names)
  const java = mcdata('pc', 'enchantments', '26.1')
  const javaByName = new Map(java.map(e => [e.name, e]))
  const out = bedrock.map(e => ({ ...e }))
  for (const [name, id] of Object.entries(PROBE.enchantments)) {
    const known = out.find(e => e.name === name) ?? { id: tables.ENCHANTMENTS_ADDED.find(a => a[1] === name)?.[0] }
    if (known.id !== id) throw new Error(`enchantment ${name}: data id ${known.id}, BDS ${id}`)
  }
  for (const [id, name] of tables.ENCHANTMENTS_ADDED) {
    const j = javaByName.get(name)
    if (!j) throw new Error(`enchantment ${name} missing from pc 26.1`)
    if (out.some(e => e.id === id || e.name === name)) throw new Error(`enchantment ${name}/${id} already present`)
    out.push({ ...j, id })
  }
  return out.sort((a, b) => a.id - b.id)
}

function buildAttributes () {
  const java = mcdata('pc', 'attributes', '26.1')
  const out = []
  const mapped = new Map(tables.ATTRIBUTES_JAVA.map(a => [a.name, a]))
  for (const j of java) {
    const m = mapped.get(j.name)
    out.push(m ? { ...j, ...m } : { ...j })
    mapped.delete(j.name)
  }
  if (mapped.size) throw new Error(`attribute table names not in pc 26.1: ${[...mapped.keys()]}`)
  for (const a of tables.ATTRIBUTES_BEDROCK_ONLY) out.push({ ...a, resource: a.bedrockName })
  return out
}

async function buildEntities (report) {
  const { idlist } = await readNbt('cloudburst/entity_identifiers.dat')
  const bedrock = mcdata('bedrock', 'entities') // minecraft-data bedrock 1.21.80
  const java = mcdata('pc', 'entities', '26.1')
  const bedrockByName = new Map(bedrock.map(e => [e.name, e]))
  const javaByName = new Map(java.map(e => [e.name, e]))
  const out = []
  for (const e of idlist) {
    const name = e.id.replace('minecraft:', '')
    const known = bedrockByName.get(name)
    const javaName = tables.ENTITY_JAVA_NAMES[name] ?? name
    const j = javaByName.get(javaName)
    const manual = tables.ENTITIES_MANUAL[name]
    const src = known ?? manual ?? j
    if (!src) throw new Error(`entity ${name}: no minecraft-data entry (add it to ENTITIES_MANUAL)`)
    // size: tables.ENTITY_SIZES, else the BDS bounding box from the live probe (summonable entities), else minecraft-data
    const probed = tables.ENTITY_SIZES[name] ?? PROBE.entities[name]
    const entity = {
      id: e.rid,
      internalId: e.rid,
      name,
      displayName: src.displayName ?? j?.displayName,
      width: probed?.[0] ?? src.width ?? j?.width ?? null,
      height: probed?.[1] ?? src.height ?? j?.height ?? null,
      type: src.type || j?.type || 'other',
      category: src.category ?? j?.category ?? 'UNKNOWN'
    }
    if (probed && known && (Math.abs(probed[0] - known.width) > 1e-3 || Math.abs(probed[1] - known.height) > 1e-3)) {
      report.push(`entities: ${name} size ${known.width}x${known.height} -> BDS ${probed[0]}x${probed[1]}`)
    }
    if (known?.length != null) entity.length = known.length
    if (known?.offset != null) entity.offset = known.offset
    if (!known) report.push(`entities: ${name} (new since 1.21.80) from ${manual ? 'ENTITIES_MANUAL' : 'pc 26.1 ' + javaName}`)
    out.push(entity)
  }
  const ids = new Set()
  for (const e of out) {
    if (ids.has(e.id)) throw new Error(`entity id ${e.id} duplicated`)
    ids.add(e.id)
    if (e.displayName == null) throw new Error(`entity ${e.name} has no display name`)
    if (e.width == null || e.height == null) {
      // Education Edition entities (agent, balloon, ice_bomb, tripod_camera): no size anywhere, not summonable
      report.push(`entities: ${e.name} has no known size, using 0x0`)
      e.width = e.width ?? 0
      e.height = e.height ?? 0
    }
  }
  for (const e of bedrock) if (!out.some(o => o.name === e.name)) report.push(`entities: dropped ${e.name} (not a BDS 1.26.51 entity identifier)`)
  return out.sort((a, b) => a.id - b.id)
}

function buildParticles () {
  // Bedrock ParticleType: level_event `0x4000 | id` (add_particle_<name>) in bedrock-protocol's 1.26.51 schema.
  const protocol = require(path.join(MCD, dataPaths.bedrock[VERSION].protocol, 'protocol.json'))
  const mappings = protocol.types.packet_level_event[1][0].type[1].mappings
  const out = []
  for (const [value, name] of Object.entries(mappings)) {
    const v = Number(value)
    if (v > 0x4000 && v < 0x8000 && name.startsWith('add_particle_')) out.push({ id: v - 0x4000, name: name.slice('add_particle_'.length) })
  }
  return out.sort((a, b) => a.id - b.id)
}

function buildSounds (report) {
  // Level sound events. On the 1.26.51 wire `level_sound_event.sound_id` is the string identifier
  // (gophertunnel's SoundEvent* constants); `id` is the legacy numeric LevelSoundEvent id from
  // bedrock-protocol's `SoundType` enum (matched by constant name).
  const protocol = require(path.join(MCD, dataPaths.bedrock[VERSION].protocol, 'protocol.json'))
  const legacy = protocol.types.SoundType[1].mappings
  const idByCamel = new Map(Object.entries(legacy).map(([id, n]) => [n.toLowerCase(), Number(id)]))
  const src = fs.readFileSync(sourcePath('gophertunnel/level_sound_event.go'), 'utf8')
  const out = []
  const seen = new Set()
  let nextId = Math.max(...idByCamel.values()) + 1
  for (const m of src.matchAll(/^\s*SoundEvent(\w+)\s*=\s*"([^"]*)"/gm)) {
    const [, camel, name] = m
    if (seen.has(name)) continue
    seen.add(name)
    let id = idByCamel.get(camel.toLowerCase())
    if (id === undefined) {
      id = nextId++
      report.push(`sounds: ${name} has no legacy id, assigned ${id}`)
    }
    out.push({ id, name })
  }
  if (out.length < 500) throw new Error(`only ${out.length} sound events parsed`)
  return out.sort((a, b) => a.id - b.id)
}

// ---------------------------------------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------------------------------------
function encode (name, value) {
  const json = JSON.stringify(value, null, name.endsWith('.gz') ? 0 : 2) + '\n'
  return name.endsWith('.gz') ? zlib.gzipSync(json, { level: 9 }) : Buffer.from(json)
}

async function main () {
  const check = process.argv.includes('--check')
  for (const s of Object.values(SOURCES)) {
    if (!fs.existsSync(sourcePath(s.id))) throw new Error(`missing source ${s.id}: run scripts/fetch-sources.js`)
  }
  const report = []
  const { blocks, blockStates, blockCollisionShapes, hashes } = buildBlocks(report)
  const { items, materials } = buildItems(report, blocks, hashes)
  const datasets = {
    blocks,
    blockStates,
    blockCollisionShapes,
    items,
    materials,
    foods: await buildFoods(items),
    effects: buildEffects(),
    enchantments: buildEnchantments(),
    attributes: buildAttributes(),
    entities: await buildEntities(report),
    particles: buildParticles(),
    sounds: buildSounds(report)
  }

  const files = {}
  for (const [name, value] of Object.entries(datasets)) {
    const plain = encode(name + '.json', value)
    const file = plain.length > GZIP_THRESHOLD ? name + '.json.gz' : name + '.json'
    files[path.join(OUT_DIR, file)] = file.endsWith('.gz') ? encode(file, value) : plain
  }
  // Test fixture: the Cloudburst runtime ids (unsigned, palette order) so unit tests can check every state
  // hash without the 18 MB source.
  const cloudburst = readJson('cloudburst/blocks.json')
  files[path.join(FIXTURE_DIR, 'cloudburst-block-hashes.json.gz')] = encode('x.json.gz', {
    source: `${SOURCES['cloudburst/blocks.json'].repo}@${SOURCES['cloudburst/blocks.json'].sha} blocks.json (Apache-2.0), blockStateHash in palette order`,
    hashes: cloudburst.map(e => e.blockStateHash >>> 0)
  })
  if (hashes.length !== cloudburst.length) throw new Error('hash count')

  let stale = 0
  const expected = new Set(Object.keys(files))
  for (const [file, buf] of Object.entries(files)) {
    const current = fs.existsSync(file) ? fs.readFileSync(file) : null
    if (current && current.equals(buf)) continue
    if (check) {
      console.error('stale:', path.relative(pkgRoot, file))
      stale++
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, buf)
      console.log('wrote', path.relative(pkgRoot, file), buf.length, 'bytes')
    }
  }
  for (const f of fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : []) {
    const file = path.join(OUT_DIR, f)
    if (expected.has(file)) continue
    if (check) { console.error('unexpected:', f); stale++ } else { fs.unlinkSync(file); console.log('removed', f) }
  }
  for (const line of report) console.log('  ' + line)
  if (check && stale) throw new Error(`${stale} generated file(s) out of date: run scripts/generate.js`)
  console.log(check ? 'generated data is up to date' : 'done')
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1) })
}

module.exports = { blockStateHash, fnv1a32 }
