// owner: U4 (core runtime)
'use strict'
/**
 * Core runtime against a real BDS 1.26.51.1 (Bedrock extra, U4): join/spawn and the harness stepping back,
 * bot.game / bot.entity / bot.player, the tick clock + stationary physics stub (no corrections), /tp →
 * forcedMove, the nether and the end via `/execute in … run tp` (world reload).
 */
const assert = require('assert')
const { once } = require('events')
const { Vec3 } = require('vec3')
const { useServer, createTestBot } = require('./common')
const { queryTargetPosition } = require('./common/helpers/base')
const mineflayerBedrock = require('../..')

const GROUND = -60
let counter = 0
const uniqueName = (prefix) => `${prefix}${process.pid % 1000}${counter++}`

function waitFor (emitter, event, predicate = () => true, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.removeListener(event, fn); reject(new Error(`timed out waiting for ${event}`)) }, timeout)
    function fn (...args) {
      if (!predicate(...args)) return
      clearTimeout(timer)
      emitter.removeListener(event, fn)
      resolve(args)
    }
    emitter.on(event, fn)
  })
}

describe('core: join, spawn, game, physics stub, dimensions (U4)', function () {
  this.timeout(120000)
  const env = useServer({ gamemode: 'creative' })
  const bots = []
  afterEach(async () => {
    for (const bot of bots.splice(0)) {
      try { bot.end('test done') } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  })

  it('login → game → spawn in mineflayer order; the harness leaves the join to the lifecycle', async () => {
    const { server } = env
    const username = uniqueName('join')
    const bot = mineflayerBedrock.createBot({ host: server.host, port: server.port, username })
    bots.push(bot)
    const events = []
    for (const e of ['connect', 'login', 'game', 'spawn', 'forcedMove']) bot.on(e, () => events.push(e))
    const sent = []
    const queue = bot._client.queue.bind(bot._client)
    bot._client.queue = (name, params) => { sent.push([name, params]); return queue(name, params) }
    await once(bot, 'spawn')
    assert.deepStrictEqual(events.filter(e => e !== 'forcedMove').slice(0, 4), ['connect', 'login', 'game', 'spawn'])
    assert.ok(events.indexOf('forcedMove') < events.indexOf('spawn'), 'position known before spawn')
    assert.deepStrictEqual(sent.filter(([n]) => n === 'respawn').map(([, p]) => p.state), [2])
    assert.deepStrictEqual(sent.filter(([n]) => n === 'serverbound_loading_screen').map(([, p]) => p.type), [1, 2])
    assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')

    assert.strictEqual(bot.username, username)
    assert.strictEqual(bot.entity.username, username)
    assert.strictEqual(bot.entity.type, 'player')
    assert.strictEqual(bot.entities[bot.entity.id], bot.entity)
    assert.strictEqual(bot.player.entity, bot.entity)
    assert.strictEqual(bot.players[username], bot.player)
    assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, GROUND, 0.5)) < 0.01, `${bot.entity.position}`)
    assert.strictEqual(bot.game.dimension, 'overworld')
    assert.strictEqual(bot.game.minY, -64)
    assert.strictEqual(bot.game.height, 384)
    assert.strictEqual(bot.game.levelType, 'flat')
    assert.strictEqual(bot.game.gameMode, 'creative')
    assert.strictEqual(bot.game.difficulty, 'peaceful')
    assert.strictEqual(bot.game.hardcore, false)
    assert.strictEqual(bot._getDimensionName(), 'minecraft:overworld')
    assert.strictEqual(bot.version, '1.26.51')
    assert.strictEqual(bot.protocolVersion, 2193)
    if (bot.game.serverViewDistance === undefined) await waitFor(bot._client, 'chunk_radius_update', () => true, 5000)
    assert.strictEqual(typeof bot.game.serverViewDistance, 'number')
    // the server simulates the player (loading screen acked) and agrees on the position
    const serverPos = await queryTargetPosition(server, username)
    assert.ok(serverPos && serverPos.distanceTo(bot.entity.position) < 0.01, `server ${serverPos}, bot ${bot.entity.position}`)
  })

  it('the e2e harness (useBot/createTestBot) steps back: no duplicate join packets', async () => {
    const { server } = env
    const { bot, ctx } = await createTestBot({ server, username: uniqueName('harness') })
    bots.push(bot)
    assert.strictEqual(ctx.raw.join, false)
    assert.strictEqual(ctx.raw.respawn, false, 'bot.respawn (U9) answers deaths: the harness steps back')
    assert.strictEqual(ctx.state.spawned, true)
    assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
  })

  it('stationary: one player_auth_input per server tick, physicsTick each tick, no correction for 10 s', async () => {
    const { server } = env
    const username = uniqueName('still')
    const bot = mineflayerBedrock.createBot({ host: server.host, port: server.port, username })
    bots.push(bot)
    await once(bot, 'spawn')
    await new Promise(resolve => setTimeout(resolve, 1000))
    const ticks = []
    const queue = bot._client.queue.bind(bot._client)
    bot._client.queue = (name, params) => { if (name === 'player_auth_input') ticks.push(params.tick); return queue(name, params) }
    let corrections = 0
    let physicsTicks = 0
    bot._client.on('correct_player_move_prediction', () => corrections++)
    bot.on('physicsTick', () => physicsTicks++)
    const t0 = performance.now()
    await new Promise(resolve => setTimeout(resolve, 10000))
    const seconds = (performance.now() - t0) / 1000
    assert.ok(Math.abs(ticks.length - seconds * 20) <= 3, `${ticks.length} inputs in ${seconds.toFixed(2)} s`)
    for (let i = 1; i < ticks.length; i++) assert.strictEqual(ticks[i], ticks[i - 1] + 1n, 'consecutive ticks')
    assert.ok(Math.abs(physicsTicks - ticks.length) <= 1)
    assert.strictEqual(corrections, 0)
    await bot.waitForTicks(5)
  })

  it('/tp → forcedMove at the feet position + handled_teleport; a /tp into the air lands on the ground', async () => {
    const { server } = env
    const username = uniqueName('tp')
    const bot = mineflayerBedrock.createBot({ host: server.host, port: server.port, username })
    bots.push(bot)
    await once(bot, 'spawn')
    const flags = []
    const queue = bot._client.queue.bind(bot._client)
    bot._client.queue = (name, params) => { if (name === 'player_auth_input') flags.push(params.input_data); return queue(name, params) }
    const moved = waitFor(bot, 'forcedMove')
    await server.commandOutput(`tp ${username} 5 ${GROUND} 7`)
    await moved
    assert.ok(bot.entity.position.distanceTo(new Vec3(5.5, GROUND, 7.5)) < 0.01, `${bot.entity.position}`)
    await bot.waitForTicks(2)
    assert.ok(flags.some(f => f.includes('handled_teleport')))
    const serverPos = await queryTargetPosition(server, username)
    assert.ok(serverPos.distanceTo(new Vec3(5.5, GROUND, 7.5)) < 0.01)

    let corrections = 0
    bot._client.on('correct_player_move_prediction', () => corrections++)
    await server.commandOutput(`tp ${username} 3 ${GROUND + 10} 3`)
    await waitFor(bot, 'forcedMove')
    await new Promise(resolve => setTimeout(resolve, 3000))
    assert.ok(Math.abs(bot.entity.position.y - GROUND) < 0.01, `landed: ${bot.entity.position}`)
    assert.strictEqual(bot.entity.onGround, true)
    assert.ok(corrections <= 3, `${corrections} corrections while falling`)
    const landed = await queryTargetPosition(server, username)
    assert.ok(landed.distanceTo(bot.entity.position) < 0.01, `server ${landed}`)
  })

  it('look: the next player_auth_input carries the rotation; the server sees it', async () => {
    const { server } = env
    const username = uniqueName('look')
    const bot = mineflayerBedrock.createBot({ host: server.host, port: server.port, username })
    bots.push(bot)
    await once(bot, 'spawn')
    await bot.look(Math.PI / 2, 0.5)
    await bot.waitForTicks(4)
    const lines = await server.commandOutput(`querytarget ${username}`)
    const data = JSON.parse('[' + lines.slice(lines.findIndex(l => /^Target data: \[/.test(l)) + 1).join('\n'))
    // querytarget yRot is the Bedrock yaw in degrees (notchian)
    const diff = ((data[0].yRot - 90) % 360 + 540) % 360 - 180 // mineflayer yaw π/2 (west) = Bedrock 90°
    assert.ok(Math.abs(diff) < 1, `yRot ${data[0].yRot}`)
  })

  it('nether and end via /execute in … run tp: world reset + reload, spawn per dimension change, back to the overworld', async () => {
    const { server } = env
    const username = uniqueName('dim')
    const bot = mineflayerBedrock.createBot({ host: server.host, port: server.port, username, viewDistance: 'tiny' })
    bots.push(bot)
    await once(bot, 'spawn')
    const unloads = []
    bot.on('chunkColumnUnload', (p) => unloads.push(p))

    let spawned = waitFor(bot, 'spawn', () => true, 30000)
    await server.commandOutput(`execute in nether run tp ${username} 8 70 8`)
    await spawned
    assert.strictEqual(bot.game.dimension, 'the_nether')
    assert.strictEqual(bot._getDimensionName(), 'minecraft:the_nether')
    assert.deepStrictEqual([bot.game.minY, bot.game.height], [0, 128])
    assert.ok(unloads.length > 0, 'the overworld columns were unloaded')
    assert.ok(bot.entity.position.distanceTo(new Vec3(8.5, 70, 8.5)) < 2, `${bot.entity.position}`)
    await bot.waitForChunksToLoad()
    assert.strictEqual(bot.blockAt(new Vec3(8, 0, 8)).name, 'bedrock', 'nether floor')
    assert.strictEqual(bot.blockAt(new Vec3(8, 127, 8)).name, 'bedrock', 'nether ceiling')
    assert.strictEqual(bot.world.getColumnAt(bot.entity.position).minY, 0)

    spawned = waitFor(bot, 'spawn', () => true, 30000)
    await server.commandOutput(`execute in the_end run tp ${username} 10 80 10`)
    await spawned
    assert.strictEqual(bot.game.dimension, 'the_end')
    assert.deepStrictEqual([bot.game.minY, bot.game.height], [0, 256])
    await bot.waitForChunksToLoad()
    let endStone = 0
    for (let y = 0; y < 128; y++) if (bot.blockAt(new Vec3(10, y, 10))?.name === 'end_stone') endStone++
    assert.ok(endStone > 0, 'the main island under the bot')

    spawned = waitFor(bot, 'spawn', () => true, 30000)
    await server.commandOutput(`execute in overworld run tp ${username} 0 ${GROUND} 0`)
    await spawned
    assert.strictEqual(bot.game.dimension, 'overworld')
    await bot.waitForChunksToLoad()
    assert.strictEqual(bot.blockAt(new Vec3(0, GROUND - 1, 0)).name, 'grass_block')
    assert.ok(Math.abs(bot.entity.position.y - GROUND) < 0.01)
    // the server simulates the player again after the dimension change (loading screen acked)
    let corrections = 0
    bot._client.on('correct_player_move_prediction', () => corrections++)
    await new Promise(resolve => setTimeout(resolve, 2000))
    assert.strictEqual(corrections, 0)
    const serverPos = await queryTargetPosition(server, username)
    assert.ok(serverPos.distanceTo(bot.entity.position) < 0.01, `server ${serverPos}`)
  })
})
