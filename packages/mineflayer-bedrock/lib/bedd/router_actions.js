// owner: BEDD-3 (bedd action translation: dig, place, use, attack)
'use strict'
const { Vec3 } = require('vec3')
const { toBedrockYaw, toBedrockPitch, FACE_VECTORS } = require('../bedrock/conversions')
const { EYE_HEIGHT } = require('../bedrock/constants')
const { isBedd } = require('../bedrock/transactions')

/**
 * Turns the action packets bedboo would have sent into intents for the real client (transport 'bedd'): the client
 * looks where the packet points and presses the button, so it generates the authentic block actions and transactions
 * itself (crack overlay, swing, eating animation).
 *
 * - player_auth_input block_action:
 *   - start_break            → `look` inside the block at the face, then `button attack down releaseOn:blockChange`
 *   - abort_break/stop_break → `button attack up`
 *   - predict_break, crack_break, continue_break and the rest → dropped (the client times the break itself)
 * - inventory_transaction:
 *   - item_use click_block   → `look` at block_position + click_pos (waits for the reply), then `button use click`
 *   - item_use click_air     → items used by holding (food, potions, bow, crossbow, trident, shield, …): `button use
 *                              down`, held until item_release or the server's completed_using_item; any other item
 *                              (throwables, fishing rod, …): `button use click`
 *   - item_release           → `button use up`
 *   - item_use_on_entity     → `look` at the clicked point of the entity (its centre for attacks), then `button attack
 *                              click` / `button use click`
 * Without the `button` op the existing `mouse` op presses the mouse buttons instead (attack = left, use = right,
 * pick = middle). Without `look` the click goes where the client already looks (bot.lookAt came first). The
 * transaction's hand is not translated: the client uses its main hand (it has no off-hand use button).
 *
 * Composition with the core router (BEDD-2): handlers live in `client.bedd.routes` (a Map plus register(name, fn)),
 * created here when missing; a handler is called `fn(params, name)`. When no `client.bedd.route` exists, one is
 * installed that dispatches through the registry and drops unknown names. A handler registered under the same name
 * (the router's player_auth_input movement handler) is chained, before or after attach(): this module takes the action
 * part and passes the whole packet on. Ops of this module run one after another in the order the packets were routed
 * (a look always precedes its click); the router's own look for the same input carries (nearly) the same rotation,
 * since bedboo looked at the target before it acted.
 */

const ACTION_LOOK_TIMEOUT_MS = 1000
const MOUSE_BUTTONS = { attack: 'left', use: 'right', pick: 'middle' }
const BREAK_RELEASES = new Set(['abort_break', 'stop_break'])
/** items used by holding the use button (besides food): draw, charge, raise, look through, toot, drink, brush */
const HOLD_ITEMS = new Set(['bow', 'crossbow', 'trident', 'shield', 'spyglass', 'goat_horn', 'potion', 'honey_bottle',
  'milk_bucket', 'brush', 'ominous_bottle'])
const FULL_CUBE = [[0, 0, 0, 1, 1, 1]]
/** how far inside the clicked face a click aims (the face plane itself may graze an edge) */
const FACE_INSET = 0.02

/** `{ map, register(name, fn), get(name) }` — the shared route registry shape */
function createRegistry () {
  const map = new Map()
  return {
    map,
    register (name, fn) {
      map.set(name, fn)
      return fn
    },
    get: (name) => map.get(name)
  }
}

function lookupRoute (routes, name) {
  if (typeof routes.get === 'function') return routes.get(name)
  return routes.map?.get?.(name)
}

function num (v) {
  return Number(v ?? 0)
}

/** yaw/pitch in Bedrock degrees (player_auth_input convention) from `from` towards `to` */
function lookAngles (from, to) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const yaw = Math.atan2(-dx, -dz) // mineflayer radians, as bot.lookAt computes them
  const pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz))
  let bedrockYaw = toBedrockYaw(yaw) % 360
  if (bedrockYaw > 180) bedrockYaw -= 360
  if (bedrockYaw <= -180) bedrockYaw += 360
  return { yaw: bedrockYaw + 0, pitch: toBedrockPitch(pitch) + 0 } // + 0: no -0
}

/**
 * The point to aim at to hit `face` of the block at `position` with the collision `shapes` (relative boxes): the
 * centre of the shapes' bounding box, moved most of the way towards the face — inside the block, so slabs, carpets and
 * plants are hit and not the block behind them.
 */
function faceAimPoint (position, face, shapes) {
  const boxes = shapes?.length ? shapes : FULL_CUBE
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const box of boxes) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], box[i])
      max[i] = Math.max(max[i], box[i + 3])
    }
  }
  const dir = FACE_VECTORS[face] ?? FACE_VECTORS[1]
  const d = [dir.x, dir.y, dir.z]
  const at = [0, 1, 2].map((i) => (min[i] + max[i]) / 2 + d[i] * ((max[i] - min[i]) / 2) * 0.8)
  return { x: num(position.x) + at[0], y: num(position.y) + at[1], z: num(position.z) + at[2] }
}

/**
 * @param {object} bot
 * @param {object} client the bedd client (`client.bedd = { rpc, caps, … }`)
 * @returns {{ translate(name, params): boolean, idle(): Promise<void> } | null}
 */
function attach (bot, client) {
  const bedd = client?.bedd
  if (!bedd) return null
  const routes = (bedd.routes ??= createRegistry())
  if (typeof bedd.route !== 'function') {
    bedd.route = function route (name, params) {
      const fn = lookupRoute(routes, name)
      if (typeof fn === 'function') return fn(params, name)
      // unknown names are dropped
    }
  }

  const present = (op) => (bedd.caps ?? {})[op] === 'present'
  const call = (op, args) => bedd.rpc.call(op, args)
  let chain = Promise.resolve()
  /** a use the client holds down (click_air of a hold item), released by item_release or completed_using_item */
  let useHeld = false

  function warn (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    if (client.listenerCount?.('warning')) client.emit('warning', error)
  }

  /** run `steps` (an async function) after every op queued before it */
  function enqueue (steps) {
    chain = chain.then(steps).catch(warn)
    return chain
  }

  async function look (target) {
    if (!present('look') || !bot.entity?.position) return
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? EYE_HEIGHT, 0)
    const { yaw, pitch } = lookAngles(eye, target)
    try {
      await call('look', { yaw, pitch, timeoutMs: ACTION_LOOK_TIMEOUT_MS })
    } catch (err) {
      warn(err) // the aim may be off (look timed out / refused): the click still goes where the client looks
    }
  }

  async function button (name, action, extra = {}) {
    if (present('button')) return call('button', { button: name, action, ...extra })
    return call('mouse', { action, button: MOUSE_BUTTONS[name] })
  }

  function releaseUse () {
    if (!useHeld) return
    useHeld = false
    enqueue(() => button('use', 'up'))
  }

  function isHoldItem (heldItem) {
    const id = heldItem?.network_id
    if (!id) return false
    const name = bot.registry?.items?.[id]?.name
    if (!name) return false
    return HOLD_ITEMS.has(name) || !!bot.registry.foodsByName?.[name]
  }

  function onBlockActions (actions) {
    for (const a of actions ?? []) {
      if (a.action === 'start_break') {
        const p = a.position
        const block = bot.blockAt?.(new Vec3(num(p.x), num(p.y), num(p.z)), false)
        const target = faceAimPoint(p, a.face, block?.shapes)
        enqueue(async () => {
          await look(target)
          await button('attack', 'down', { releaseOn: 'blockChange' })
        })
      } else if (BREAK_RELEASES.has(a.action)) {
        enqueue(() => button('attack', 'up'))
      }
      // predict_break / crack_break / continue_break / …: the client times the break itself
    }
  }

  function findEntity (runtimeId) {
    let id
    try {
      id = BigInt(runtimeId)
    } catch (_) {
      return null
    }
    const keyed = bot.entities?.[Number(id)] // entities.js keys bot.entities by runtime id
    if (keyed) return keyed
    for (const entity of Object.values(bot.entities ?? {})) {
      const rid = entity?.runtimeId ?? entity?.id
      if (rid === undefined || rid === null) continue
      try {
        if (BigInt(rid) === id) return entity
      } catch (_) {}
    }
    return null
  }

  /** @returns {boolean} whether the transaction was translated */
  function onTransaction (params) {
    const t = params?.transaction
    const data = t?.transaction_data
    if (!t || !data) return false
    if (t.transaction_type === 'item_use') {
      if (data.action_type === 'click_block') {
        const bp = data.block_position
        const cp = data.click_pos ?? { x: 0.5, y: 0.5, z: 0.5 }
        const dir = FACE_VECTORS[data.face] ?? { x: 0, y: 0, z: 0 }
        const target = {
          x: num(bp.x) + num(cp.x) - dir.x * FACE_INSET,
          y: num(bp.y) + num(cp.y) - dir.y * FACE_INSET,
          z: num(bp.z) + num(cp.z) - dir.z * FACE_INSET
        }
        enqueue(async () => {
          await look(target)
          await button('use', 'click')
        })
        return true
      }
      if (data.action_type === 'click_air') {
        if (isHoldItem(data.held_item)) {
          if (!useHeld) {
            useHeld = true
            enqueue(() => button('use', 'down'))
          }
        } else {
          releaseUse()
          enqueue(() => button('use', 'click'))
        }
        return true
      }
      return false
    }
    if (t.transaction_type === 'item_release') {
      useHeld = true // release even when the press was not routed here
      releaseUse()
      return true
    }
    if (t.transaction_type === 'item_use_on_entity') {
      const entity = findEntity(data.entity_runtime_id)
      const which = data.action_type === 'attack' ? 'attack' : 'use'
      // click_pos is relative to the entity's feet (attack: half its height; activateEntityAt: the given point)
      const cp = data.click_pos
      const clicked = cp && (num(cp.x) !== 0 || num(cp.y) !== 0 || num(cp.z) !== 0)
      let target = null
      if (entity?.position) {
        target = clicked
          ? entity.position.offset(num(cp.x), num(cp.y), num(cp.z))
          : entity.position.offset(0, (entity.height ?? 0) / 2, 0)
      }
      enqueue(async () => {
        if (target) await look(target)
        await button(which, 'click')
      })
      return true
    }
    return false
  }

  const handlers = {
    // the action part is ours, the movement / look part goes on to the router
    player_auth_input: (params) => {
      if (params?.block_action?.length) onBlockActions(params.block_action)
      return false
    },
    inventory_transaction: (params) => onTransaction(params)
  }
  const ours = new Set()

  /** register where the registry does not hold our handler (yet, or any more): the handler found there is chained */
  function install () {
    for (const [name, handler] of Object.entries(handlers)) {
      const previous = lookupRoute(routes, name)
      if (ours.has(previous)) continue
      const fn = function routeAction (params, routedName = name) {
        const handled = isBedd(bot) ? handler(params) : false
        if (typeof previous === 'function' && handled !== true) return previous(params, routedName)
      }
      ours.add(fn)
      routes.register(name, fn)
    }
  }
  install()
  // the core router may register its handlers after this module (attach order): chain onto them as well
  setImmediate(install)
  bot.once?.('login', install)
  // the client finished a use itself (eaten, drunk): its button is up again
  client.on?.('completed_using_item', () => {
    if (useHeld && isBedd(bot)) releaseUse()
  })

  return {
    /** translate one packet directly (tests / other routers); true when it became intents */
    translate (name, params) {
      if (name === 'player_auth_input') {
        onBlockActions(params?.block_action)
        return !!params?.block_action?.length
      }
      if (name === 'inventory_transaction') return onTransaction(params)
      return false
    },
    /** settles once every op queued so far was answered */
    idle: () => chain
  }
}

module.exports = { attach, createRegistry, lookAngles, faceAimPoint }
