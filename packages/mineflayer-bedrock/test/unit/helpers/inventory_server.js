// owner: U8 (inventory, windows, creative & item use) — shared by the U8 unit tests (free to reuse by later units)
'use strict'
/**
 * A tiny server-side responder for a fake bedrock-protocol client (test/unit/helpers/fake.js): answers what BDS
 * 1.26.51.1 answers to the inventory packets of the bot, as observed on a real server:
 * - `interact open_inventory`           → container_open { window_type: 'inventory', window_id: <next id> }
 * - `container_close` (client)          → container_close echo { window_type: 'none', server: false }
 * - `item_stack_request`                → item_stack_response: `ok` with the resulting count + a new stack id for
 *   every slot the request touched (from the bot's own prediction), or `{ status: <code> }` when `reject(code)`
 *   was armed for the next request.
 * - `inventory_transaction inventory_mismatch` → inventory_content of the inventory (the model's state, or
 *   `server.truth`), armor, ui and off-hand (`server.resyncs` counts them; `server.ignoreResync`: no answer).
 * Packets are answered asynchronously (setImmediate), like a network round trip.
 *
 *   const server = serveInventory(bot, client)
 *   server.reject(50)                 // the next item stack request fails with status 50
 *   server.requests                   // every request seen
 *   server.hold = true                // keep responses until server.flush()
 *   server.ignoreRequests = true      // never answer item stack requests (timeouts)
 */
const { windowIdOf } = require('../../../lib/bedrock/inventory_model')
const { toNetwork } = require('../../../lib/bedrock/item')

function serveInventory (bot, client, { firstWindowId = 2 } = {}) {
  let nextWindowId = firstWindowId
  let nextStackId = 1000
  const rejections = []
  const held = []
  const server = {
    requests: [],
    hold: false,
    ignoreRequests: false,
    reject (status = 50) { rejections.push(status) },
    flush () { for (const fn of held.splice(0)) fn() },
    openWindow (packet) {
      const id = packet.window_id ?? nextWindowId++
      client.receive('container_open', { window_id: id, window_type: 'container', coordinates: { x: 0, y: 0, z: 0 }, runtime_entity_id: -1n, ...packet })
      return id
    }
  }
  const later = (fn) => {
    if (server.hold) held.push(fn)
    else setImmediate(fn)
  }

  /** the answer, computed when the request arrives (from the bot's prediction, like the server's own result) */
  function respond (request) {
    const status = rejections.shift()
    if (status !== undefined) {
      return { responses: [{ status, request_id: request.request_id }] }
    }
    const model = bot._bedrock.inventoryModel
    const containers = new Map()
    for (const action of request.actions) {
      for (const info of [action.source, action.destination]) {
        if (!info || info.slot_type.container_id === 'creative_output') continue
        const id = info.slot_type.container_id
        if (!containers.has(id)) containers.set(id, new Map())
        const key = model.keyOfResponse(id, info.slot)
        const item = key ? model.read(key) : null
        const slot = { slot: info.slot, hotbar_slot: info.slot, count: item ? item.count : 0, custom_name: '', filtered_custom_name: '', durability_correction: 0 }
        if (item) slot.item_stack_id = item.stackId > 0 ? item.stackId : nextStackId++
        containers.get(id).set(info.slot, slot)
      }
    }
    return {
      responses: [{
        status: 'ok',
        request_id: request.request_id,
        containers: [...containers].map(([id, slots]) => ({ slot_type: { container_id: id }, slots: [...slots.values()] }))
      }]
    }
  }

  const queue = client.queue
  client.queue = (name, params) => {
    queue(name, params)
    if (name === 'interact' && params.action_id === 'open_inventory') {
      later(() => client.receive('container_open', { window_id: nextWindowId++, window_type: 'inventory', coordinates: { x: 0, y: -59, z: 0 }, runtime_entity_id: -1n }))
    } else if (name === 'container_close') {
      later(() => client.receive('container_close', { window_id: windowIdOf(params.window_id), window_type: 'none', server: false }))
    } else if (name === 'item_stack_request') {
      for (const request of params.requests) {
        server.requests.push(request)
        if (server.ignoreRequests) continue
        const answer = respond(request)
        later(() => client.receive('item_stack_response', answer))
      }
    } else if (name === 'inventory_transaction' && params?.transaction?.transaction_type === 'inventory_mismatch') {
      // BDS resends the player's inventory (POLISH-LIB): the inventory window's content, then armor / ui / off-hand —
      // the state when the request arrives (here: the model's, predictions included), or `server.truth`
      // ({ bedrockSlot: [name, count, stackId] }) for the inventory window
      server.resyncs++
      if (server.ignoreResync) return
      const model = bot._bedrock.inventoryModel
      const wire = (key) => {
        const item = model.read(key)
        return item ? toNetwork(bot.registry, item, { stackId: item.stackId }) : wireItem(bot, null)
      }
      const input = Array.from({ length: 36 }, (_, i) => {
        if (!server.truth) return wire(`p:${i}`)
        const t = server.truth[i]
        return t ? wireItem(bot, t[0], t[1], t[2]) : wireItem(bot, null)
      })
      const others = [['armor', 4], ['ui', 54], ['offhand', 1]].map(([window, size]) => [window, Array.from({ length: size }, (_, i) =>
        wire(window === 'armor' ? `a:${i}` : window === 'offhand' ? 'o' : i === 0 ? 'c' : `u:${i}`))])
      later(() => {
        const content = (window, items) => client.receive('inventory_content', { window_id: window, input: items, container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
        content('inventory', input)
        for (const [window, items] of others) content(window, items)
      })
    }
  }
  server.resyncs = 0
  return server
}

/** an ItemV4 wire item (network id of `name` in the bot's registry) */
function wireItem (bot, name, count = 1, stackId = undefined, extra = {}) {
  if (!name) return { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 }
  const def = bot.registry.itemsByName[name]
  if (!def) throw new Error(`no item ${name}`)
  const item = { network_id: def.id, count, metadata: 0, has_stack_id: stackId !== undefined, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [], ...extra } }
  if (stackId !== undefined) item.stack_id = stackId
  return item
}

/** inventory_content for the player inventory window from `{ bedrockSlot: [name, count] }` */
function inventoryContent (bot, slots, { window = 'inventory', size = 36, firstStackId = 1 } = {}) {
  let stackId = firstStackId
  const input = Array.from({ length: size }, (_, i) => slots[i] ? wireItem(bot, slots[i][0], slots[i][1], stackId++) : wireItem(bot, null))
  return { window_id: window, input, container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

module.exports = { serveInventory, wireItem, inventoryContent, tick }
