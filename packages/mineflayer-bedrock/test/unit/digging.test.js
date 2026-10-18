'use strict'
// owner: U10 (digging) — lib/bedrock/dig_speed.js (Bedrock break speed, calibrated on BDS 1.26.51.1) and the digging
// plugin's block-action protocol on a fake client with the recorded BDS join (flat world), plus the mineflayer
// internalTest digTime analog (docs/parity/U3-internal-tests.md).
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { createRegistry } = require('../../lib/registry')
const digSpeed = require('../../lib/bedrock/dig_speed')

const HASTE = 3
const MINING_FATIGUE = 4
const CONDUIT_POWER = 26

/**
 * BDS 1.26.51.1 measurements: level_event block_start_break data (progress per tick × 65535, floored) when the bot
 * started breaking `block` with `tool` (scratch probe, docs/differences/U10.md#dig-speed).
 */
const MEASURED = [
  { block: 'dirt', data: 4369 },
  { block: 'dirt', tool: 'wooden_shovel', data: 8738 },
  { block: 'stone', data: 436 },
  { block: 'stone', tool: 'wooden_pickaxe', data: 2912 },
  { block: 'iron_ore', tool: 'wooden_pickaxe', data: 436 },
  { block: 'iron_ore', tool: 'stone_pickaxe', data: 2912 },
  { block: 'obsidian', tool: 'diamond_pickaxe', data: 499 },
  { block: 'obsidian', tool: 'iron_pickaxe', data: 112 },
  { block: 'ancient_debris', tool: 'netherite_pickaxe', data: 655 },
  { block: 'deepslate_iron_ore', tool: 'iron_pickaxe', data: 2912 },
  { block: 'stone', tool: 'golden_pickaxe', data: 17476 },
  { block: 'stone', tool: 'copper_pickaxe', data: 7281 },
  { block: 'oak_log', tool: 'wooden_axe', data: 2184 },
  { block: 'oak_log', tool: 'wooden_pickaxe', data: 1092 },
  { block: 'oak_leaves', data: 10922 },
  { block: 'oak_leaves', tool: 'shears', data: 163837 },
  { block: 'oak_leaves', tool: 'wooden_hoe', data: 21845 },
  { block: 'glass', data: 7281 },
  { block: 'sand', tool: 'iron_shovel', data: 26214 },
  { block: 'gravel', data: 3640 },
  { block: 'grass_block', data: 3640 },
  { block: 'stone', tool: 'iron_pickaxe', efficiency: 1, data: 11650 },
  { block: 'stone', tool: 'iron_pickaxe', efficiency: 3, data: 23301 },
  { block: 'stone', tool: 'iron_pickaxe', efficiency: 5, data: 46602 },
  { block: 'stone', tool: 'wooden_pickaxe', efficiency: 5, data: 40777 },
  { block: 'stone', tool: 'wooden_shovel', efficiency: 3, data: 436 },
  { block: 'stone', tool: 'iron_pickaxe', haste: 1, data: 12582 },
  { block: 'stone', tool: 'iron_pickaxe', haste: 2, data: 17615 },
  { block: 'stone', tool: 'iron_pickaxe', haste: 3, data: 24158 },
  { block: 'stone', tool: 'iron_pickaxe', haste: 5, data: 43485 },
  { block: 'stone', haste: 1, data: 629 },
  { block: 'stone', tool: 'iron_pickaxe', conduit: 1, data: 12582 },
  { block: 'stone', tool: 'iron_pickaxe', conduit: 2, haste: 1, data: 17615 },
  { block: 'stone', tool: 'iron_pickaxe', fatigue: 1, data: 1834 },
  { block: 'stone', tool: 'iron_pickaxe', fatigue: 2, data: 385 },
  { block: 'stone', tool: 'iron_pickaxe', fatigue: 3, data: 80 },
  { block: 'stone', tool: 'iron_pickaxe', fatigue: 4, data: 16 },
  { block: 'stone', tool: 'diamond_pickaxe', fatigue: 5, data: 4 },
  { block: 'stone', fatigue: 1, data: 91 },
  { block: 'stone', tool: 'iron_pickaxe', haste: 2, fatigue: 1, data: 3699 },
  { block: 'stone', tool: 'iron_pickaxe', efficiency: 2, haste: 2, data: 32295 },
  { block: 'dirt', inWater: true, data: 873 },
  { block: 'dirt', notOnGround: true, data: 873 },
  { block: 'dirt', inWater: true, notOnGround: true, data: 174 },
  { block: 'dirt', inWater: true, aquaAffinity: true, data: 4369 },
  { block: 'dirt', aquaAffinity: true, data: 4369 }
]

function inputsOf (registry, c) {
  const effects = {}
  if (c.haste) effects[HASTE] = { id: HASTE, amplifier: c.haste - 1, duration: 2000 }
  if (c.fatigue) effects[MINING_FATIGUE] = { id: MINING_FATIGUE, amplifier: c.fatigue - 1, duration: 2000 }
  if (c.conduit) effects[CONDUIT_POWER] = { id: CONDUIT_POWER, amplifier: c.conduit - 1, duration: 2000 }
  const enchantments = []
  if (c.efficiency) enchantments.push({ name: 'efficiency', lvl: c.efficiency })
  if (c.aquaAffinity) enchantments.push({ name: 'aqua_affinity', lvl: 1 })
  return {
    heldItemType: c.tool ? registry.itemsByName[c.tool].id : null,
    inWater: !!c.inWater,
    notOnGround: !!c.notOnGround,
    enchantments,
    effects
  }
}

describe('dig speed (lib/bedrock/dig_speed.js)', function () {
  this.timeout(60000)
  const registry = createRegistry('1.26.51')
  const Block = require('prismarine-block')(registry)

  it('reproduces every break speed measured on BDS 1.26.51.1 (level_event data)', () => {
    assert.strictEqual(registry.effectsByName.Haste.id, HASTE)
    assert.strictEqual(registry.effectsByName.MiningFatigue.id, MINING_FATIGUE)
    assert.strictEqual(registry.effectsByName.ConduitPower.id, CONDUIT_POWER)
    for (const c of MEASURED) {
      const block = Block.fromStateId(registry.blocksByName[c.block].defaultState, 0)
      const delta = digSpeed.breakDelta(registry, block, inputsOf(registry, c))
      assert.strictEqual(digSpeed.speedData(delta), c.data, JSON.stringify(c))
    }
  })

  it('equals prismarine-block digTime for every block × tool × water/air/efficiency without effects', () => {
    const tools = new Set([null])
    for (const material of Object.values(registry.materials)) for (const id of Object.keys(material)) tools.add(Number(id))
    let compared = 0
    for (const def of Object.values(registry.blocks)) {
      const block = Block.fromStateId(def.defaultState, 0)
      for (const tool of tools) {
        for (const [inWater, notOnGround] of [[false, false], [true, false], [false, true], [true, true]]) {
          for (const enchantments of [[], [{ name: 'efficiency', lvl: 4 }], [{ name: 'aqua_affinity', lvl: 1 }]]) {
            const ours = digSpeed.digTime(registry, block, { heldItemType: tool, inWater, notOnGround, enchantments, effects: {} })
            const theirs = block.digTime(tool, false, inWater, notOnGround, enchantments, {})
            if (ours !== theirs) assert.fail(`${def.name} tool ${tool} water ${inWater} air ${notOnGround} ${JSON.stringify(enchantments)}: ${ours} ≠ ${theirs}`)
            compared++
          }
        }
      }
    }
    assert.ok(compared > 100000, `${compared} cases`)
    assert.strictEqual(digSpeed.digTime(registry, Block.fromStateId(registry.blocksByName.stone.defaultState, 0), { creative: true }), 0)
  })

  it('ticks: the start tick counts, 0 = instant, Infinity = never (bedrock)', () => {
    assert.strictEqual(digSpeed.ticksFor(1 / 15), 15)
    assert.strictEqual(digSpeed.ticksFor(1 / 0.6 / 30), 18, 'grass by hand: BDS accepted predict_break 17 inputs after start_break')
    assert.strictEqual(digSpeed.ticksFor(1 / 0.3 / 30), 9, 'glass by hand: BDS accepted predict_break 8 inputs after start_break')
    assert.strictEqual(digSpeed.ticksFor(2.5), 0)
    assert.strictEqual(digSpeed.ticksFor(0), Infinity)
    const bedrock = Block.fromStateId(registry.blocksByName.bedrock.defaultState, 0)
    assert.strictEqual(digSpeed.digTime(registry, bedrock, {}), Infinity)
  })
})

async function spawned (options) {
  const created = await createFakeBot(options)
  await replayJoin(created.bot, created.client)
  created.client.clearSent()
  created.tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      created.clock.advance(50)
      created.bot._bedrock.input.pump()
    }
  }
  created.inputs = () => created.client.sent('player_auth_input')
  created.actions = () => created.inputs().map((p) => (p.block_action ?? []).map((a) => a.action))
  created.tick(3) // settle on the grass
  return created
}

/** the server's update_block for `pos` (layer 0) */
function serverSets (bot, client, pos, name) {
  const registry = bot.registry
  const runtimeId = registry.runtimeIdByStateId[registry.blocksByName[name].defaultState]
  client.receive('update_block', {
    position: { x: pos.x, y: pos.y, z: pos.z },
    block_runtime_id: runtimeId,
    flags: { _value: 3, neighbors: true, network: true, no_graphic: false, unused: false, priority: false },
    layer: 0
  })
}

describe('digging plugin (U10): Bedrock server-authoritative block breaking', function () {
  this.timeout(30000)

  it('internalTest › digTime › should use eye-level water check instead of isInWater for dig speed', async () => {
    const { bot, client } = await spawned()
    bot.game.gameMode = 'survival'
    const g = -60
    const target = new Vec3(1, g, 1)
    serverSets(bot, client, target, 'dirt')
    bot.entity.onGround = true
    bot.entity.isInWater = false
    bot.entity.effects = {}
    bot.entity.position = new Vec3(1.5, g + 1, 2.5)
    const dry = bot.digTime(bot.blockAt(target))
    assert.strictEqual(dry, 750)
    // water at eye level (feet + 1.62 → block y g + 2)
    serverSets(bot, client, new Vec3(1, g + 2, 2), 'water')
    assert.strictEqual(bot._getBlockAtEyeLevel().name, 'water')
    const wet = bot.digTime(bot.blockAt(target))
    assert.ok(wet > dry, `dig time with water at eye level (${wet}) should be greater than without (${dry})`)
    assert.strictEqual(wet, 3750)
    // isInWater alone (no water at eye level) must not change the dig time
    serverSets(bot, client, new Vec3(1, g + 2, 2), 'air')
    bot.entity.isInWater = true
    assert.strictEqual(bot.digTime(bot.blockAt(target)), dry)
  })

  it('digTime: tool, efficiency, helmet aqua affinity, Bedrock haste / mining fatigue, creative', async () => {
    const { bot, client } = await spawned()
    const Item = require('prismarine-item')(bot.registry)
    bot.game.gameMode = 'survival'
    bot.entity.onGround = true
    const stone = new Vec3(2, -60, 0)
    serverSets(bot, client, stone, 'stone')
    const block = bot.blockAt(stone)
    assert.strictEqual(bot.digTime(block), 7500, 'stone by hand: 150 ticks')
    bot.inventory.slots[36] = new Item(bot.registry.itemsByName.iron_pickaxe.id, 1)
    assert.strictEqual(bot.heldItem?.name, 'iron_pickaxe')
    assert.strictEqual(bot.digTime(block), 400, 'iron pickaxe: 8 ticks')
    bot.entity.effects = { [HASTE]: { id: HASTE, amplifier: 1, duration: 100 } }
    assert.strictEqual(bot.digTime(block), 200, 'haste II on BDS: 6 × 1.4 × 1.44 / 45 per tick')
    bot.entity.effects = { [MINING_FATIGUE]: { id: MINING_FATIGUE, amplifier: 0, duration: 100 } }
    assert.strictEqual(bot.digTime(block), 50 * 36, 'mining fatigue I on BDS (0.21)')
    bot.entity.effects = {}
    // aqua affinity on the helmet cancels the eye-in-water penalty (upstream reads the helmet's enchantments)
    const dirt = new Vec3(2, -60, 1)
    serverSets(bot, client, dirt, 'dirt')
    bot.entity.position = new Vec3(0.5, -60, 1.5)
    serverSets(bot, client, new Vec3(0, -59, 1), 'water')
    bot.inventory.slots[36] = null
    assert.strictEqual(bot.digTime(bot.blockAt(dirt)), 3750, 'eye in water: 5× slower')
    const helmet = new Item(bot.registry.itemsByName.diamond_helmet.id, 1)
    helmet.enchants = [{ name: 'aqua_affinity', lvl: 1 }]
    assert.deepStrictEqual(helmet.enchants, [{ name: 'aqua_affinity', lvl: 1 }], 'Bedrock `ench` NBT with numeric ids')
    bot.inventory.slots[bot.getEquipmentDestSlot('head')] = helmet
    assert.strictEqual(bot.digTime(bot.blockAt(dirt)), 750)
    bot.game.gameMode = 'creative'
    assert.strictEqual(bot.digTime(block), 0)
  })

  it('dig: start_break, nothing while held, predict_break one tick after the server completes, abort_break after the update', async () => {
    const { bot, client, tick, actions } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'dirt')
    const block = bot.blockAt(target)
    assert.strictEqual(bot.digTime(block), 750)
    client.clearSent()
    const events = []
    bot.on('diggingCompleted', (b) => events.push(['completed', b.name, b.position.toString()]))
    const done = bot.dig(block, true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(bot.targetDigBlock, block)
    assert.strictEqual(bot.targetDigFace, 4, 'the line of sight enters the west face')
    tick(1)
    assert.deepStrictEqual(actions().at(-1), ['start_break'])
    const start = client.sent('player_auth_input').at(-1).block_action[0]
    assert.deepStrictEqual(start.position, { x: 2, y: -60, z: 0 })
    assert.strictEqual(start.face, 4)
    // 15 ticks: BDS completes in the input 14 after the start one; predict in the next one
    tick(14)
    assert.ok(actions().slice(-14).every((a) => a.length === 0), 'nothing sent while the break is held')
    tick(1)
    assert.deepStrictEqual(actions().at(-1), ['predict_break'])
    assert.strictEqual(bot._bedrock.digging.active().predictIndex, 15)
    tick(2)
    assert.ok(bot.targetDigBlock, 'waits for the server')
    serverSets(bot, client, target, 'air')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepStrictEqual(events, [], 'settles only once the release went out')
    tick(1)
    assert.deepStrictEqual(actions().at(-1), ['abort_break'], 'releases the server break state')
    await done
    assert.deepStrictEqual(events, [['completed', 'air', '(2, -60, 0)']])
    assert.strictEqual(bot.targetDigBlock, null)
    assert.strictEqual(bot.targetDigFace, null)
    assert.ok(typeof bot.lastDigTime === 'number')
    const last = bot._bedrock.digging.last
    assert.strictEqual(last.outcome, 'completed')
    assert.strictEqual(last.ticks, 15)
    assert.strictEqual(last.restores, 0)
    assert.doesNotThrow(() => bot.stopDigging(), 'no-op after completion')
  })

  it('dig: with BDS progress reports, predict_break waits for the server (one report before completion), however late it runs', async () => {
    const { bot, client, tick, actions } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'dirt')
    client.clearSent()
    const done = bot.dig(bot.blockAt(target), true)
    await new Promise((resolve) => setImmediate(resolve))
    tick(1)
    const at = { x: 2, y: -60, z: 0 }
    client.receive('level_event', { event: 'block_start_break', position: at, data: 4369 })
    // the server runs 10 ticks behind our inputs: our own count would have predicted long ago
    tick(25)
    for (let i = 0; i < 13; i++) {
      client.receive('level_event', { event: 'block_break_speed', position: at, data: 4369 })
      tick(1)
    }
    assert.ok(!actions().flat().includes('predict_break'), 'not before the server is one tick from done')
    client.receive('level_event', { event: 'block_break_speed', position: at, data: 4369 })
    tick(1)
    assert.deepStrictEqual(actions().at(-1), ['predict_break'])
    serverSets(bot, client, target, 'air')
    tick(1) // the release (abort_break) goes out, then the dig settles
    await done
    assert.strictEqual(bot._bedrock.digging.last.restores, 0)
  })

  it('dig: the server finishing first completes the dig (no predict needed)', async () => {
    const { bot, client, tick, actions } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 1)
    serverSets(bot, client, target, 'stone')
    client.clearSent()
    const done = bot.dig(bot.blockAt(target))
    await new Promise((resolve) => setImmediate(resolve))
    tick(1) // the look (not forced) goes out with this input
    await new Promise((resolve) => setImmediate(resolve))
    tick(5)
    assert.deepStrictEqual(actions().filter((a) => a.length), [['start_break']])
    serverSets(bot, client, target, 'air')
    tick(1) // the release (abort_break) goes out, then the dig settles
    await done
    assert.ok(!actions().flat().includes('predict_break'))
    assert.deepStrictEqual(actions().at(-1), ['abort_break'])
  })

  it('dig: a slower speed reported by the server delays predict_break; a restore is counted', async () => {
    const { bot, client, tick, actions } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'dirt')
    client.clearSent()
    const done = bot.dig(bot.blockAt(target), true)
    await new Promise((resolve) => setImmediate(resolve))
    tick(1)
    // the server is 5× slower (e.g. it thinks the bot is in the air)
    client.receive('level_event', { event: 'block_start_break', position: { x: 2, y: -60, z: 0 }, data: 873 })
    tick(20)
    assert.ok(!actions().flat().includes('predict_break'), 'not predicted at our 15 ticks')
    const active = bot._bedrock.digging.active()
    assert.strictEqual(active.serverData, 873)
    for (let i = 0; i < 100 && !actions().flat().includes('predict_break'); i++) tick(1)
    const predictAt = actions().findIndex((a) => a.includes('predict_break'))
    assert.ok(predictAt > 20, `predicted eventually (input ${predictAt})`)
    // a premature predict is answered with the block itself
    serverSets(bot, client, target, 'dirt')
    assert.strictEqual(bot._bedrock.digging.active().restores, 1)
    serverSets(bot, client, target, 'air')
    tick(1) // the release (abort_break) goes out, then the dig settles
    await done
    assert.strictEqual(bot._bedrock.digging.last.restores, 1)
  })

  it('stopDigging: abort_break, diggingAborted, the promise rejects with "Digging aborted"', async () => {
    const { bot, client, tick, actions } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'stone')
    client.clearSent()
    const aborted = []
    bot.on('diggingAborted', (b) => aborted.push(b.name))
    const done = bot.dig(bot.blockAt(target), true)
    await new Promise((resolve) => setImmediate(resolve))
    tick(3)
    bot.stopDigging()
    await assert.rejects(done, /Digging aborted/)
    assert.deepStrictEqual(aborted, ['stone'])
    assert.strictEqual(bot.targetDigBlock, null)
    tick(1)
    assert.deepStrictEqual(actions().at(-1), ['abort_break'])
    assert.strictEqual(bot._bedrock.digging.last.outcome, 'aborted')
    // a dig while another one runs cancels the first
    const first = bot.dig(bot.blockAt(target), true)
    await new Promise((resolve) => setImmediate(resolve))
    const other = new Vec3(2, -60, 1)
    serverSets(bot, client, other, 'dirt')
    const second = bot.dig(bot.blockAt(other), true)
    await assert.rejects(first, /Digging aborted/)
    tick(1)
    serverSets(bot, client, other, 'air')
    tick(1) // the release (abort_break) goes out, then the dig settles
    await second
  })

  it('dig: gives up when the server never breaks the block', async () => {
    const { bot, client, tick } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'dirt')
    const done = bot.dig(bot.blockAt(target), true)
    done.catch(() => {})
    await new Promise((resolve) => setImmediate(resolve))
    tick(16 + 40 + 1)
    await assert.rejects(done, /the server did not break dirt/)
  })

  it('creative: start_break and predict_break in the same input', async () => {
    const { bot, client, tick, actions } = await spawned()
    bot.game.gameMode = 'creative'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'obsidian')
    client.clearSent()
    const done = bot.dig(bot.blockAt(target), true)
    await new Promise((resolve) => setImmediate(resolve))
    tick(1)
    assert.deepStrictEqual(actions().at(-1), ['start_break', 'predict_break'])
    serverSets(bot, client, target, 'air')
    tick(1) // the release (abort_break) goes out, then the dig settles
    await done
    assert.deepStrictEqual(actions().at(-1), ['abort_break'])
  })

  it('dig: a block turning into water (waterlogged / ice) completes; redstone ore lighting up does not', async () => {
    const { bot, client, tick } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'ice')
    let done = bot.dig(bot.blockAt(target), true)
    await new Promise((resolve) => setImmediate(resolve))
    tick(1)
    serverSets(bot, client, target, 'water')
    tick(1) // the release (abort_break) goes out, then the dig settles
    await done
    serverSets(bot, client, target, 'redstone_ore')
    let finished = false
    done = bot.dig(bot.blockAt(target), true)
    done.then(() => { finished = true }, () => {})
    await new Promise((resolve) => setImmediate(resolve))
    tick(1)
    serverSets(bot, client, target, 'lit_redstone_ore')
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(finished, false)
    serverSets(bot, client, target, 'air')
    tick(1) // the release (abort_break) goes out, then the dig settles
    await done
  })

  it('dig: digFace vector / raycast / ignore choose the face like upstream', async () => {
    const { bot, client, tick } = await spawned()
    bot.game.gameMode = 'creative'
    const target = new Vec3(2, -60, 0)
    const run = async (forceLook, digFace) => {
      serverSets(bot, client, target, 'dirt')
      const done = bot.dig(bot.blockAt(target), forceLook, digFace)
      await new Promise((resolve) => setImmediate(resolve))
      const face = bot.targetDigFace
      tick(1)
      serverSets(bot, client, target, 'air')
      tick(1) // the release (abort_break) goes out, then the dig settles
      await done
      return face
    }
    assert.strictEqual(await run(true, new Vec3(0, 1, 0)), 1)
    assert.strictEqual(await run(true, new Vec3(-1, 0, 0)), 4)
    assert.strictEqual(await run(true, new Vec3(0, 0, 1)), 3)
    assert.strictEqual(await run(true, 'raycast'), 4, 'the west face is the visible one')
    assert.strictEqual(await run('ignore'), 1, 'forceLook "ignore": upstream default face (top)')
    bot.game.gameMode = 'survival'
    await assert.rejects(bot.dig(null), /dig was called with an undefined or null block/)
    await assert.rejects(bot.dig(bot.blockAt(new Vec3(0, -64, 0))), /dig time for bedrock is Infinity/)
  })

  it('canDigBlock: diggable and within 5.1 blocks of the eyes (upstream)', async () => {
    const { bot, client } = await spawned()
    serverSets(bot, client, new Vec3(2, -60, 0), 'dirt')
    serverSets(bot, client, new Vec3(9, -60, 0), 'dirt')
    assert.ok(bot.canDigBlock(bot.blockAt(new Vec3(2, -60, 0))))
    assert.ok(!bot.canDigBlock(bot.blockAt(new Vec3(9, -60, 0))))
    assert.ok(!bot.canDigBlock(bot.blockAt(new Vec3(0, -64, 0))), 'bedrock is not diggable')
  })

  it('legacy servers (server_authoritative_block_breaking false): crack_break per tick, stop_break + break_block', async () => {
    const { bot, client, tick, actions } = await spawned()
    bot._bedrock.startGame.server_authoritative_block_breaking = false
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'oak_leaves')
    client.clearSent()
    const done = bot.dig(bot.blockAt(target), true)
    await new Promise((resolve) => setImmediate(resolve))
    tick(3)
    assert.deepStrictEqual(actions().slice(0, 3), [['start_break'], ['crack_break'], ['crack_break']])
    await done // 300 ms timer, block predicted locally like upstream
    assert.strictEqual(bot.blockAt(target).name, 'air')
    tick(1)
    assert.ok(actions().at(-1).includes('stop_break'))
    const tx = client.sent('inventory_transaction').at(-1)
    assert.strictEqual(tx.transaction.transaction_data.action_type, 'break_block')
    assert.deepStrictEqual(tx.transaction.transaction_data.block_position, { x: 2, y: -60, z: 0 })
    const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
    assert.ok(createSerializer('1.26.51').createPacketBuffer({ name: 'inventory_transaction', params: tx }).length > 0)
  })

  it('a dig started while another runs keeps its own face (the stopped dig clears bot.targetDigFace)', async () => {
    const { bot, client, tick, actions } = await spawned()
    bot.game.gameMode = 'survival'
    const a = new Vec3(2, -60, 0)
    const b = new Vec3(0, -61, 0) // below the bot: seen from above
    serverSets(bot, client, a, 'stone')
    const first = bot.dig(bot.blockAt(a), true)
    first.catch(() => {})
    await new Promise((resolve) => setImmediate(resolve))
    tick(1)
    client.clearSent()
    const second = bot.dig(bot.blockAt(b), true)
    await assert.rejects(first, /Digging aborted/)
    assert.strictEqual(bot.targetDigFace, 1)
    tick(1)
    const sent = client.sent('player_auth_input').at(-1).block_action
    assert.deepStrictEqual(sent.map((x) => [x.action, x.face]), [['abort_break', 1], ['start_break', 1]])
    assert.strictEqual(bot._bedrock.digging.active().face, 1)
    serverSets(bot, client, b, 'air')
    tick(1) // the release (abort_break) goes out, then the dig settles
    await second
    assert.ok(actions().length > 0)
  })

  it('dig: a turtle egg losing one egg, or a block turning into a bubble column, completes the dig', async () => {
    const { bot, client, tick } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 0)
    const registry = bot.registry
    const eggs = registry.blocksByName.turtle_egg
    client.receive('update_block', { position: target, block_runtime_id: registry.runtimeIdByStateId[eggs.maxStateId], flags: { _value: 3 }, layer: 0 })
    let done = bot.dig(bot.blockAt(target), true)
    await new Promise((resolve) => setImmediate(resolve))
    tick(1)
    serverSets(bot, client, target, 'turtle_egg')
    tick(1) // the release (abort_break) goes out, then the dig settles
    await done
    serverSets(bot, client, target, 'dirt')
    done = bot.dig(bot.blockAt(target), true)
    await new Promise((resolve) => setImmediate(resolve))
    tick(1)
    serverSets(bot, client, target, 'bubble_column')
    tick(1) // the release (abort_break) goes out, then the dig settles
    await done
  })

  it('dig: the confirm timeout waits while the server still reports progress (our estimate too fast)', async () => {
    const { bot, client, tick } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'dirt')
    const done = bot.dig(bot.blockAt(target), true)
    done.catch(() => {})
    await new Promise((resolve) => setImmediate(resolve))
    tick(16) // predicted at 15
    // the server is far slower and keeps reporting its progress every tick: no timeout
    for (let i = 0; i < 80; i++) {
      client.receive('level_event', { event: 'block_break_speed', position: { x: 2, y: -60, z: 0 }, data: 100 })
      tick(1)
    }
    assert.ok(bot.targetDigBlock, 'still digging')
    serverSets(bot, client, target, 'air')
    tick(1) // the release (abort_break) goes out, then the dig settles
    await done
  })

  it('creative: no breaking with a sword, the trident or the mace (BDS); a spear works', async () => {
    const { bot, client } = await spawned()
    const Item = require('prismarine-item')(bot.registry)
    bot.game.gameMode = 'creative'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'stone')
    const block = bot.blockAt(target)
    for (const [name, time] of [['diamond_sword', Infinity], ['trident', Infinity], ['mace', Infinity], ['iron_spear', 0], ['diamond_pickaxe', 0]]) {
      bot.inventory.slots[36] = new Item(bot.registry.itemsByName[name].id, 1)
      assert.strictEqual(bot.digTime(block), time, name)
    }
    bot.inventory.slots[36] = new Item(bot.registry.itemsByName.netherite_sword.id, 1)
    await assert.rejects(bot.dig(block), /dig time for stone is Infinity/)
  })

  it('a disconnect settles a pending dig', async () => {
    const { bot, client, tick } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'stone')
    const done = bot.dig(bot.blockAt(target), true)
    done.catch(() => {})
    await new Promise((resolve) => setImmediate(resolve))
    tick(1)
    bot.emit('end', 'socketClosed')
    await assert.rejects(done, /connection ended/)
  })

  it('death stops the dig like upstream', async () => {
    const { bot, client, tick } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 0)
    serverSets(bot, client, target, 'stone')
    const done = bot.dig(bot.blockAt(target), true)
    await new Promise((resolve) => setImmediate(resolve))
    tick(1)
    bot.emit('death')
    await assert.rejects(done, /Digging aborted/)
    assert.strictEqual(bot.targetDigBlock, null)
  })
})

describe('physics engine: resting on ground needs ground (U10 minimal fix in lib/physics/engine.js)', function () {
  const registry = createRegistry('1.26.51')
  const Block = require('prismarine-block')(registry)
  const { Physics } = require('../../lib/physics')
  const grass = Block.fromStateId(registry.blocksByName.grass_block.defaultState, 0)
  const air = Block.fromStateId(registry.blocksByName.air.defaultState, 0)
  const world = {
    getBlock: (p) => {
      const b = Object.create(p.y < -60 ? grass : air)
      b.position = p.floored()
      return b
    }
  }

  it('without gravity (creative.startFlying) a box teleported into the air with on_ground true is not on ground; on the ground it stays', () => {
    const physics = Physics(registry, world)
    physics.gravity = 0
    const state = (y) => ({ pos: new Vec3(0.5, y, 0.5), vel: new Vec3(0, 0, 0), onGround: true, control: {}, yaw: 0, pitch: 0, flying: false })
    const inTheAir = state(-58)
    physics.simulatePlayer(inTheAir, world)
    assert.strictEqual(inTheAir.onGround, false)
    const resting = state(-59.9999885559082)
    physics.simulatePlayer(resting, world)
    assert.strictEqual(resting.onGround, true)
  })
})
