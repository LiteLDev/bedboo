// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/commandBlock.js — ADAPTED (docs/differences/U9.md#command-block):
 * - confirmation: a Java server answers the command block update with an `advMode.setCommand.success` chat message;
 *   BDS prints nothing and sends the command block's block entity back instead (block_entity_data with the new
 *   `Command` → 'blockEntityData'), which is what the port waits for;
 * - position: (1, 5, 1) is 65 blocks above the bot on the -60 flat world, and BDS ignores command_block_update for
 *   a block out of the player's reach (Java does not check): the block is 5 blocks above the ground instead.
 * The setblock + setCommandBlock(pos, command, false) calls are verbatim.
 * Extra Bedrock check: options (mode, alwaysActive, trackOutput) reach the block entity, and the command runs when
 * the block is powered.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { once, onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

const upstream = () => async (bot) => {
  const command = `/say ${Math.floor(Math.random() * 1000)}`
  // Bedrock (adapted): within reach of the bot (BDS ignores edits of far command blocks)
  const commandBlockPos = new Vec3(1, bot.test.groundY + 5, 1)
  const commandBlockPosText = commandBlockPos.toArray().join(' ')

  // Put and activate the command block
  const p = once(bot.world, `blockUpdate:(${commandBlockPos.x}, ${commandBlockPos.y}, ${commandBlockPos.z})`)
  bot.test.sayEverywhere(`/setblock ${commandBlockPosText} minecraft:command_block`)
  await p
  // Bedrock (adapted): the confirmation is the block entity, armed before the update
  const updated = onceWithCleanup(bot, 'blockEntityData', {
    timeout: 5000,
    checkCondition: (block) => block?.position.equals(commandBlockPos) && block.blockEntity?.Command === command
  })
  bot.setCommandBlock(commandBlockPos, command, false)

  const [block] = await updated
  assert.strictEqual(block.name, 'command_block')
  assert.strictEqual(bot.blockAt(commandBlockPos).blockEntity.Command, command)
  return command
}

describe('commandBlock', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('commandBlock', async () => {
    const { bot, server } = ctx
    try {
      await upstream()(bot)
    } finally {
      await server.commandOutput(`setblock 1 ${bot.test.groundY + 5} 1 air`)
    }
  })

  it('commandBlock: options reach the block entity, the command runs when powered (Bedrock extra)', async () => {
    const { bot } = ctx
    const pos = new Vec3(2, bot.test.groundY, 2)
    try {
      await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'command_block' })
      assert.throws(() => bot.setCommandBlock(pos.offset(1, 0, 0), '/say no', {}), /isn't a command block/)

      let updated = onceWithCleanup(bot, 'blockEntityData', { timeout: 5000, checkCondition: (b) => b?.position.equals(pos) && b.blockEntity?.Command === '/say tracked' })
      bot.setCommandBlock(pos, '/say tracked', { mode: 1, alwaysActive: true, trackOutput: true, conditional: true })
      let [block] = await updated
      // Bedrock: the mode is the block (repeat → repeating_command_block), alwaysActive = `auto`
      assert.strictEqual(block.name, 'repeating_command_block')
      assert.strictEqual(block.blockEntity.auto, 1)
      assert.strictEqual(block.blockEntity.conditionalMode, 1)
      assert.strictEqual(block.blockEntity.TrackOutput, 1)

      const word = `cb${Math.floor(Math.random() * 1e6)}`
      updated = onceWithCleanup(bot, 'blockEntityData', { timeout: 5000, checkCondition: (b) => b?.position.equals(pos) && b.blockEntity?.Command === `/say ${word}` })
      bot.setCommandBlock(pos, `/say ${word}`) // defaults: impulse (command_block), needs redstone, no output
      ;[block] = await updated
      assert.strictEqual(block.name, 'command_block')
      assert.strictEqual(block.blockEntity.auto, 0)
      assert.strictEqual(block.blockEntity.conditionalMode, 0)
      assert.strictEqual(block.blockEntity.TrackOutput, 0)

      const said = onceWithCleanup(bot._client, 'text', { timeout: 10000, checkCondition: (p) => JSON.stringify(p).includes(word) })
      await bot.test.setBlock({ x: pos.x + 1, y: pos.y, z: pos.z, blockName: 'redstone_block' })
      await said
    } finally {
      await bot.test.becomeCreative()
    }

    // creative mode is required, like upstream
    await bot.test.becomeSurvival()
    try {
      assert.throws(() => bot.setCommandBlock(pos, '/say x', {}), /creative mode/)
    } finally {
      await bot.test.becomeCreative()
    }
  })
})
