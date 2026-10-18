// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Player and world state against BDS 1.26.51.1 (Bedrock extra):
 * - bot.game: levelType, hardcore, enableRespawnScreen, difficulty (/difficulty), bot.bedrock.gameRules (/gamerule);
 * - bot.abilities + 'abilities' at join (update_abilities layers) and on game mode changes (derived like the Java
 *   server's GameType.updatePlayerAbilities: BDS sends no update_abilities then);
 * - bot.spawnPoint + 'game' on /setworldspawn;
 * - beds: isABed / parseBedMetadata on /setblock beds; 'spawnReset' when the bed the bot set its spawn with is gone.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')
const transactions = require('../../lib/bedrock/transactions')

describe('playerState', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('playerState: game fields, difficulty, game rules', async () => {
    const { bot } = ctx
    assert.strictEqual(bot.game.levelType, 'flat')
    assert.strictEqual(bot.game.hardcore, false)
    assert.strictEqual(bot.game.enableRespawnScreen, true)
    assert.strictEqual(bot.game.difficulty, 'peaceful')
    // the harness' deterministic profile
    assert.strictEqual(bot.bedrock.gameRules.doDayLightCycle, false)
    assert.strictEqual(bot.bedrock.gameRules.doMobSpawning, false)
    assert.strictEqual(typeof bot.bedrock.gameRules.randomTickSpeed, 'number')
    try {
      await bot.test.botCommand('/difficulty normal')
      await bot.test.botCommand('/gamerule keepInventory true')
      await bot.test.wait(300)
      assert.strictEqual(bot.game.difficulty, 'normal')
      assert.strictEqual(bot.bedrock.gameRules.keepInventory, true)
    } finally {
      await bot.test.botCommand('/difficulty peaceful')
      await bot.test.botCommand('/gamerule keepInventory false')
    }
    await bot.test.wait(300)
    assert.strictEqual(bot.game.difficulty, 'peaceful')
    assert.strictEqual(bot.bedrock.gameRules.keepInventory, false)
  })

  it('playerState: abilities at join and per game mode', async () => {
    const { bot } = ctx
    // creative (resetState)
    assert.deepStrictEqual(
      [bot.abilities.mayFly, bot.abilities.instantBuild, bot.abilities.invulnerable],
      [true, true, true])
    assert.ok(Math.abs(bot.abilities.flyingSpeed - 0.05) < 1e-6)
    assert.ok(Math.abs(bot.abilities.walkingSpeed - 0.1) < 1e-6)
    try {
      let changed = onceWithCleanup(bot, 'abilities', { timeout: 5000 })
      await bot.test.becomeSurvival()
      let [abilities] = await changed
      assert.strictEqual(abilities, bot.abilities)
      assert.deepStrictEqual(
        [bot.abilities.mayFly, bot.abilities.instantBuild, bot.abilities.invulnerable, bot.abilities.flying],
        [false, false, false, false])
      changed = onceWithCleanup(bot, 'abilities', { timeout: 5000 })
      await bot.test.setGameMode('spectator')
      ;[abilities] = await changed
      assert.deepStrictEqual([abilities.mayFly, abilities.flying, abilities.invulnerable, abilities.instantBuild], [true, true, true, false])
      assert.strictEqual(bot.entity.flying, true)
    } finally {
      await bot.test.becomeCreative()
    }
    assert.deepStrictEqual([bot.abilities.mayFly, bot.abilities.instantBuild, bot.abilities.invulnerable], [true, true, true])
  })

  it('playerState: spawnPoint + game on /setworldspawn', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    try {
      const game = onceWithCleanup(bot, 'game', { timeout: 5000, checkCondition: () => bot.spawnPoint.x === 3 })
      await bot.test.botCommand(`/setworldspawn 3 ${g} 4`)
      await game
      assert.ok(bot.spawnPoint.equals(new Vec3(3, g, 4)), `${bot.spawnPoint}`)
    } finally {
      const restored = onceWithCleanup(bot, 'game', { timeout: 5000, checkCondition: () => bot.spawnPoint.x === 0 })
      await bot.test.botCommand(`/setworldspawn 0 ${g} 0`)
      await restored
    }
    // the player's own spawn (/spawnpoint) is not the world spawn
    await bot.test.botCommand(`/spawnpoint @s 2 ${g} 2`)
    await bot.test.wait(300)
    assert.ok(bot.spawnPoint.equals(new Vec3(0, g, 0)), `${bot.spawnPoint}`)
  })

  it('playerState: beds — isABed, parseBedMetadata, spawnReset when the spawn bed is gone', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    // a bed whose head points south (direction 0) and one pointing east (direction 3)
    await bot.test.setBlock({ x: 2, y: g, z: -2, blockName: 'bed ["direction"=0,"head_piece_bit"=true]' })
    await bot.test.wait(300)
    const south = [new Vec3(2, g, -2), new Vec3(2, g, -3)].map(p => bot.blockAt(p))
    assert.ok(south.every(b => bot.isABed(b)), south.map(b => b.name).join())
    const head = south.find(b => bot.parseBedMetadata(b).part)
    const foot = south.find(b => !bot.parseBedMetadata(b).part)
    assert.ok(head && foot, 'a head and a foot')
    const meta = bot.parseBedMetadata(foot)
    assert.strictEqual(meta.facing, 0)
    assert.ok(meta.headOffset.equals(new Vec3(0, 0, 1)))
    assert.strictEqual(meta.occupied, false)
    assert.ok(foot.position.plus(meta.headOffset).equals(head.position), 'the head is at foot + headOffset')
    assert.strictEqual(bot.isABed(bot.blockAt(new Vec3(0, g - 1, 0))), false)

    await bot.test.setBlock({ x: -3, y: g, z: 2, blockName: 'bed ["direction"=3,"head_piece_bit"=true]' })
    await bot.test.wait(300)
    const east = [new Vec3(-3, g, 2), new Vec3(-4, g, 2), new Vec3(-2, g, 2)].map(p => bot.blockAt(p)).filter(b => bot.isABed(b))
    const eastFoot = east.find(b => !bot.parseBedMetadata(b).part)
    assert.strictEqual(bot.parseBedMetadata(eastFoot).facing, 3)
    assert.ok(bot.parseBedMetadata(eastFoot).headOffset.equals(new Vec3(1, 0, 0)))

    // the bot sets its spawn with a bed away from the world spawn (BDS says nothing when the bed spawn falls back to
    // the very same position), the bed goes, the bot dies → BDS: tile.bed.notValid → 'spawnReset'
    const at = new Vec3(20, g, 20)
    const bed = new Vec3(22, g, 18) // head; foot at z 17
    await bot.test.teleport(at)
    await bot.waitForChunksToLoad()
    await bot.test.becomeSurvival()
    try {
      await bot.test.setBlock({ x: bed.x, y: g, z: bed.z, blockName: 'bed ["direction"=0,"head_piece_bit"=true]' })
      await bot.test.wait(300)
      const spawnSet = bot.test.ctx.packet('set_spawn_position', (p) => p.spawn_type === 'player' && p.world_position.x === bed.x, 5000)
      transactions.useItemOn(bot, { position: bed, face: 1 })
      await spawnSet.promise
      await bot.test.setBlock({ x: bed.x, y: g, z: bed.z, blockName: 'air' })
      await bot.test.wait(1000)
      const reset = onceWithCleanup(bot, 'spawnReset', { timeout: 15000 })
      const spawned = onceWithCleanup(bot, 'spawn', { timeout: 15000 })
      await bot.test.selfKill()
      await reset
      await spawned
    } finally {
      await bot.test.becomeCreative()
      await bot.test.botCommand(`/fill ${bed.x} ${g} ${bed.z - 1} ${bed.x} ${g} ${bed.z} air`)
    }
  })
})
