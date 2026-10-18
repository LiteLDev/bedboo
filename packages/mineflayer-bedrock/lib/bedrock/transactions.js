// owner: U4 (core runtime)
'use strict'
const { stubAsync, stubSync } = require('./errors')

/**
 * inventory_transaction builders (legacy "use item" transactions — not item stack requests).
 *
 * Every transaction carries `held_item`, which must byte-for-byte equal the server's copy of the
 * held hotbar item; it comes from `bot._bedrock.heldNetworkItem()` (U4 mirrors raw inventory
 * packets; U8 replaces the provider with its inventory model).
 *
 * Contract (all return a Promise that resolves once the packet(s) are queued; none wait for
 * server confirmation — callers wait for block_update/inventory events themselves):
 * - `useItemOn(bot, { position, face, cursor?, hotbarSlot?, blockRuntimeId? })`
 *     click a block: wraps the `item_use` transaction (`click_block`) in
 *     player_action `start_item_use_on` / `stop_item_use_on` (placement, activateBlock, …)
 * - `useItem(bot, { hotbarSlot?, face? })`         `click_air` (eat/drink/throw/bow draw)
 * - `release(bot, { hotbarSlot? })`                `item_release` `release` (bow shoot, stop eating)
 * - `useOnEntity(bot, entity, { action: 'interact'|'attack', position? })`  `item_use_on_entity`
 * - `mouseOver(bot, entity, position?)`             interact packet `mouse_over_entity`
 */

module.exports = {
  useItemOn: stubAsync('U4', 'transactions.useItemOn', 2),
  useItem: stubAsync('U4', 'transactions.useItem', 2),
  release: stubAsync('U4', 'transactions.release', 2),
  useOnEntity: stubAsync('U4', 'transactions.useOnEntity', 3),
  mouseOver: stubSync('U4', 'transactions.mouseOver', 3)
}
