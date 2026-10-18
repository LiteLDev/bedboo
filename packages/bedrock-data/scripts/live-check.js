#!/usr/bin/env node
// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * Live data check against a running BDS 1.26.51.1 (manual container, see docs/testing.md): joins with a raw
 * bedrock-protocol client after install(), builds the registry from start_game + item_registry, requests
 * and decodes every sub-chunk it is offered with the patched prismarine-chunk in the overworld, the nether
 * and the end (`/execute in <dim> run tp @s …`), and checks
 *   - no runtime id falls back to the unknown placeholder,
 *   - every decoded sub-chunk re-encodes byte for byte,
 *   - every item in inventory/creative packets resolves, mob_effect ids resolve, update_attributes names
 *     map to registry.attributes, level_sound_event names are in registry.sounds,
 *   - every biome id in the level_chunk biome palettes is a registry biome of that dimension,
 *   - `--biomes a,b,…`: for each biome, `/locate biome minecraft:<name>` (in its dimension), teleport there
 *     and read the biome id at the located block from the chunk: it must be that biome's registry id.
 * Exit code 1 on any failure.
 *
 *   node packages/bedrock-data/scripts/live-check.js --port 40110 [--host 127.0.0.1] [--seconds 12] [--biomes a,b]
 */
const { connect, sleep } = require('./lib/bds-client')

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def }
const DIMENSIONS = {
  overworld: { id: 0, minY: -4, maxY: 19, tp: '0 100 0' },
  nether: { id: 1, minY: 0, maxY: 7, tp: '0 70 0' },
  the_end: { id: 2, minY: 0, maxY: 15, tp: '100 49 0' }
}

async function main () {
  const bot = connect({ host: arg('host', '127.0.0.1'), port: Number(arg('port', 40110)), username: 'U2Live' })
  const { client, requireLib } = bot
  const { Vec3 } = requireLib('vec3')
  const registry = requireLib('prismarine-registry')('bedrock_1.26.51')
  const Item = requireLib('prismarine-item')(registry)
  let Chunk = null
  const failures = []
  const fail = msg => { if (failures.length < 50) console.error('FAIL', msg); failures.push(msg) }

  client.on('start_game', p => {
    registry.handleStartGame(p)
    Chunk = requireLib('prismarine-chunk')(registry)
  })
  client.on('item_registry', p => registry.handleItemRegistry(p))

  const stats = {}
  const biomeStats = {} // dimension → biome name → columns
  let dimension = 'overworld'
  const columns = new Map()
  const pending = []
  client.on('level_chunk', p => {
    if (!Chunk) return
    const dim = Object.keys(DIMENSIONS).find(d => DIMENSIONS[d].id === p.dimension)
    const column = new Chunk({ x: p.x, z: p.z })
    // the column defaults to the overworld's -64..320; biome sections are read from the bottom of the
    // dimension, so the nether (0..128) and the end (0..256) need their own bounds
    column.setBounds(DIMENSIONS[dim].minY, DIMENSIONS[dim].maxY + 1)
    try {
      column.networkDecodeNoCache(p.payload, p.sub_chunk_count)
    } catch (err) { fail(`${dim} level_chunk ${p.x},${p.z}: ${err.message}`) }
    columns.set(`${p.dimension}:${p.x},${p.z}`, column)
    // biome palettes carry vanilla biome ids: each must be a registry biome of this dimension
    const ids = new Set()
    for (const section of column.biomes ?? []) for (const id of section.palette ?? []) ids.add(id)
    for (const id of ids) {
      const biome = registry.biomes[id]
      if (!biome) { fail(`${dim} ${p.x},${p.z}: unknown biome id ${id}`); continue }
      if (biome.dimension !== dim) fail(`${dim} ${p.x},${p.z}: biome id ${id} is ${biome.name}, a ${biome.dimension} biome`)
      const s = (biomeStats[dim] ??= {})
      s[`${biome.name}(${id})`] = (s[`${biome.name}(${id})`] || 0) + 1
    }
    const { minY, maxY } = DIMENSIONS[dim]
    const requests = []
    for (let y = minY; y <= maxY; y++) requests.push({ x: 0, y, z: 0 })
    client.queue('subchunk_request', { dimension: p.dimension, origin: { x: p.x, y: 0, z: p.z }, requests })
  })
  client.on('subchunk', p => {
    const dim = Object.keys(DIMENSIONS).find(d => DIMENSIONS[d].id === p.dimension)
    const s = (stats[dim] ??= { subchunks: 0, airOnly: 0, names: {} })
    for (const e of p.entries) {
      if (e.result === 'success_all_air') { s.airOnly++; continue }
      if (e.result !== 'success') continue
      const x = p.origin.x + e.dx
      const y = p.origin.y + e.dy
      const z = p.origin.z + e.dz
      const column = columns.get(`${p.dimension}:${x},${z}`)
      if (!column) continue
      pending.push((async () => {
        try {
          await column.networkDecodeSubChunkNoCache(y, e.payload)
          s.subchunks++
          for (const layer of column.getSectionAtIndex(y).palette) {
            for (const entry of layer) {
              if (entry.runtimeId !== undefined) fail(`${dim} ${x},${y},${z}: unknown runtime id ${entry.runtimeId}`)
              s.names[entry.name] = (s.names[entry.name] || 0) + 1
            }
          }
          const encoded = await column.networkEncodeSubChunkNoCache(y)
          if (!encoded.equals(e.payload)) fail(`${dim} ${x},${y},${z}: re-encode differs`)
        } catch (err) { fail(`${dim} sub-chunk ${x},${y},${z}: ${err.message}`) }
      })())
    }
  })
  client.on('change_dimension', p => {
    dimension = Object.keys(DIMENSIONS).find(d => DIMENSIONS[d].id === p.dimension)
    console.log('change_dimension →', dimension)
    setTimeout(() => {
      client.queue('player_action', {
        runtime_entity_id: bot.state.startGame.runtime_entity_id,
        action: 'dimension_change_ack',
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0
      })
      client.queue('serverbound_loading_screen', { type: 1, loading_screen_id: p.loading_screen_id })
      client.queue('serverbound_loading_screen', { type: 2, loading_screen_id: p.loading_screen_id })
    }, 500)
  })

  // other datasets against what the server sends
  const checkItem = (where, wire) => {
    if (!wire || wire.network_id === 0) return
    if (!registry.items[wire.network_id]) return fail(`${where}: unknown item ${wire.network_id}`)
    const item = Item.fromNotch(wire)
    if (wire.block_runtime_id && !registry.blocksByRuntimeId[wire.block_runtime_id]) fail(`${where}: ${item.name} block_runtime_id ${wire.block_runtime_id}`)
  }
  client.on('inventory_content', p => p.input.forEach(i => checkItem('inventory_content', i)))
  client.on('inventory_slot', p => checkItem('inventory_slot', p.item))
  client.on('creative_content', p => p.items.forEach(e => {
    checkItem('creative_content', e.item)
    if ((Item.toNotch(new Item(e.item.network_id, 1, e.item.metadata)).block_runtime_id) !== e.item.block_runtime_id) fail(`creative item ${registry.items[e.item.network_id]?.name}: block_runtime_id`)
  }))
  client.on('mob_effect', p => { if (!registry.effects[p.effect_id]) fail(`mob_effect id ${p.effect_id}`) })
  const bedrockAttributes = new Set(registry.attributesArray.map(a => a.bedrockName).filter(Boolean))
  client.on('update_attributes', p => p.attributes.forEach(a => { if (!bedrockAttributes.has(a.name)) fail(`attribute ${a.name}`) }))
  client.on('level_sound_event', p => { if (!registry.soundsByName[p.sound_id]) fail(`sound ${p.sound_id}`) })
  client.on('add_entity', p => { if (!registry.entitiesByName[p.entity_type.replace('minecraft:', '')]) fail(`entity ${p.entity_type}`) })
  client.on('update_block', p => { if (!registry.blocksByRuntimeId[p.block_runtime_id]) fail(`update_block ${p.block_runtime_id}`) })

  /**
   * `/locate biome` the biome in its dimension, teleport there and read the chunk biome id at the located
   * block: it must be the registry id of that biome. locate samples the biome noise, which can differ from the
   * stored chunk biomes right at a border, so a block within 8 blocks of the located one also counts.
   */
  async function checkLocatedBiome (name) {
    const biome = registry.biomesByName[name]
    if (!biome) return fail(`biome tour: ${name} is not a registry biome`)
    const dim = biome.dimension
    // command() takes the next command_output: check that it answers this locate (a late answer to an
    // earlier command would otherwise be taken for it)
    const out = await bot.command(`/execute in ${dim} run locate biome minecraft:${name}`, 60000)
    const answer = out?.output?.find(o => o.parameters?.[0] === `minecraft:${name}`)
    if (answer?.message_id === 'commands.locate.biome.fail') return console.log(`biome tour: ${name} not found near the player, skipped`)
    if (answer?.message_id !== 'commands.locate.biome.success') return fail(`biome tour: locate ${name}: ${JSON.stringify(out?.output ?? 'no answer')}`)
    const [x, y, z] = answer.parameters.slice(1, 4).map(Number)
    const keyOf = (bx, bz) => `${DIMENSIONS[dim].id}:${bx >> 4},${bz >> 4}`
    // a column the client already has is not sent again (biomes never change, so it is still valid)
    const tp = await bot.command(`/execute in ${dim} run tp @s ${x} ${y} ${z}`, 30000)
    if (!tp?.success_count) return fail(`biome tour: tp to ${name} at ${x},${y},${z}: ${JSON.stringify(tp?.output ?? 'no answer')}`)
    for (let waited = 0; !columns.has(keyOf(x, z)) && waited < 30000; waited += 250) await sleep(250)
    if (!columns.has(keyOf(x, z))) return fail(`biome tour: no level_chunk for ${name} at ${x},${y},${z} (${dim})`)
    await sleep(1000) // neighbouring columns
    const { minY, maxY } = DIMENSIONS[dim]
    const idAt = (bx, by, bz) => by >= minY * 16 && by < (maxY + 1) * 16 ? columns.get(keyOf(bx, bz))?.getBiomeId(new Vec3(bx & 15, by, bz & 15)) : undefined
    const exact = idAt(x, y, z)
    const around = new Set()
    for (let dx = -8; dx <= 8; dx += 2) for (let dy = -8; dy <= 8; dy += 2) for (let dz = -8; dz <= 8; dz += 2) around.add(idAt(x + dx, y + dy, z + dz))
    around.delete(undefined)
    const names = [...around].map(id => `${registry.biomes[id]?.name}(${id})`).join(', ')
    const msg = `${name} (registry id ${biome.id}) located at ${x},${y},${z} (${dim}): chunk biome id ${exact} (${registry.biomes[exact]?.name})`
    if (exact === biome.id) console.log(`biome tour: ${msg}`)
    else if (around.has(biome.id)) console.log(`biome tour: ${msg}; within 8 blocks: ${names}`)
    else return fail(`biome tour: ${msg}; within 8 blocks only ${names}`)
    verifiedBiomes++
  }
  let verifiedBiomes = 0

  await bot.spawned
  const seconds = Number(arg('seconds', 12))
  await bot.command('/gamerule domobspawning false')
  await bot.command('/effect @s speed 5 1')
  await bot.command('/effect @s resistance 600 255 true') // survive falls / suffocation after the teleports
  await bot.command('/give @s cooked_beef 3')
  await bot.command('/give @s oak_log 2')
  await sleep(seconds * 1000)
  for (const dim of ['nether', 'the_end', 'overworld']) {
    await bot.command(`/execute in ${dim} run tp @s ${DIMENSIONS[dim].tp}`)
    await sleep(seconds * 1000)
    if (dim === 'nether') {
      const column = columns.get('1:0,0')
      const block = column?.getBlock(new Vec3(0, 0, 0))
      if (block?.name !== 'bedrock') fail(`nether 0,0,0 is ${block?.name}, expected bedrock`)
    }
  }
  const tour = (arg('biomes', '') || '').split(',').filter(Boolean)
  for (const name of tour) await checkLocatedBiome(name)
  if (tour.length) {
    console.log(`biome tour: ${verifiedBiomes}/${tour.length} biomes verified`)
    if (!verifiedBiomes) fail('biome tour: no biome could be checked')
  }
  await Promise.all(pending)
  bot.close()

  for (const [dim, s] of Object.entries(stats)) {
    const top = Object.entries(s.names).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, c]) => `${n}×${c}`).join(' ')
    console.log(`${dim}: ${s.subchunks} sub-chunks decoded (+${s.airOnly} all-air), ${Object.keys(s.names).length} block names; ${top}`)
  }
  for (const [dim, s] of Object.entries(biomeStats)) {
    console.log(`${dim} biomes (columns): ${Object.entries(s).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(' ')}`)
  }
  for (const dim of Object.keys(DIMENSIONS)) if (!stats[dim]?.subchunks) fail(`no sub-chunk decoded in ${dim}`)
  for (const dim of Object.keys(DIMENSIONS)) if (!biomeStats[dim]) fail(`no biome decoded in ${dim}`)
  if (!biomeStats.the_end?.['the_end(9)']) fail('the end: biome the_end (9) not seen')
  const expect = { overworld: ['bedrock', 'dirt', 'grass_block'], nether: ['netherrack', 'bedrock', 'lava'], the_end: ['end_stone'] }
  for (const [dim, names] of Object.entries(expect)) for (const n of names) if (!stats[dim]?.names[n]) fail(`${dim}: no ${n} decoded`)
  console.log(failures.length ? `${failures.length} failure(s)` : 'live check passed')
  setTimeout(() => process.exit(failures.length ? 1 : 0), 200)
}

main().catch(err => { console.error(err); process.exit(1) })
