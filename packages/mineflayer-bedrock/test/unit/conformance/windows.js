// owner: U3 (parity tooling)
'use strict'
/**
 * Window-class probe: opens every mineflayer window kind without a server and records the members
 * the plugins add to the window (Chest/Dispenser deposit/withdraw/close, Furnace putFuel/…, …).
 *
 * How: `bot.activateBlock` / `bot.activateEntity` are replaced by no-ops, the opener is called
 * (`bot.openFurnace(furnaceBlock)`, …), then a prismarine-windows window of the expected type is
 * announced with `bot.emit('windowOpen', window)` — exactly what mineflayer's inventory plugin waits
 * for in `openBlock`/`openEntity`. For villagers an empty `trade_list` is sent (upstream waits for it).
 * The members the opener added are the difference to a pristine window of the same type.
 *
 * Against mineflayer-bedrock this works while the openers keep upstream's shape (opener →
 * bot.openBlock/openEntity → 'windowOpen'); when an implementation cannot be driven this way the class
 * is reported as `unverified` (covered by the parity fragment's asserting test instead). An opener that
 * never settles leaves its listeners behind, so the remaining classes are probed on a fresh bot.
 */
const { addedMembers, realSetTimeout } = require('./surface')

/**
 * One entry per window class mineflayer creates; `cls` uses the index.d.ts class names. `windows` lists
 * candidate prismarine-windows types: the modern Java names first, then the pre-1.14 names that
 * prismarine-windows uses for registries without the village&pillage window list (Bedrock).
 */
const WINDOW_SPECS = [
  { cls: 'Chest', opener: 'openContainer', block: 'chest', title: 'Chest', windows: [['minecraft:generic_9x3'], ['minecraft:chest', 27], ['minecraft:container', 27]] },
  { cls: 'Dispenser', opener: 'openDispenser', block: 'dispenser', title: 'Dispenser', windows: [['minecraft:generic_3x3'], ['minecraft:dispenser']] },
  { cls: 'Furnace', opener: 'openFurnace', block: 'furnace', title: 'Furnace', windows: [['minecraft:furnace']] },
  { cls: 'EnchantmentTable', opener: 'openEnchantmentTable', block: 'enchanting_table', title: 'Enchant', windows: [['minecraft:enchantment'], ['minecraft:enchanting_table']] },
  { cls: 'Anvil', opener: 'openAnvil', block: 'anvil', title: 'Repair & Name', windows: [['minecraft:anvil']] },
  { cls: 'Villager', opener: 'openVillager', entity: ['villager', 'villager_v2'], title: 'Villager', windows: [['minecraft:merchant'], ['minecraft:villager']] }
]

function withTimeout (promise, ms) {
  let timer
  const timeout = new Promise((resolve) => { timer = realSetTimeout(() => resolve({ timeout: true }), ms) })
  return Promise.race([promise.then(value => ({ value }), error => ({ error })), timeout])
    .finally(() => clearTimeout(timer))
}

/** A window of the first candidate type prismarine-windows can create for this registry, or null. */
function createWindow (windows, spec) {
  for (const [type, slots] of spec.windows) {
    const w = windows.createWindow(1, type, spec.title, slots)
    if (w) return w
  }
  return null
}

/**
 * @param {object} bot injected bot
 * @param {{ require: Function, timeoutMs?: number, tradeListPacket?: string|null, freshBot?: () => Promise<object> }} opts
 *   `require` resolves prismarine-* the way this bot does (upstream: from mineflayer's dir);
 *   `freshBot` creates another injected bot, used after a probe left an opener pending.
 * @returns {Promise<Record<string, { status: 'ok'|'stub'|'unverified', members?: object, unit?: string, reason?: string }>>}
 */
async function probeWindows (bot, { require: req, timeoutMs = 300, tradeListPacket = null, freshBot = null }) {
  const results = {}
  let current = bot
  let dirty = false
  for (const spec of WINDOW_SPECS) {
    if (dirty) {
      if (!freshBot) {
        results[spec.cls] = { status: 'unverified', reason: 'skipped: an earlier window probe left an opener pending' }
        continue
      }
      current = await freshBot()
      dirty = false
    }
    const res = await probeOne(current, spec, { req, timeoutMs, tradeListPacket })
    dirty = !!res.dirty
    delete res.dirty
    results[spec.cls] = res
  }
  return results
}

async function probeOne (bot, spec, { req, timeoutMs, tradeListPacket }) {
  const opener = bot[spec.opener]
  if (typeof opener !== 'function') return { status: 'unverified', reason: `bot.${spec.opener} is missing` }
  if (opener.notImplemented === true) return { status: 'stub', unit: opener.unit }

  const registry = bot.registry
  let target, windows, window
  try {
    windows = req('prismarine-windows')(registry)
    window = createWindow(windows, spec)
    if (!window) return { status: 'unverified', reason: `prismarine-windows cannot create a ${spec.windows.map(w => w[0]).join('/')} window for this registry` }
    if (spec.block) {
      const Block = req('prismarine-block')(registry)
      const def = registry.blocksByName[spec.block]
      if (!def) return { status: 'unverified', reason: `no block '${spec.block}' in the registry` }
      target = Block.fromStateId(def.defaultState ?? def.minStateId, 0)
    } else {
      const Entity = req('prismarine-entity')(registry)
      const def = spec.entity.map(n => registry.entitiesByName[n]).find(Boolean)
      if (!def) return { status: 'unverified', reason: `no entity ${spec.entity.join('/')} in the registry` }
      target = new Entity(1234)
      target.entityType = def.id
      target.name = def.name
      target.type = def.type
      target.displayName = def.displayName
    }
  } catch (err) {
    return { status: 'unverified', reason: `cannot build the ${spec.cls} window/target: ${err.message}` }
  }

  const saved = { activateBlock: bot.activateBlock, activateEntity: bot.activateEntity }
  bot.activateBlock = async () => {}
  bot.activateEntity = async () => {}
  let settled = false
  try {
    const pending = Promise.resolve().then(() => opener.call(bot, target))
    pending.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    bot.currentWindow = window
    bot.emit('windowOpen', window)
    if (spec.entity && tradeListPacket) {
      await new Promise(resolve => setImmediate(resolve))
      bot._client.emit(tradeListPacket, { windowId: window.id, trades: [] })
    }
    const res = await withTimeout(pending, timeoutMs)
    if (res.timeout) return { status: 'unverified', dirty: true, reason: `bot.${spec.opener}() did not resolve within ${timeoutMs} ms of 'windowOpen'` }
    if (res.error) return { status: 'unverified', reason: `bot.${spec.opener}() rejected: ${res.error.message}` }
    if (!res.value || typeof res.value !== 'object') return { status: 'unverified', reason: `bot.${spec.opener}() resolved to ${res.value}` }
    const pristine = createWindow(windows, spec)
    return { status: 'ok', members: addedMembers(res.value, pristine) }
  } catch (err) {
    return { status: 'unverified', dirty: !settled, reason: `bot.${spec.opener}() threw: ${err.message}` }
  } finally {
    bot.activateBlock = saved.activateBlock
    bot.activateEntity = saved.activateEntity
    bot.currentWindow = null
    window.removeAllListeners()
  }
}

module.exports = { probeWindows, WINDOW_SPECS }
