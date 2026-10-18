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
