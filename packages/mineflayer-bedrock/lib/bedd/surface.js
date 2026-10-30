// owner: BEDD-5 (bedd lifecycle, capability surface and BeddUnsupportedError)
'use strict'
const { BeddUnsupportedError } = require('./errors')

/**
 * The bot's API surface with `transport: 'bedd'` (a real Minecraft client hosted by Be.D.D.). Loaded by
 * `client.bedd.attach(bot)` (lib/bedd/index.js) through a guarded require: `attach(bot, client)`.
 *
 * The real client owns every serverbound packet; what bedboo would send becomes a BeDD op (lib/bedd/router.js). So
 * whether an API works depends on the ops the BeDD instance offers (`client.bedd.caps[op]` 'present' | 'disabled' |
 * 'absent'). {@link API} maps each bot API whose effect needs an op to its requirement:
 *   - an array of groups, ALL of which must be met; a group is a list of alternative ops, ANY of which must be
 *     'present' (`[['look', 'raw'], ['button', 'mouse']]`: an absolute or a raw look, and a button or a mouse click);
 *   - `'v2'`: no op does it yet (screen-level actions the user does on the client).
 * APIs not in the table (state reads, events, …) always work.
 *
 * `attach` (idempotent):
 *   - `bot.bedrock.bedd.caps` (live view of client.bedd.caps) and `bot.bedrock.bedd.supports(name)`;
 *   - wraps the `guard`ed members (item stack and screen-level APIs, whose packets the router cannot translate)
 *     with stubs that keep upstream's arity and sync/async behaviour: while the requirement is unmet they throw /
 *     reject a BeddUnsupportedError (ERR_BEDD_UNSUPPORTED) before sending anything (`noop` ones warn once instead),
 *     otherwise they call the real member (the item stack APIs then go through BeDD's `stack` op,
 *     lib/bedd/inventory.js). The other APIs are not wrapped: the router falls back op by op (`supports` tells);
 *   - `bot.end()` / `bot.quit()` only detach: the real client stays in its world;
 *   - options the real client owns (auth, host, port, viewDistance) are ignored with one warning each.
 */

const LOOK = ['look', 'raw']
const CLICK = ['button', 'mouse']
const MOVE = ['input', 'key']
const STACK = ['stack']
const HOTBAR = [['slot', 'key']]

/** @type {{ [api: string]: { needs: string[][] | 'v2', guard?: boolean, async?: boolean, noop?: boolean } }} */
const API = {
  // movement and look (router: `input` / `look`, falling back to keys / raw mouse)
  setControlState: { needs: [MOVE] },
  clearControlStates: { needs: [MOVE] },
  look: { needs: [LOOK] },
  lookAt: { needs: [LOOK] },
  dismount: { needs: [MOVE] },
  // hotbar (router: `slot`, falling back to keys 1-9)
  setQuickBarSlot: { needs: HOTBAR },
  // chat (router: `send`, falling back to the chat screen)
  chat: { needs: [['send', 'text']] },
  whisper: { needs: [['send', 'text']] },
  // actions (router_actions: look, then `button`, falling back to `mouse`)
  dig: { needs: [LOOK, CLICK] },
  stopDigging: { needs: [CLICK] },
  placeBlock: { needs: [LOOK, CLICK] },
  activateBlock: { needs: [LOOK, CLICK] },
  activateEntity: { needs: [LOOK, CLICK] },
  activateEntityAt: { needs: [LOOK, CLICK] },
  attack: { needs: [LOOK, CLICK] },
  mount: { needs: [LOOK, CLICK] },
  useOn: { needs: [LOOK, CLICK] },
  activateItem: { needs: [CLICK] },
  deactivateItem: { needs: [CLICK] },
  consume: { needs: [CLICK] },
  openContainer: { needs: [LOOK, CLICK] },
  openChest: { needs: [LOOK, CLICK] },
  openFurnace: { needs: [LOOK, CLICK] },
  openBlock: { needs: [LOOK, CLICK] },
  closeWindow: { needs: [['key']] },
  // item stack requests (lib/bedd/inventory.js: BeDD `stack` op)
  clickWindow: { needs: [STACK], guard: true, async: true },
  moveSlotItem: { needs: [STACK], guard: true, async: true },
  putAway: { needs: [STACK], guard: true, async: true },
  putSelectedItemRange: { needs: [STACK], guard: true, async: true },
  trade: { needs: [STACK], guard: true, async: true },
  transfer: { needs: [STACK], guard: true, async: true },
  craft: { needs: [STACK], guard: true, async: true },
  equip: { needs: [STACK], guard: true, async: true }, // an item already in the hotbar, to the hand: HOTBAR only
  unequip: { needs: [STACK], guard: true, async: true },
  toss: { needs: [STACK], guard: true, async: true },
  tossStack: { needs: [STACK], guard: true, async: true },
  'creative.setInventorySlot': { needs: [STACK], guard: true, async: true },
  'creative.clearSlot': { needs: [STACK], guard: true, async: true },
  'creative.clearInventory': { needs: [STACK], guard: true, async: true },
  // screen-level actions: the user does them on the client (v2: screen ops)
  writeBook: { needs: 'v2', guard: true, async: true },
  signBook: { needs: 'v2', guard: true, async: true },
  updateSign: { needs: 'v2', guard: true, async: false },
  // the user clicks Respawn on the client. bot.respawn() is a no-op with one warning rather than a throw: health.js
  // calls it from its packet listeners (the `respawn` option) on every health-0 update
  respawn: { needs: 'v2', guard: true, async: false, noop: true },
  // only detach (the real client stays connected)
  end: { needs: [] },
  quit: { needs: [] }
}

/** createBot options the real client owns */
const IGNORED_OPTIONS = ['auth', 'host', 'port', 'viewDistance']

const HOTBAR_START = 36

/**
 * @param {object} caps client.bedd.caps
 * @param {string[][] | 'v2'} needs
 * @returns {string[]} what is missing: [] when met, ['v2'], or the alternatives of the first unmet group
 */
function missingFor (caps, needs) {
  if (needs === 'v2') return ['v2']
  for (const group of needs) {
    if (!group.some(op => caps?.[op] === 'present')) return [...group]
  }
  return []
}

/**
 * @param {object} caps client.bedd.caps
 * @param {string} name a bot API (`'dig'`, `'creative.setInventorySlot'`) or a BeDD op (`'look'`)
 */
function supports (caps, name) {
  const entry = API[name]
  if (entry) return missingFor(caps, entry.needs).length === 0
  if (caps && Object.prototype.hasOwnProperty.call(caps, name)) return caps[name] === 'present'
  return true
}

function resolve (bot, path) {
  const parts = path.split('.')
  let owner = bot
  for (const part of parts.slice(0, -1)) {
    owner = owner?.[part]
    if (!owner || typeof owner !== 'object') return null
  }
  return { owner, key: parts[parts.length - 1] }
}

/** equip(item, destination) of an item already in the hotbar to the hand: a hotbar slot change, no stack request */
function equipsFromHotbar (bot, item, destination) {
  if ((destination ?? 'hand') !== 'hand') return false
  const found = typeof item === 'number' ? bot.inventory?.findInventoryItem?.(item) : item
  const start = bot.inventory?.hotbarStart ?? HOTBAR_START
  return !!found && typeof found.slot === 'number' && found.slot >= start && found.slot < start + 9
}

/**
 * Wrap the guarded members of `bot` (idempotent: a member already wrapped is left alone; a member a plugin
 * re-assigned since is wrapped again).
 */
function applyCapabilities (bot, client, state = surfaceState(bot, client)) {
  const caps = () => client.bedd?.caps ?? {}
  for (const [path, entry] of Object.entries(API)) {
    if (!entry.guard) continue
    const where = resolve(bot, path)
    if (!where) continue
    const original = where.owner[where.key]
    if (typeof original !== 'function' || original.beddSurface === true) continue
    const feature = `bot.${path}`
    const check = (args) => {
      const needs = path === 'equip' && equipsFromHotbar(bot, args[0], args[1]) ? HOTBAR : entry.needs
      const missing = missingFor(caps(), needs)
      return missing.length === 0 ? null : new BeddUnsupportedError(feature, { missing })
    }
    let wrapped
    if (entry.async) {
      wrapped = function (...args) {
        const err = check(args)
        if (err) return Promise.reject(err)
        return original.apply(this, args)
      }
    } else {
      wrapped = function (...args) {
        const err = check(args)
        if (err && entry.noop) {
          // respawn: upstream's no-op while alive; while dead the user clicks Respawn on the client
          if (path !== 'respawn' || !bot.isAlive) warnOnce(bot, state, path, `${feature}() does nothing with transport 'bedd': ${err.message}`)
          return
        }
        if (err) throw err
        return original.apply(this, args)
      }
    }
    Object.defineProperty(wrapped, 'name', { value: original.name || where.key })
    Object.defineProperty(wrapped, 'length', { value: original.length })
    wrapped.beddSurface = true
    wrapped.feature = feature
    wrapped.original = original
    where.owner[where.key] = wrapped
  }
  wrapEnd(bot, client, state)
}

/** bot.end() (and bot.quit(), which calls it) only detaches from the real client: no disconnect packet. */
function wrapEnd (bot, client, state) {
  if (typeof bot.end !== 'function' || bot.end.beddSurface === true) return
  const end = function end (reason) {
    if (state.detached) return
    state.detached = true
    // the bot's 'end' carries the reason (lib/loader.js), then the transport detaches
    client.emit('end', reason)
    if (typeof client.close === 'function') client.close()
  }
  end.beddSurface = true
  end.original = bot.end
  bot.end = end
}

function warnOnce (bot, state, key, message) {
  if (state.warned.has(key)) return
  state.warned.add(key)
  if (typeof bot._warn === 'function') bot._warn(message)
}

const STATE = Symbol('bedd.surface')

function surfaceState (bot, client) {
  if (!bot[STATE]) {
    Object.defineProperty(bot, STATE, { value: { client, warned: new Set(), detached: false, attached: false } })
  }
  return bot[STATE]
}

/** `bot.bedrock.bedd`: created here if missing (lib/bedd/follower.js adds `observed`) */
function exposeNamespace (bot, client) {
  bot.bedrock = bot.bedrock ?? {}
  const ns = bot.bedrock.bedd ?? (bot.bedrock.bedd = {})
  Object.defineProperty(ns, 'caps', { get: () => client.bedd?.caps ?? {}, enumerable: true, configurable: true })
  ns.supports = (name) => supports(client.bedd?.caps ?? {}, name)
  if (!('observed' in ns)) ns.observed = null // BeddExtras: lib/bedd/follower.js keeps it up to date
  return ns
}

function warnIgnoredOptions (bot, client, state) {
  const options = client.bedd?.options ?? client.options ?? {}
  for (const key of IGNORED_OPTIONS) {
    if (options[key] === undefined) continue
    warnOnce(bot, state, `option:${key}`, `createBot option '${key}' is ignored with transport 'bedd': the real client owns it`)
  }
}

/**
 * The real client's name, learnt from its player_list entry (on a server that comes after start_game, where the bot
 * took the createBot / fallback name): bot.username, the own entity and the own bot.players entry follow it. Runs
 * before the plugins see that player_list packet.
 */
function renameSelf (bot, username) {
  const old = bot.username
  if (!username || old === username) return
  bot.username = username
  if (bot.entity) bot.entity.username = username
  const player = bot.player
  if (!player) return
  if (bot.players?.[old] === player) delete bot.players[old]
  player.username = username
  if (bot.players) bot.players[username] = player
  if (player.uuid !== undefined && bot.uuidToUsername) bot.uuidToUsername[player.uuid] = username
  if (player.displayName?.extra?.[0]) player.displayName.extra[0].text = username
}

/**
 * Apply the bedd surface to `bot` (call with the bedd client, `client.bedd` set). Safe before the plugins are
 * injected (the members are wrapped once they are) and safe to call again.
 * @param {import('events').EventEmitter & { bedd?: object }} bot
 * @param {object} [client] defaults to bot._client
 */
function attach (bot, client = bot._client) {
  if (!client?.bedd) return null
  const state = surfaceState(bot, client)
  const ns = exposeNamespace(bot, client)
  applyCapabilities(bot, client, state)
  if (!state.attached) {
    state.attached = true
    warnIgnoredOptions(bot, client, state)
    client.on?.('bedd_self', ({ username }) => renameSelf(bot, username))
    // plugins inject on 'inject_allowed' (mineflayer's plugin loader listens first): wrap what they define
    bot.once('inject_allowed', () => applyCapabilities(bot, client, state))
  }
  return ns
}

module.exports = { attach, applyCapabilities, supports, missingFor, API, IGNORED_OPTIONS }
