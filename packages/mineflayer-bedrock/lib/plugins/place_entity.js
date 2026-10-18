// owner: U11 (placing & placement-based parity)
// Upstream: mineflayer 4.39.0 lib/plugins/place_entity.js
// Surface: bot.placeEntity(referenceBlock, faceVector) → Promise<Entity>,
//   bot._placeEntityWithOptions(referenceBlock, faceVector, options)
// Events: 'entityPlaced' (entity)
// Bedrock: boats, minecarts, armor stands, spawn eggs, end crystals via useItemOn; the new entity
//   is matched from add_entity.
'use strict'
const { stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.placeEntity = stubAsync('U11', 'bot.placeEntity', 2)
  bot._placeEntityWithOptions = stubAsync('U11', 'bot._placeEntityWithOptions', 3)
}
