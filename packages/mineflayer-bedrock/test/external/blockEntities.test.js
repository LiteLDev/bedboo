// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Block entities and signs against BDS 1.26.51.1 (Bedrock extra; the upstream `sign` test, which needs
 * bot.placeBlock, is ported in sign.test.js):
 * - a /setblock sign → block_entity_data → 'blockEntityData', block.blockEntity, signText '';
 * - the editor opened by interacting with the sign (BDS opens it for any unwaxed sign; one edit per opening) →
 *   'signOpen'; bot.updateSign front and back → the echoed block_entity_data → 'blockEntityData' + signText / getSignText();
 *   upstream's validation errors;
 * - a bot joining later reads the sign text from the sub-chunk payload's block entity NBT;
 * - a replaced block loses its block entity.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot, createTestBot } = require('./common')
const transactions = require('../../lib/bedrock/transactions')

describe('blockEntities', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('blockEntities: /setblock sign, signOpen on interaction, updateSign front + back, blockEntityData + signText', async () => {
    const { bot, server } = ctx
    const g = bot.test.groundY
    const pos = new Vec3(2, g, 1)
    const placed = onceWithCleanup(bot, 'blockEntityData', { timeout: 5000, checkCondition: (b) => b?.position.equals(pos) })
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'standing_sign' })
    const [fresh] = await placed
    assert.strictEqual(fresh.name, 'standing_sign')
    assert.strictEqual(fresh.signText, '')
    assert.deepStrictEqual(fresh.getSignText(), ['', ''])
    assert.strictEqual(fresh.blockEntity.id, 'Sign')

    const opened = onceWithCleanup(bot, 'signOpen', { timeout: 5000 })
    transactions.useItemOn(bot, { position: pos, face: 1 })
    const [sign] = await opened
    assert.ok(sign.position.equals(pos))
    assert.strictEqual(sign.name, 'standing_sign')

    let updated = onceWithCleanup(bot, 'blockEntityData', {
      timeout: 5000,
      checkCondition: (block) => block?.position?.equals(sign.position) && block.signText?.trimEnd() === '1\n2\n3'
    })
    bot.updateSign(sign, '1\n2\n3\n')
    await updated
    assert.strictEqual(bot.blockAt(pos).signText.trimEnd(), '1\n2\n3')
    assert.strictEqual(bot.blockAt(pos).blockEntity.FrontText.Text.trimEnd(), '1\n2\n3')

    // BDS ends the editing session with the edit: open the editor again for the back side
    const reopened = onceWithCleanup(bot, 'signOpen', { timeout: 5000 })
    transactions.useItemOn(bot, { position: pos, face: 1 })
    await reopened
    updated = onceWithCleanup(bot, 'blockEntityData', {
      timeout: 5000,
      checkCondition: (block) => block?.position?.equals(sign.position) && block.getSignText()[1] === 'back side'
    })
    bot.updateSign(bot.blockAt(pos), 'back side', true)
    await updated
    assert.deepStrictEqual(bot.blockAt(pos).getSignText().map(t => t.trimEnd()), ['1\n2\n3', 'back side'])

    // upstream's validation
    const errors = []
    const onError = (err) => errors.push(err.message)
    bot.on('error', onError)
    try {
      bot.updateSign(sign, '1\n2\n3\n4\n5')
      bot.updateSign(sign, 'x'.repeat(46))
    } finally {
      bot.removeListener('error', onError)
    }
    assert.deepStrictEqual(errors, ['too many lines for sign text', 'Signs have a maximum of 45 characters per line'])

    // a bot joining now reads the text from the sub-chunk's block entity NBT
    const { bot: other } = await createTestBot({ server, username: `signreader${process.pid % 1000}`, botOptions: { viewDistance: 'tiny' } })
    try {
      await other.waitForChunksToLoad()
      const seen = other.blockAt(pos)
      assert.strictEqual(seen.name, 'standing_sign')
      assert.deepStrictEqual(seen.getSignText().map(t => t.trimEnd()), ['1\n2\n3', 'back side'])
    } finally {
      other.end('test done')
    }

    // the sign's block entity goes away with the sign
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'air' })
    assert.strictEqual(bot.blockAt(pos).blockEntity, undefined)
    assert.strictEqual(bot.blockAt(pos).entity, undefined)
  })

  it('blockEntities: chest / command block entities, replaced by another block entity', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const pos = new Vec3(-2, g, 2)
    let got = onceWithCleanup(bot, 'blockEntityData', { timeout: 5000, checkCondition: (b) => b?.position.equals(pos) })
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'chest' })
    let [block] = await got
    assert.strictEqual(block.name, 'chest')
    assert.strictEqual(block.blockEntity.id, 'Chest')
    got = onceWithCleanup(bot, 'blockEntityData', { timeout: 5000, checkCondition: (b) => b?.position.equals(pos) })
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'command_block' })
    ;[block] = await got
    assert.strictEqual(block.name, 'command_block')
    assert.strictEqual(block.blockEntity.id, 'CommandBlock')
    assert.strictEqual(block.blockEntity.pairx, undefined, 'nothing left of the chest entity')
    // BDS sends the new block entity a second time one tick later: let it arrive before replacing the block
    await bot.test.wait(300)
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'stone' })
    assert.strictEqual(bot.blockAt(pos).blockEntity, undefined, 'no stale command block entity on the stone')
  })
})
