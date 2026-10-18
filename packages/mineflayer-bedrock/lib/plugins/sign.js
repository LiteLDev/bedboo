// owner: U9 (player state, world extras & dimensions)
// Adapted from mineflayer 4.39.0 lib/plugins/blocks.js (MIT, Copyright (c) 2013 Andrew Kelley): bot.updateSign
//   (same validation and errors) and 'signOpen'; split into its own plugin file so blocks.js (world core) and sign
//   editing have separate owners.
// Surface: bot.updateSign(block, text, back = false); block.signText / getSignText() via prismarine-block (Bedrock
//   FrontText/BackText, patched by U9)
// Events: 'signOpen' (block)
// Bedrock (BDS 1.26.51.1, observed live; docs/differences/U9.md#signs):
// - open_sign { position, is_front } → 'signOpen' (bot.blockAt(position)). BDS opens the editor when the player
//   places a sign or interacts with an unwaxed sign (inventory_transaction click_block).
// - edits are block_entity_data { position, nbt } with the whole sign compound: `FrontText` / `BackText`
//   compounds whose `Text` holds every line joined with '\n' (one string per side, no per-line fields), plus the
//   sign's other fields (id 'Sign', x/y/z, IsWaxed, …) taken from the current block entity. The server accepts it
//   from the player editing the sign and answers with the stored block_entity_data → blocks.js 'blockEntityData'.
'use strict'
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')

module.exports = inject

/** deep copy of an NBT tag (keeps bigint longs) */
function cloneTag (tag) {
  if (tag === null || typeof tag !== 'object') return tag
  if (Array.isArray(tag)) return tag.map(cloneTag)
  const out = {}
  for (const [key, value] of Object.entries(tag)) out[key] = cloneTag(value)
  return out
}

/**
 * The block_entity_data compound for `block` (a sign) whose front (or back) text becomes `text`: a copy of its
 * current block entity, both sides filled in by prismarine-block's Bedrock sign helpers (FrontText / BackText with
 * their style fields), the position set.
 */
function signNbt (Block, block, current, position, text, back) {
  // (prismarine-block adds the sign helpers to sign blocks only: any other block is edited as a standing sign)
  const isSign = typeof block?.name === 'string' && block.name.includes('sign')
  const sign = Block.fromStateId(isSign ? block.stateId : Block.fromProperties('standing_sign', {}, 0).stateId, 0)
  sign.entity = current?.type === 'compound' ? cloneTag(current) : nbt.comp({ id: nbt.string('Sign') })
  const [front, backText] = sign.getSignText()
  sign.setSignText(back ? front : text, back ? text : backText)
  Object.assign(sign.entity.value, { x: nbt.int(position.x), y: nbt.int(position.y), z: nbt.int(position.z) })
  return sign.entity
}

function inject (bot) {
  const Block = require('prismarine-block')(bot.registry)

  bot._client.on('open_sign', (packet) => {
    const pos = new Vec3(packet.position.x, packet.position.y, packet.position.z)
    bot.emit('signOpen', bot.blockAt(pos))
  })

  bot.updateSign = (block, text, back = false) => {
    const lines = text.split('\n')
    if (lines.length > 4) {
      bot.emit('error', new Error('too many lines for sign text'))
      return
    }

    for (let i = 0; i < lines.length; ++i) {
      if (lines[i].length > 45) {
        bot.emit('error', new Error('Signs have a maximum of 45 characters per line'))
        return
      }
    }

    const position = new Vec3(Math.floor(block.position.x), Math.floor(block.position.y), Math.floor(block.position.z))
    const target = bot.blockAt(position) ?? block
    bot._client.queue('block_entity_data', {
      position: { x: position.x, y: position.y, z: position.z },
      nbt: signNbt(Block, target, target.entity ?? block.entity, position, text, back)
    })
  }
}

module.exports.signNbt = signNbt
