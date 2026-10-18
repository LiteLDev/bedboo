// owner: U4 (wave 2, core world) → U9 (wave 3, extras: dimension reset, block entities API)
// Upstream: mineflayer 4.39.0 lib/plugins/blocks.js (bot.updateSign lives in sign.js here)
// Surface: bot.world (prismarine-world WorldSync), bot.blockAt(point, extraInfos = true),
//   bot.findBlocks(options), bot.findBlock(options), bot.canSeeBlock(block),
//   bot.waitForChunksToLoad(), bot._updateBlockState(point, stateId), bot._getDimensionName()
// Events: 'blockUpdate' (old, new), 'blockUpdate:(x, y, z)', 'chunkColumnLoad' (point),
//   'chunkColumnUnload' (point), 'blockEntityData' (block) [U9]
// Bedrock: level_chunk (sub-chunk request mode: `highest_subchunk_count` present) → subchunk_request
//   → subchunk; update_block (layers), update_subchunk_blocks, network_chunk_publisher_update
//   (unload outside radius), block_entity_data.
'use strict'
const { stubSync, stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  const World = require('prismarine-world')(bot.registry)
  // Upstream creates the world on login; an empty world is harmless until U4 wires chunks.
  bot.world = new World(null).sync

  bot.blockAt = stubSync('U4', 'bot.blockAt', 1)
  bot.findBlocks = stubSync('U4', 'bot.findBlocks', 1)
  bot.findBlock = stubSync('U4', 'bot.findBlock', 1)
  bot.canSeeBlock = stubSync('U4', 'bot.canSeeBlock', 1)
  bot.waitForChunksToLoad = stubAsync('U4', 'bot.waitForChunksToLoad', 0)
  bot._updateBlockState = stubSync('U4', 'bot._updateBlockState', 2)
  bot._getDimensionName = stubSync('U4', 'bot._getDimensionName', 0)
}
