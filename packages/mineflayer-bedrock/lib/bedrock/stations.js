// owner: U13 (stations)
'use strict'

/**
 * Shared helpers of the station plugins (furnace, enchantment_table, anvil, villager).
 *
 * Bedrock stations are server-authoritative item stack requests (verified on BDS 1.26.51.1, protocol 2193):
 * - the inputs are moved into the station's slots with ordinary take/place actions (bot.clickWindow / transfer);
 * - the operation itself is ONE request: a craft action (`craft_recipe { recipe_network_id }` for enchanting and
 *   trading, `optional { recipe_network_id: 0, filtered_string_index }` for the anvil, whose new name travels in the
 *   request's `custom_names`), optionally `results_deprecated`, a `consume` per input slot, and `place`/`take`
 *   actions moving the produced item out of `creative_output` slot 50 (stack id = the request id).
 * - the response only reports counts and stack ids: the produced item itself (enchantments, name, repair cost) is
 *   never sent back, so the client predicts it (the server's later inventory resends carry its real copy).
 *
 * Contract (used by lib/plugins/{enchantment_table,anvil,villager}.js):
 * - `zigzag32(n)` — player_enchant_options `option_id` → craft_recipe `recipe_network_id`.
 * - `resultDescriptor(item)` — results_deprecated ItemStackRequestInstanceDescriptor of a predicted item.
 * - `resultSteps(model, window, item)` → `{ steps, rest }` inventory model steps that place a produced `item` into
 *   the player part of `window` like mineflayer's `putAway` of a result slot (a stack of the same item with room
 *   first, then the first empty slot, from `inventoryStart`); `rest` items go to the cursor (`take`).
 * - `runStation(bot, window, steps, opts) → response` — `inventoryModel.execute` with the station's custom names;
 *   a rejected / unanswered request throws an Error naming the station.
 * - `closeCurrentWindow(bot)` — close bot.currentWindow before activating a station (BDS ignores the activation otherwise).
 * - `onWindowGone(bot, window, fn)` — `fn` once when `window` closes (its 'close' or the bot's windowClose for it).
 * - `itemFromNbt(Item, registry, compound, count?)` — a trade offer's NBT item (`{ Name, Count, Damage, tag }`) →
 *   prismarine-item Item (Damage 32767 = any data value → metadata 0), null for unknown items.
 * - `withNbt(Item, item, edit)` — copy of `item` (keeps the server's wire extras) whose NBT compound value is
 *   replaced by `edit(value)` (an empty result removes the NBT).
 */

const STATION_TIMEOUT_MS = 5000

/** zigzag32 encoding: the enchanting option id is sent as the recipe network id in its wire encoding */
function zigzag32 (n) {
  return ((n << 1) ^ (n >> 31)) >>> 0
}

const hasNbt = (item) => !!(item?.nbt?.value && Object.keys(item.nbt.value).length > 0)

/** results_deprecated item descriptor of `item` (name descriptor + its NBT) */
function resultDescriptor (item) {
  const withNbt = hasNbt(item)
  return {
    type: 'name',
    legacy_type: 1,
    name: `minecraft:${item.name}`,
    metadata: item.metadata ?? 0,
    count: item.count,
    block_runtime_id: 0,
    extra: {
      has_nbt: withNbt ? 'true' : 'false',
      nbt: withNbt ? { version: 1, nbt: item.nbt } : undefined,
      can_place_on: [],
      can_destroy: []
    }
  }
}

/**
 * Steps that place a produced item into the player part of `window` (Java `putAway` of a result slot: pick the
 * result up, then put it into a same-item stack with room in [inventoryStart, inventoryEnd), else the first empty
 * slot of that range). Items that do not fit go to the cursor (the caller drops them like putSelectedItemRange).
 * @returns {{ steps: object[], rest: number }}
 */
function resultSteps (model, window, item) {
  const start = window.inventoryStart
  const end = window.inventoryEnd
  const virtual = new Map()
  const at = (s) => virtual.has(s) ? virtual.get(s) : window.slots[s]
  const nbtKey = JSON.stringify(item.nbt ?? null)
  const same = (other) => other && other.type === item.type && other.metadata === item.metadata &&
    JSON.stringify(other.nbt ?? null) === nbtKey
  const steps = []
  let remaining = item.count
  while (remaining > 0) {
    let dest = null
    for (let s = start; s < end; s++) {
      const there = at(s)
      if (same(there) && there.count < there.stackSize) { dest = s; break }
    }
    if (dest === null) {
      for (let s = start; s < end; s++) {
        if (!at(s)) { dest = s; break }
      }
    }
    if (dest === null) break
    const there = at(dest)
    const n = Math.min(remaining, (there ? there.stackSize - there.count : item.stackSize) || remaining)
    steps.push({ type: 'place', count: n, src: { created: item }, dst: model.keyOf(window, dest) })
    virtual.set(dest, { type: item.type, metadata: item.metadata, nbt: item.nbt, stackSize: item.stackSize, count: (there?.count ?? 0) + n })
    remaining -= n
  }
  if (remaining > 0) {
    if (model.cursor) throw new Error('destination full')
    steps.push({ type: 'take', count: remaining, src: { created: item }, dst: 'c' })
  }
  return { steps, rest: remaining }
}

/**
 * Send one station request through the inventory model (prediction + rollback).
 * @param {object} bot
 * @param {object} window the open station window
 * @param {object[]} steps inventory model steps
 * @param {{ what: string, customNames?: string[], cause?: string|number, timeout?: number }} opts
 */
async function runStation (bot, window, steps, { what, customNames, cause, timeout = STATION_TIMEOUT_MS } = {}) {
  const restore = customNames || cause !== undefined ? requestOptions(bot, window, { customNames, cause }) : () => {}
  try {
    return await bot._bedrock.inventoryModel.execute(window, steps, { timeout, customNames, cause })
  } catch (err) {
    if (err.name !== 'StackRequestError') throw err
    const reason = err.outcome === 'error' ? `rejected by the server (status ${err.status})` : `failed (${err.outcome})`
    const wrapped = new Error(`${what} ${reason}`)
    wrapped.cause = err
    throw wrapped
  } finally {
    restore()
  }
}

/**
 * The inventory model (U8, lib/bedrock/inventory_model.js) does not pass request-level options to the stack request
 * manager: give the next request created for `window` the anvil's `custom_names` / filter cause. One-shot: the
 * manager's `create` is restored by that request or by the returned function.
 * TODO(W3-FIX-B): replace with `execute(window, steps, { customNames, cause })` once the model forwards them.
 */
function requestOptions (bot, window, { customNames, cause }) {
  const mgr = bot._bedrock.stackRequests
  const original = mgr.create
  if (original.stationWrapper) return () => {}
  const restore = () => { if (mgr.create === wrapper) mgr.create = original }
  function wrapper (actions, opts = {}) {
    if (opts.meta?.window !== window || opts.customNames) return original.call(mgr, actions, opts)
    restore()
    const extra = { customNames: customNames ?? opts.customNames }
    if (cause !== undefined) extra.cause = cause
    return original.call(mgr, actions, { ...opts, ...extra })
  }
  wrapper.stationWrapper = true
  mgr.create = wrapper
  return restore
}

/**
 * BDS ignores a container activation while another window is open (the opener would wait 20 s for windowOpen):
 * close the current window first (coordinator note, until W3-FIX-B makes openBlock / openEntity do it).
 */
async function closeCurrentWindow (bot) {
  const window = bot.currentWindow
  if (!window) return
  // window.close() (inventory plugin) also emits the window's 'close', which the station plugins listen to
  if (typeof window.close === 'function') await window.close()
  else await bot.closeWindow(window)
}

/**
 * Run `fn` once when `window` goes away: its 'close' event (window.close()) or the bot's windowClose for it (closed
 * with bot.closeWindow, by the server, or replaced by a dimension change) — the station plugins' listener cleanup.
 */
function onWindowGone (bot, window, fn) {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    window.removeListener('close', finish)
    bot.removeListener('windowClose', onWindowClose)
    fn()
  }
  const onWindowClose = (closed) => { if (closed === window) finish() }
  window.once('close', finish)
  bot.on('windowClose', onWindowClose)
}

/** value of a typed NBT tag, or of an already simplified one */
const tagValue = (tag) => (tag && typeof tag === 'object' && 'type' in tag && 'value' in tag) ? tag.value : tag

/**
 * A Bedrock item compound of a trade offer → Item.
 * @param {Function} Item prismarine-item class
 * @param {object} registry
 * @param {object} compound typed NBT compound (`{ type: 'compound', value: { Name, Count, Damage, tag? } }`)
 * @param {number} [count] count override
 * @returns {object|null}
 */
function itemFromNbt (Item, registry, compound, count) {
  const value = tagValue(compound)
  if (!value || typeof value !== 'object') return null
  const name = String(tagValue(value.Name) ?? '').replace(/^minecraft:/, '')
  const def = registry.itemsByName[name]
  if (!def) return null
  const damage = Number(tagValue(value.Damage) ?? 0)
  const metadata = damage === 32767 ? 0 : damage
  const tag = value.tag && value.tag.type === 'compound' ? { type: 'compound', name: '', value: JSON.parse(JSON.stringify(value.tag.value)) } : null
  const n = count ?? Number(tagValue(value.Count) ?? 1)
  return new Item(def.id, n, metadata, tag && Object.keys(tag.value).length ? tag : null, null, true)
}

/**
 * Copy of `item` with its NBT compound value replaced by `edit(copyOfValue)`; keeps the Bedrock wire extras.
 * @param {Function} Item
 * @param {object} item
 * @param {(value: object) => object} edit
 * @param {{ type?: number, count?: number }} [over]
 */
function withNbt (Item, item, edit, { type = item.type, count = item.count } = {}) {
  const value = edit(JSON.parse(JSON.stringify(item.nbt?.value ?? {})))
  const nbt = value && Object.keys(value).length ? { type: 'compound', name: '', value } : null
  const copy = new Item(type, count, item.metadata, nbt, null, true)
  if (type === item.type) {
    for (const key of ['blockRuntimeId', 'canPlaceOn', 'canDestroy', 'blockingTick']) {
      if (item[key] !== undefined) copy[key] = Array.isArray(item[key]) ? [...item[key]] : item[key]
    }
  }
  return copy
}

module.exports = { zigzag32, resultDescriptor, resultSteps, runStation, closeCurrentWindow, onWindowGone, itemFromNbt, withNbt, tagValue, STATION_TIMEOUT_MS }
