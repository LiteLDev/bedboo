// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Dimension travel against BDS 1.26.51.1 (Bedrock extra; the user requirement "every dimension must be enterable"):
 * - overworld → nether → overworld → end → overworld through `/execute in <dim> run tp @s …` (the bot's own command);
 * - stepping into portal blocks placed with /setblock at the bot's feet: `portal` (Bedrock's nether portal block, a
 *   survival player stands in it ~4 s) and `end_portal`;
 * - the End exit portal → overworld: BDS shows the credits (show_credits status 0) the first time and waits for the
 *   client's show_credits status 1 before the change_dimension; a second exit has no credits;
 * - a death in the nether → respawn in the overworld (the dimension change inside the respawn: no loading screen
 *   acks, one 'spawn').
 * After every change: bot.game.dimension / _getDimensionName() / minY / height, the 'game', 'respawn',
 * 'forcedMove' and 'spawn' events, blocks of the new dimension (bedrock floor, netherrack, end_stone, obsidian), the
 * biome from registry.biomes, only columns of the new dimension in bot.world, the server-side dimension
 * (querytarget) and no prediction corrections while standing still afterwards.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

const DIMENSIONS = {
  overworld: { id: 0, minY: -64, height: 384, name: 'minecraft:overworld' },
  the_nether: { id: 1, minY: 0, height: 128, name: 'minecraft:the_nether' },
  the_end: { id: 2, minY: 0, height: 256, name: 'minecraft:the_end' }
}

/** server-side dimension id + feet position of the bot (querytarget) */
async function serverState (server, username) {
  const lines = await server.commandOutput(`querytarget ${username}`)
  const start = lines.findIndex((l) => /^Target data: \[/.test(l))
  if (start < 0) return null
  const [data] = JSON.parse('[' + lines.slice(start + 1).join('\n'))
  return { dimension: data.dimension, position: new Vec3(data.position.x, data.position.y - 1.62, data.position.z) }
}

describe('dimensionTravel', function () {
  this.timeout(180000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  /**
   * Run `trigger` and wait for the dimension change to complete ('spawn'); records the bot events in between and
   * checks the world right at 'spawn' (no column of the previous dimension).
   */
  async function travel (trigger, expected, { timeout = 30000 } = {}) {
    const { bot } = ctx
    const events = []
    const record = (name) => () => events.push(name)
    const listeners = ['game', 'respawn', 'forcedMove', 'spawn', 'death'].map(name => [name, record(name)])
    for (const [name, fn] of listeners) bot.on(name, fn)
    const unloaded = []
    const onUnload = (p) => unloaded.push(p)
    bot.on('chunkColumnUnload', onUnload)
    const loadedBefore = Object.keys(bot.world.async.columns).length
    let columnsAtSpawn
    let positionAtSpawn
    const spawned = onceWithCleanup(bot, 'spawn', {
      timeout,
      checkCondition: () => {
        if (bot.game.dimension !== expected) return false
        columnsAtSpawn = Object.values(bot.world.async.columns)
        positionAtSpawn = bot.entity.position.clone()
        return true
      }
    })
    try {
      await trigger()
      await spawned
    } finally {
      for (const [name, fn] of listeners) bot.removeListener(name, fn)
      bot.removeListener('chunkColumnUnload', onUnload)
    }
    // the previous dimension's columns are gone when the new one spawns
    const dim = DIMENSIONS[expected]
    // 'spawn' fires at the real position (W3-FIX-A: the End exit's change_dimension carries the y 32767 search height,
    // the position follows in respawn state 1)
    assert.ok(positionAtSpawn.y >= dim.minY && positionAtSpawn.y < dim.minY + dim.height, `position at spawn ${positionAtSpawn}`)
    for (const column of columnsAtSpawn) {
      assert.strictEqual(column.minY, dim.minY, `column ${column.x},${column.z} of another dimension at spawn`)
      assert.strictEqual(column.worldHeight, dim.height, `column ${column.x},${column.z} height`)
    }
    assert.ok(unloaded.length >= Math.min(loadedBefore, 1), `${unloaded.length} columns unloaded of ${loadedBefore}`)
    return events
  }

  /**
   * every assertion about being in `expected` after a dimension change; `still`: the bot stands in the open (not
   * teleported into nether rock), so the server must not correct it while it stands still
   */
  async function assertIn (expected, events, { still = true } = {}) {
    const { bot, server } = ctx
    const dim = DIMENSIONS[expected]
    assert.strictEqual(bot.game.dimension, expected)
    assert.strictEqual(bot._getDimensionName(), dim.name)
    assert.strictEqual(bot.game.minY, dim.minY)
    assert.strictEqual(bot.game.height, dim.height)
    assert.strictEqual(bot.isAlive, true)
    assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
    if (events) {
      for (const e of ['game', 'respawn', 'forcedMove', 'spawn']) assert.ok(events.includes(e), `${e} in ${events}`)
      assert.ok(events.indexOf('game') < events.indexOf('spawn'), `${events}`)
      assert.ok(events.indexOf('respawn') < events.indexOf('spawn'), `${events}`)
      assert.strictEqual(events.filter(e => e === 'spawn').length, 1, `${events}`)
    }
    await bot.waitForChunksToLoad()
    const columns = Object.values(bot.world.async.columns)
    assert.ok(columns.length > 0)
    for (const column of columns) {
      assert.strictEqual(column.minY, dim.minY, `column ${column.x},${column.z}`)
      assert.strictEqual(column.worldHeight, dim.height, `column ${column.x},${column.z}`)
    }
    const pos = bot.entity.position
    assert.ok(pos.y >= dim.minY && pos.y < dim.minY + dim.height, `position ${pos}`)
    const floor = bot.blockAt(new Vec3(Math.floor(pos.x), dim.minY, Math.floor(pos.z)))
    // biomes (registry.biomes: vanilla Bedrock ids) of the whole column, not only its lowest biome section
    const biomes = [dim.minY, Math.floor(pos.y), dim.minY + dim.height - 1].map(y => bot.registry.biomes[bot.blockAt(new Vec3(Math.floor(pos.x), y, Math.floor(pos.z))).biome.id])
    if (expected === 'overworld') {
      assert.strictEqual(floor.name, 'bedrock')
      assert.deepStrictEqual(biomes.map(b => b?.name), ['plains', 'plains', 'plains'])
    } else if (expected === 'the_nether') {
      assert.strictEqual(floor.name, 'bedrock', 'nether floor')
      assert.strictEqual(bot.blockAt(new Vec3(Math.floor(pos.x), 127, Math.floor(pos.z))).name, 'bedrock', 'nether ceiling')
      assert.ok(biomes.every(b => b?.dimension === 'nether'), `nether biomes ${biomes.map(b => b?.name)}`)
      assert.ok(bot.findBlock({ matching: bot.registry.blocksByName.netherrack.id, maxDistance: 64 }), 'netherrack around')
    } else {
      assert.deepStrictEqual(biomes.map(b => b?.name), ['the_end', 'the_end', 'the_end'])
      assert.ok(bot.findBlock({ matching: bot.registry.blocksByName.end_stone.id, maxDistance: 128 }), 'end_stone around')
    }
    // the server agrees on the dimension and simulates the player (loading screen acked): no corrections
    const state = await serverState(server, bot.username)
    assert.strictEqual(state.dimension, dim.id)
    if (!still) return
    let corrections = 0
    const onCorrection = () => corrections++
    bot._client.on('correct_player_move_prediction', onCorrection)
    try {
      await bot.waitForTicks(30)
    } finally {
      bot._client.removeListener('correct_player_move_prediction', onCorrection)
    }
    assert.ok(corrections <= 3, `${corrections} corrections standing still`)
  }

  const say = (command) => () => { ctx.bot.chat(command) }

  async function backToOverworld () {
    const { bot } = ctx
    if (bot.game.dimension === 'overworld') return
    await travel(say(`/execute in overworld run tp @s 0 ${bot.test.groundY} 0`), 'overworld')
    await bot.waitForChunksToLoad()
  }

  afterEach(async function () {
    this.timeout(60000)
    if (ctx.bot?.game?.dimension && ctx.bot.game.dimension !== 'overworld') await backToOverworld()
  })

  it('dimensionTravel: overworld → nether → overworld → end → overworld via /execute in … run tp', async () => {
    const { bot } = ctx
    await assertIn('overworld')
    let events = await travel(say('/execute in nether run tp @s 8 70 8'), 'the_nether')
    await assertIn('the_nether', events, { still: false }) // (8, 70, 8) may be inside the nether rock
    assert.ok(bot.entity.position.distanceTo(new Vec3(8.5, 70, 8.5)) < 3, `${bot.entity.position}`)

    events = await travel(say(`/execute in overworld run tp @s 0 ${bot.test.groundY} 0`), 'overworld')
    await assertIn('overworld', events)
    assert.strictEqual(bot.blockAt(new Vec3(0, bot.test.groundY - 1, 0)).name, 'grass_block')
    assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, bot.test.groundY, 0.5)) < 0.01, `${bot.entity.position}`)
    for (let y = 0; y < 128; y += 7) assert.strictEqual(bot.blockAt(new Vec3(8, y, 8)).name, 'air', `no nether block left at y ${y}`)

    // above the main island (the spawn platform only exists once someone came through an end portal)
    events = await travel(say('/execute in the_end run tp @s 10 80 10'), 'the_end')
    await assertIn('the_end', events, { still: false })
    let endStone = 0
    for (let y = 0; y < 80; y++) if (bot.blockAt(new Vec3(10, y, 10))?.name === 'end_stone') endStone++
    assert.ok(endStone > 0, 'the main island under the bot')

    events = await travel(say(`/execute in overworld run tp @s 0 ${bot.test.groundY} 0`), 'overworld')
    await assertIn('overworld', events)
  })

  it('dimensionTravel: nether portal block at the feet (survival) → nether, and a nether portal back', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await bot.test.teleport(new Vec3(24, g, 24))
    await bot.waitForChunksToLoad()
    await bot.test.becomeSurvival()
    try {
      const portal = bot.registry.blocksByName.nether_portal ? 'nether_portal' : 'portal'
      assert.strictEqual(portal, 'portal', 'Bedrock name of the nether portal block')
      const usedAt = Date.now()
      let events = await travel(say(`/setblock ~ ~ ~ ${portal}`), 'the_nether', { timeout: 60000 })
      assert.ok(Date.now() - usedAt >= 2500, 'survival players stand in the portal for a while')
      await assertIn('the_nether', events)
      // BDS built (or found) the arrival portal: an obsidian frame with portal blocks at the bot
      const feet = bot.entity.position.floored()
      assert.ok(bot.findBlock({ matching: bot.registry.blocksByName.portal.id, maxDistance: 3 }), 'arrival portal')
      assert.ok(bot.findBlock({ matching: bot.registry.blocksByName.obsidian.id, maxDistance: 3 }), 'arrival portal frame')

      // step out of the arrival portal, then into a new one
      const out = feet.offset(3, 0, 0)
      await bot.test.botCommand(`/fill ${out.x} ${out.y} ${out.z} ${out.x} ${out.y + 1} ${out.z} air`)
      await bot.test.botCommand(`/setblock ${out.x} ${out.y - 1} ${out.z} obsidian`)
      const moved = onceWithCleanup(bot, 'forcedMove', { timeout: 5000 })
      bot.chat(`/tp @s ${out.x} ${out.y} ${out.z}`)
      await moved
      await bot.test.wait(1000)
      events = await travel(say(`/setblock ${out.x} ${out.y} ${out.z} ${portal}`), 'overworld', { timeout: 60000 })
      await assertIn('overworld', events)
      assert.ok(bot.findBlock({ matching: bot.registry.blocksByName.portal.id, maxDistance: 3 }), 'arrived at an overworld portal')
    } finally {
      await bot.test.becomeCreative()
    }
  })

  it('dimensionTravel: end portal block at the feet → the End, End exit portal → overworld with the credits ack', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await bot.test.teleport(new Vec3(-24, g, 24))
    await bot.waitForChunksToLoad()
    let events = await travel(say('/setblock ~ ~ ~ end_portal'), 'the_end')
    await assertIn('the_end', events)
    const feet = bot.entity.position.floored()
    assert.strictEqual(bot.blockAt(feet.offset(0, -1, 0)).name, 'obsidian', 'the End spawn platform')

    // the exit portal: the first exit shows the credits, the bot skips them like upstream (status 1 = end)
    const sent = []
    const queue = bot._client.queue.bind(bot._client)
    bot._client.queue = (name, params) => { if (name === 'show_credits') sent.push(params); return queue(name, params) }
    const credits = onceWithCleanup(bot._client, 'show_credits', { timeout: 30000 })
    try {
      const exit = feet.offset(1, 0, 1)
      await bot.test.botCommand(`/setblock ${exit.x} ${exit.y} ${exit.z} air`)
      const moved = onceWithCleanup(bot, 'forcedMove', { timeout: 5000 })
      bot.chat(`/tp @s ${exit.x} ${exit.y} ${exit.z}`)
      await moved
      await bot.test.wait(1000)
      events = await travel(say(`/setblock ${exit.x} ${exit.y} ${exit.z} end_portal`), 'overworld', { timeout: 60000 })
      const [shown] = await credits
      assert.strictEqual(shown.status, 0)
      assert.deepStrictEqual(sent.map(p => p.status), [1])
      assert.strictEqual(sent[0].runtime_entity_id, bot._bedrock.ids.selfRuntimeId())
      await assertIn('overworld', events)

      // a second exit: no credits this time, straight to the overworld
      await travel(say('/execute in the_end run tp @s 100 50 0'), 'the_end')
      await bot.waitForChunksToLoad()
      const exit2 = new Vec3(101, 50, -1)
      await bot.test.botCommand(`/setblock ${exit2.x} ${exit2.y} ${exit2.z} air`)
      const moved2 = onceWithCleanup(bot, 'forcedMove', { timeout: 5000 })
      bot.chat(`/tp @s ${exit2.x} ${exit2.y} ${exit2.z}`)
      await moved2
      await bot.test.wait(1000)
      events = await travel(say(`/setblock ${exit2.x} ${exit2.y} ${exit2.z} end_portal`), 'overworld', { timeout: 60000 })
      await assertIn('overworld', events)
      assert.strictEqual(sent.length, 1, 'credits acked once')
    } finally {
      bot._client.queue = queue
    }
  })

  it('dimensionTravel: a death in the nether respawns in the overworld (one spawn, no loading screen acks)', async () => {
    const { bot } = ctx
    await travel(say('/execute in nether run tp @s 8 70 8'), 'the_nether')
    await bot.waitForChunksToLoad()
    const sent = []
    const queue = bot._client.queue.bind(bot._client)
    bot._client.queue = (name, params) => { sent.push([name, params]); return queue(name, params) }
    let ended = false
    const onEnd = () => { ended = true }
    bot.once('end', onEnd)
    try {
      const deaths = []
      bot.once('death', () => deaths.push(bot.game.dimension))
      const events = await travel(() => bot.test.selfKill(), 'overworld')
      await bot.test.wait(1000)
      assert.deepStrictEqual(deaths, ['the_nether'])
      assert.ok(events.indexOf('death') < events.indexOf('respawn'), `${events}`)
      assert.strictEqual(events.filter(e => e === 'respawn').length, 1, `one respawn per death: ${events}`)
      assert.strictEqual(ended, false, 'still connected')
      const names = sent.map(([n, p]) => n === 'player_action' ? `player_action:${p.action}` : n)
      assert.deepStrictEqual(names.filter(n => n === 'respawn'), ['respawn'], 'one client respawn (state 2)')
      assert.strictEqual(sent.find(([n]) => n === 'respawn')[1].state, 2)
      assert.ok(names.includes('player_action:dimension_change_ack'))
      assert.ok(names.includes('player_action:respawn'))
      assert.ok(!names.includes('serverbound_loading_screen'), 'no loading screen for the respawn dimension change')
      await assertIn('overworld', events)
    } finally {
      bot._client.queue = queue
      bot.removeListener('end', onEnd)
      await bot.test.becomeCreative()
    }
  })
})
