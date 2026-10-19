// owner: U15 (ecosystem plugins & examples)
'use strict'
/**
 * Bedrock extra: the ported plugin examples run as child processes against BDS 1.26.51.1, driven over chat like a
 * player would (they have no 'loaded' / 'Ready!' handshake, so bot.test.runExample does not apply):
 * - examples/pathfinder/gps.js: "come" → mineflayer-pathfinder GoalNear to the player;
 * - examples/collectblock.js: "collect dirt" → mineflayer-collectblock digs the nearest dirt (survival) and picks up
 *   the drop.
 */
const assert = require('assert')
const path = require('path')
const { spawn } = require('child_process')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

const EXAMPLES = path.join(__dirname, '../../examples')

describe('exampleEcosystem', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'survival' } })
  let child = null
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => { const t = setTimeout(resolve, 5000); child.once('close', () => { clearTimeout(t); resolve() }) })
    }
    child = null
  })

  /** start `node <example> host port <name>`, resolve once its player is in the world */
  async function start (file, name) {
    const { bot, server } = ctx
    child = spawn(process.execPath, [path.join(EXAMPLES, file), server.host, `${server.port}`, name], { cwd: EXAMPLES })
    child.stdout.on('data', (d) => process.stdout.write(`      [${name}] ${d}`))
    child.stderr.on('data', (d) => process.stderr.write(`      [${name}] ${d}`))
    const t0 = Date.now()
    while (!bot.players[name]?.entity) {
      assert.ok(child.exitCode === null, `${file} exited (${child.exitCode})`)
      assert.ok(Date.now() - t0 < 30000, `${name} did not appear`)
      await bot.waitForTicks(5)
    }
    return bot.players[name].entity
  }

  it('pathfinder/gps.js: "come" walks the example bot to the player', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const gps = await start('pathfinder/gps.js', 'gps')
    await bot.test.ctx.consoleExpect(`tp gps 12 ${g} 3`, /^Teleported/)
    await bot.test.wait(1500) // the example sets up its listener on spawn
    bot.chat('come')
    const t0 = Date.now()
    while (gps.position.distanceTo(bot.entity.position) > 2) {
      assert.ok(Date.now() - t0 < 30000, `gps at ${gps.position}`)
      await bot.waitForTicks(5)
    }
  })

  it('collectblock.js: "collect dirt" digs the nearest dirt and picks it up', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const collector = await start('collectblock.js', 'collector')
    await bot.test.ctx.consoleExpect(`tp collector 7 ${g} 6`, /^Teleported/)
    await bot.test.ctx.consoleExpect(`setblock 8 ${g} 6 dirt`, /placed/i) // nearer than the dirt layer under the grass
    await bot.test.wait(1500)
    const seen = []
    const picked = new Promise((resolve) => {
      const onCollect = (who, item) => {
        seen.push([who.username ?? who.name, item.getDroppedItem?.()?.name])
        if (who.username !== 'collector' || item.getDroppedItem?.()?.name !== 'dirt') return
        bot.removeListener('playerCollect', onCollect)
        resolve()
      }
      bot.on('playerCollect', onCollect)
    })
    const said = bot.test.awaitChat((username, message) => username === 'collector' && /^Collecting the nearest dirt/.test(message), 10000)
    bot.chat('collect dirt')
    await said
    await Promise.race([picked, bot.test.wait(30000).then(() => { throw new Error(`the dirt was not collected (collector at ${collector.position}, block ${bot.blockAt(new Vec3(8, g, 6)).name}, collects seen ${JSON.stringify(seen)})`) })])
    assert.strictEqual(bot.blockAt(new Vec3(8, g, 6)).name, 'air', 'the placed dirt (the nearest) was dug')
  })
})
