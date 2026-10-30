// owner: U4 (core runtime); BEDD-3: bedd-mode gates
'use strict'
const { Vec3 } = require('vec3')
const { EMPTY_NETWORK_ITEM } = require('./item')
const { feetToWire, FACE_VECTORS } = require('./conversions')

/**
 * inventory_transaction builders (legacy "use item" transactions — not item stack requests) and the
 * held-item provider.
 *
 * Every transaction carries `held_item`, which must equal the server's copy of the held hotbar item;
 * it comes from `bot._bedrock.heldNetworkItem()` (U4: `createHeldItemProvider` mirrors the raw
 * inventory packets; U8 replaces the provider with its inventory model).
 *
 * Contract (all return a Promise that resolves once the packet(s) are queued; none wait for
 * server confirmation — callers wait for block_update/inventory events themselves):
 * - `useItemOn(bot, { position, face, cursor?, hotbarSlot?, blockRuntimeId?, hand?, lifecycle?, stopDelay? })`
 *     click a block: the `item_use` transaction (`click_block`, trigger `player_input`, prediction `success`)
 *     wrapped in player_action `start_item_use_on` (position = clicked block, result_position = clicked
 *     block + face) and, `stopDelay` ms later (default 150), `stop_item_use_on` (position = the block in
 *     front of the face). `lifecycle: false` sends the bare click (container/button activation).
 *     `blockRuntimeId` defaults to the network runtime id of the clicked block in `bot.world`.
 * - `useItem(bot, { hotbarSlot?, hand? })`        `click_air` (eat/drink/throw/bow draw)
 * - `release(bot, { hotbarSlot? })`                `item_release` `release` (bow shoot, stop eating)
 * - `useOnEntity(bot, entity, { action: 'interact'|'attack', position?, hotbarSlot? })`  `item_use_on_entity`
 * - `mouseOver(bot, entity, position?)`             interact packet `mouse_over_entity` (sync)
 * The builders (`buildUseItemOn`, `buildUseItem`, `buildRelease`, `buildUseOnEntity`, `buildMouseOver`) return
 * the packet params without sending (unit-tested against bedrock-protocol's serializer).
 *
 * Sneak / sprint ordering (W3-FIX-A): `setControlState('sneak' | 'sprint')` reaches the server only with the next
 * player_auth_input (upstream sends it at once), so `useItemOn` and `useOnEntity` first wait for
 * `bot._bedrock.physics.controlsSent()` when a change is pending — a sneak-click on a chest places instead of
 * opening it. Nothing pending: the packets are queued synchronously, as before.
 *
 * Packet shapes after a real 1.26.51 client (notes from Pix3lPirat3/mineflayer feat/bedrock-edition-adapter,
 * lib/bedrock_plugins/interact.js, MIT — reference only): placement = start_item_use_on → item_use click_block
 * (hand, client_prediction 'success') → stop_item_use_on ~150 ms later; click_air uses trigger 'unknown',
 * face 255 and prediction 'failure'.
 *
 * bedd mode (`bot._bedrock.mode === 'bedd'`, BEDD-3): the real client owns player_action start/stop_item_use_on and
 * interact mouse_over_entity, so `useItemOn` sends only the transaction (the router turns it into look + use click) and
 * `mouseOver` sends nothing.
 */

const DEFAULT_STOP_DELAY_MS = 150
const ZERO = Object.freeze({ x: 0, y: 0, z: 0 })

const isBedd = (bot) => bot._bedrock?.mode === 'bedd'

const blockPos = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

function selfRuntimeId (bot) {
  return bot._bedrock?.ids?.selfRuntimeId() ?? 0n
}

function heldItem (bot) {
  const provider = bot._bedrock?.heldNetworkItem
  if (typeof provider !== 'function' || provider.notImplemented) return { ...EMPTY_NETWORK_ITEM }
  return provider() ?? { ...EMPTY_NETWORK_ITEM }
}

function hotbarSlot (bot, slot) {
  if (slot !== undefined && slot !== null) return slot
  if (typeof bot.quickBarSlot === 'number') return bot.quickBarSlot
  return bot._bedrock?.heldNetworkItem?.selectedSlot?.() ?? 0
}

/** Eye-level wire position of the bot (player_pos / head_pos of transactions). */
function eyePosition (bot) {
  return bot.entity ? feetToWire(bot.entity.position) : { ...ZERO }
}

function blockRuntimeIdAt (bot, position) {
  const block = bot.world?.getBlock?.(new Vec3(position.x, position.y, position.z))
  if (!block) return 0
  return bot.registry.runtimeIdByStateId?.[block.stateId] ?? block.hash ?? 0
}

function buildUseItemOn (bot, { position, face, cursor, hotbarSlot: slot, blockRuntimeId, hand = 'main_hand' }) {
  const bp = blockPos(position)
  const dir = FACE_VECTORS[face] ?? FACE_VECTORS[1]
  const clickPos = cursor
    ? { x: cursor.x, y: cursor.y, z: cursor.z }
    : { x: 0.5 + dir.x * 0.5, y: 0.5 + dir.y * 0.5, z: 0.5 + dir.z * 0.5 }
  const resultPosition = { x: bp.x + dir.x, y: bp.y + dir.y, z: bp.z + dir.z }
  return {
    start: { runtime_entity_id: selfRuntimeId(bot), action: 'start_item_use_on', position: bp, result_position: resultPosition, face },
    transaction: {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: 'item_use',
        actions: [],
        transaction_data: {
          action_type: 'click_block',
          trigger_type: 'player_input',
          block_position: bp,
          face,
          hotbar_slot: hotbarSlot(bot, slot),
          hand,
          held_item: heldItem(bot),
          player_pos: eyePosition(bot),
          click_pos: clickPos,
          block_runtime_id: blockRuntimeId ?? blockRuntimeIdAt(bot, bp),
          client_prediction: 'success',
          client_cooldown_state: 'off'
        }
      }
    },
    stop: { runtime_entity_id: selfRuntimeId(bot), action: 'stop_item_use_on', position: resultPosition, result_position: { ...ZERO }, face: 0 }
  }
}

function buildUseItem (bot, { hotbarSlot: slot, hand = 'main_hand' } = {}) {
  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use',
      actions: [],
      transaction_data: {
        action_type: 'click_air',
        trigger_type: 'unknown',
        block_position: { ...ZERO },
        face: 255,
        hotbar_slot: hotbarSlot(bot, slot),
        hand,
        held_item: heldItem(bot),
        player_pos: eyePosition(bot),
        click_pos: { ...ZERO },
        block_runtime_id: 0,
        client_prediction: 'failure',
        client_cooldown_state: 'off'
      }
    }
  }
}

function buildRelease (bot, { hotbarSlot: slot, action = 'release' } = {}) {
  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_release',
      actions: [],
      transaction_data: {
        action_type: action,
        hotbar_slot: hotbarSlot(bot, slot),
        held_item: heldItem(bot),
        head_pos: eyePosition(bot)
      }
    }
  }
}

function entityRuntimeId (entity) {
  const id = typeof entity === 'object' && entity !== null ? (entity.runtimeId ?? entity.id) : entity
  if (id === undefined || id === null) throw new TypeError('entity has no runtime id')
  return BigInt(id)
}

function buildUseOnEntity (bot, entity, { action = 'interact', position, hotbarSlot: slot } = {}) {
  if (action !== 'interact' && action !== 'attack') throw new TypeError(`useOnEntity: action must be 'interact' or 'attack', got ${action}`)
  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use_on_entity',
      actions: [],
      transaction_data: {
        entity_runtime_id: entityRuntimeId(entity),
        action_type: action,
        hotbar_slot: hotbarSlot(bot, slot),
        held_item: heldItem(bot),
        player_pos: eyePosition(bot),
        click_pos: position ? { x: position.x, y: position.y, z: position.z } : { ...ZERO }
      }
    }
  }
}

function buildMouseOver (bot, entity, position) {
  const packet = { action_id: 'mouse_over_entity', target_entity_id: entity === null || entity === undefined ? 0n : entityRuntimeId(entity), has_position: !!position }
  if (position) packet.position = { x: position.x, y: position.y, z: position.z }
  return packet
}

/**
 * Promise of the physics plugin's `controlsSent()` when a sneak / sprint change has not reached the server yet, else
 * null (the caller sends synchronously).
 */
function pendingControls (bot) {
  const physics = bot._bedrock?.physics
  if (typeof physics?.controlsPending !== 'function' || typeof physics.controlsSent !== 'function') return null
  return physics.controlsPending() ? physics.controlsSent() : null
}

/**
 * @returns {Promise<void>} resolves once start/transaction/stop are queued (stop after `stopDelay` ms)
 */
function useItemOn (bot, opts) {
  const pending = pendingControls(bot)
  return pending ? pending.then(() => sendUseItemOn(bot, opts)) : sendUseItemOn(bot, opts)
}

async function sendUseItemOn (bot, opts) {
  const { stopDelay = DEFAULT_STOP_DELAY_MS } = opts
  // bedd: the client sends start/stop_item_use_on itself around its own click
  const lifecycle = (opts.lifecycle ?? true) && !isBedd(bot)
  const { start, transaction, stop } = buildUseItemOn(bot, opts)
  if (lifecycle) bot._client.queue('player_action', start)
  bot._client.queue('inventory_transaction', transaction)
  if (!lifecycle) return
  if (stopDelay > 0) await new Promise(resolve => setTimeout(resolve, stopDelay))
  bot._client.queue('player_action', stop)
}

async function useItem (bot, opts) {
  bot._client.queue('inventory_transaction', buildUseItem(bot, opts ?? {}))
}

async function release (bot, opts) {
  bot._client.queue('inventory_transaction', buildRelease(bot, opts ?? {}))
}

async function useOnEntity (bot, entity, opts) {
  const pending = pendingControls(bot)
  if (pending) await pending
  bot._client.queue('inventory_transaction', buildUseOnEntity(bot, entity, opts ?? {}))
}

function mouseOver (bot, entity, position) {
  if (isBedd(bot)) return // client-owned: the client hovers what it looks at
  bot._client.queue('interact', buildMouseOver(bot, entity, position))
}

/**
 * U4's `bot._bedrock.heldNetworkItem` provider: mirrors the raw player inventory packets (the exact server
 * copy of each hotbar item) and the selected hotbar slot.
 * - `inventory_content` window `inventory` (what `/give`, `/replaceitem`, `/clear` produce) → all slots
 * - `inventory_slot` window `inventory` → one slot
 * - `player_hotbar` (window `inventory`) and the bot's own `mob_equipment` → selected slot (+ held item)
 * @returns {(() => object) & { selectedSlot: () => number, slot: (i: number) => object, slots: object[] }}
 */
function createHeldItemProvider (bot) {
  const slots = []
  let selected = 0
  const isSelf = (runtimeId) => !!bot._bedrock?.ids?.isSelf(runtimeId)
  const isInventory = (windowId) => windowId === 'inventory' || windowId === 0

  const provider = function heldNetworkItem () {
    return slots[selected] ?? { ...EMPTY_NETWORK_ITEM }
  }
  provider.slots = slots
  provider.selectedSlot = () => selected
  provider.slot = (i) => slots[i] ?? { ...EMPTY_NETWORK_ITEM }

  const client = bot._client
  client.on('inventory_content', (packet) => {
    if (!isInventory(packet.window_id)) return
    slots.length = 0
    for (const item of packet.input ?? []) slots.push(item)
  })
  client.on('inventory_slot', (packet) => {
    if (!isInventory(packet.window_id)) return
    slots[packet.slot] = packet.item
  })
  client.on('player_hotbar', (packet) => {
    if (packet.window_id !== undefined && !isInventory(packet.window_id)) return
    selected = packet.selected_slot
  })
  client.on('mob_equipment', (packet) => {
    if (!isSelf(packet.runtime_entity_id) || !isInventory(packet.window_id)) return
    selected = packet.selected_slot
    if (packet.item) slots[packet.selected_slot] = packet.item
  })
  return provider
}

module.exports = {
  isBedd,
  pendingControls,
  useItemOn,
  useItem,
  release,
  useOnEntity,
  mouseOver,
  buildUseItemOn,
  buildUseItem,
  buildRelease,
  buildUseOnEntity,
  buildMouseOver,
  createHeldItemProvider,
  DEFAULT_STOP_DELAY_MS
}
