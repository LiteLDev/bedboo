// owner: U8 (inventory, windows, creative & item use)
// Adapted from mineflayer 4.39.0 lib/plugins/inventory.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): putSelectedItemRange, transfer, extendWindow (deposit/withdraw/close),
// openBlock/openEntity, putAway, moveSlotItem, consume, updateHeldItem, _setSlot and the heldItemChanged / eating
// bookkeeping are kept verbatim; the packet layer is Bedrock (see below).
// Surface: bot.inventory (prismarine-windows Window, Java 46-slot player layout), bot.currentWindow,
//   bot.quickBarSlot, bot.heldItem (getter), bot.usingHeldItem, bot.entity.equipment (getter, set on spawn),
//   bot.activateBlock(block, direction, cursorPos), bot.activateEntity(entity),
//   bot.activateEntityAt(entity, position), bot.consume(), bot.activateItem(offHand = false),
//   bot.deactivateItem(), bot.clickWindow(slot, mouseButton, mode), bot.putSelectedItemRange(start, end,
//   window, slot), bot.putAway(slot), bot.closeWindow(window), bot.transfer(options),
//   bot.openBlock(block, direction, cursorPos), bot.openEntity(entity), bot.moveSlotItem(source, dest),
//   bot.updateHeldItem(), bot._setSlot(slot, item, window), bot._syncWindow(window)
// Events: 'windowOpen' (window), 'windowClose' (window), 'heldItemChanged' (item),
//   window 'updateSlot' / 'updateSlot:<n>' (slot, oldItem, newItem), window 'close'
// Bedrock:
// - model: lib/bedrock/inventory_model.js (`bot._bedrock.inventoryModel`) mirrors inventory_content /
//   inventory_slot of the inventory (0), armor (120), off-hand (119), ui (124: cursor + crafting/station slots)
//   and open container windows into the Java-layout windows; one shared cursor = `selectedItem`.
// - clickWindow: lib/bedrock/click.js plans the Java click (modes 0-4) as item stack request steps; the model
//   predicts it, sends one item_stack_request (lib/bedrock/stack_request.js) and waits for the response
//   (rejected → rolled back + "Server rejected transaction …"). Clicks on bot.inventory open the player's
//   inventory screen (interact open_inventory) and close it again when idle (BDS rejects cursor moves without it).
// - container_open { window_id, window_type, coordinates, runtime_entity_id } + inventory_content → a window built
//   from the registry (lib/bedrock/windows.js, `bot._bedrock.windows`) → windowOpen; container_close
//   { window_id, window_type, server: false } closes (the server echoes it; a carried item is first put back
//   into the inventory, which BDS does not do by itself).
// - held item: player_hotbar (server) / mob_equipment (setQuickBarSlot); `bot._bedrock.heldNetworkItem()` is the
//   exact wire item of the held slot from this model (replaces U4's raw provider).
// - item use: inventory_transaction item_use click_air (lib/bedrock/transactions.js) + completed_using_item;
//   deactivate = item_release; a shield is raised by sneaking (Bedrock), see docs/differences/U8.md.
'use strict'
const assert = require('assert')
const { Vec3 } = require('vec3')
const { once, sleep, createDoneTask, createTask, withTimeout } = require('mineflayer/lib/promise_utils')
const tx = require('../bedrock/transactions')
const slots = require('../bedrock/slots')
const { toNetwork } = require('../bedrock/item')
const { createInventoryModel, windowIdOf } = require('../bedrock/inventory_model')
const { windowKey, containerSize, PLAYER_INVENTORY } = require('../bedrock/windows')
const { planClick } = require('../bedrock/click')
const { isStub } = require('../bedrock/errors')

module.exports = inject

// ms to wait before clicking on a tool so the server can send the new
// damage information
const DIG_CLICK_TIMEOUT = 500
// The number of milliseconds to wait for the server to respond with consume completion.
// Bedrock eating takes 32 ticks (1.6 s) like Java; the server answers with completed_using_item.
const CONSUME_TIMEOUT = 2500
// milliseconds to wait for the server to respond to a window click (item stack request)
const WINDOW_TIMEOUT = 5000
// milliseconds to wait for a container's inventory_content after its container_open
const CONTENT_TIMEOUT = 1000

const ALWAYS_CONSUMABLES = [
  'potion',
  'milk_bucket',
  'enchanted_golden_apple',
  'golden_apple'
]

function inject (bot) {
  const Item = require('prismarine-item')(bot.registry)
  const windows = require('prismarine-windows')(bot.registry)
  const model = createInventoryModel(bot, { Item, Window: windows.Window })
  bot._bedrock.inventoryModel = model

  let eatingTask = createDoneTask()
  // the window we closed last (the server echoes container_close; later units may inspect it)
  let lastClosedWindow = null
  // a container_open waiting for its inventory_content: { id, packet, key, spec }
  let pendingOpen = null
  // echo of the last container_close we sent (openBlock waits for it before opening another container)
  let closing = Promise.resolve()
  // activateItem(true/false) raised a shield by sneaking
  let shieldRaised = false

  // 0-8, null = uninitialized
  // which quick bar slot is selected
  bot.quickBarSlot = null
  // Java 1.9+ player window: 46 slots (45 = off-hand). Built directly: prismarine-windows sizes its legacy
  // `minecraft:inventory` from minecraft-data's Bedrock `shieldSlot` feature (unset → 45 slots).
  bot.inventory = model.shareCursor(new windows.Window(0, 'minecraft:inventory', 'Inventory', 46, { start: 9, end: 44 }, 0, true))
  Object.defineProperty(bot.inventory, 'bedrock', {
    enumerable: false,
    configurable: true,
    value: { key: 'inventory', spec: PLAYER_INVENTORY, slotMap: PLAYER_INVENTORY.slotMap, size: 9, id: 0, windowType: 'inventory' }
  })
  bot.currentWindow = null
  bot.usingHeldItem = false

  Object.defineProperty(bot, 'heldItem', {
    get: function () {
      return bot.inventory.slots[bot.QUICK_BAR_START + bot.quickBarSlot]
    }
  })

  // the exact server copy of the held item for inventory_transaction held_item (contract: U4 → U8)
  const heldNetworkItem = function heldNetworkItem () {
    return toNetwork(bot.registry, bot.heldItem ?? null)
  }
  heldNetworkItem.selectedSlot = () => bot.quickBarSlot ?? 0
  heldNetworkItem.slot = (i) => toNetwork(bot.registry, model.read(`p:${i}`))
  heldNetworkItem.offhand = () => toNetwork(bot.registry, bot.inventory.slots[45] ?? null)
  Object.defineProperty(heldNetworkItem, 'slots', { get: () => Array.from({ length: 36 }, (_, i) => heldNetworkItem.slot(i)) })
  bot._bedrock.heldNetworkItem = heldNetworkItem

  bot.on('spawn', () => {
    Object.defineProperty(bot.entity, 'equipment', {
      configurable: true,
      enumerable: true,
      get: function () {
        return [bot.heldItem, bot.inventory.slots[45], bot.inventory.slots[8],
          bot.inventory.slots[7], bot.inventory.slots[6], bot.inventory.slots[5]]
      }
    })
  })

  const isSelf = (runtimeId) => !!bot._bedrock.ids?.isSelf?.(runtimeId)

  // Bedrock: the server reports a finished use (eat/drink) with completed_using_item (Java: entity_status 9)
  bot._client.on('completed_using_item', () => {
    if (!eatingTask.done) {
      eatingTask.finish()
    }
    bot.usingHeldItem = false
  })

  let previousHeldItem = null
  bot.on('heldItemChanged', (heldItem) => {
    // we only disable the item if the item type or count changes
    if (
      heldItem?.type === previousHeldItem?.type && heldItem?.count === previousHeldItem?.count
    ) {
      previousHeldItem = heldItem
      return
    }
    if (!eatingTask.done) {
      eatingTask.finish()
    }
    bot.usingHeldItem = false
  })

  // Java's set_cooldown has no Bedrock counterpart: item cooldowns are client side (the client announces them with
  // client_start_item_cooldown); completed_using_item and heldItemChanged end a use.

  async function consume () {
    if (!eatingTask.done) {
      eatingTask.cancel(new Error('Consuming cancelled due to calling bot.consume() again'))
    }

    if (bot.game.gameMode !== 'creative' && !ALWAYS_CONSUMABLES.includes(bot.heldItem.name) && bot.food === 20) {
      throw new Error('Food is full')
    }

    eatingTask = createTask()

    activateItem()

    await withTimeout(eatingTask.promise, CONSUME_TIMEOUT)
  }

  function raiseShield (on) {
    shieldRaised = on
    if (typeof bot.setControlState === 'function' && !isStub(bot.setControlState)) bot.setControlState('sneak', on)
    else bot._bedrock.input.hold('sneaking', on)
  }

  function activateItem (offHand = false) {
    bot.usingHeldItem = true
    // a use from the inventory screen is not possible: close it (queued before the transaction)
    if (model.screen.isOpen()) model.screen.close().catch(() => {})
    const item = offHand ? bot.inventory.slots[45] : bot.heldItem
    if (item?.name === 'shield') {
      // Bedrock has no "use" for shields: a player blocks while sneaking with a shield in either hand
      raiseShield(true)
      return
    }
    const packet = tx.buildUseItem(bot, { hand: offHand ? 'off_hand' : 'main_hand' })
    if (offHand) packet.transaction.transaction_data.held_item = heldNetworkItem.offhand()
    bot._client.queue('inventory_transaction', packet)
  }

  function deactivateItem () {
    if (shieldRaised) {
      raiseShield(false)
    } else {
      bot._client.queue('inventory_transaction', tx.buildRelease(bot))
    }

    bot.usingHeldItem = false
  }

  async function putSelectedItemRange (start, end, window, slot) {
    // put the selected item back indow the slot range in window

    // try to put it in an item that already exists and just increase
    // the count.

    while (window.selectedItem) {
      const item = window.findItemRange(start, end, window.selectedItem.type, window.selectedItem.metadata, true, window.selectedItem.nbt)

      if (item && item.stackSize !== item.count) { // something to join with
        await clickWindow(item.slot, 0, 0)
      } else { // nothing to join with
        const emptySlot = window.firstEmptySlotRange(start, end)
        if (emptySlot === null) { // no room left
          if (slot === null) { // no room => drop it
            await tossLeftover()
          } else { // if there is still some leftover and slot is not null, click slot
            await clickWindow(slot, 0, 0)
            await tossLeftover()
          }
        } else {
          await clickWindow(emptySlot, 0, 0)
        }
      }
    }

    async function tossLeftover () {
      if (window.selectedItem) {
        await clickWindow(-999, 0, 0)
      }
    }
  }

  async function prepareInteraction () {
    await closing
    await model.screen.close()
  }

  async function activateBlock (block, direction, cursorPos) {
    direction = direction ?? new Vec3(0, 1, 0)
    const directionNum = vectorToDirection(direction) // The packet needs a number as the direction
    cursorPos = cursorPos ?? new Vec3(0.5, 0.5, 0.5)
    await prepareInteraction()
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), false)
    // Bedrock: item_use click_block (no start/stop_item_use_on: that wraps placements only)
    await tx.useItemOn(bot, {
      position: block.position,
      face: directionNum,
      cursor: { x: cursorPos.x, y: cursorPos.y, z: cursorPos.z },
      lifecycle: false
    })

    // swing arm animation
    if (typeof bot.swingArm === 'function' && !isStub(bot.swingArm)) bot.swingArm()
  }

  async function activateEntity (entity) {
    await prepareInteraction()
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(entity.position.offset(0, 1, 0), false)
    tx.mouseOver(bot, entity)
    await tx.useOnEntity(bot, entity, { action: 'interact' })
  }

  async function activateEntityAt (entity, position) {
    await prepareInteraction()
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(position, false)
    const at = position.minus(entity.position)
    tx.mouseOver(bot, entity, at)
    await tx.useOnEntity(bot, entity, { action: 'interact', position: at })
  }

  async function transfer (options) {
    const window = options.window || bot.currentWindow || bot.inventory
    const itemType = options.itemType
    const metadata = options.metadata
    const nbt = options.nbt
    let count = (options.count === undefined || options.count === null) ? 1 : options.count
    let firstSourceSlot = null

    // ranges
    const sourceStart = options.sourceStart
    const destStart = options.destStart
    assert.notStrictEqual(sourceStart, null)
    assert.notStrictEqual(destStart, null)
    const sourceEnd = options.sourceEnd === null ? sourceStart + 1 : options.sourceEnd
    const destEnd = options.destEnd === null ? destStart + 1 : options.destEnd

    await transferOne()

    async function transferOne () {
      if (count === 0) {
        await putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot)
        return
      }
      if (!window.selectedItem || window.selectedItem.type !== itemType ||
        (metadata != null && window.selectedItem.metadata !== metadata) ||
        (nbt != null && window.selectedItem.nbt !== nbt)) {
        // we are not holding the item we need. click it.
        const sourceItem = window.findItemRange(sourceStart, sourceEnd, itemType, metadata, false, nbt)
        const mcDataEntry = bot.registry.itemsArray.find(x => x.id === itemType)
        assert(mcDataEntry, 'Invalid itemType')
        if (!sourceItem) throw new Error(`Can't find ${mcDataEntry.name} in slots [${sourceStart} - ${sourceEnd}], (item id: ${itemType})`)
        if (firstSourceSlot === null) firstSourceSlot = sourceItem.slot
        // number of item that can be moved from that slot
        await clickWindow(sourceItem.slot, 0, 0)
      }
      await clickDest()

      async function clickDest () {
        assert.notStrictEqual(window.selectedItem.type, null)
        assert.notStrictEqual(window.selectedItem.metadata, null)
        let destItem
        let destSlot
        // special case for tossing
        if (destStart === -999) {
          destSlot = -999
        } else {
          // find a non full item that we can drop into
          destItem = window.findItemRange(destStart, destEnd,
            window.selectedItem.type, window.selectedItem.metadata, true, nbt)
          // if that didn't work find an empty slot to drop into
          destSlot = destItem
            ? destItem.slot
            : window.firstEmptySlotRange(destStart, destEnd)
          // if that didn't work, give up
          if (destSlot === null) {
            throw new Error('destination full')
          }
        }
        // move the maximum number of item that can be moved
        const destSlotCount = destItem && destItem.count ? destItem.count : 0
        const movedItems = Math.min(window.selectedItem.stackSize - destSlotCount, window.selectedItem.count)
        const target = destSlotCount + count
        const half = Math.floor(Math.min(destSlotCount + window.selectedItem.count, window.selectedItem.stackSize) / 2)
        // if the number of item the left click moves is less than the number of item we want to move
        // several at the same time (left click)
        if (movedItems <= count) {
          await clickWindow(destSlot, 0, 0)
          // update the number of item we want to move (count)
          count -= movedItems
          await transferOne()
        } else if (destSlot !== -999 && half <= target && 3 + target - half < count) {
          // A right click on a stack with an empty cursor takes the larger half.
          await clickWindow(destSlot, 0, 0)
          if (window.selectedItem) await putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot)
          await clickWindow(destSlot, 1, 0)
          for (let missing = target - half; missing > 0; missing--) {
            await clickWindow(destSlot, 1, 0)
          }
          count = 0
          await transferOne()
        } else {
          // one by one (right click)
          await clickWindow(destSlot, 1, 0)
          count -= 1
          await transferOne()
        }
      }
    }
  }

  function extendWindow (window) {
    window.close = () => {
      const closed = closeWindow(window)
      window.emit('close')
      return closed
    }

    window.withdraw = async (itemType, metadata, count, nbt) => {
      if (bot.inventory.emptySlotCount() === 0) {
        throw new Error('Unable to withdraw, Bot inventory is full.')
      }
      const options = {
        window,
        itemType,
        metadata,
        count,
        nbt,
        sourceStart: 0,
        sourceEnd: window.inventoryStart,
        destStart: window.inventoryStart,
        destEnd: window.inventoryEnd
      }
      await transfer(options)
    }
    window.deposit = async (itemType, metadata, count, nbt) => {
      const options = {
        window,
        itemType,
        metadata,
        count,
        nbt,
        sourceStart: window.inventoryStart,
        sourceEnd: window.inventoryEnd,
        destStart: 0,
        destEnd: window.inventoryStart
      }
      await transfer(options)
    }
  }

  /** wait for windowOpen; a failing activation rejects at once instead of after once()'s 20 s */
  async function awaitWindowOpen (opened, activation) {
    const failed = Promise.resolve(activation).then(() => new Promise(() => {}))
    const [window] = await Promise.race([opened, failed])
    extendWindow(window)
    return window
  }

  async function openBlock (block, direction, cursorPos) {
    const opened = once(bot, 'windowOpen')
    await prepareInteraction()
    return awaitWindowOpen(opened, bot.activateBlock(block, direction, cursorPos))
  }

  async function openEntity (entity) {
    const opened = once(bot, 'windowOpen')
    await prepareInteraction()
    return awaitWindowOpen(opened, bot.activateEntity(entity))
  }

  function updateHeldItem () {
    bot.emit('heldItemChanged', bot.heldItem)
  }

  /**
   * Close a window: container_close { window_id, window_type, server: false } (the carried item and station input
   * items are first put back into the inventory, which Java's server does and BDS does not). The returned promise
   * resolves on the server's echo (≤ 1 s). Closing bot.inventory closes the player's inventory screen if the bot
   * opened it.
   */
  function closeWindow (window) {
    if (!window) return Promise.resolve()
    if (slots.isPlayerInventory(window)) return model.screen.close()
    const isCurrent = bot.currentWindow === window
    // the carried item and the items in station input slots kept in the ui container (crafting grid, anvil,
    // enchanting, …) go back into the inventory like on Java; block entities (chest, furnace, …) keep theirs
    const keys = []
    if (isCurrent) {
      if (model.cursor) keys.push('c')
      for (let j = 0; j < window.inventoryStart; j++) {
        const key = model.keyOf(window, j)
        if (key && key.startsWith('u:') && model.read(key)) keys.push(key)
      }
    }
    // like upstream: the window is no longer current and windowClose fires right away
    lastClosedWindow = window
    if (isCurrent) {
      bot.currentWindow = null
      model.closingWindow = window
    }
    bot.emit('windowClose', window)
    const done = (async () => {
      try {
        if (keys.length > 0) {
          await model.returnItems(window, keys)
            .catch(err => bot._warn(`returning items before closing window ${window.id}: ${err.message}`))
        }
      } finally {
        if (model.closingWindow === window) model.closingWindow = null
      }
      const bedrock = window.bedrock
      await model.sendClose(window.id, bedrock ? bedrock.id : window.id, bedrock ? bedrock.windowType : 'none')
    })()
    closing = done
    return done
  }

  async function clickWindow (slot, mouseButton, mode) {
    // if you click on the quick bar and have dug recently,
    // wait a bit
    if (slot >= bot.QUICK_BAR_START && bot.lastDigTime != null) {
      let timeSinceLastDig
      while ((timeSinceLastDig = new Date() - bot.lastDigTime) < DIG_CLICK_TIMEOUT) {
        await sleep(DIG_CLICK_TIMEOUT - timeSinceLastDig)
      }
    }
    const window = bot.currentWindow || bot.inventory

    assert.ok(mode >= 0 && mode <= 6)
    const planned = planClick(window, slot, mouseButton, mode, model.clickOptions(window))
    if (planned.length === 0) return
    const key = (s) => s === undefined ? undefined : model.keyOf(window, s)
    const steps = planned.map(step => ({ ...step, src: key(step.src), dst: key(step.dst) }))
    try {
      await model.execute(window, steps, { timeout: WINDOW_TIMEOUT })
    } catch (err) {
      if (err.name !== 'StackRequestError') throw err
      if (err.outcome === 'error') {
        throw new Error(`Server rejected transaction for clicking on slot ${slot}, on window with id ${window?.id}.`)
      }
      throw new Error(`Server didn't respond to transaction for clicking on slot ${slot} on window with id ${window?.id}.`)
    }
  }

  async function putAway (slot) {
    const window = bot.currentWindow || bot.inventory
    const promisePutAway = once(window, `updateSlot:${slot}`)
    const start = window.inventoryStart
    const end = window.inventoryEnd
    const item = window.slots[slot]
    // A shift click on a result slot repeats the craft or trade while the
    // inputs cover it, and does nothing when the inventory has no room.
    const resultSlot = slot === window.craftingResultSlot || (window.type === 'minecraft:merchant' && slot === 2)
    const room = item && (window.findItemRange(start, end, item.type, item.metadata, true, item.nbt) || window.firstEmptySlotRange(start, end) !== null)
    let moved = false
    if (room && !resultSlot) {
      await clickWindow(slot, 0, 1)
      // Java's shift click has its own target range (e.g. hotbar → main only): when it moved nothing, fall back
      // to picking the item up and placing it anywhere in the range
      moved = window.slots[slot] !== item
    }
    if (!moved) {
      await clickWindow(slot, 0, 0)
      await putSelectedItemRange(start, end, window, null)
    }
    await promisePutAway
  }

  async function moveSlotItem (sourceSlot, destSlot) {
    await clickWindow(sourceSlot, 0, 0)
    await clickWindow(destSlot, 0, 0)
    // if we're holding an item, put it back where the source item was.
    // otherwise we're done.
    updateHeldItem()
    if (bot.inventory.selectedItem) {
      await clickWindow(sourceSlot, 0, 0)
    }
  }

  // ---------------------------------------------------------------- held item

  function selectSlot (slot) {
    if (!(slot >= 0 && slot <= 8) || bot.quickBarSlot === slot) return
    bot.quickBarSlot = slot
    updateHeldItem()
  }
  // the server selects a hotbar slot (join, /give …): select_slot = the client must switch
  bot._client.on('player_hotbar', (packet) => {
    if (packet.window_id !== undefined && windowIdOf(packet.window_id) !== 0) return
    if (!packet.select_slot && bot.quickBarSlot !== null) return
    selectSlot(packet.selected_slot)
  })
  bot._client.on('mob_equipment', (packet) => {
    if (!isSelf(packet.runtime_entity_id) || windowIdOf(packet.window_id) !== 0) return
    selectSlot(packet.selected_slot)
  })

  // ---------------------------------------------------------------- windows

  function openWindow (pending, items) {
    const { id, packet, key, spec } = pending
    pendingOpen = null
    const size = containerSize(spec, items ? items.length : null)
    const coordinates = packet.coordinates ? new Vec3(packet.coordinates.x, packet.coordinates.y, packet.coordinates.z) : null
    const uniqueId = packet.runtime_entity_id === undefined ? -1n : BigInt(packet.runtime_entity_id)
    const window = model.createWindow({
      key,
      spec,
      id,
      rawId: packet.window_id,
      windowType: packet.window_type,
      size,
      coordinates,
      entityUniqueId: uniqueId === -1n ? null : uniqueId
    })
    bot.currentWindow = window
    if (items) model.applyWindowContent(window, items)
    extendWindow(window)
    bot.emit('windowOpen', window)
  }

  bot._client.on('container_open', (packet) => {
    const id = windowIdOf(packet.window_id)
    if (packet.window_type === 'inventory') {
      model.screen.onOpen(id, packet.window_id)
      return
    }
    lastClosedWindow = null
    if (model.screen.isOpen()) model.screen.onClosed(model.screen.id) // the server replaced our inventory screen
    // `runtime_entity_id` carries the container entity's UNIQUE id (-1: a block container at `coordinates`)
    const uniqueId = packet.runtime_entity_id === undefined ? -1n : BigInt(packet.runtime_entity_id)
    let blockName = null
    let entityName = null
    if (uniqueId === -1n && packet.coordinates && typeof bot.blockAt === 'function') {
      try {
        blockName = bot.blockAt(new Vec3(packet.coordinates.x, packet.coordinates.y, packet.coordinates.z))?.name ?? null
      } catch {}
    } else if (uniqueId !== -1n) {
      const runtimeId = bot._bedrock.ids?.uniqueToRuntime?.get(uniqueId)
      const entity = runtimeId === undefined ? null : bot.entities?.[Number(runtimeId)]
      entityName = entity?.name ?? null
    }
    const key = windowKey(packet, { blockName, entityName })
    const spec = bot._bedrock.windows.get(key) ?? bot._bedrock.windows.get('container')
    const pending = { id, packet, key, spec }
    if (!spec.content) {
      openWindow(pending, null)
      return
    }
    pendingOpen = pending
    if (model.hasEarlyContent(id)) {
      openWindow(pending, model.takeEarlyContent(id))
      return
    }
    // BDS sends the contents in the same batch; never leave an opener hanging if they do not come
    setTimeout(() => { if (pendingOpen === pending) openWindow(pending, null) }, CONTENT_TIMEOUT).unref?.()
  })
  // inventory_content for a window that is not open yet (container_open first, contents right after)
  bot.on('_bedrockWindowContent', (id) => {
    if (pendingOpen && pendingOpen.id === id) openWindow(pendingOpen, model.takeEarlyContent(id))
  })

  bot._client.on('container_close', (packet) => {
    const id = windowIdOf(packet.window_id)
    model.screen.onClosed(id)
    if (pendingOpen && pendingOpen.id === id) pendingOpen = null
    const oldWindow = bot.currentWindow
    if (oldWindow && oldWindow.id === id) {
      // closed by the server (block broken, out of range, …)
      bot.currentWindow = null
      lastClosedWindow = oldWindow
      bot.emit('windowClose', oldWindow)
    }
  })

  bot._client.on('inventory_content', (packet) => model.onInventoryContent(packet))
  bot._client.on('inventory_slot', (packet) => model.onInventorySlot(packet))
  bot._client.on('inventory_transaction', (packet) => model.onInventoryTransaction(packet))

  // a new login (upstream: login) or another dimension drops every screen server side
  function dropWindows () {
    pendingOpen = null
    lastClosedWindow = null
    model.screen.reset()
    const oldWindow = bot.currentWindow
    if (!oldWindow) return
    bot.currentWindow = null
    bot.emit('windowClose', oldWindow)
  }
  bot._client.on('start_game', dropWindows)
  bot._client.on('change_dimension', dropWindows)

  bot._setSlot = (slotId, newItem, window = bot.inventory) => {
    // set slot
    const oldItem = window.slots[slotId]
    window.updateSlot(slotId, newItem)
    updateHeldItem()
    bot.emit(`setSlot:${window.id}`, oldItem, newItem)
  }

  bot.inventory.on('updateSlot', (index) => {
    if (index === bot.quickBarSlot + bot.inventory.hotbarStart) {
      bot.emit('heldItemChanged', bot.heldItem)
    }
  })

  // Java 1.17.1+ resyncs a window on an impossible click; Bedrock has no client-initiated resync (the server
  // resends the inventory itself after a rejected transaction), so there is nothing to wait for.
  async function syncWindow (window) {}
  bot._syncWindow = syncWindow

  /**
   * Convert a vector direction to minecraft packet number direction
   * @param {Vec3} v
   * @returns {number}
   */
  function vectorToDirection (v) {
    if (v.y < 0) {
      return 0
    } else if (v.y > 0) {
      return 1
    } else if (v.z < 0) {
      return 2
    } else if (v.z > 0) {
      return 3
    } else if (v.x < 0) {
      return 4
    } else if (v.x > 0) {
      return 5
    }
    assert.ok(false, `invalid direction vector ${v}`)
  }

  bot.activateBlock = activateBlock
  bot.activateEntity = activateEntity
  bot.activateEntityAt = activateEntityAt
  bot.consume = consume
  bot.activateItem = activateItem
  bot.deactivateItem = deactivateItem

  // not really in the public API
  bot.clickWindow = clickWindow
  bot.putSelectedItemRange = putSelectedItemRange
  bot.putAway = putAway
  bot.closeWindow = closeWindow
  bot.transfer = transfer
  bot.openBlock = openBlock
  bot.openEntity = openEntity
  bot.moveSlotItem = moveSlotItem
  bot.updateHeldItem = updateHeldItem

  Object.defineProperty(model, 'lastClosedWindow', { get: () => lastClosedWindow })
}
