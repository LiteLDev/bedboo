// owner: U8 (inventory, windows, creative & item use)
'use strict'
const slots = require('./slots')
const { fromNetwork } = require('./item')
const { CONTAINER_SPECS, slotMapOf, javaTypeOf, containerSize } = require('./windows')
const { placeBackPlan, armorSlotFor, sameItem } = require('./click')

/**
 * The client-side model of the server-authoritative Bedrock inventory, exposed as `bot._bedrock.inventoryModel`
 * (created by the inventory plugin). It keeps mineflayer's Java-layout windows (`bot.inventory`,
 * `bot.currentWindow`) in sync with the Bedrock containers and turns Java-slot steps into item stack requests
 * with local prediction.
 *
 * Physical slots ("keys"):
 *   'p:<0-35>' player inventory (0-8 hotbar)  → bot.inventory 36-44 / 9-35 (+ the open window's player part)
 *   'a:<0-3>'  armor head..feet               → bot.inventory 5-8
 *   'o'        off-hand                       → bot.inventory 45
 *   'c'        cursor (ui 0)                  → `selectedItem` of every window (one shared cursor, like Java's
 *                                               carried item)
 *   'u:<n>'    ui container slot n (window 124): 28-31 = bot.inventory 1-4 (2×2 grid); station slots (anvil,
 *              enchanting, crafting table grid, …) = the open window's Java slot
 *   'w:<j>'    container slot j of bot.currentWindow (chest, furnace, …)
 *   'out'      created output (creative_output 50): crafting / creative results, never stored
 *
 * `execute(window, steps)` builds ONE item_stack_request from steps (lib/bedrock/click.js format, src/dst =
 * keys or `{ created: Item }`), predicts the result (each changed slot gets one updateSlot, its item carries the
 * request id as pending stack id), sends it and resolves with the response (rejects with the StackRequestError).
 * Responses apply the server's counts / stack ids; an error, timeout or disconnect rolls the prediction back.
 * Requests may overlap (a click planned on another one's prediction): per slot, a settled request hands its result
 * to the next request in flight on that slot instead of overwriting its prediction (see "per-slot request chains").
 * Steps on bot.inventory need the player's inventory screen (BDS rejects cursor / cross-container moves and
 * craft_creative without one): the model opens it (`interact open_inventory` → container_open window_type
 * 'inventory') and closes it again 100 ms after the last request when the cursor is empty (`screen`).
 * Server packets always win; when the model finds a player slot out of date (an un-raced stack id mismatch, a
 * server transaction whose old item is not ours) it asks for the server's copy of the inventory (`resync`, an
 * inventory_mismatch transaction) — see "resync".
 */

const IDLE_CLOSE_MS = 100
/** item_stack_response status BDS answers when the request needs a screen the player does not have open */
const NO_SCREEN_STATUS = 7
const SCREEN_TIMEOUT_MS = 8000
/** the open request is repeated this often while unanswered (BDS ignores it while the player is in a portal) */
const SCREEN_RESEND_MS = 1500
const CLOSE_ECHO_TIMEOUT_MS = 1000
/** item_stack_response status of a request naming a stack id the server does not have in that slot */
const STACK_ID_MISMATCH_STATUS = 49
/** a resync (inventory_mismatch → the server's inventory_content) that gets no answer gives up after this long */
const RESYNC_TIMEOUT_MS = 2000
/** ms a resync waits for the armor / ui / off-hand contents after the inventory window's content */
const RESYNC_TAIL_MS = 250
/** automatic resyncs (a stale slot detected) are at most one per this interval */
const AUTO_RESYNC_INTERVAL_MS = 1000

/** bedrock-protocol WindowID enum names → numbers */
const WINDOW_IDS = {
  drop_contents: -100,
  beacon: -24,
  trading_output: -23,
  trading_use_inputs: -22,
  trading_input_2: -21,
  trading_input_1: -20,
  enchant_output: -17,
  enchant_material: -16,
  enchant_input: -15,
  anvil_output: -13,
  anvil_result: -12,
  anvil_material: -11,
  container_input: -10,
  crafting_use_ingredient: -5,
  crafting_result: -4,
  crafting_remove_ingredient: -3,
  crafting_add_ingredient: -2,
  none: -1,
  inventory: 0,
  first: 1,
  last: 100,
  offhand: 119,
  armor: 120,
  creative: 121,
  hotbar: 122,
  fixed_inventory: 123,
  ui: 124
}
const INVENTORY_WINDOW = 0
const OFFHAND_WINDOW = 119
const ARMOR_WINDOW = 120
const UI_WINDOW = 124

/** container_open / inventory_content window id (number or enum name) → number */
function windowIdOf (raw) {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'bigint') return Number(raw)
  if (typeof raw === 'string' && raw in WINDOW_IDS) return WINDOW_IDS[raw]
  const n = Number(raw)
  return Number.isNaN(n) ? null : n
}

/** ui container slot → its ContainerSlotType name (from every spec's slot map) */
const UI_CONTAINER_IDS = (() => {
  const out = new Map()
  for (const spec of Object.values(CONTAINER_SPECS)) {
    const map = typeof spec.slotMap === 'function' ? [] : spec.slotMap
    for (const ref of map) if (ref && ref.ui) out.set(ref.slot, ref.container_id)
  }
  return out
})()

const HOTBAR_KEY = /^p:[0-8]$/

/**
 * @param {object} bot
 * @param {{ Item: Function, Window: Function }} classes prismarine-item Item and prismarine-windows Window classes
 */
function createInventoryModel (bot, { Item, Window }) {
  let cursor = null
  const uiStore = new Array(54).fill(null)
  const inflight = new Map() // request id → entry { id, window, changes: [{ key, before, after }], byKey }
  // per slot, the requests in flight that changed it, in send order: a request's `before` of the slot is the state it
  // was planned on (the previous request's prediction, then that request's server result); see applyResponse
  const chains = new Map() // chain key → entry[]
  const windowTags = new WeakMap()
  let nextWindowTag = 1
  const earlyContent = new Map() // window id → items (inventory_content before / without container_open)

  const mgr = () => bot._bedrock.stackRequests

  // ---------------------------------------------------------------- items

  /** copy of an item with another count / stack id (keeps the Bedrock wire extras) */
  function cloneItem (item, count, stackId) {
    if (!item) return null
    const nbt = item.nbt ? JSON.parse(JSON.stringify(item.nbt)) : null
    const copy = new Item(item.type, count ?? item.count, item.metadata, nbt, (stackId === undefined ? item.stackId : stackId) ?? null, true)
    for (const key of ['blockRuntimeId', 'canPlaceOn', 'canDestroy', 'blockingTick']) {
      if (item[key] !== undefined) copy[key] = Array.isArray(item[key]) ? [...item[key]] : item[key]
    }
    return copy
  }

  /** same stack for the window model (type, count, metadata, NBT); stack ids are not compared */
  function sameStack (a, b) {
    if (!a && !b) return true
    if (!a || !b) return false
    return Item.equal(a, b, true, true)
  }

  /** set a Java slot of a window: updateSlot (events) when the stack changed, a silent replace otherwise */
  function setSlot (window, slot, item) {
    if (!window || slot === null || slot === undefined || slot < 0 || slot >= window.slots.length) return
    const old = window.slots[slot]
    if (old === item) return
    if (sameStack(old, item)) {
      if (item) item.slot = slot
      window.slots[slot] = item
      return
    }
    window.updateSlot(slot, item)
  }

  // ---------------------------------------------------------------- keys

  // a container window being closed: no longer bot.currentWindow (like upstream, closeWindow clears it at once)
  // while its carried / station items are put back before the container_close
  let closingWindow = null

  /** the open container window (bot.currentWindow, or the one being closed) */
  function currentWindow () {
    const w = bot.currentWindow
    if (w && !slots.isPlayerInventory(w)) return w
    return closingWindow
  }

  /** physical key of a Java slot of `window` (or 'cursor'), null if the slot has no Bedrock address */
  function keyOf (window, javaSlot) {
    if (javaSlot === 'cursor') return 'c'
    if (typeof javaSlot !== 'number' || javaSlot < 0) return null
    const i = slots.playerIndex(window, javaSlot)
    if (i !== null) return `p:${i}`
    // one mapping (lib/bedrock/slots.js + the window's slot map): the key follows the Bedrock address
    const ref = slots.refOf(window, javaSlot)
    if (!ref) return null
    switch (ref.container_id) {
      case 'creative_output': return 'out'
      case 'armor': return `a:${ref.slot}`
      case 'offhand': return 'o'
    }
    if (UI_CONTAINER_IDS.get(ref.slot) === ref.container_id) return `u:${ref.slot}`
    return slots.isPlayerInventory(window) ? null : `w:${javaSlot}`
  }

  /**
   * physical key of an item_stack_response container slot
   * @param {object} [window] the container window the request was made for (default: the open one)
   */
  function keyOfResponse (containerId, slot, window = null) {
    if (slots.PLAYER_CONTAINERS.has(containerId)) return slot >= 0 && slot <= 35 ? `p:${slot}` : null
    switch (containerId) {
      case 'armor': return slot >= 0 && slot <= 3 ? `a:${slot}` : null
      case 'offhand': return 'o'
      case 'cursor': return 'c'
      case 'creative_output': return 'out'
    }
    if (UI_CONTAINER_IDS.get(slot) === containerId) return `u:${slot}`
    const cw = window && !slots.isPlayerInventory(window) ? window : currentWindow()
    if (!cw) return null
    const j = slots.toJava(cw, containerId, slot)
    return typeof j === 'number' ? `w:${j}` : null
  }

  /** StackRequestSlotInfo address of a key */
  function refOfKey (key) {
    const [kind, n] = key.split(':')
    const i = Number(n)
    switch (kind) {
      case 'p': return slots.playerRef(i)
      case 'a': return slots.refOf(bot.inventory, 5 + i)
      case 'o': return slots.refOf(bot.inventory, 45)
      case 'c': return { ...slots.CURSOR }
      case 'out': return slots.refOf(bot.inventory, 0)
      case 'u': {
        const id = UI_CONTAINER_IDS.get(i)
        if (!id) throw new Error(`ui slot ${i} has no container id`)
        return { container_id: id, slot: i }
      }
      case 'w': {
        const cw = currentWindow()
        const ref = cw && slots.refOf(cw, i)
        if (!ref) throw new Error(`slot ${i} of the open window has no Bedrock address`)
        return ref
      }
    }
    throw new Error(`unknown inventory key ${key}`)
  }

  function read (key) {
    const [kind, n] = key.split(':')
    const i = Number(n)
    switch (kind) {
      case 'p': return bot.inventory.slots[slots.javaOfPlayerIndex(bot.inventory, i)] ?? null
      case 'a': return bot.inventory.slots[5 + i] ?? null
      case 'o': return bot.inventory.slots[45] ?? null
      case 'c': return cursor
      case 'out': return null
      case 'u': {
        const own = slots.uiToJava(bot.inventory, i)
        if (own !== null) return bot.inventory.slots[own] ?? null
        const cw = currentWindow()
        const j = cw ? slots.uiToJava(cw, i) : null
        return j !== null ? (cw.slots[j] ?? null) : (uiStore[i] ?? null)
      }
      case 'w': return currentWindow()?.slots[i] ?? null
    }
    return null
  }

  function write (key, item) {
    const [kind, n] = key.split(':')
    const i = Number(n)
    switch (kind) {
      case 'p': {
        setSlot(bot.inventory, slots.javaOfPlayerIndex(bot.inventory, i), item)
        const cw = currentWindow()
        if (cw) setSlot(cw, slots.javaOfPlayerIndex(cw, i), cloneItem(item))
        return
      }
      case 'a': return setSlot(bot.inventory, 5 + i, item)
      case 'o': return setSlot(bot.inventory, 45, item)
      case 'c':
        cursor = item ?? null
        if (cursor) cursor.slot = -1
        return
      case 'out': return
      case 'u': {
        uiStore[i] = item ?? null
        const own = slots.uiToJava(bot.inventory, i)
        if (own !== null) return setSlot(bot.inventory, own, item)
        const cw = currentWindow()
        const j = cw ? slots.uiToJava(cw, i) : null
        if (j !== null) setSlot(cw, j, item)
        return
      }
      case 'w': return setSlot(currentWindow(), i, item)
    }
  }

  // ---------------------------------------------------------------- windows

  /** make `window.selectedItem` the shared cursor */
  function shareCursor (window) {
    Object.defineProperty(window, 'selectedItem', {
      configurable: true,
      enumerable: true,
      get () { return cursor },
      set (item) { cursor = item ?? null }
    })
    return window
  }

  /**
   * A Java-layout window for a Bedrock container.
   * @param {{ key: string, spec: object, id: number, rawId: any, windowType: string, size: number,
   *   coordinates?: object, entityUniqueId?: bigint }} info  (`window.bedrock` keeps these)
   */
  function createWindow ({ key, spec, id, rawId, windowType, size, coordinates = null, entityUniqueId = null }) {
    const javaType = javaTypeOf(spec, size)
    const window = new Window(id, javaType, spec.title ?? javaType, size + 36, { start: size, end: size + 35 }, spec.craftingResultSlot ?? -1, true)
    Object.defineProperty(window, 'bedrock', {
      enumerable: false,
      configurable: true,
      value: { key, spec, slotMap: slotMapOf(spec, size), size, id: rawId, windowType, coordinates, entityUniqueId }
    })
    shareCursor(window)
    // player part mirrors bot.inventory
    for (let i = 0; i < 36; i++) {
      const item = cloneItem(bot.inventory.slots[slots.javaOfPlayerIndex(bot.inventory, i)])
      const j = slots.javaOfPlayerIndex(window, i)
      if (item) item.slot = j
      window.slots[j] = item
    }
    // station slots kept in the ui container
    for (let j = 0; j < size; j++) {
      const ref = window.bedrock.slotMap[j]
      if (ref && ref.ui && uiStore[ref.slot]) {
        const item = cloneItem(uiStore[ref.slot])
        item.slot = j
        window.slots[j] = item
      }
    }
    return window
  }

  /** apply the container contents of `window` (inventory_content of its window id) */
  function applyWindowContent (window, items) {
    for (let idx = 0; idx < items.length; idx++) {
      const j = slots.contentToJava(window, idx)
      if (j === null) continue
      const key = keyOf(window, j)
      if (key && key !== 'out') {
        if (key.startsWith('w:') && window !== currentWindow()) setSlot(window, j, items[idx])
        else serverWrite(key, items[idx])
      }
    }
  }

  function takeEarlyContent (id) {
    const items = earlyContent.get(id)
    earlyContent.delete(id)
    return items ?? null
  }

  // ---------------------------------------------------------------- server packets

  function itemsOf (list) {
    return (list ?? []).map(wire => fromNetwork(bot.registry, wire))
  }

  /**
   * A server packet sets slot `key` while requests that change it are in flight (FINAL-FIX-LIB): when the server's
   * stack is not the one such a request was planned on (a pickup, /give, a hopper, another player changed it — new
   * stack id), BDS rejects the request (49 stack id mismatch / 50): it is marked `raced` so execute() plans it again
   * on the server's state (Java's server applies a click to its own current state instead of rejecting it).
   */
  function noteServerWrite (key, item) {
    if (inflight.size === 0) return
    const cw = key.startsWith('w:') ? currentWindow() : null
    for (const entry of inflight.values()) {
      const change = entry.byKey.get(key)
      if (!change) continue
      if (cw && entry.window !== cw) continue
      const before = change.before
      // planned on another request's prediction (chained): that one is compared; its rejection propagates (rollback)
      if (before && inflight.has(before.stackId)) continue
      if (sameServerStack(before, item)) continue // a resend of what it was planned on (a resync, a command's resend)
      change.racedWrite = true // applyResponse: the server's newer item is the base, not the prediction
      entry.raced = true
    }
  }
  /** the same server stack: type, count and stack id (null = empty) */
  function sameServerStack (a, b) {
    if (!a || !b) return !a && !b
    return a.type === b.type && a.count === b.count && (a.stackId ?? 0) === (b.stackId ?? 0)
  }
  /** write() of a server packet */
  function serverWrite (key, item) {
    noteServerWrite(key, item)
    write(key, item)
  }

  function onInventoryContent (packet) {
    const id = windowIdOf(packet.window_id)
    const items = itemsOf(packet.input)
    switch (id) {
      case INVENTORY_WINDOW:
        for (let i = 0; i < 36; i++) serverWrite(`p:${i}`, items[i] ?? null)
        bot.emit('setWindowItems:0')
        return
      case ARMOR_WINDOW:
        for (let i = 0; i < 4; i++) serverWrite(`a:${i}`, items[i] ?? null)
        return
      case OFFHAND_WINDOW:
        serverWrite('o', items[0] ?? null)
        return
      case UI_WINDOW:
        serverWrite('c', items[0] ?? null)
        for (let i = 1; i < items.length && i < uiStore.length; i++) serverWrite(`u:${i}`, items[i] ?? null)
        return
    }
    if (id === null) return
    const cw = currentWindow()
    if (cw && cw.id === id) {
      applyWindowContent(cw, items)
      bot.emit(`setWindowItems:${id}`)
    } else {
      earlyContent.set(id, items)
      bot.emit('_bedrockWindowContent', id)
    }
  }

  function onInventorySlot (packet) {
    const id = windowIdOf(packet.window_id)
    const item = fromNetwork(bot.registry, packet.item)
    const slot = packet.slot
    switch (id) {
      case INVENTORY_WINDOW: if (slot >= 0 && slot < 36) serverWrite(`p:${slot}`, item); return
      case ARMOR_WINDOW: if (slot >= 0 && slot < 4) serverWrite(`a:${slot}`, item); return
      case OFFHAND_WINDOW: serverWrite('o', item); return
      case UI_WINDOW:
        if (slot === 0) serverWrite('c', item)
        else if (slot > 0 && slot < uiStore.length) serverWrite(`u:${slot}`, item)
        return
    }
    const cw = currentWindow()
    if (cw && cw.id === id) {
      const j = slots.contentToJava(cw, slot)
      const key = j === null ? null : keyOf(cw, j)
      if (key && key !== 'out') serverWrite(key, item)
    } else if (id !== null) {
      const early = earlyContent.get(id)
      if (early && slot < early.length) early[slot] = item
    }
  }

  /**
   * server-driven inventory_transaction (normal): /give, pickups … carry the new items with their stack ids. Each
   * action also names the slot's previous content (`old_item`, BDS sends it before the inventory_content of a /give):
   * a slot no request of ours is changing that holds neither the old nor the new item was out of date — the server's
   * copy of the whole inventory is asked for (resync).
   */
  function onInventoryTransaction (packet) {
    const tx = packet.transaction
    if (!tx || tx.transaction_type !== 'normal') return
    let stale = null
    for (const action of tx.actions ?? []) {
      if (action.source_type !== 'container') continue
      const id = windowIdOf(action.window_id)
      let key = null
      if (id === INVENTORY_WINDOW && action.slot >= 0 && action.slot < 36) key = `p:${action.slot}`
      else if (id === ARMOR_WINDOW && action.slot >= 0 && action.slot < 4) key = `a:${action.slot}`
      else if (id === OFFHAND_WINDOW) key = 'o'
      else if (id === UI_WINDOW && action.slot === 0) key = 'c'
      if (key === null) continue
      const item = fromNetwork(bot.registry, action.new_item)
      if (key !== 'c' && !chains.has(key) && action.old_item) {
        const local = read(key)
        if (!sameContent(local, fromNetwork(bot.registry, action.old_item)) && !sameContent(local, item)) stale = key
      }
      serverWrite(key, item)
    }
    if (stale) resync(`a server change of ${stale} found it out of date`, { auto: true })
  }

  /** same item type and count (null = empty) */
  function sameContent (a, b) {
    if (!a || !b) return !a && !b
    return a.type === b.type && a.count === b.count
  }

  // ---------------------------------------------------------------- resync (POLISH-LIB)
  // BDS resends the player's whole inventory (inventory_content of the inventory, armor, ui and off-hand windows, then
  // player_hotbar) when the client sends inventory_transaction { transaction_type: 'inventory_mismatch' } — measured on
  // 1.26.51.1, nothing else happens. Nothing else makes it resend: not (re)opening the inventory screen, not a rejected
  // item stack request (the vanilla client would stay out of sync as well). A slot that went out of date would make
  // every request on it fail (status 49) for good; the model asks for the server's copy when it sees evidence of that:
  // an un-raced status-49 rejection (execute), a server transaction whose old item is not the local one
  // (onInventoryTransaction), a response counting items in a slot the model holds nothing in (applyResponse).
  // `bot.bedrock.resyncInventory()` asks for it explicitly.
  const resyncState = { pending: null, lastAuto: -Infinity, count: 0, last: null }
  /**
   * @param {string} [reason]
   * @param {{ auto?: boolean }} [opts] auto: skipped (resolves false) within AUTO_RESYNC_INTERVAL_MS of the last one
   * @returns {Promise<boolean>} true once the server's inventory_content arrived and was applied, false on a timeout
   *   (or a skipped automatic resync)
   */
  function resync (reason = 'requested', { auto = false } = {}) {
    if (resyncState.pending) return resyncState.pending
    const now = Date.now()
    if (auto && now - resyncState.lastAuto < AUTO_RESYNC_INTERVAL_MS) return Promise.resolve(false)
    if (auto) resyncState.lastAuto = now
    resyncState.count++
    resyncState.last = { reason, at: now }
    if (auto) bot._warn?.(`inventory resync: ${reason}`)
    const pending = new Promise((resolve) => {
      let tail = null
      const done = (ok) => {
        clearTimeout(timer)
        clearTimeout(tail)
        bot._client.removeListener('inventory_content', onContent)
        bot.removeListener('end', onEnd)
        if (resyncState.pending === pending) resyncState.pending = null
        resolve(ok)
      }
      // BDS answers with the inventory window's content, then armor, ui (cursor) and off-hand in the same batch: settle
      // once the off-hand window is in (applied: the inventory plugin's listener runs first), or shortly after the
      // inventory window should the rest not come
      let inventorySeen = false
      const onContent = (packet) => {
        const id = windowIdOf(packet?.window_id)
        if (id === INVENTORY_WINDOW && !inventorySeen) {
          inventorySeen = true
          tail = setTimeout(() => done(true), RESYNC_TAIL_MS)
          tail.unref?.()
        } else if (id === OFFHAND_WINDOW && inventorySeen) {
          setImmediate(() => done(true))
        }
      }
      const onEnd = () => done(false)
      const timer = setTimeout(() => done(false), RESYNC_TIMEOUT_MS)
      timer.unref?.()
      bot._client.on('inventory_content', onContent)
      bot.once('end', onEnd)
    })
    resyncState.pending = pending
    try {
      bot._client.queue('inventory_transaction', {
        transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'inventory_mismatch', actions: [] }
      })
    } catch (err) {
      bot._warn?.(`inventory resync: ${err.message}`)
    }
    return pending
  }

  // ---------------------------------------------------------------- requests

  // ---- per-slot request chains
  // Requests are not serialized: a click planned while another is in flight builds on its prediction (and names the
  // pending request id as stack id, like the vanilla client). BDS answers in send order. Each slot keeps the requests
  // in flight that changed it; a settled request hands its result for the slot (the server's count + stack id, or its
  // own `before` when rejected) to the NEXT request on that slot as that request's `before`, and only the last
  // request on a slot writes the slot. So a later prediction is never overwritten by an earlier answer, and a chain
  // of rejections ends at the state before the first request.

  function tagOf (window) {
    let tag = windowTags.get(window)
    if (tag === undefined) windowTags.set(window, (tag = nextWindowTag++))
    return tag
  }
  /** chain key of a slot: 'w:' keys are per container window */
  function chainKey (entry, key) {
    return key.startsWith('w:') ? `${tagOf(entry.window)}|${key}` : key
  }
  function chainOf (entry, key) {
    return chains.get(chainKey(entry, key)) ?? []
  }
  function link (entry) {
    for (const { key } of entry.changes) {
      const ck = chainKey(entry, key)
      if (!chains.has(ck)) chains.set(ck, [])
      chains.get(ck).push(entry)
    }
  }
  function unlink (entry) {
    for (const { key } of entry.changes) {
      const ck = chainKey(entry, key)
      const chain = chains.get(ck)
      const index = chain ? chain.indexOf(entry) : -1
      if (index === -1) continue
      chain.splice(index, 1)
      if (chain.length === 0) chains.delete(ck)
    }
  }
  /** the request in flight after `entry` (or the first one, when `entry` is not in the chain) on slot `key` */
  function nextOnSlot (entry, key) {
    const chain = entry ? chainOf(entry, key) : (chains.get(key) ?? [])
    const index = entry ? chain.indexOf(entry) : -1
    return chain[index + 1] ?? null
  }
  /**
   * the slot is still addressable: a container window's own slots ('w:' keys) are dropped once that window is no
   * longer open (a late answer, a close); the ui container (station slots, 'u:') outlives the window server side
   */
  function windowKeyValid (entry, key) {
    const window = entry?.window
    if (!window || slots.isPlayerInventory(window) || window === currentWindow()) return true
    return !key.startsWith('w:')
  }

  /**
   * Apply an `ok` response of `entry` (`late`: of a request that timed out and was rolled back): per slot the
   * server's count and stack id, on the item the request predicted there (or the current item when it did not touch
   * the slot, or a server packet replaced it meanwhile).
   */
  function applyResponse (response, entry, late = false) {
    for (const container of response.containers ?? []) {
      const containerId = container.slot_type?.container_id
      for (const s of container.slots ?? []) {
        const key = keyOfResponse(containerId, s.slot, entry?.window)
        if (!key || key === 'out' || !windowKeyValid(entry, key)) continue
        const change = entry?.byKey.get(key)
        const next = nextOnSlot(entry, key)
        const current = read(key)
        let item = null
        if (s.count) {
          let base
          if (next) base = change ? (change.after ?? change.before) : next.byKey.get(key).before
          // the request's own prediction, unless a server packet replaced the slot with something else meanwhile (a
          // resend of the state it was planned on — a resync, a command's resend — does not count: the server applied
          // the request to that state, POLISH-LIB)
          else if (change && (late || !current || !change.racedWrite)) base = change.after ?? change.before ?? current
          else base = current ?? change?.after ?? change?.before
          if (!base) {
            bot._warn?.(`item stack response ${response.request_id}: ${containerId} ${s.slot} holds ${s.count} unknown item(s)`)
            // the server counts items in a slot the model holds nothing in: ask for its copy (POLISH-LIB)
            if (!key.startsWith('w:') && !key.startsWith('u:')) resync(`${key} holds ${s.count} item(s) the model does not know`, { auto: true })
            continue
          }
          item = cloneItem(base, s.count, s.item_stack_id ?? base.stackId)
        }
        if (next) {
          // a later request in flight planned on this slot: the server state is what it builds on, its own
          // prediction stays visible until its answer
          next.byKey.get(key).before = item
        } else if (!item) {
          if (current) write(key, null)
        } else if (item.type !== current?.type || item.count !== current?.count || item.stackId !== current?.stackId) {
          write(key, item)
        }
      }
    }
  }

  /** undo `entry`'s prediction (rejected, timed out, disconnected) */
  function rollback (entry) {
    for (let k = entry.changes.length - 1; k >= 0; k--) {
      const { key, before, after } = entry.changes[k]
      if (!windowKeyValid(entry, key)) continue
      const next = nextOnSlot(entry, key)
      if (next) {
        next.byKey.get(key).before = before // the next request was planned on our (rejected) prediction
        if (entry.raced) next.raced = true // and named its request id: rejected too, planned again like this one
        next.chained = true // its stack id mismatch is explained: no resync for it
      } else if (read(key) === after) write(key, before) // else a server packet replaced the slot meanwhile: keep it
    }
    unlink(entry)
  }

  // requests that timed out: rolled back, kept for a while in case the server's answer comes late
  const expired = new Map()
  const MAX_EXPIRED = 64
  let observed = false
  function observeResponses () {
    if (observed) return
    observed = true
    mgr().observe(({ request, response, outcome }) => {
      const id = request.request_id
      if (outcome === 'late-ok' || outcome === 'late-error') {
        // a request that timed out (rolled back, out of its chains) was answered after all: an accepted one's
        // response carries every slot it changed (handed to the requests in flight after it, like applyResponse)
        const entry = expired.get(id)
        expired.delete(id)
        if (outcome === 'late-ok') applyResponse(response, entry, true)
        return
      }
      const entry = inflight.get(id)
      inflight.delete(id)
      if (outcome === 'ok') {
        applyResponse(response, entry)
        if (entry) unlink(entry)
      } else if (entry) {
        rollback(entry)
        if (outcome === 'timeout') {
          expired.set(id, entry)
          if (expired.size > MAX_EXPIRED) expired.delete(expired.keys().next().value)
        }
      }
    })
  }

  function needsScreen (step) {
    if (step.type === 'creative' || step.type === 'destroy' || step.type === 'raw') return true
    const keys = [step.src, step.dst].filter(k => typeof k === 'string')
    return keys.some(k => !HOTBAR_KEY.test(k)) || typeof step.src === 'object'
  }

  /**
   * Build, predict and send one item stack request.
   * @param {object} window the window whose Java slots the caller planned with (bot.inventory or bot.currentWindow)
   * @param {object[] | (() => object[])} steps keys-based steps (see the module comment and lib/bedrock/click.js),
   *   or a planner: called again after waiting for the inventory screen, so a request planned while an earlier one
   *   waited too builds on that one's prediction (like Java's synchronous click prediction)
   * @param {{ timeout?: number, creativeEntry?: (item: object) => { id: number, item: object }, customNames?: string[],
   *   cause?: number, requestId?: number }} [opts] `customNames` / `cause` / `requestId`: the request's fields (see
   *   stack_request.js; a `raw` step's `action` may also be a function of the request id)
   * @returns {Promise<object|null>} the ItemStackResponse (null: nothing to do)
   */
  async function execute (window, steps, opts = {}) {
    if (!steps || (Array.isArray(steps) && steps.length === 0)) return null
    let retried = !!opts.retried
    for (;;) {
      try {
        return await executeOnce(window, steps, opts)
      } catch (err) {
        if (err.name !== 'StackRequestError' || !(await retryAfter(err, retried))) throw err
        retried = true
      }
    }

    /** whether to send the request once more after `err` (at most one retry) */
    async function retryAfter (err, retried) {
      // planned requests (clickWindow, returnItems, craft) can be planned again; fixed steps were sized for the old state
      const replannable = () => typeof steps === 'function' && opts.requestId === undefined &&
        (slots.isPlayerInventory(window) || window === currentWindow())
      // a stack id mismatch no server packet explains (not raced, not planned on a rejected request): the model's copy
      // of a slot is out of date (a desync) — every request on that slot would fail for good. Ask for the server's copy;
      // when it differs from what the request was planned on, plan it again once on it (POLISH-LIB)
      if (err.outcome === 'error' && err.status === STACK_ID_MISMATCH_STATUS && !err.raced && !err.chained) {
        if (retried || !replannable()) {
          resyncAfterMismatch(err).catch(() => {}) // heals the model for the next request; nothing to wait for here
          return false
        }
        return (await resyncAfterMismatch(err)) && replannable()
      }
      if (retried) return false
      // a server packet changed a slot of the request while it was in flight (a pickup, /give, a hopper: new stack
      // id) and BDS rejected it: plan it again on the server's state, once (FINAL-FIX-LIB; Java's server applies the
      // click to its current state)
      if (err.raced && err.outcome === 'error') return replannable()
      // status 7: BDS has no matching screen (e.g. it dropped our inventory screen on a respawn) → reopen, retry once
      if (err.status === NO_SCREEN_STATUS && slots.isPlayerInventory(window) && !currentWindow()) {
        screen.reset()
        return true
      }
      return false
    }
  }

  /**
   * After an un-raced stack id mismatch: resync when the request touched the player's slots (the server resends
   * those only). @returns {Promise<boolean>} whether a touched slot now differs from what the request was planned on
   */
  async function resyncAfterMismatch (err) {
    const touched = (err.inventoryChanges ?? []).filter(({ key }) => /^(?:p:\d+|a:\d|o|c)$/.test(key))
    if (touched.length === 0) return false
    await resync(`item stack request ${err.request?.request_id} rejected: stack id mismatch`, { auto: true })
    return touched.some(({ key, before }) => !sameServerStack(read(key), before))
  }

  async function executeOnce (window, plan, opts) {
    observeResponses()
    const isInventory = slots.isPlayerInventory(window)
    let steps = typeof plan === 'function' ? plan() : plan
    if (!steps || steps.length === 0) return null // nothing to do (even for a window closed meanwhile)
    if (!isInventory && window !== currentWindow()) throw new Error(`window ${window?.id} is not open`)
    const useScreen = isInventory && !currentWindow() && steps.some(needsScreen)
    // busy before the screen opens: the idle close must not fire while this request is being built or in flight
    screen.busy++
    try {
      // no wait when the screen is open already: the prediction is committed synchronously, so the next click
      // (even not awaited) is planned on it
      if (useScreen && !screen.isOpen()) {
        await screen.open()
        if (typeof plan === 'function') {
          steps = plan() // on the predictions committed meanwhile
          if (!steps || steps.length === 0) return null
        }
      }
      const virtual = new Map()
      const touched = new Set()
      const vget = (k) => virtual.has(k) ? virtual.get(k) : read(k)
      const { request, response } = mgr().create((requestId) => {
        const actions = []
        const sid = (k) => {
          const it = vget(k)
          if (!it) return 0
          return touched.has(k) ? requestId : (it.stackId ?? 0)
        }
        const info = (k) => slots.slotInfo(refOfKey(k), sid(k))
        const mark = (k, item) => { virtual.set(k, item); touched.add(k) }
        // `src: { created: item }`: the created output (creative_output 50) of an earlier craft action of this request
        const createdOf = (step) => typeof step.src === 'object' && step.src !== null ? step.src.created : null
        const createdOutput = () => slots.slotInfo({ container_id: 'creative_output', slot: 50 }, requestId)
        for (const step of steps) {
          switch (step.type) {
            case 'take':
            case 'place': {
              const n = step.count
              const created = createdOf(step)
              const s = created ?? vget(step.src)
              if (!s || !(n >= 1) || (!created && n > s.count)) throw new Error(`cannot move ${n} item(s) from ${step.src}`)
              const d = vget(step.dst)
              if (d && !sameItem(Item, d, s)) throw new Error(`cannot move ${s.name} onto ${d.name} (${step.dst})`)
              actions.push({
                type_id: step.type,
                count: n,
                source: created ? createdOutput() : info(step.src),
                destination: info(step.dst)
              })
              if (!created) mark(step.src, s.count - n > 0 ? cloneItem(s, s.count - n) : null)
              mark(step.dst, d ? cloneItem(d, d.count + n) : cloneItem(s, n))
              break
            }
            case 'swap': {
              const a = vget(step.src)
              const b = vget(step.dst)
              actions.push({ type_id: 'swap', source: info(step.src), destination: info(step.dst) })
              mark(step.src, cloneItem(b))
              mark(step.dst, cloneItem(a))
              break
            }
            case 'drop':
            case 'destroy':
            case 'consume': {
              const created = createdOf(step)
              const s = created ?? vget(step.src)
              const n = step.count
              if (!s || !(n >= 1) || (!created && n > s.count)) throw new Error(`cannot ${step.type} ${n} item(s) from ${created ? 'the created output' : step.src}`)
              const source = created ? createdOutput() : info(step.src)
              const action = { type_id: step.type, count: n, source }
              if (step.type === 'drop') action.randomly = false
              actions.push(action)
              if (!created) mark(step.src, s.count - n > 0 ? cloneItem(s, s.count - n) : null)
              break
            }
            case 'creative': {
              const entry = (opts.creativeEntry ?? bot._bedrock.creativeItems?.entryFor)?.(step.item)
              if (!entry) throw new Error(`${step.item?.name ?? 'item'} is not in the creative inventory`)
              const d = vget(step.dst)
              const made = cloneItem(entry.item, step.count, null)
              if (d && !sameItem(Item, d, made)) throw new Error(`cannot create ${made.name} onto ${d.name} (${step.dst})`)
              actions.push({ type_id: 'craft_creative', item_id: entry.id, times_crafted: 1 })
              actions.push({
                type_id: step.dst === 'c' ? 'take' : 'place',
                count: step.count,
                source: createdOutput(),
                destination: info(step.dst)
              })
              mark(step.dst, d ? cloneItem(d, d.count + step.count) : made)
              break
            }
            case 'raw': // `action` may be a function of the request id (actions that name the request itself)
              actions.push(typeof step.action === 'function' ? step.action(requestId) : step.action)
              break
            default:
              throw new Error(`unknown inventory step ${step.type}`)
          }
        }
        return actions
      }, { timeout: opts.timeout, meta: { window }, customNames: opts.customNames, cause: opts.cause, requestId: opts.requestId })
      // commit the prediction: one updateSlot per changed slot
      const changes = []
      const byKey = new Map()
      for (const [key, item] of virtual) {
        if (item) item.stackId = request.request_id
        const change = { key, before: read(key), after: item }
        changes.push(change)
        byKey.set(key, change)
      }
      const entry = { id: request.request_id, window: isInventory ? bot.inventory : window, changes, byKey }
      inflight.set(request.request_id, entry)
      link(entry)
      for (const { key, after } of changes) write(key, after)
      mgr().write(request)
      try {
        return await response
      } catch (err) {
        if (err && typeof err === 'object') {
          if (entry.raced) err.raced = true
          if (entry.chained) err.chained = true
          // the slots it changed and what it was planned on (resyncAfterMismatch)
          Object.defineProperty(err, 'inventoryChanges', { value: entry.changes, configurable: true, writable: true })
        }
        throw err
      }
    } finally {
      screen.busy--
      screen.scheduleIdleClose()
    }
  }

  // ---------------------------------------------------------------- the player's inventory screen

  const screen = {
    id: null,
    rawId: null,
    busy: 0,
    opening: null,
    openWaiter: null,
    idleTimer: null,
    closeWaiters: new Map(),
    isOpen () { return screen.id !== null },
    /** open the player's inventory screen (no-op when it or a container window is open) */
    async open () {
      clearTimeout(screen.idleTimer)
      if (screen.id !== null || currentWindow()) return
      if (!screen.opening) {
        const request = () => bot._client.queue('interact', {
          action_id: 'open_inventory',
          target_entity_id: bot._bedrock.ids?.selfRuntimeId?.() ?? bot.entity?.runtimeId ?? 0n,
          has_position: false
        })
        screen.opening = new Promise((resolve, reject) => {
          // U18: BDS drops the request while the player stands in a nether portal and for ~1–2 s after it stepped
          // out of the arrival portal (no container_open at all): ask again every 1.5 s until the timeout
          const resend = setInterval(request, SCREEN_RESEND_MS)
          resend.unref?.()
          const timer = setTimeout(() => {
            clearInterval(resend)
            screen.openWaiter = null
            reject(new Error('the server did not open the inventory screen'))
          }, SCREEN_TIMEOUT_MS)
          timer.unref?.()
          screen.openWaiter = () => { clearTimeout(timer); clearInterval(resend); resolve() }
        }).finally(() => { screen.opening = null })
        request()
      }
      await screen.opening
    },
    onOpen (id, rawId) {
      screen.id = id
      screen.rawId = rawId
      const waiter = screen.openWaiter
      screen.openWaiter = null
      if (waiter) waiter()
      screen.scheduleIdleClose()
    },
    onClosed (id) {
      if (screen.id === id) {
        screen.id = null
        screen.rawId = null
      }
      const waiter = screen.closeWaiters.get(id)
      if (waiter) waiter()
    },
    /** forget the screen without closing it (the server dropped it: dimension change, rejoin, …) */
    reset () {
      clearTimeout(screen.idleTimer)
      if (screen.id !== null) screen.onClosed(screen.id)
    },
    scheduleIdleClose () {
      clearTimeout(screen.idleTimer)
      if (screen.busy > 0 || screen.id === null || cursor) return
      screen.idleTimer = setTimeout(() => {
        if (screen.busy > 0 || cursor) return
        screen.close().catch(err => bot._warn?.(`closing the inventory screen: ${err.message}`))
      }, IDLE_CLOSE_MS)
      screen.idleTimer.unref?.()
    },
    /** put a carried item back, close the inventory screen and wait for the server's echo */
    async close () {
      clearTimeout(screen.idleTimer)
      if (screen.opening) await screen.opening.catch(() => {})
      if (screen.id === null) return
      if (cursor) await returnCursor(bot.inventory).catch(err => bot._warn?.(`returning the cursor item: ${err.message}`))
      if (screen.id === null) return
      const { id, rawId } = screen
      screen.id = null
      screen.rawId = null
      await sendClose(id, rawId, 'inventory')
    }
  }

  /** send container_close and wait (≤ 1 s, never rejects) for the server's echo */
  function sendClose (id, rawId, windowType) {
    const echo = new Promise((resolve) => {
      const timer = setTimeout(done, CLOSE_ECHO_TIMEOUT_MS)
      timer.unref?.()
      function done () {
        clearTimeout(timer)
        if (screen.closeWaiters.get(id) === done) screen.closeWaiters.delete(id)
        resolve()
      }
      screen.closeWaiters.set(id, done)
    })
    bot._client.queue('container_close', { window_id: rawId ?? id, window_type: windowType ?? 'none', server: false })
    return echo
  }

  /**
   * Java `placeItemBackInInventory` for the items at `keys` (the cursor, station input slots): each goes into the
   * player inventory (selected slot, off-hand and stacks with room first, then the first empty slot), the rest is
   * dropped — one request. Java's server does this when a container closes; BDS keeps them where they are.
   */
  async function returnItems (window, keys) {
    // planned when the request is built (after a wait for the inventory screen, on the predictions made meanwhile)
    return execute(window, () => returnSteps(keys))
  }
  function returnSteps (keys) {
    const steps = []
    const virtual = new Map()
    const keyOfIndex = (i) => i === 'offhand' ? 'o' : `p:${i}`
    const at = (i) => {
      const k = keyOfIndex(i)
      return virtual.has(k) ? virtual.get(k) : read(k)
    }
    for (const key of keys) {
      const item = read(key)
      if (!item) continue
      const plan = placeBackPlan(Item, at, item, bot.quickBarSlot ?? 0)
      for (const { index, count } of plan.moves) {
        const k = keyOfIndex(index)
        const there = at(index)
        steps.push({ type: 'place', count, src: key, dst: k })
        virtual.set(k, there ? cloneItem(there, there.count + count) : cloneItem(item, count))
      }
      if (plan.rest > 0) steps.push({ type: 'drop', count: plan.rest, src: key })
    }
    return steps
  }

  /** put the carried item back into the inventory (see returnItems) */
  function returnCursor (window) {
    return cursor ? returnItems(window, ['c']) : Promise.resolve(null)
  }

  // ---------------------------------------------------------------- planner hooks

  /** clickWindow planner options for `window` */
  function clickOptions (window) {
    const isInventory = slots.isPlayerInventory(window)
    const key = window.bedrock?.key
    const spec = window.bedrock?.spec ?? null
    let kind = 'station'
    if (isInventory) kind = 'inventory'
    else if (!spec || (spec.craftingResultSlot === -1 && spec.content && ['container', 'barrel', 'shulker'].includes(window.bedrock?.slotMap?.[0]?.container_id))) kind = 'chest'
    return {
      Item,
      kind,
      gameMode: bot.game?.gameMode,
      isCreatedOutput: (s) => keyOf(window, s) === 'out',
      isAddressable: (s) => keyOf(window, s) !== null,
      quickMoveTargets: spec?.quickMoveTargets ? (item) => spec.quickMoveTargets(item) : null,
      slotLimit: spec?.slotLimits ? (s) => spec.slotLimits[s] : null,
      mayPlace: (s, item) => {
        if (isInventory && s >= 5 && s <= 8) return armorSlotFor(item) === s
        if (key === 'shulker_box' && s < window.inventoryStart) return !/shulker_box$/.test(item?.name ?? '')
        return true
      }
    }
  }

  return {
    keyOf,
    keyOfResponse,
    refOfKey,
    read,
    write,
    setSlot,
    cloneItem,
    sameStack,
    shareCursor,
    createWindow,
    applyWindowContent,
    takeEarlyContent,
    hasEarlyContent: (id) => earlyContent.has(id),
    onInventoryContent,
    onInventorySlot,
    onInventoryTransaction,
    execute,
    returnItems,
    returnCursor,
    sendClose,
    clickOptions,
    containerSize,
    screen,
    get cursor () { return cursor },
    set cursor (item) { cursor = item ?? null },
    get closingWindow () { return closingWindow },
    set closingWindow (window) { closingWindow = window ?? null },
    currentWindow,
    uiStore,
    inflight,
    chains,
    resync,
    /** diagnostics: { count, last: { reason, at } | null, pending: boolean } */
    get resyncs () { return { count: resyncState.count, last: resyncState.last, pending: !!resyncState.pending } }
  }
}

module.exports = { createInventoryModel, windowIdOf, WINDOW_IDS, UI_CONTAINER_IDS, IDLE_CLOSE_MS }
