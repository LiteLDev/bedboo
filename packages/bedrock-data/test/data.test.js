'use strict'
// owner: U2 (Bedrock data layer)
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const data = require('..')
const { blockStateHash } = require('../scripts/generate')

data.install()
const mcData = require('minecraft-data')('bedrock_1.26.51')

const unique = (array, key) => new Set(array.map(x => x[key])).size === array.length

describe('bedrock_1.26.51 datasets', () => {
  describe('blocks and block states', () => {
    const cloudburst = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'cloudburst-block-hashes.json.gz'))))

    it('every block state hashes to the CloudburstMC runtime id at the same palette index', () => {
      assert.strictEqual(cloudburst.hashes.length, mcData.blockStates.length)
      const known = new Set(cloudburst.hashes)
      const notFnv = []
      for (let i = 0; i < mcData.blockStates.length; i++) {
        const { name, states, hash } = mcData.blockStates[i]
        assert.ok(Number.isInteger(hash) && hash === (hash | 0), `state ${i} carries its runtime id as a signed int32`)
        if (hash !== blockStateHash(name, states)) notFnv.push(name)
        assert.ok(known.has(hash >>> 0), `${name} ${JSON.stringify(states)} hash ${hash} not in Cloudburst`)
        assert.strictEqual(hash >>> 0, cloudburst.hashes[i], `state ${i} (${name})`)
      }
      assert.deepStrictEqual(notFnv, ['unknown'], 'only minecraft:unknown has a reserved runtime id')
      assert.strictEqual(mcData.blockStates.find(s => s.name === 'unknown').hash, -2)
    })

    it('block state ranges partition blockStates exactly and name-match', () => {
      const owner = new Array(mcData.blockStates.length).fill(null)
      for (const block of mcData.blocksArray) {
        assert.ok(block.minStateId <= block.defaultState && block.defaultState <= block.maxStateId, block.name)
        for (let s = block.minStateId; s <= block.maxStateId; s++) {
          assert.strictEqual(owner[s], null, `state ${s} owned twice`)
          owner[s] = block.name
          assert.strictEqual(mcData.blockStates[s].name, block.name)
        }
      }
      assert.ok(owner.every(Boolean), 'every state belongs to a block')
      assert.ok(unique(mcData.blocksArray, 'id') && unique(mcData.blocksArray, 'name'))
    })

    it('has the 1.26.50 states minecraft-data 3.117.0 lacks (connections, stair corners)', () => {
      const has = (name, prop) => mcData.blockStates.some(s => s.name === name && prop in s.states)
      assert.ok(has('oak_fence', 'minecraft:connection_north'))
      assert.ok(has('iron_bars', 'minecraft:connection_east'))
      assert.ok(has('oak_stairs', 'minecraft:corner'))
    })

    it('every block has friction (Cloudburst) and a collision shape per state', () => {
      const { blocks, shapes } = mcData.blockCollisionShapes
      for (const block of mcData.blocksArray) {
        assert.strictEqual(typeof block.friction, 'number', block.name)
        const ids = blocks[block.name]
        assert.notStrictEqual(ids, undefined, block.name)
        if (Array.isArray(ids)) assert.strictEqual(ids.length, block.maxStateId - block.minStateId + 1, block.name)
        for (const id of [].concat(ids)) assert.ok(Array.isArray(shapes[id]), `${block.name} shape ${id}`)
      }
      assert.strictEqual(mcData.blocksByName.ice.friction, 0.98)
      assert.strictEqual(mcData.blocksByName.blue_ice.friction, 0.989)
      assert.strictEqual(mcData.blocksByName.slime.friction, 0.8)
      assert.strictEqual(mcData.blocksByName.stone.friction, 0.6)
    })

    it('uses the BDS collision boxes for doors and end portal frames (allowlist)', () => {
      const { blocks, shapes } = mcData.blockCollisionShapes
      const door = mcData.blocksByName.wooden_door
      const doorShapes = [].concat(blocks.wooden_door).map(id => shapes[id])
      for (const boxes of doorShapes) {
        const thin = boxes[0].slice(3).map((max, i) => max - boxes[0][i]).filter(d => d < 1)
        assert.deepStrictEqual(thin, [0.1875], JSON.stringify(boxes))
      }
      assert.strictEqual(doorShapes.length, door.maxStateId - door.minStateId + 1)
      const frame = mcData.blocksByName.end_portal_frame
      const eye = mcData.blockStates.findIndex((s, i) => i >= frame.minStateId && s.states.end_portal_eye_bit?.value === 1)
      assert.strictEqual(shapes[blocks.end_portal_frame[eye - frame.minStateId]].length, 2, 'frame + eye box')
    })
  })

  describe('items, materials, foods', () => {
    it('items have unique ids and names; block items name a valid block state', () => {
      assert.ok(unique(mcData.itemsArray, 'id') && unique(mcData.itemsArray, 'name'))
      const blockItems = mcData.itemsArray.filter(i => i.blockStateId !== undefined)
      assert.ok(blockItems.length > 1000)
      for (const item of blockItems) assert.ok(mcData.blockStates[item.blockStateId], item.name)
      assert.strictEqual(mcData.blockStates[mcData.itemsByName.oak_log.blockStateId].name, 'oak_log')
      assert.strictEqual(mcData.itemsByName.dispenser.blockStateId, mcData.blockStates.findIndex(s => s.name === 'dispenser' && s.states.facing_direction.value === 3 && s.states.triggered_bit.value === 0))
      assert.strictEqual(mcData.itemsByName.wooden_door.blockStateId, undefined, 'door items are not block items on Bedrock')
      assert.strictEqual(mcData.itemsByName.diamond_pickaxe.blockStateId, undefined)
    })

    it('harvestTools and materials use Bedrock item ids', () => {
      for (const block of mcData.blocksArray) {
        for (const id of Object.keys(block.harvestTools || {})) assert.ok(mcData.items[id], `${block.name} harvest tool ${id}`)
        assert.ok(mcData.materials[block.material], `${block.name} material ${block.material}`)
      }
      for (const tools of Object.values(mcData.materials)) for (const id of Object.keys(tools)) assert.ok(mcData.items[id], id)
      const pick = n => mcData.itemsByName[n + '_pickaxe'].id
      assert.deepStrictEqual(
        Object.keys(mcData.blocksByName.diamond_ore.harvestTools).map(Number).sort(),
        [pick('iron'), pick('diamond'), pick('netherite')].sort()
      )
      assert.strictEqual(mcData.materials['mineable/pickaxe'][pick('wooden')], 2)
      assert.strictEqual(mcData.materials['mineable/pickaxe'][pick('diamond')], 8)
    })

    it('foods follow the minecraft-data schema with Bedrock ids', () => {
      assert.strictEqual(mcData.foodsArray.length, 40)
      for (const food of mcData.foodsArray) {
        assert.strictEqual(mcData.items[food.id].name, food.name)
        for (const k of ['stackSize', 'foodPoints', 'saturation', 'effectiveQuality', 'saturationRatio']) assert.strictEqual(typeof food[k], 'number', `${food.name}.${k}`)
        assert.strictEqual(food.effectiveQuality, Math.round((food.foodPoints + food.saturation) * 100) / 100)
      }
      assert.deepStrictEqual(
        (({ foodPoints, saturation, saturationRatio }) => ({ foodPoints, saturation, saturationRatio }))(mcData.foodsByName.golden_apple),
        { foodPoints: 4, saturation: 9.6, saturationRatio: 2.4 }
      )
      assert.strictEqual(mcData.foodsByName.cooked_beef.foodPoints, 8)
    })
  })

  describe('effects, enchantments, attributes', () => {
    it('effects: Bedrock ids with minecraft-data (Java) names', () => {
      assert.ok(unique(mcData.effectsArray, 'id') && unique(mcData.effectsArray, 'name'))
      const ids = { Speed: 1, Slowness: 2, Haste: 3, MiningFatigue: 4, JumpBoost: 8, Levitation: 24, FatalPoison: 25, ConduitPower: 26, SlowFalling: 27, Darkness: 30, BreathOfTheNautilus: 37 }
      for (const [name, id] of Object.entries(ids)) assert.strictEqual(mcData.effectsByName[name].id, id, name)
      for (const javaOnly of ['Glowing', 'Luck', 'BadLuck', 'DolphinsGrace']) assert.strictEqual(mcData.effectsByName[javaOnly], undefined)
    })

    it('enchantments: Bedrock ids', () => {
      assert.ok(unique(mcData.enchantmentsArray, 'id') && unique(mcData.enchantmentsArray, 'name'))
      const ids = { protection: 0, aqua_affinity: 8, sharpness: 9, efficiency: 15, silk_touch: 16, fortune: 18, mending: 26, swift_sneak: 37, wind_burst: 38, density: 39, breach: 40, lunge: 41 }
      for (const [name, id] of Object.entries(ids)) assert.strictEqual(mcData.enchantmentsByName[name].id, id, name)
      assert.strictEqual(mcData.enchantmentsByName.sweeping_edge, undefined)
    })

    it('attributes: Java resource keys with Bedrock names', () => {
      assert.ok(unique(mcData.attributesArray, 'name') && unique(mcData.attributesArray, 'resource'))
      const a = mcData.attributesByName
      assert.strictEqual(a.movementSpeed.resource, 'minecraft:movement_speed')
      assert.strictEqual(a.movementSpeed.bedrockName, 'minecraft:movement')
      assert.strictEqual(a.maxHealth.bedrockName, 'minecraft:health')
      assert.strictEqual(a.playerHunger.resource, 'minecraft:player.hunger')
      assert.strictEqual(mcData.attributes['minecraft:movement_speed'], a.movementSpeed)
      assert.strictEqual(new Set(mcData.attributesArray.filter(x => x.bedrockName).map(x => x.bedrockName)).size, mcData.attributesArray.filter(x => x.bedrockName).length)
    })
  })

  describe('entities, particles, sounds', () => {
    it('entities: every BDS 1.26.51 identifier, with sizes', () => {
      assert.strictEqual(mcData.entitiesArray.length, 137)
      assert.ok(unique(mcData.entitiesArray, 'id') && unique(mcData.entitiesArray, 'name'))
      for (const e of mcData.entitiesArray) {
        for (const k of ['width', 'height']) assert.strictEqual(typeof e[k], 'number', `${e.name}.${k}`)
        assert.strictEqual(typeof e.displayName, 'string')
        assert.strictEqual(e.internalId, e.id)
      }
      for (const name of ['happy_ghast', 'copper_golem', 'nautilus', 'zombie_nautilus', 'camel_husk', 'parched', 'breeze', 'warden', 'armadillo']) assert.ok(mcData.entitiesByName[name], name)
      assert.deepStrictEqual([mcData.entitiesByName.zombie.width, mcData.entitiesByName.zombie.height], [0.6, 1.9])
      assert.strictEqual(mcData.entitiesByName.player.id, 257)
      assert.strictEqual(mcData.entitiesByName.zombie.type, 'hostile')
    })

    it('entities: identifiers minecraft-data lists twice keep the Bedrock entity, not a Java-only variant', () => {
      const displayNames = {
        zombie: 'Zombie', // not Giant
        llama: 'Llama', // not Trader Llama (Bedrock: trader_llama)
        arrow: 'Arrow', // not Spectral Arrow
        evocation_illager: 'Evoker', // not Illusioner
        armor_stand: 'Armor Stand',
        minecart: 'Minecart',
        trader_llama: 'Trader Llama'
      }
      for (const [name, displayName] of Object.entries(displayNames)) assert.strictEqual(mcData.entitiesByName[name].displayName, displayName, name)
      for (const javaOnly of ['Giant', 'Spectral Arrow', 'Illusioner']) assert.ok(!mcData.entitiesArray.some(e => e.displayName === javaOnly), javaOnly)
    })

    it('particles: Bedrock particle types', () => {
      assert.ok(unique(mcData.particlesArray, 'id') && unique(mcData.particlesArray, 'name'))
      assert.strictEqual(mcData.particlesByName.bubble.id, 1)
      assert.strictEqual(mcData.particlesByName.heart.id, 19)
    })

    it('sounds: level sound event identifiers', () => {
      assert.ok(unique(mcData.soundsArray, 'id') && unique(mcData.soundsArray, 'name'))
      assert.strictEqual(mcData.soundsByName['item.use.on'].id, 0)
      for (const name of ['spawn', 'pop', 'armor.equip_iron', 'mob.warning', 'disappeared']) assert.ok(mcData.soundsByName[name], name)
    })
  })

  describe('biomes', () => {
    /** the minecraft-data schema (draft-07 subset it uses: type, required, additionalProperties, min/max, enum, pattern) */
    function validate (value, schema, where) {
      const types = { integer: Number.isInteger, number: v => typeof v === 'number', string: v => typeof v === 'string', boolean: v => typeof v === 'boolean', array: Array.isArray, object: v => v !== null && typeof v === 'object' && !Array.isArray(v) }
      assert.ok(types[schema.type](value), `${where}: ${JSON.stringify(value)} is not ${schema.type}`)
      if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${where} >= ${schema.minimum}`)
      if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${where} <= ${schema.maximum}`)
      if (schema.enum) assert.ok(schema.enum.includes(value), `${where} in ${schema.enum}`)
      if (schema.pattern) assert.match(value, new RegExp(schema.pattern), where)
      if (schema.type === 'array' && schema.items) value.forEach((v, i) => validate(v, schema.items, `${where}[${i}]`))
      if (schema.type === 'object') {
        for (const key of schema.required ?? []) assert.ok(key in value, `${where}.${key} is required`)
        for (const [key, v] of Object.entries(value)) {
          assert.ok(schema.properties[key] || schema.additionalProperties !== false, `${where}.${key} is not in the schema`)
          if (schema.properties[key]) validate(v, schema.properties[key], `${where}.${key}`)
        }
      }
    }

    it('are keyed by the vanilla Bedrock ids that chunk biome palettes carry', () => {
      const ids = [
        ['ocean', 0], ['plains', 1], ['desert', 2], ['river', 7], ['hell', 8], ['the_end', 9], ['stone_beach', 25],
        ['bamboo_jungle', 48], ['sunflower_plains', 129], ['soulsand_valley', 178], ['crimson_forest', 179],
        ['warped_forest', 180], ['basalt_deltas', 181], ['frozen_peaks', 183], ['grove', 185], ['lush_caves', 187],
        ['deep_dark', 190], ['mangrove_swamp', 191], ['cherry_grove', 192], ['pale_garden', 193], ['sulfur_caves', 194],
        ['dappled_forest', 195]
      ]
      for (const [name, id] of ids) {
        assert.strictEqual(mcData.biomesByName[name]?.id, id, name)
        assert.strictEqual(mcData.biomes[id].name, name, String(id))
      }
      assert.strictEqual(mcData.biomesArray.length, 89)
      assert.ok(unique(mcData.biomesArray, 'id') && unique(mcData.biomesArray, 'name'))
    })

    it('ids sort exactly like BDS lists the biomes in biome_definition_list (probe)', () => {
      const order = require('../scripts/probe/1.26.51.json').biomeOrder
      assert.deepStrictEqual([...mcData.biomesArray].sort((a, b) => a.id - b.id).map(b => b.name), order)
    })

    it('agree with minecraft-data bedrock 1.20.0 (vanilla ids) on every biome it lists', () => {
      const legacy = require('minecraft-data/minecraft-data/data/bedrock/1.20.0/biomes.json')
      for (const old of legacy) {
        const b = mcData.biomes[old.id]
        assert.strictEqual(b?.name, old.name, `id ${old.id}`)
        assert.strictEqual(b.category, old.category, old.name)
        assert.strictEqual(b.displayName, old.displayName, old.name)
        assert.strictEqual(b.dimension, old.dimension === 'end' ? 'the_end' : old.dimension, old.name)
      }
    })

    it('follow the minecraft-data biomes schema', () => {
      validate(mcData.biomesArray, require('minecraft-data/minecraft-data/schemas/biomes_schema.json'), 'biomes')
    })

    it('carry the BDS climate and dimension', () => {
      const b = mcData.biomesByName
      assert.deepStrictEqual([b.hell.dimension, b.hell.temperature, b.hell.has_precipitation], ['nether', 2, false])
      assert.deepStrictEqual([b.the_end.dimension, b.the_end.has_precipitation], ['the_end', false])
      assert.deepStrictEqual([b.plains.dimension, b.plains.temperature, b.plains.rainfall, b.plains.has_precipitation], ['overworld', 0.8, 0.4, true])
      assert.strictEqual(b.desert.has_precipitation, false)
      assert.strictEqual(b.frozen_peaks.temperature, -0.7)
      assert.deepStrictEqual(mcData.biomesArray.filter(x => x.dimension === 'nether').map(x => x.name).sort(), ['basalt_deltas', 'crimson_forest', 'hell', 'soulsand_valley', 'warped_forest'])
      assert.deepStrictEqual(mcData.biomesArray.filter(x => x.dimension === 'the_end').map(x => x.name), ['the_end'])
    })
  })

  describe('feature table', () => {
    it('agrees with minecraft-data on every Bedrock feature', () => {
      const names = require('minecraft-data/minecraft-data/data/bedrock/common/features.json').map(f => f.name)
      for (const name of names) {
        assert.ok(Object.prototype.hasOwnProperty.call(data.features, name), name)
        assert.deepStrictEqual(data.features[name], mcData.supportFeature(name), name)
        assert.deepStrictEqual(data.bedrockFeatures[name], mcData.supportFeature(name), name)
      }
    })

    it('is frozen', () => {
      assert.ok(Object.isFrozen(data.features))
    })
  })
})
