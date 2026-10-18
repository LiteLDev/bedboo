// owner: U10 (digging)
'use strict'
/**
 * Bedrock extra (no mineflayer counterpart): every ore / stone / wood / soil family × bare hand and each tool tier
 * (wooden, stone, iron, diamond, netherite), then Efficiency, Haste, Conduit Power, Mining Fatigue, under water (with
 * and without Aqua Affinity) and in the air, against BDS 1.26.51.1. For every case:
 * - BDS reports the same break speed as bot.digTime's (level_event block_start_break data);
 * - digs up to MAX_FULL_DIG_MS: the block becomes air (client and server), BDS never restores it (no predict too
 *   early, nothing within 1 s after), the break takes digTime (± 150 ms + 5 %), drops spawn when the tool can
 *   harvest the block and do not when it cannot (e.g. iron ore by hand), the tool loses durability;
 * - longer digs (e.g. obsidian by hand: 175 s): the speed check, then stopDigging (diggingAborted, "Digging aborted",
 *   the block stays, no drop).
 * Blocks are staged with /setblock, tools with /replaceitem, enchantments with /enchant, effects with /effect.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

const MAX_FULL_DIG_MS = 8000
const TIERS = [null, 'wooden', 'stone', 'iron', 'diamond', 'netherite']
const RANDOM = null
/** block → { tool type, drops when harvested (RANDOM: not asserted, []: never) } */
const FAMILIES = {
  coal_ore: { tool: 'pickaxe', drops: ['coal'] },
  deepslate_coal_ore: { tool: 'pickaxe', drops: ['coal'] },
  copper_ore: { tool: 'pickaxe', drops: ['raw_copper'] },
  deepslate_copper_ore: { tool: 'pickaxe', drops: ['raw_copper'] },
  iron_ore: { tool: 'pickaxe', drops: ['raw_iron'] },
  deepslate_iron_ore: { tool: 'pickaxe', drops: ['raw_iron'] },
  gold_ore: { tool: 'pickaxe', drops: ['raw_gold'] },
  deepslate_gold_ore: { tool: 'pickaxe', drops: ['raw_gold'] },
  redstone_ore: { tool: 'pickaxe', drops: ['redstone'] },
  deepslate_redstone_ore: { tool: 'pickaxe', drops: ['redstone'] },
  lapis_ore: { tool: 'pickaxe', drops: ['lapis_lazuli'] },
  deepslate_lapis_ore: { tool: 'pickaxe', drops: ['lapis_lazuli'] },
  diamond_ore: { tool: 'pickaxe', drops: ['diamond'] },
  deepslate_diamond_ore: { tool: 'pickaxe', drops: ['diamond'] },
  emerald_ore: { tool: 'pickaxe', drops: ['emerald'] },
  deepslate_emerald_ore: { tool: 'pickaxe', drops: ['emerald'] },
  nether_gold_ore: { tool: 'pickaxe', drops: ['gold_nugget'] },
  quartz_ore: { tool: 'pickaxe', drops: ['quartz'] },
  ancient_debris: { tool: 'pickaxe', drops: ['ancient_debris'] },
  stone: { tool: 'pickaxe', drops: ['cobblestone'] },
  deepslate: { tool: 'pickaxe', drops: ['cobbled_deepslate'] },
  obsidian: { tool: 'pickaxe', drops: ['obsidian'] },
  oak_log: { tool: 'axe', drops: ['oak_log'] },
  oak_planks: { tool: 'axe', drops: ['oak_planks'] },
  dirt: { tool: 'shovel', drops: ['dirt'] },
  grass_block: { tool: 'shovel', drops: ['dirt'] },
  sand: { tool: 'shovel', drops: ['sand'] },
  gravel: { tool: 'shovel', drops: ['gravel', 'flint'] },
  oak_leaves: { tool: 'hoe', drops: RANDOM },
  glass: { tool: 'pickaxe', drops: [] }
}

const HASTE = 'haste'
const FATIGUE = 'mining_fatigue'
const CONDUIT = 'conduit_power'
const LEVITATION = 'levitation'

describe('digOres', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  let target
  let g

  before(async function () {
    const { bot } = ctx
    await bot.test.resetState()
    bot.creative.stopFlying() // resetState flies (gravity 0, like upstream's testCommon)
    g = bot.test.groundY
    target = new Vec3(2, g, 0)
    await bot.test.becomeSurvival()
    await bot.test.teleport(new Vec3(0, g, 0))
  })

  afterEach(async function () {
    const { bot, server } = ctx
    if (bot.targetDigBlock) {
      try { bot.stopDigging() } catch {}
    }
    const who = bot.test.ctx.who()
    await server.commandOutput(`effect ${who} clear`)
    await server.commandOutput(`fill -1 ${g} -1 3 ${g + 2} 1 air`)
    await server.command('kill @e[type=item]')
    await server.command('kill @e[type=xp_orb]')
    if (bot.inventory.slots[5]) await bot.test.setInventorySlot(5, null)
    await bot.test.teleport(new Vec3(0, g, 0))
  })

  // ---- helpers ------------------------------------------------------------------------------------------

  async function until (predicate, ticks = 40, what = 'condition') {
    const { bot } = ctx
    for (let i = 0; i < ticks; i++) {
      if (predicate()) return
      await bot.waitForTicks(1)
    }
    assert.ok(predicate(), `timed out waiting for ${what}`)
  }

  async function holdTool (name) {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    if (bot.quickBarSlot !== 0) bot.setQuickBarSlot(0)
    await bot.test.setInventorySlot(36, name ? new Item(bot.registry.itemsByName[name].id, 1) : null)
    await until(() => (bot.heldItem?.name ?? null) === name, 40, `holding ${name}`)
  }

  async function enchantHeld (enchantment, level) {
    const { bot, server } = ctx
    let out = []
    // the server learns about a hotbar switch (mob_equipment) a tick later: retry "doesn't hold an item"
    for (let attempt = 0; attempt < 5; attempt++) {
      await bot.waitForTicks(2)
      out = await server.commandOutput(`enchant ${bot.test.ctx.who()} ${enchantment} ${level}`)
      if (!out.some((l) => /doesn't hold an item/.test(l))) break
    }
    assert.ok(out.some((l) => /Enchanting succeeded/.test(l)), out.join(' | '))
    await until(() => bot.heldItem?.enchants?.some((e) => e.name === enchantment && e.lvl === level), 40, `${enchantment} ${level}`)
  }

  async function addEffect (name, level) {
    const { bot, server } = ctx
    const out = await server.commandOutput(`effect ${bot.test.ctx.who()} ${name} 120 ${level - 1} true`)
    assert.ok(out.some((l) => /Gave|Applied/i.test(l)), out.join(' | '))
    const id = { haste: 3, mining_fatigue: 4, conduit_power: 26, levitation: 24 }[name]
    await until(() => bot.entity.effects?.[id]?.amplifier === level - 1, 40, `effect ${name}`)
  }

  /** glass walls around the bot's column (feet + head), optionally water inside and a ceiling */
  async function cell ({ water = false, ceiling = false } = {}) {
    const { bot, server } = ctx
    for (const [x1, z1, x2, z2] of [[-1, -1, -1, 1], [1, -1, 1, 1], [0, -1, 0, -1], [0, 1, 0, 1]]) {
      await server.commandOutput(`fill ${x1} ${g} ${z1} ${x2} ${g + 1} ${z2} glass`)
    }
    if (ceiling) await server.commandOutput(`setblock 0 ${g + 2} 0 glass`)
    if (water) {
      await server.commandOutput(`fill 0 ${g} 0 0 ${g + 1} 0 water`)
      await until(() => bot._getBlockAtEyeLevel()?.name === 'water', 40, 'water at eye level')
    }
  }

  async function stage (blockName) {
    const { bot } = ctx
    await bot.test.setBlock({ x: target.x, y: target.y, z: target.z, blockName })
    const block = bot.blockAt(target)
    assert.strictEqual(block.name, blockName)
    return block
  }

  /** server-side check of the target block */
  async function serverHas (blockName) {
    const out = await ctx.server.commandOutput(`testforblock ${target.x} ${target.y} ${target.z} ${blockName}`)
    return out.some((l) => /^Successfully found the block/.test(l))
  }

  /**
   * Dig the staged block and check everything (see the file comment). `expect.drops`: names (one must drop when
   * harvestable), [] (never drops), RANDOM (not checked).
   */
  async function digAndCheck (block, { drops = RANDOM, onGround = true, durability = true } = {}) {
    const { bot } = ctx
    if (onGround) await until(() => bot.entity.onGround, 40, 'on ground')
    const digTime = bot.digTime(block)
    assert.ok(Number.isFinite(digTime), `${block.name}: digTime ${digTime}`)
    const held = bot.heldItem
    const harvestable = block.canHarvest(held?.type ?? null)
    const usedBefore = held?.durabilityUsed ?? null
    const updates = []
    const dropped = []
    const onUpdate = (p) => {
      if (p.position.x === target.x && p.position.y === target.y && p.position.z === target.z) {
        updates.push({ name: bot.registry.blocksByRuntimeId[p.block_runtime_id]?.name, at: performance.now() })
      }
    }
    const center = target.offset(0.5, 0.5, 0.5)
    const onDrop = (entity) => {
      if (entity.position.distanceTo(center) < 1.5) dropped.push(entity.getDroppedItem()?.name)
    }
    bot._client.on('update_block', onUpdate)
    bot.on('itemDrop', onDrop)
    try {
      if (digTime > MAX_FULL_DIG_MS) return await speedThenAbort(block)
      const completed = onceWithCleanup(bot, 'diggingCompleted', { timeout: digTime + 5000 })
      await bot.dig(block, true)
      const [completedBlock] = await completed
      assert.strictEqual(completedBlock.name, 'air')
      const doneAt = performance.now()
      const last = bot._bedrock.digging.last
      // the break speed BDS reports is ours
      assert.strictEqual(last.serverSpeedData, last.speedData, `${block.name}: break speed (×65535) BDS ${last.serverSpeedData} vs ours ${last.speedData}`)
      assert.strictEqual(last.restores, 0, 'BDS restored the block (predict_break too early)')
      // the break took digTime (the server completes ticks-1 server ticks after the start input; + network, + server
      // tick jitter on a loaded host)
      const elapsed = last.endedAt - last.startedAt
      const slack = 150 + digTime * 0.05
      assert.ok(elapsed >= digTime - slack && elapsed <= digTime + slack + 50, `${block.name}: took ${Math.round(elapsed)} ms, digTime ${digTime} ms`)
      await bot.test.wait(1000)
      // gone on both sides, never restored
      assert.strictEqual(bot.blockAt(target).name, 'air')
      assert.ok(await serverHas('air'), 'air on the server')
      const late = updates.filter((u) => u.at >= doneAt && u.name !== 'air')
      assert.deepStrictEqual(late, [], 'restored after the break')
      // drops
      if (drops !== RANDOM) {
        if (harvestable && drops.length) {
          assert.ok(dropped.some((n) => drops.includes(n)), `${block.name} with ${held?.name ?? 'hand'}: expected ${drops}, got ${dropped}`)
        } else {
          assert.deepStrictEqual(dropped, [], `${block.name} with ${held?.name ?? 'hand'}: nothing should drop`)
        }
      }
      // durability (BDS damages the tool itself and sends the inventory slot)
      if (durability && usedBefore !== null && held.maxDurability) {
        await until(() => (bot.heldItem?.durabilityUsed ?? 0) > usedBefore, 40, 'tool durability')
      }
      return { digTime, elapsed, dropped, last }
    } finally {
      bot._client.removeListener('update_block', onUpdate)
      bot.removeListener('itemDrop', onDrop)
    }
  }

  /** slow cases: check BDS's break speed, then stop digging */
  async function speedThenAbort (block) {
    const { bot } = ctx
    const aborted = onceWithCleanup(bot, 'diggingAborted', { timeout: 10000 })
    const dig = bot.dig(block, true)
    dig.catch(() => {})
    await until(() => bot._bedrock.digging.active()?.serverData != null, 60, 'the server break speed')
    const active = bot._bedrock.digging.active()
    assert.strictEqual(active.serverData, require('../../lib/bedrock/dig_speed').speedData(active.delta), `${block.name}: break speed`)
    await bot.waitForTicks(4)
    bot.stopDigging()
    await assert.rejects(dig, /Digging aborted/)
    const [abortedBlock] = await aborted
    assert.strictEqual(abortedBlock.name, block.name)
    assert.strictEqual(bot.targetDigBlock, null)
    await bot.test.wait(500)
    // redstone ore lights up when it is hit (lit_redstone_ore / lit_deepslate_redstone_ore)
    const names = [block.name, `lit_${block.name}`]
    const now = bot.blockAt(target).name
    assert.ok(names.includes(now), `${block.name} → ${now}`)
    assert.ok(await serverHas(now), `${block.name} is still there`)
    return { aborted: true }
  }

  // ---- families × tiers ------------------------------------------------------------------------------------

  for (const [blockName, family] of Object.entries(FAMILIES)) {
    for (const tier of TIERS) {
      const tool = tier ? `${tier}_${family.tool}` : null
      it(`${blockName} with ${tool ?? 'the bare hand'}`, async () => {
        await holdTool(tool)
        const block = await stage(blockName)
        await digAndCheck(block, { drops: family.drops })
      })
    }
  }

  it('iron_ore by hand: 15 s, no drop (not harvestable)', async () => {
    await holdTool(null)
    const block = await stage('iron_ore')
    const { bot } = ctx
    await until(() => bot.entity.onGround, 40, 'on ground')
    assert.strictEqual(bot.digTime(block), 15000)
    const { dropped } = await digToTheEnd(block)
    assert.deepStrictEqual(dropped, [])
  })

  async function digToTheEnd (block) {
    // the generic helper caps full digs at MAX_FULL_DIG_MS; this one case is dug to the end
    const { bot } = ctx
    const center = target.offset(0.5, 0.5, 0.5)
    const dropped = []
    const onDrop = (entity) => { if (entity.position.distanceTo(center) < 1.5) dropped.push(entity.getDroppedItem()?.name) }
    bot.on('itemDrop', onDrop)
    try {
      await bot.dig(block, true)
      const last = bot._bedrock.digging.last
      assert.strictEqual(last.serverSpeedData, last.speedData)
      assert.strictEqual(last.restores, 0)
      await bot.test.wait(1000)
      assert.strictEqual(bot.blockAt(target).name, 'air')
      assert.ok(await serverHas('air'))
      return { dropped }
    } finally {
      bot.removeListener('itemDrop', onDrop)
    }
  }

  // ---- modifiers -----------------------------------------------------------------------------------------

  for (const level of [1, 2, 3, 4, 5]) {
    it(`modifiers: stone with an Efficiency ${level} iron pickaxe`, async () => {
      await holdTool('iron_pickaxe')
      await enchantHeld('efficiency', level)
      const block = await stage('stone')
      const { digTime } = await digAndCheck(block, { drops: ['cobblestone'] })
      assert.strictEqual(digTime, 50 * Math.ceil(1 / ((6 + level * level + 1) / 1.5 / 30)))
    })
  }

  for (const level of [1, 2, 5]) {
    it(`modifiers: stone with an iron pickaxe and Haste ${level} (Bedrock factor)`, async () => {
      await holdTool('iron_pickaxe')
      await addEffect(HASTE, level)
      const block = await stage('stone')
      const { digTime } = await digAndCheck(block, { drops: ['cobblestone'] })
      assert.strictEqual(digTime, 50 * Math.ceil(1 / (6 * (1 + 0.2 * level) * Math.pow(1.2, level) / 1.5 / 30)))
    })
  }

  it('modifiers: Conduit Power acts like Haste', async () => {
    await holdTool('iron_pickaxe')
    await addEffect(CONDUIT, 1)
    const block = await stage('stone')
    const { digTime } = await digAndCheck(block, { drops: ['cobblestone'] })
    assert.strictEqual(digTime, 50 * Math.ceil(1 / (6 * 1.44 / 1.5 / 30)))
  })

  for (const level of [1, 2, 3]) {
    it(`modifiers: dirt with an iron shovel and Mining Fatigue ${level} (Bedrock factor 0.21^level)`, async () => {
      await holdTool('iron_shovel')
      await addEffect(FATIGUE, level)
      const block = await stage('dirt')
      const { bot } = ctx
      await until(() => bot.entity.onGround, 40, 'on ground')
      assert.strictEqual(bot.digTime(block), 50 * Math.ceil(1 / (6 * Math.pow(0.21, level) / 0.5 / 30)))
      await digAndCheck(block, { drops: ['dirt'] })
    })
  }

  it('modifiers: Haste 2 and Mining Fatigue 1 together', async () => {
    await holdTool('iron_pickaxe')
    await addEffect(HASTE, 2)
    await addEffect(FATIGUE, 1)
    const block = await stage('stone')
    await digAndCheck(block, { drops: ['cobblestone'] })
  })

  it('modifiers: under water (eyes in water): 5× slower', async () => {
    await holdTool(null)
    await cell({ water: true })
    const block = await stage('dirt')
    const { digTime } = await digAndCheck(block, { drops: ['dirt'] })
    assert.strictEqual(digTime, 3750)
  })

  it('modifiers: under water with an Aqua Affinity helmet: normal speed', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(37, new Item(bot.registry.itemsByName.diamond_helmet.id, 1))
    bot.setQuickBarSlot(1)
    await until(() => bot.heldItem?.name === 'diamond_helmet', 40, 'holding the helmet')
    await enchantHeld('aqua_affinity', 1)
    await bot.equip(bot.inventory.slots[37], 'head')
    await until(() => bot.inventory.slots[5]?.enchants?.some((e) => e.name === 'aqua_affinity'), 40, 'helmet on')
    await holdTool(null)
    await cell({ water: true })
    const block = await stage('dirt')
    const { digTime } = await digAndCheck(block, { drops: ['dirt'] })
    assert.strictEqual(digTime, 750)
  })

  it('modifiers: in the air (levitating against a ceiling): 5× slower', async () => {
    const { bot } = ctx
    await holdTool(null)
    await cell({ ceiling: true })
    await addEffect(LEVITATION, 1)
    await until(() => !bot.entity.onGround, 40, 'off the ground')
    const block = await stage('dirt')
    await bot.waitForTicks(5)
    assert.ok(!bot.entity.onGround)
    const { digTime } = await digAndCheck(block, { drops: ['dirt'], onGround: false })
    assert.strictEqual(digTime, 3750)
  })

  it('modifiers: in the air and under water: 25× slower', async () => {
    const { bot } = ctx
    await holdTool('iron_shovel')
    await cell({ water: true, ceiling: true })
    await addEffect(LEVITATION, 1)
    await until(() => !bot.entity.onGround, 40, 'off the ground')
    const block = await stage('dirt')
    await bot.waitForTicks(5)
    const { digTime } = await digAndCheck(block, { drops: ['dirt'], onGround: false })
    assert.strictEqual(digTime, 50 * Math.ceil(1 / (6 / 25 / 0.5 / 30)))
  })
})
