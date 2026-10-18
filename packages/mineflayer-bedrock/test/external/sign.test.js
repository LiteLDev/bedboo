// owner: U9 (wave 3: written, skipped until bot.placeBlock exists) → U11 (wave 4, the seed's owner of `sign`)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/sign.js: place a sign with bot.placeBlock (U11), wait for the editor,
 * updateSign, read signText. Two adaptations: Bedrock opens the editor with `open_sign { position, is_front }`
 * instead of Java's `open_sign_entity { location }`, and the sign item search skips the sign BLOCKS the Bedrock item
 * registry lists (`*_wall_sign`, `*_standing_sign`: no command gives them); everything else is verbatim.
 * The sign API itself (signOpen, updateSign front/back, blockEntityData, signText) is tested now, without
 * placeBlock, by blockEntities.test.js.
 */
const assert = require('assert')
const Vec3 = require('vec3')
const { useBot, implemented } = require('./common')

const upstream = () => async (bot) => {
  const Item = require('prismarine-item')(bot.registry)
  const lowerBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0))

  let signItem = null
  for (const name in bot.registry.itemsByName) {
    // Bedrock (adapted): the item registry also lists the sign BLOCKS (`*_wall_sign`, `*_standing_sign`), which no
    // command can give
    if (/(wall|standing)_sign$/.test(name)) continue
    if (name.includes('sign') && !name.includes('hanging')) signItem = bot.registry.itemsByName[name]
  }
  assert.notStrictEqual(signItem, null)

  const p = new Promise((resolve) => {
    // Bedrock (adapted): open_sign { position } instead of open_sign_entity { location }
    bot._client.once('open_sign', (packet) => {
      const sign = bot.blockAt(new Vec3(packet.position))
      bot.updateSign(sign, '1\n2\n3\n')

      setTimeout(() => {
        // Get updated sign
        const sign = bot.blockAt(bot.entity.position)

        assert.strictEqual(sign.signText.trimEnd(), '1\n2\n3')

        if (sign.blockEntity) {
          // Check block update
          bot.activateBlock(sign)
          assert.notStrictEqual(sign.blockEntity, undefined)
        }

        resolve()
      }, 500)
    })
  })

  await bot.lookAt(lowerBlock.position, true)
  await bot.test.setInventorySlot(36, new Item(signItem.id, 1, 0))
  await bot.placeBlock(lowerBlock, new Vec3(0, 1, 0))
  return p
}

describe('sign', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('sign', async function () {
    // needs bot.placeBlock (U11, wave 4) and bot.activateBlock (U8)
    if (!implemented(ctx.bot.placeBlock) || !implemented(ctx.bot.activateBlock)) this.skip()
    await upstream()(ctx.bot)
  })
})
