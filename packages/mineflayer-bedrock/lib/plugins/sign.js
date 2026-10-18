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

const SIDE_FIELDS = {
  IgnoreLighting: () => nbt.byte(0),
  HideGlowOutline: () => nbt.byte(0),
  PersistFormatting: () => nbt.byte(1),
  SignTextColor: () => nbt.int(-16777216),
  TextOwner: () => nbt.string(''),
  FilteredText: () => nbt.string('')
}

/** deep copy of an NBT tag (keeps bigint longs) */
function cloneTag (tag) {
  if (tag === null || typeof tag !== 'object') return tag
  if (Array.isArray(tag)) return tag.map(cloneTag)
  const out = {}
  for (const [key, value] of Object.entries(tag)) out[key] = cloneTag(value)
  return out
}

/** the block_entity_data compound for a sign whose `side` ('FrontText' | 'BackText') text becomes `text` */
function signNbt (current, position, side, text) {
  const tag = current?.type === 'compound' ? cloneTag(current) : nbt.comp({})
  const value = tag.value
  value.id ??= nbt.string('Sign')
  value.x = nbt.int(position.x)
  value.y = nbt.int(position.y)
  value.z = nbt.int(position.z)
  for (const name of ['FrontText', 'BackText']) {
    if (value[name]?.type !== 'compound') value[name] = nbt.comp({ Text: nbt.string('') })
    for (const [key, make] of Object.entries(SIDE_FIELDS)) {
      if (!(key in value[name].value)) value[name].value[key] = make()
    }
    if (!('Text' in value[name].value)) value[name].value.Text = nbt.string('')
  }
  value[side].value.Text = nbt.string(text)
  return tag
}

function inject (bot) {
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
    const current = bot.blockAt(position)?.entity ?? block.entity
    bot._client.queue('block_entity_data', {
      position: { x: position.x, y: position.y, z: position.z },
      nbt: signNbt(current, position, back ? 'BackText' : 'FrontText', text)
    })
  }
}

module.exports.signNbt = signNbt
