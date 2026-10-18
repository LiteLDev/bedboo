// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Block action events against BDS 1.26.51.1 (Bedrock extra: mineflayer 4.39.0 has no external test for them; the
 * events are upstream's block_actions.js ones). Stations are staged with /setblock:
 * - noteHeard: a note block on a gold block (bell) powered by a redstone block;
 * - pistonMove: pistons (normal + sticky, several facings) pushed / pulled by a redstone block;
 * - chestLidMove: the bot opens / closes a chest and a double chest (raw click_block transaction + container_close:
 *   U8's openContainer is wave 3 too);
 * - blockBreakProgressObserved / blockBreakProgressEnd: a second bot breaks a block (server-auth block actions in
 *   its player_auth_input; U10's dig is wave 4).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot, createTestBot, implemented } = require('./common')
const transactions = require('../../lib/bedrock/transactions')

function collect (bot, event) {
  const seen = []
  const fn = (...args) => seen.push(args)
  bot.on(event, fn)
  return { seen, stop: () => bot.removeListener(event, fn) }
}

describe('blockActions', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('blockActions: noteHeard (instrument from the block below, pitch)', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const note = new Vec3(3, g, 3)
    await bot.test.setBlock({ x: 3, y: g - 1, z: 3, blockName: 'gold_block' })
    await bot.test.setBlock({ x: note.x, y: note.y, z: note.z, blockName: 'noteblock' })
    const heard = onceWithCleanup(bot, 'noteHeard', { timeout: 5000 })
    await bot.test.setBlock({ x: 4, y: g, z: 3, blockName: 'redstone_block' })
    const [block, instrument, pitch] = await heard
    assert.ok(block.position.equals(note))
    assert.strictEqual(block.name, 'noteblock')
    assert.strictEqual(instrument.name, 'bell')
    assert.strictEqual(instrument.id, 6)
    assert.strictEqual(pitch, 0)

    // a harp (instrument 0: bedrock-protocol maps it to 'sound') on dirt
    const harpPos = new Vec3(3, g, -3)
    await bot.test.setBlock({ x: harpPos.x, y: g - 1, z: harpPos.z, blockName: 'dirt' })
    await bot.test.setBlock({ x: harpPos.x, y: harpPos.y, z: harpPos.z, blockName: 'noteblock' })
    const harp = onceWithCleanup(bot, 'noteHeard', { timeout: 5000, checkCondition: (b) => b.position.equals(harpPos) })
    await bot.test.setBlock({ x: harpPos.x + 1, y: g, z: harpPos.z, blockName: 'redstone_block' })
    const [, harpInstrument] = await harp
    assert.strictEqual(harpInstrument.name, 'harp')
  })

  it('blockActions: pistonMove push / pull with the Java direction', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const moves = collect(bot, 'pistonMove')
    try {
      // facing_direction 2 = Bedrock south (Java 3), pushed by a redstone block east of it
      const piston = new Vec3(-3, g, 2)
      await bot.test.setBlock({ x: piston.x, y: g, z: piston.z, blockName: 'piston ["facing_direction"=2]' })
      let push = onceWithCleanup(bot, 'pistonMove', { timeout: 5000, checkCondition: (b) => b.position.equals(piston) })
      await bot.test.setBlock({ x: piston.x - 1, y: g, z: piston.z, blockName: 'redstone_block' })
      let [block, isPulling, direction] = await push
      assert.strictEqual(block.name, 'piston')
      assert.strictEqual(isPulling, 0)
      assert.strictEqual(direction, 3, 'south')
      let pull = onceWithCleanup(bot, 'pistonMove', { timeout: 5000, checkCondition: (b) => b.position.equals(piston) })
      await bot.test.setBlock({ x: piston.x - 1, y: g, z: piston.z, blockName: 'air' })
      ;[block, isPulling, direction] = await pull
      assert.strictEqual(isPulling, 1)
      assert.strictEqual(direction, 3)

      // sticky piston facing_direction 4 = Bedrock east (Java 5)
      const sticky = new Vec3(-3, g, -2)
      await bot.test.setBlock({ x: sticky.x, y: g, z: sticky.z, blockName: 'sticky_piston ["facing_direction"=4]' })
      push = onceWithCleanup(bot, 'pistonMove', { timeout: 5000, checkCondition: (b) => b.position.equals(sticky) })
      await bot.test.setBlock({ x: sticky.x, y: g + 1, z: sticky.z, blockName: 'redstone_block' })
      ;[block, isPulling, direction] = await push
      assert.strictEqual(block.name, 'sticky_piston')
      assert.strictEqual(isPulling, 0)
      assert.strictEqual(direction, 5, 'east')
      pull = onceWithCleanup(bot, 'pistonMove', { timeout: 5000, checkCondition: (b) => b.position.equals(sticky) })
      await bot.test.setBlock({ x: sticky.x, y: g + 1, z: sticky.z, blockName: 'air' })
      ;[, isPulling] = await pull
      assert.strictEqual(isPulling, 1)
      // one event per push / pull (not per block entity update)
      assert.strictEqual(moves.seen.length, 4, JSON.stringify(moves.seen.map(([b, p, d]) => [b.position, p, d])))
    } finally {
      moves.stop()
    }
  })

  it('blockActions: chestLidMove when the bot opens and closes a chest and a double chest', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const lids = collect(bot, 'chestLidMove')
    try {
      const chest = new Vec3(2, g, -2)
      await bot.test.setBlock({ x: chest.x, y: chest.y, z: chest.z, blockName: 'chest' })
      async function openAndClose (pos) {
        const opened = onceWithCleanup(bot._client, 'container_open', { timeout: 5000 })
        const lidUp = onceWithCleanup(bot, 'chestLidMove', { timeout: 5000 })
        transactions.useItemOn(bot, { position: pos, face: 1 })
        const [window] = await opened
        const [block, isOpen, block2] = await lidUp
        const lidDown = onceWithCleanup(bot, 'chestLidMove', { timeout: 5000 })
        bot._client.queue('container_close', { window_id: window.window_id, window_type: window.window_type, server: false })
        const closed = await lidDown
        return { block, isOpen, block2, closed }
      }
      let r = await openAndClose(chest)
      assert.ok(r.block.position.equals(chest))
      assert.strictEqual(r.block.name, 'chest')
      assert.strictEqual(r.isOpen, 1)
      assert.strictEqual(r.block2, null, 'single chest')
      assert.strictEqual(r.closed[1], 0)

      // a double chest: the pair comes from the block entities (pairx / pairz)
      const left = new Vec3(4, g, -4)
      await bot.test.setBlock({ x: left.x, y: g, z: left.z, blockName: 'chest ["minecraft:cardinal_direction"="north"]' })
      const paired = onceWithCleanup(bot, 'blockEntityData', { timeout: 5000, checkCondition: (b) => b?.position.equals(left) && b.blockEntity?.pairx !== undefined })
      await bot.test.setBlock({ x: left.x + 1, y: g, z: left.z, blockName: 'chest ["minecraft:cardinal_direction"="north"]' })
      await paired
      r = await openAndClose(left)
      assert.strictEqual(r.isOpen, 1)
      assert.ok(r.block2, 'the other half')
      assert.strictEqual(r.block2.name, 'chest')
      assert.ok([left, left.offset(1, 0, 0)].some(p => p.equals(r.block.position)))
      assert.ok([left, left.offset(1, 0, 0)].some(p => p.equals(r.block2.position)))
      assert.ok(!r.block.position.equals(r.block2.position))
      assert.strictEqual(r.closed[1], 0)
      assert.strictEqual(lids.seen.length, 4, 'one event per lid change')
    } finally {
      lids.stop()
    }
  })

  it('blockActions: blockBreakProgressObserved / blockBreakProgressEnd when another player breaks a block', async () => {
    const { bot, server } = ctx
    const g = bot.test.groundY
    const target = new Vec3(4, g, 0)
    await bot.test.setBlock({ x: target.x, y: target.y, z: target.z, blockName: 'stone' })
    const { bot: breaker } = await createTestBot({ server, username: `breaker${process.pid % 1000}`, botOptions: { viewDistance: 'tiny' } })
    try {
      await breaker.test.teleport(new Vec3(2, g, 0))
      await breaker.test.becomeSurvival()
      await breaker.lookAt(target.offset(0.5, 0.5, 0.5), true)
      const stages = []
      const onStage = (block, stage, entity) => { if (block?.position.equals(target)) stages.push([stage, entity]) }
      bot.on('blockBreakProgressObserved', onStage)
      try {
        const started = onceWithCleanup(bot, 'blockBreakProgressObserved', { timeout: 5000, checkCondition: (b) => b?.position.equals(target) })
        breaker._bedrock.input.queueBlockAction({ action: 'start_break', position: target, face: 4 })
        const [block, stage, entity] = await started
        assert.strictEqual(block.name, 'stone')
        assert.strictEqual(stage, 0)
        if (implemented(bot.nearestEntity)) {
          assert.strictEqual(entity?.username, breaker.username, 'the nearest other player')
        } else {
          assert.strictEqual(entity, undefined, 'no player entities before U7')
        }
        // stone by hand: 7.5 s → a stage every ~0.75 s
        await onceWithCleanup(bot, 'blockBreakProgressObserved', { timeout: 5000, checkCondition: (b, s) => b?.position.equals(target) && s >= 2 })
        const ended = onceWithCleanup(bot, 'blockBreakProgressEnd', { timeout: 5000, checkCondition: (b) => b?.position.equals(target) })
        breaker._bedrock.input.queueBlockAction({ action: 'abort_break', position: target, face: 4 })
        const [endBlock] = await ended
        assert.strictEqual(endBlock.name, 'stone')
        const observed = stages.map(([s]) => s)
        assert.deepStrictEqual(observed, [...observed].sort((a, b) => a - b), `stages in order: ${observed}`)
        assert.ok(observed.length >= 3 && observed.every(s => s >= 0 && s <= 9), `${observed}`)
      } finally {
        bot.removeListener('blockBreakProgressObserved', onStage)
      }
    } finally {
      breaker.end('test done')
    }
  })
})
