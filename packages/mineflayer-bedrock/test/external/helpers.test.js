// owner: U1 (BDS harness & e2e infra)
'use strict'
/**
 * Every bot.test.* helper once against a raw-client bot (no plugins), asserting the server-side
 * effect through the console and the client-side effect through raw packets.
 */
const assert = require('assert')
const path = require('path')
const { Vec3 } = require('vec3')
const { useBot, createRawBot, inject, createTestBot } = require('./common')

describe('harness helpers (raw client bot)', function () {
  this.timeout(120000)
  const env = useBot({ raw: true, server: { gamemode: 'creative' } })
  const at = (x, y, z, block) => env.server.commandWithOutput(`testforblock ${x} ${y} ${z} ${block}`, /Successfully found|is .*\(expected|Cannot test|not loaded|error/i)
    .then((msg) => /Successfully found/.test(msg))

  it('resetState: creative, at the origin, clean superflat, empty inventory', async () => {
    const { bot } = env
    await bot.test.setBlock({ x: 2, y: bot.test.groundY, z: 2, blockName: 'stone' })
    await bot.test.give('dirt', 3)
    await bot.test.becomeSurvival()
    await bot.test.teleport(new Vec3(4, bot.test.groundY, 4))
    await bot.test.resetState()
    const { state } = bot.test.ctx
    assert.strictEqual(state.gameMode, 'creative')
    assert.ok(state.position.distanceTo(new Vec3(0, bot.test.groundY, 0)) < 0.9, `position ${state.position}`)
    assert.ok(await at(2, bot.test.groundY, 2, 'air'), 'superflat restored')
    assert.ok(await at(2, bot.test.groundY - 1, 2, 'grass_block'))
    assert.ok(state.inventory.inventory.every((i) => i === null), 'inventory empty')
  })

  it('becomeSurvival / becomeCreative switch the gamemode (update_player_game_type)', async () => {
    const { bot } = env
    await bot.test.becomeSurvival()
    assert.strictEqual(bot.test.ctx.state.gameMode, 'survival')
    await bot.test.becomeSurvival() // no-op
    await bot.test.becomeCreative()
    assert.strictEqual(bot.test.ctx.state.gameMode, 'creative')
  })

  it('setBlock: absolute, relative and already-set blocks', async () => {
    const { bot } = env
    const y = bot.test.groundY
    await bot.test.setBlock({ x: 3, y, z: 1, blockName: 'stone' })
    assert.ok(await at(3, y, 1, 'stone'))
    await bot.test.setBlock({ x: 3, y, z: 1, blockName: 'stone' }) // already stone: resolves without update
    await bot.test.setBlock({ x: 1, y: 0, z: 0, relative: true, blockName: 'dirt' })
    const p = bot.test.ctx.position().floored()
    assert.ok(await at(p.x + 1, p.y, p.z, 'dirt'))
    // BDS errors fail fast with the console output
    const t0 = Date.now()
    await assert.rejects(bot.test.setBlock({ x: 3, y, z: 2, blockName: 'no_such_block_xyz' }), /setblock 3 -60 2 no_such_block_xyz: .+/)
    assert.ok(Date.now() - t0 < 3000)
  })

  it('setInventorySlot: hotbar, main inventory, armor, off-hand and clearing a slot', async () => {
    const { bot } = env
    const inv = bot.test.ctx.state.inventory
    await bot.test.setInventorySlot(36, { name: 'diamond_sword', count: 1 })
    assert.strictEqual(inv.inventory[0]?.name, 'diamond_sword')
    await bot.test.setInventorySlot(9, { name: 'stone', count: 5 })
    assert.deepStrictEqual([inv.inventory[9]?.name, inv.inventory[9]?.count], ['stone', 5])
    await bot.test.setInventorySlot(5, { name: 'iron_helmet', count: 1 })
    assert.strictEqual(inv.armor[0]?.name, 'iron_helmet')
    await bot.test.setInventorySlot(45, { name: 'shield', count: 1 })
    assert.strictEqual(inv.offhand[0]?.name, 'shield')
    await bot.test.setInventorySlot(36, null)
    assert.strictEqual(inv.inventory[0], null)
    await assert.rejects(bot.test.setInventorySlot(0, { name: 'stone', count: 1 }), /no Bedrock replaceitem equivalent/)
    // a tool's Damage goes through replaceitem's data value; NBT replaceitem cannot set is refused
    const nbtOf = (value) => ({ type: 'compound', name: '', value })
    const update = bot.test.ctx.packet('inventory_content', (p) => String(p.window_id) === 'inventory')
    update.promise.catch(() => {})
    try {
      await bot.test.setInventorySlot(36, { name: 'diamond_sword', count: 1, metadata: 0, nbt: nbtOf({ Damage: { type: 'int', value: 10 } }) })
    } catch (err) {
      update.cancel()
      throw err
    }
    assert.strictEqual((await update.promise).input[0].extra.nbt?.nbt?.value?.Damage?.value, 10)
    const ench = nbtOf({ ench: { type: 'list', value: { type: 'compound', value: [{ id: { type: 'short', value: 9 }, lvl: { type: 'short', value: 1 } }] } } })
    await assert.rejects(bot.test.setInventorySlot(36, { name: 'diamond_sword', count: 1, nbt: ench }), /NBT cannot be set with replaceitem; use bot\.creative\.setInventorySlot/)
  })

  it('clearInventory empties inventory, armor and off-hand', async () => {
    const { bot } = env
    await bot.test.setInventorySlot(37, { name: 'apple', count: 2 })
    await bot.test.clearInventory()
    const inv = bot.test.ctx.state.inventory
    assert.ok([...inv.inventory, ...inv.armor, ...inv.offhand].every((i) => i === null))
    await bot.test.clearInventory() // nothing to clear
  })

  it('give and awaitItemReceived', async () => {
    const { bot } = env
    await bot.test.clearInventory()
    await bot.test.give('dirt', 3)
    assert.deepStrictEqual(bot.test.ctx.state.inventory.inventory.filter(Boolean).map((i) => [i.name, i.count]), [['dirt', 3]])
    await bot.test.awaitItemReceived(`/give ${bot.test.ctx.who()} stone 2`)
    assert.ok(bot.test.ctx.state.inventory.inventory.some((i) => i?.name === 'stone' && i.count === 2))
    await assert.rejects(bot.test.awaitItemReceived('/give @s no_such_item_xyz'), /awaitItemReceived/)
    await assert.rejects(bot.test.give('no_such_item_xyz'), /give no_such_item_xyz: .+/)
  })

  it('teleport and fly move the bot (move_player)', async () => {
    const { bot } = env
    await bot.test.teleport(new Vec3(5, bot.test.groundY, -3))
    assert.ok(bot.test.ctx.position().distanceTo(new Vec3(5, bot.test.groundY, -3)) < 0.9)
    const before = bot.test.ctx.position().clone()
    await bot.test.fly(new Vec3(0, 2, 0))
    assert.ok(Math.abs(bot.test.ctx.position().y - (before.y + 2)) < 0.01)
    await bot.test.teleport(new Vec3(0, bot.test.groundY, 0))
  })

  it('placeBlock sets the block of the item in the given slot', async () => {
    const { bot } = env
    await bot.test.setInventorySlot(36, { name: 'oak_planks', count: 1 })
    await bot.test.placeBlock(36, new Vec3(-2, bot.test.groundY, 1))
    assert.ok(await at(-2, bot.test.groundY, 1, 'oak_planks'))
    await assert.rejects(bot.test.placeBlock(40, new Vec3(-2, bot.test.groundY, 2)), /no item in slot 40/)
  })

  it('summon and killEntity', async () => {
    const { bot } = env
    const pig = await bot.test.summon('pig', new Vec3(3, bot.test.groundY, 3))
    assert.strictEqual(pig.name, 'pig')
    assert.ok(typeof pig.id === 'number')
    assert.ok(bot.test.rawEntities().has(pig.id))
    await bot.test.killEntity(pig)
    assert.ok(!bot.test.rawEntities().has(pig.id))
  })

  it('selfKill (creative → survival) and the raw respawn handshake', async () => {
    const { bot } = env
    await bot.test.becomeCreative()
    await bot.test.teleport(new Vec3(2, bot.test.groundY, 2))
    await bot.test.selfKill()
    assert.strictEqual(bot.test.ctx.state.alive, false)
    await bot.test.awaitRespawn()
    assert.strictEqual(bot.test.ctx.state.alive, true)
    assert.strictEqual(bot.test.ctx.state.gameMode, 'survival')
    // alive again: the server accepts targeted commands
    const q = await env.server.commandWithOutput(`querytarget ${bot.test.ctx.who()}`, /^Target data|No targets/)
    assert.match(q, /^Target data/)
    await bot.test.resetState()
  })

  it('sayEverywhere, awaitCommandsProcessed, wait, botCommand', async () => {
    const { bot } = env
    await bot.test.sayEverywhere('### helpers test')
    await bot.test.awaitCommandsProcessed()
    const t0 = Date.now()
    await bot.test.wait(100)
    assert.ok(Date.now() - t0 >= 95)
    const out = await bot.test.botCommand('/time set 1000')
    assert.strictEqual(out.success_count, 1)
    assert.strictEqual(out.output[0].message_id, 'commands.time.set')
    assert.strictEqual(bot.test.groundY, -60)
    assert.strictEqual(bot.test.port, env.server.port)
  })

  it('tellAndListen with a second player', async () => {
    const { bot, server } = env
    const other = createRawBot({ host: server.host, port: server.port, username: 'listener' })
    try {
      const ctx2 = inject(other, server)
      await ctx2.waitForSpawn()
      other._client.on('text', (p) => {
        if (p.type === 'chat' && ctx2.stripFormatting(p.source_name) === bot.test.ctx.username() && p.message === 'ping') ctx2.chat('pong')
      })
      const [from, message] = await bot.test.tellAndListen('listener', 'ping', (m) => m === 'pong')
      assert.deepStrictEqual([from, message], ['listener', 'pong'])
    } finally {
      other.end()
    }
  })

  it('runExample runs a child bot and talks to it', async () => {
    const { bot } = env
    const file = path.join(__dirname, 'common/fixtures/echo_example.js')
    let ran = false
    await bot.test.runExample(file, async (name) => {
      assert.strictEqual(name, 'echobot')
      await bot.test.tellAndListen(name, 'hello', (m) => m === 'echo: hello')
      ran = true
    })
    assert.ok(ran)
  })
})

describe('harness helpers (mineflayer-bedrock createBot)', function () {
  this.timeout(120000)

  it('createTestBot spawns and the console helpers work whatever plugins are implemented', async () => {
    const { bot, stop } = await createTestBot({ serverOptions: { gamemode: 'survival' } })
    try {
      assert.ok(bot.test.ctx.state.spawned || bot.entity, 'spawned')
      await bot.test.becomeCreative()
      assert.strictEqual(bot.test.ctx.state.gameMode, 'creative')
      await bot.test.teleport(new Vec3(1, bot.test.groundY, 1))
      await bot.test.setBlock({ x: 2, y: bot.test.groundY, z: 2, blockName: 'stone' })
    } finally {
      await stop()
    }
  })
})
