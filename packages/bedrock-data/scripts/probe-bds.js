#!/usr/bin/env node
// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * Asks a running BDS 1.26.51.1 for the facts no pinned source has, and writes them to
 * `scripts/probe/1.26.51.json` (committed; generate.js reads it):
 *   - effect ids:      `/effect @s <name>` → mob_effect.effect_id
 *   - enchantment ids: `/enchant @s <name>` on a suitable item → `ench` NBT id (inventory_transaction)
 *   - entity sizes:    `/summon <id>` → add_entity metadata boundingbox_width / boundingbox_height
 *   - biome order:     the vanilla biome names in the order `biome_definition_list` lists them (vanilla id
 *                      order; their `biome_id` is 65535 = "vanilla id"), checked against the biome ids
 *
 *   node packages/bedrock-data/scripts/probe-bds.js --port 40110 [--host 127.0.0.1] [--only biomes]
 * `--only biomes` joins, records the biome order and updates just that key of the probe file.
 * The player must be an operator (DEFAULT_PLAYER_PERMISSION_LEVEL=operator in the docker recipe).
 */
const fs = require('fs')
const path = require('path')
const { connect, sleep } = require('./lib/bds-client')
const tables = require('./tables')
const { sourcePath } = require('./sources')

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def }
const OUT = path.join(__dirname, 'probe', '1.26.51.json')

/** item to hold for each enchantment probe (Bedrock only enchants compatible items) */
const ENCHANT_ITEM = { wind_burst: 'mace', density: 'mace', breach: 'mace', lunge: 'iron_spear', sharpness: 'iron_sword', efficiency: 'iron_pickaxe' }

/** entities whose size is random per spawn (slime/magma cube sizes): not probed, see tables.ENTITY_SIZES */
const RANDOM_SIZE = new Set(['slime', 'magma_cube'])

/**
 * Summons `id` and returns its final bounding box: add_entity metadata, updated by any set_entity_data
 * for the same runtime id within 800 ms (component groups applied right after spawn).
 */
async function probeSize (bot, id) {
  const got = bot.waitFor('add_entity', p => p.entity_type === id, 2500)
  await bot.command(`/summon ${id} ~4 ~ ~4`)
  const p = await got
  if (!p) return null
  const md = {}
  const apply = list => { for (const m of list) md[m.key] = m.value }
  apply(p.metadata)
  const onData = d => { if (BigInt(d.runtime_entity_id) === BigInt(p.runtime_id)) apply(d.metadata) }
  bot.client.on('set_entity_data', onData)
  await sleep(800)
  bot.client.removeListener('set_entity_data', onData)
  if (md.boundingbox_width == null) return null
  const r = v => Math.round(v * 1e4) / 1e4
  return { width: r(md.boundingbox_width), height: r(md.boundingbox_height), baby: !!md.flags?.baby }
}

/** Vanilla biome names (no namespace) in biome_definition_list order; custom (data-driven) biomes are skipped. */
function biomeOrder (packet) {
  const names = []
  for (const def of packet.biome_definitions) {
    const name = packet.string_list[def.name_index]
    if (!name.startsWith('minecraft:')) continue
    if (def.biome_id !== 65535) throw new Error(`biome ${name} has biome_id ${def.biome_id} (expected 65535 for vanilla biomes)`)
    names.push(name.slice('minecraft:'.length))
  }
  return names
}

function writeProbe (result) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2).replace(/\[\n\s+([\d.]+),\n\s+([\d.]+)\n\s+\]/g, '[$1, $2]') + '\n')
}

async function main () {
  const port = Number(arg('port', 40110))
  const bot = connect({ host: arg('host', '127.0.0.1'), port, username: 'U2Probe' })
  const biomes = bot.waitFor('biome_definition_list', () => true, 30000)
  const nbt = bot.requireLib('prismarine-nbt')
  await bot.spawned
  const biomePacket = await biomes
  if (!biomePacket) throw new Error('no biome_definition_list during join')
  if (arg('only') === 'biomes') {
    const result = JSON.parse(fs.readFileSync(OUT, 'utf8'))
    result.biomeOrder = biomeOrder(biomePacket)
    bot.close()
    writeProbe(result)
    console.log('wrote', path.relative(process.cwd(), OUT), `(biomeOrder: ${result.biomeOrder.length} biomes)`)
    setTimeout(() => process.exit(0), 200)
    return
  }
  await sleep(1500)
  const result = { bds: '1.26.51.1', probedAt: new Date().toISOString().slice(0, 10), effects: {}, enchantments: {}, entities: {}, biomeOrder: biomeOrder(biomePacket) }

  for (const [, , , , bedrockName] of tables.EFFECTS) {
    const got = bot.waitFor('mob_effect', p => p.event_id === 'add', 2000)
    await bot.command(`/effect @s ${bedrockName} 5 0`)
    const p = await got
    result.effects[bedrockName] = p ? p.effect_id : null
    await bot.command('/effect @s clear')
  }

  for (const [name, item] of Object.entries(ENCHANT_ITEM)) {
    await bot.command(`/replaceitem entity @s slot.hotbar 0 ${item}`)
    await sleep(300)
    const got = bot.waitFor('inventory_transaction', p => (p.transaction?.actions || []).some(a => a.new_item?.extra?.nbt?.nbt), 3000)
    await bot.command(`/enchant @s ${name} 1`)
    const p = await got
    const action = p?.transaction.actions.find(a => a.new_item?.extra?.nbt?.nbt)
    const ench = action ? nbt.simplify(action.new_item.extra.nbt.nbt).ench : null
    result.enchantments[name] = ench?.length === 1 ? ench[0].id : null
  }

  await bot.command('/gamerule domobspawning false')
  const { idlist } = nbt.simplify((await nbt.parse(fs.readFileSync(sourcePath('cloudburst/entity_identifiers.dat')))).parsed)
  for (const e of idlist) {
    const name = e.id.replace('minecraft:', '')
    if (!e.summonable || RANDOM_SIZE.has(name)) continue
    // summon may produce a baby (zombies, piglins, …): retry for an adult, keep a baby only if nothing else
    // spawns (tadpole is always a baby)
    let baby = null
    result.entities[name] = null
    for (let attempt = 0; attempt < 4 && !result.entities[name]; attempt++) {
      const size = await probeSize(bot, e.id)
      if (size && !size.baby) result.entities[name] = [size.width, size.height]
      else if (size) baby = [size.width, size.height]
      await bot.command(`/kill @e[type=${e.id}]`)
    }
    result.entities[name] ??= baby
  }
  await bot.command('/kill @e[type=!player]')
  bot.close()

  writeProbe(result)
  const missing = [
    ...Object.entries(result.effects).filter(([, v]) => v == null).map(([k]) => 'effect ' + k),
    ...Object.entries(result.enchantments).filter(([, v]) => v == null).map(([k]) => 'enchantment ' + k),
    ...Object.entries(result.entities).filter(([, v]) => v == null).map(([k]) => 'entity ' + k)
  ]
  console.log('wrote', path.relative(process.cwd(), OUT), missing.length ? 'unresolved: ' + missing.join(', ') : '(all resolved)')
  setTimeout(() => process.exit(0), 200)
}

main().catch(err => { console.error(err); process.exit(1) })
