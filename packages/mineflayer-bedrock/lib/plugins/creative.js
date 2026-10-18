// owner: U8 (inventory, windows, creative & item use; flight delegates to U5's physics hook)
// Adapted from mineflayer 4.39.0 lib/plugins/creative.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): the setInventorySlot guards (same item → no-op, concurrent call on
// the same slot → error), clearInventory, startFlying/stopFlying (gravity) and the flyTo fallback are verbatim.
// Surface: bot.creative { setInventorySlot(slot, item, waitTimeout = 400), clearSlot(slot),
//   clearInventory(), flyTo(destination), startFlying(), stopFlying() }
// Bedrock: there is no set_creative_slot. An item is created by an item_stack_request in the player's inventory
//   screen: [destroy <old stack>,] craft_creative { item_id: the creative_content entry id } + place from
//   creative_output 50 into the slot; clearing = destroy. Only items of the server's creative inventory
//   (creative_content: base items and the listed NBT variants such as enchanted books) can be created; the
//   creative index is exposed as `bot._bedrock.creativeItems` ({ entryFor(item), entries, ready }).
//   Flight: bot._bedrock.physics.setFlying(on) / .flyTo(destination) (U5) when implemented.
'use strict'
const assert = require('assert')
const { Vec3 } = require('vec3')
const { sleep, once } = require('mineflayer/lib/promise_utils')
const { fromNetwork } = require('../bedrock/item')
const { isStub } = require('../bedrock/errors')

module.exports = inject

/** item NBT for matching creative entries: `Damage: 0` (every new tool) is ignored */
function nbtKey (item) {
  const value = item?.nbt?.value
  if (!value) return ''
  const keys = Object.keys(value).filter(k => !(k === 'Damage' && value[k]?.value === 0)).sort()
  if (keys.length === 0) return ''
  return JSON.stringify(keys.map(k => [k, value[k]]))
}

/** creative_content → `entryFor(item)` (`{ id: entry_id, item }`) */
function createCreativeIndex (bot) {
  let entries = []
  const byType = new Map()
  const index = {
    ready: false,
    get entries () { return entries },
    /** the creative entry that creates `item` (same type, metadata and NBT), or null */
    entryFor (item) {
      if (!item) return null
      const candidates = byType.get(item.type) ?? []
      const metadata = item.metadata ?? 0
      const key = nbtKey(item)
      return candidates.find(e => (e.item.metadata ?? 0) === metadata && nbtKey(e.item) === key) ?? null
    }
  }
  bot._client.on('creative_content', (packet) => {
    entries = []
    byType.clear()
    for (const entry of packet.items ?? []) {
      let item
      try {
        item = fromNetwork(bot.registry, { has_stack_id: false, ...entry.item })
      } catch {
        item = null
      }
      if (!item) continue
      const e = { id: entry.entry_id, item, group: entry.group_index }
      entries.push(e)
      if (!byType.has(item.type)) byType.set(item.type, [])
      byType.get(item.type).push(e)
    }
    index.ready = true
  })
  return index
}

function inject (bot) {
  const Item = require('prismarine-item')(bot.registry)
  bot._bedrock.creativeItems = createCreativeIndex(bot)

  // these features only work when you are in creative mode.
  bot.creative = {
    setInventorySlot,
    flyTo,
    startFlying,
    stopFlying,
    clearSlot: slotNum => setInventorySlot(slotNum, null),
    clearInventory
  }

  const creativeSlotsUpdates = []

  // WARN: This method should not be called twice on the same slot before first promise succeeds
  async function setInventorySlot (slot, item, waitTimeout = 400) {
    assert(slot >= 0 && slot <= 45)

    if (Item.equal(bot.inventory.slots[slot], item, true)) return
    if (creativeSlotsUpdates[slot]) {
      throw new Error(`Setting slot ${slot} cancelled due to calling bot.creative.setInventorySlot(${slot}, ...) again`)
    }
    creativeSlotsUpdates[slot] = true
    try {
      if (bot.currentWindow) {
        throw new Error('bot.creative.setInventorySlot: Bedrock creates creative items only in the inventory screen; close bot.currentWindow first')
      }
      const model = bot._bedrock.inventoryModel
      const key = model.keyOf(bot.inventory, slot)
      if (!key || key === 'out') throw new Error(`bot.creative.setInventorySlot: slot ${slot} cannot hold items`)
      if (item && !bot._bedrock.creativeItems.entryFor(item)) {
        throw new Error(`bot.creative.setInventorySlot: ${item.name}${item.nbt ? ' with this NBT' : ''} is not in the server's creative inventory`)
      }
      const current = model.read(key)
      const steps = []
      if (current) steps.push({ type: 'destroy', count: current.count, src: key })
      if (item) steps.push({ type: 'creative', item, count: item.count, dst: key })
      await model.execute(bot.inventory, steps)
    } catch (err) {
      if (err.name === 'StackRequestError') throw new Error(`Server rejected bot.creative.setInventorySlot(${slot}, ${item ? item.name : null}): ${err.message}`)
      throw err
    } finally {
      creativeSlotsUpdates[slot] = false
    }
  }

  async function clearInventory () {
    return Promise.all(bot.inventory.slots.filter(item => item).map(item => setInventorySlot(item.slot, null)))
  }

  let normalGravity = null
  const flyingSpeedPerUpdate = 0.5

  function physicsHook (name) {
    const physics = bot._bedrock.physics
    const fn = physics?.[name]
    return typeof fn === 'function' && !isStub(fn) ? (...args) => fn.apply(physics, args) : null
  }

  // straight line, so make sure there's a clear path.
  async function flyTo (destination) {
    const hook = physicsHook('flyTo')
    if (hook) {
      startFlying()
      return hook(destination)
    }
    // upstream fallback: move the position in small steps without gravity
    startFlying()

    let vector = destination.minus(bot.entity.position)
    let magnitude = vecMagnitude(vector)

    while (magnitude > flyingSpeedPerUpdate) {
      bot.physics.gravity = 0
      bot.entity.velocity = new Vec3(0, 0, 0)

      // small steps
      const normalizedVector = vector.scaled(1 / magnitude)
      bot.entity.position.add(normalizedVector.scaled(flyingSpeedPerUpdate))

      await sleep(50)

      vector = destination.minus(bot.entity.position)
      magnitude = vecMagnitude(vector)
    }

    // last step
    bot.entity.position = destination
    await once(bot, 'move', /* no timeout */ 0)
  }

  function startFlying () {
    if (normalGravity == null) normalGravity = bot.physics.gravity
    bot.physics.gravity = 0
    physicsHook('setFlying')?.(true)
  }

  function stopFlying () {
    if (normalGravity != null) bot.physics.gravity = normalGravity
    physicsHook('setFlying')?.(false)
  }
}

// this should be in the vector library
function vecMagnitude (vec) {
  return Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z)
}

module.exports.createCreativeIndex = createCreativeIndex
module.exports.nbtKey = nbtKey
