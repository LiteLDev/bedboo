// owner: W3-FIX-B (wave-3 fix-ups: inventory, entities, chat, world)
'use strict'
/**
 * Bedrock extra (W3-FIX-B), against a real BDS 1.26.51.1:
 * - item stacks merging on the ground (entity_event item_entity_merge): getDroppedItem().count follows, itemDrop and
 *   entityUpdate fire again (Java: the item stack metadata update);
 * - attack / useOn / mount leave the bot's view alone like upstream, and still land while the bot faces away.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

describe('entities › item merges, attacks without turning (W3-FIX-B)', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative', difficulty: 'easy' } })
  const cmd = (command) => env.server.commandOutput(command)
  beforeEach(() => env.bot.test.resetState())

  it('itemDrop + getDroppedItem().count follow BDS item merges', async () => {
    const { bot } = env
    const Y = bot.test.groundY
    const merges = []
    const onDrop = (e) => { if (e.getDroppedItem()?.name === 'dirt') merges.push(e.getDroppedItem().count) }
    bot.on('itemDrop', onDrop)
    try {
      await mergeDrops()
    } finally {
      bot.off('itemDrop', onDrop)
      await cmd('kill @e[type=item]')
    }
    async function mergeDrops () {
      // three single dirt drops at one spot: BDS merges them into one stack (entity_event item_entity_merge)
      for (let i = 0; i < 3; i++) {
        await cmd(`setblock 3 ${Y} -3 dirt`)
        await cmd(`setblock 3 ${Y} -3 air destroy`)
        await bot.test.wait(300)
      }
      // BDS merges stacks that lie close enough; the drops scatter a little: gather them on one spot
      await cmd(`tp @e[type=item] 3.5 ${Y} -2.5`)
      const deadline = Date.now() + 10000
      const dirtItems = () => Object.values(bot.entities).filter(e => e.name === 'item' && e.getDroppedItem()?.name === 'dirt')
      while (Date.now() < deadline && !(dirtItems().length < 3 && merges.some(c => c > 1))) await bot.test.wait(200)
      await bot.test.wait(500)
      const counts = dirtItems().map(e => e.getDroppedItem().count)
      assert.ok(counts.length < 3, `merged: ${counts}`)
      assert.strictEqual(counts.reduce((a, b) => a + b, 0), 3, `the remaining stacks hold the 3 items: ${counts}`)
      assert.ok(merges.some(c => c > 1), `itemDrop fired again with a merged count: ${merges}`)
    }
  })

  it('a joining bot: login → game → playerJoined (itself and the players already online, with bot.game set) → spawn', async () => {
    const { bot, server } = env
    const order = []
    const joiner = require('../../').createBot({ host: server.host, port: server.port, username: `w3j${process.pid % 1000}` })
    try {
      joiner.on('error', () => {})
      joiner.on('login', () => order.push('login'))
      joiner.on('game', () => { if (!order.includes('game')) order.push('game') })
      joiner.on('playerJoined', (p) => order.push(`playerJoined ${p.username === joiner.username ? 'self' : p.username}${joiner.game?.gameMode ? '' : ' (no game!)'}`))
      await new Promise((resolve, reject) => {
        joiner.once('spawn', resolve)
        joiner.once('end', () => reject(new Error('the joining bot ended')))
        setTimeout(() => reject(new Error('no spawn')), 60000).unref()
      })
      order.push('spawn')
      const joins = order.filter(e => e.startsWith('playerJoined'))
      assert.ok(joins.includes('playerJoined self') && joins.includes(`playerJoined ${bot.username}`), order.join(', '))
      assert.deepStrictEqual(order.slice(0, 2), ['login', 'game'], order.join(', '))
      assert.ok(!order.some(e => e.includes('no game')), order.join(', '))
      assert.ok(order.indexOf('playerJoined self') < order.indexOf('spawn'), order.join(', '))
    } finally {
      joiner.end('done')
    }
  })

  it('attack while facing away: the bot is not turned, the zombie is still hurt; mounting a boat behind the bot works too', async () => {
    const { bot } = env
    const Y = bot.test.groundY
    await bot.test.setGameMode('survival')
    await cmd(`effect ${bot.test.ctx.who()} resistance 600 4 true`)
    // the bot looks west (-x), the zombie stands east of it
    await bot.look(Math.PI / 2, 0, true)
    await bot.test.wait(200)
    const zombie = await bot.test.summon('zombie', new Vec3(bot.entity.position.x + 1.6, Y, bot.entity.position.z), { spawnEvent: 'minecraft:as_adult' })
    await cmd('effect @e[type=zombie] slowness 600 255 true')
    const { yaw, pitch } = bot.entity
    const hurt = bot.test.botEvent('entityHurt', (e) => e === zombie, 5000)
    bot.attack(zombie)
    await hurt.promise
    assert.deepStrictEqual([bot.entity.yaw, bot.entity.pitch], [yaw, pitch], 'upstream never turns the bot to attack')
    await bot.test.wait(500)
    assert.deepStrictEqual([bot.entity.yaw, bot.entity.pitch], [yaw, pitch])
    await bot.test.killEntity(zombie)
    // a boat behind the bot
    const boat = await bot.test.summon('boat', new Vec3(bot.entity.position.x + 1.5, Y, bot.entity.position.z))
    const mounted = bot.test.botEvent('mount', () => true, 5000)
    bot.mount(boat)
    await mounted.promise
    assert.strictEqual(bot.vehicle, boat)
    const dismounted = bot.test.botEvent('dismount', () => true, 5000)
    bot.dismount()
    await dismounted.promise
    await bot.test.killEntity(boat)
  })
})
