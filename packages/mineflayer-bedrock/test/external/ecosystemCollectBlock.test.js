// owner: U15 (ecosystem plugins & examples)
'use strict'
/**
 * mineflayer-collectblock 1.6.0 (unpatched; with the patched mineflayer-pathfinder and mineflayer-tool) on BDS
 * 1.26.51.1, survival, seeded default world "2" (Bedrock extra, docs/ecosystem.md):
 * - 5 oak logs from the trunks of the forest around the spawn (pathfinding through trees, the drops collected via
 *   itemDrop → GoalFollow → playerCollect / entityGone);
 * - coal ore and iron ore with a stone pickaxe (Bedrock drops: coal, raw_iron);
 * - a full inventory is emptied into a chest (openChest / deposit) before the next block is collected.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

const SEED = '2'

describe('ecosystemCollectBlock', function () {
  this.timeout(300000)
  const ctx = useBot({ server: { world: 'default', seed: SEED, gamemode: 'survival' } })
  let pad = null // the cleared 9×9 grass pad at the spawn (feet level)

  async function build (cmd) {
    const out = await ctx.bot.test.ctx.consoleOutput(cmd)
    if (!out.some((l) => /filled|placed|couldn't be placed|No blocks/i.test(l))) throw new Error(`${cmd}: ${out.join(' | ')}`)
  }
  const count = (name) => ctx.bot.inventory.count(ctx.bot.registry.itemsByName[name].id)

  /** highest block a bot can stand on at x, z (leaves and logs are not ground) */
  function surfaceY (x, z) {
    for (let y = 120; y > 40; y--) {
      const b = ctx.bot.blockAt(new Vec3(x, y, z))
      if (b && b.boundingBox === 'block' && !/leaves|_log$/.test(b.name)) return y + 1
    }
    throw new Error(`no surface at ${x} ${z}`)
  }

  before(async function () {
    this.timeout(0)
    const { bot } = ctx
    bot.loadPlugin(require('mineflayer-collectblock').plugin)
    await bot.waitForTicks(2) // collectblock loads pathfinder and tool on the next tick
    assert.ok(bot.collectBlock && bot.pathfinder && bot.tool)
    // a search on the default world (full-height chunks) under a loaded host (four e2e shards + agent runs) took over
    // pathfinder's default 5 s once: "Took to long to decide path to goal!" (docs/ecosystem.md: thinkTimeout)
    bot.pathfinder.thinkTimeout = 20000
    await bot.test.ctx.consoleOutput(`effect ${bot.username} resistance 100000 255 true`)
    const y = surfaceY(-31, 6)
    pad = new Vec3(-31, y, 6)
    await bot.test.teleport(pad)
    await bot.waitForChunksToLoad()
    // a clean pad (no tree in the way of the ores / chest), the forest around stays
    await build(`fill -35 ${y} 2 -27 ${y + 6} 10 air`)
    await build(`fill -35 ${y - 1} 2 -27 ${y - 1} 10 grass_block`)
    await build(`fill -35 ${y - 4} 2 -27 ${y - 2} 10 stone`)
  })
  beforeEach(async () => {
    await ctx.bot.test.clearInventory()
    await ctx.bot.test.teleport(pad)
    await ctx.bot.waitForTicks(10)
  })
  afterEach(async () => {
    await ctx.bot.collectBlock.cancelTask()
    ctx.bot.pathfinder.setGoal(null)
  })

  async function collect (targets, maxMs) {
    const { bot } = ctx
    const t0 = Date.now()
    let timer
    try {
      await Promise.race([
        bot.collectBlock.collect(targets),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`collect not done within ${maxMs} ms (at ${bot.entity.position})`)), maxMs) })
      ])
    } finally {
      clearTimeout(timer)
    }
    return Date.now() - t0
  }

  it('collects 5 oak logs from the forest (stone axe, dirt to scaffold)', async () => {
    const { bot } = ctx
    await bot.test.give('stone_axe', 1)
    await bot.test.give('dirt', 32)
    // the lowest logs of the trunks (on dirt / grass) and the one above them: their drops fall where the bot can walk
    // (a drop caught in the canopy is out of reach: collectblock then fails, the same on Java)
    const ground = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol'])
    const bases = bot.findBlocks({ matching: bot.registry.blocksByName.oak_log.id, maxDistance: 32, count: 200 })
      .filter(p => ground.has(bot.blockAt(p.offset(0, -1, 0))?.name))
    const logs = bases.flatMap(p => [p, p.offset(0, 1, 0)]).filter(p => bot.blockAt(p)?.name === 'oak_log').slice(0, 5).map(p => bot.blockAt(p))
    assert.strictEqual(logs.length, 5, `oak trunks near the spawn (seed 2): ${bases.length}`)
    const drops = []
    const onDrop = (e) => drops.push(e.getDroppedItem?.()?.name)
    bot.on('itemDrop', onDrop)
    try {
      const ms = await collect(logs, 180000)
      await bot.waitForTicks(20)
      console.log(`      5 oak logs: ${(ms / 1000).toFixed(1)} s, inventory ${count('oak_log')} oak_log, drops seen ${JSON.stringify(drops)}`)
    } finally {
      bot.removeListener('itemDrop', onDrop)
    }
    for (const log of logs) assert.notStrictEqual(bot.blockAt(log.position).name, 'oak_log', `${log.position} dug`)
    assert.ok(count('oak_log') >= 5, `oak_log x ${count('oak_log')}`)
  })

  it('collects coal ore and iron ore with a stone pickaxe', async () => {
    const { bot } = ctx
    const y = pad.y - 1
    await build(`setblock -29 ${y} 6 coal_ore`)
    await build(`setblock -33 ${y} 4 iron_ore`)
    await bot.test.give('stone_pickaxe', 1)
    const ores = [bot.blockAt(new Vec3(-29, y, 6)), bot.blockAt(new Vec3(-33, y, 4))]
    assert.deepStrictEqual(ores.map(b => b.name), ['coal_ore', 'iron_ore'])
    const ms = await collect(ores, 60000)
    await bot.waitForTicks(20)
    console.log(`      coal + iron ore: ${(ms / 1000).toFixed(1)} s, coal x ${count('coal')}, raw_iron x ${count('raw_iron')}`)
    assert.ok(count('coal') >= 1, 'coal')
    assert.strictEqual(count('raw_iron'), 1, 'raw_iron')
    assert.strictEqual(bot.heldItem?.name, 'stone_pickaxe', 'mineflayer-tool equipped the pickaxe')
  })

  it('empties a full inventory into a chest (openChest / deposit), then collects', async () => {
    const { bot } = ctx
    const y = pad.y
    await build(`setblock -34 ${y} 9 chest`)
    await build(`setblock -33 ${y} 9 chest`)
    await build(`setblock -29 ${y - 1} 4 coal_ore`)
    await bot.test.give('stone_pickaxe', 1)
    await bot.test.give('dirt', 64 * 35) // 35 stacks: with the pickaxe every slot is taken
    for (let i = 0; i < 40 && bot.inventory.emptySlotCount() > 0; i++) await bot.waitForTicks(2)
    assert.strictEqual(bot.inventory.emptySlotCount(), 0, 'inventory full')
    bot.collectBlock.chestLocations = [new Vec3(-34, y, 9)]
    try {
      const ms = await collect(bot.blockAt(new Vec3(-29, y - 1, 4)), 120000)
      await bot.waitForTicks(20)
      console.log(`      deposit + coal ore: ${(ms / 1000).toFixed(1)} s, dirt left ${count('dirt')}, coal x ${count('coal')}`)
    } finally {
      bot.collectBlock.chestLocations = []
    }
    assert.strictEqual(count('dirt'), 0, 'the dirt went into the chest')
    assert.ok(count('coal') >= 1, 'then the ore was collected')
    assert.strictEqual(count('stone_pickaxe'), 1, 'tools stay (itemFilter)')
    // back to the chest (the ore is ~7 blocks away: BDS ignores an open out of reach) and count what it holds
    const { goals } = require('mineflayer-pathfinder')
    await bot.pathfinder.goto(new goals.GoalGetToBlock(-34, y, 9))
    const chest = await bot.openChest(bot.blockAt(new Vec3(-34, y, 9)))
    try {
      assert.strictEqual(chest.containerItems().reduce((n, i) => n + (i.name === 'dirt' ? i.count : 0), 0), 64 * 35)
    } finally {
      chest.close()
    }
  })
})
