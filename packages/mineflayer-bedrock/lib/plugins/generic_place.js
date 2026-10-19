// owner: U11 (placing & placement-based parity)
// Adapted from mineflayer 4.39.0 lib/plugins/generic_place.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): the held-item checks, the look at the face center (half / delta /
// forceLook), the arm swing and the resolved value are kept verbatim; the packet is Bedrock's.
// Surface: bot._genericPlace(referenceBlock, faceVector, options) options {half, delta, forceLook, offhand, swingArm,
//   showHand} → Promise<Vec3> (the reference block's position), resolved as soon as the click is sent (like upstream:
//   callers wait for the server's answer themselves)
// Bedrock (lib/bedrock/placement.js, measured on BDS 1.26.51.1 — docs/differences/U11.md#placement-protocol):
// - the click is player_action start_item_use_on → inventory_transaction item_use click_block (exact held item from
//   bot._bedrock.heldNetworkItem(), the reference block's runtime id, the click position on the face = the look target,
//   the face, the hotbar slot, the hand, the EYE-level player position) → stop_item_use_on 150 ms later;
// - against an interactive block (chest, crafting table, furnace, door, button, sign, …) the use action would win:
//   the bot holds the sneak control, waits until it went out with a player_auth_input (the click must follow it) and
//   the server acknowledged `sneaking` in set_entity_data (not while flying: the raw sneak keys count there), clicks,
//   then releases the sneak it pressed (upstream's "TODO: tell the server that we are sneaking while doing this");
// - jump-placing under the feet (mineflayer-pathfinder's pillar): BDS refuses a block that intersects the player's
//   server-side hitbox; while the bot rises out of the destination block or keeps jumping, the click waits (≤ 20
//   inputs) for the first input whose hitbox is clear of it, then follows that input;
// - bot._bedrock.placement: { click, flushStop, raycast, isInteractive, blockTargetOf, useOnLookedAtBlock(item,
//   offHand), sneakForClick } for place_entity.js and item use on blocks (buckets, boats: BDS ignores their click_air;
//   bot.activateItem can delegate to useOnLookedAtBlock).
'use strict'
const assert = require('assert')
const { isStub } = require('../bedrock/errors')
const placement = require('../bedrock/placement')

module.exports = inject

/**
 * ms to wait for the server's `sneaking` acknowledgement before clicking anyway (it normally comes within one round
 * trip + a tick; the input order alone already makes BDS see the sneak before the click)
 */
const SNEAK_ACK_TIMEOUT = 300
/** inputs to wait at most for the hitbox to rise out of the destination block (a jump lasts ~12 ticks) */
const CLEARANCE_TICKS = 20
/** ms to wait at most for one input to be sent */
const TICK_TIMEOUT = 200

function inject (bot) {
  const placer = placement.createPlacer(bot)
  // placements in flight that hold the sneak control this plugin pressed (released when the last one clicked)
  let sneakHolds = 0

  const implemented = (fn) => typeof fn === 'function' && !isStub(fn)

  /** resolves once the next player_auth_input was sent (or after `timeout` ms) */
  function nextInputSent (timeout = 200) {
    const input = bot._bedrock?.input
    return new Promise((resolve) => {
      let unsubscribe = null
      const timer = setTimeout(done, timeout)
      function done () {
        clearTimeout(timer)
        unsubscribe?.()
        resolve()
      }
      unsubscribe = typeof input?.onSent === 'function' ? input.onSent(done) : null
    })
  }

  /** resolves once the control states set so far went out with a player_auth_input (W3-FIX-A hook when present) */
  function controlsSent () {
    const physics = bot._bedrock?.physics
    if (typeof physics?.controlsSent === 'function') return Promise.resolve(physics.controlsSent()).catch(() => {})
    return nextInputSent()
  }

  /**
   * resolves once the server reports the bot sneaking (set_entity_data flags.sneaking → entityCrouch), false on
   * timeout; `fresh`: only an acknowledgement from now on counts (after our own press, `crouching` may still be the
   * state before a release whose echo has not arrived yet)
   */
  function sneakAcknowledged ({ fresh = false, timeout = SNEAK_ACK_TIMEOUT } = {}) {
    if (!fresh && bot.entity?.crouching) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), timeout)
      function onCrouch (entity) {
        if (entity === bot.entity) finish(true)
      }
      function onEnd () { finish(false) }
      function finish (ok) {
        clearTimeout(timer)
        bot.removeListener('entityCrouch', onCrouch)
        bot.removeListener('end', onEnd)
        resolve(ok)
      }
      bot.on('entityCrouch', onCrouch)
      bot.on('end', onEnd)
    })
  }

  function isFlying () {
    return !!bot._bedrock?.physics?.isFlying?.()
  }

  /** the bot's hitbox (feet position, width, height) intersects the block at `dest` */
  function intersectsSelf (dest) {
    const entity = bot.entity
    if (!entity?.position) return false
    const p = entity.position
    const w = (entity.width ?? 0.6) / 2
    const h = entity.height ?? 1.8
    return p.x + w > dest.x && p.x - w < dest.x + 1 &&
      p.y + h > dest.y && p.y < dest.y + 1 &&
      p.z + w > dest.z && p.z - w < dest.z + 1
  }

  /**
   * Jump-placing under the feet (mineflayer-pathfinder's pillar): BDS refuses a block that intersects the player where
   * the server simulated it at the click, and pathfinder clicks as soon as the feet left the ground. While the bot
   * rises out of the destination block — or keeps jumping (jump control held, how pathfinder pillars: it clicks
   * again while falling back) — wait (≤ CLEARANCE_TICKS inputs) until an input with the hitbox clear of it was sent:
   * the click then follows that input. A bot that will not clear the block (standing, falling without jumping) clicks
   * at once and gets the server's refusal like upstream.
   */
  async function waitForClearance (dest) {
    for (let i = 0; i < CLEARANCE_TICKS && intersectsSelf(dest); i++) {
      const entity = bot.entity
      if (bot.vehicle || isFlying()) return
      const rising = !entity.onGround && entity.velocity?.y > 0
      const jumping = implemented(bot.getControlState) && bot.getControlState('jump')
      if (!rising && !jumping) return
      await nextInputSent(TICK_TIMEOUT)
    }
  }

  /**
   * Make sure the server sees the bot sneaking before a click on an interactive block. Returns the function that
   * undoes what was done here (releases the sneak control if this call pressed it).
   */
  async function sneakForClick (referenceBlock) {
    const noop = () => {}
    if (!placement.isInteractive(referenceBlock)) return noop
    if (!implemented(bot.setControlState) || !bot.entity) return noop
    // sneaking while riding dismounts on Bedrock: the use action of the block wins there (like on the vanilla client)
    if (bot.vehicle) return noop
    // a sneak held by the caller (e.g. mineflayer-pathfinder) stays theirs; ours is shared by concurrent placements
    if (sneakHolds === 0 && bot.getControlState('sneak')) {
      await controlsSent()
      if (!isFlying()) await sneakAcknowledged()
      return noop
    }
    const pressed = sneakHolds === 0
    sneakHolds++
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (--sneakHolds === 0) bot.setControlState('sneak', false)
    }
    try {
      if (pressed) bot.setControlState('sneak', true)
      // the sneak keys reach BDS with the next player_auth_input (packets keep their order): the click must follow it.
      // A flying player has no `sneaking` state, the raw sneak keys are what the server checks; otherwise also wait
      // for the server's acknowledgement (set_entity_data sneaking) of this press.
      await controlsSent()
      if (!isFlying()) await sneakAcknowledged({ fresh: pressed })
    } catch (err) {
      release()
      throw err
    }
    return release
  }

  /**
   *
   * @param {import('prismarine-block').Block} referenceBlock
   * @param {import('vec3').Vec3} faceVector
   * @param {{half?: 'top'|'bottom', delta?: import('vec3').Vec3, forceLook?: boolean | 'ignore', offhand?: boolean, swingArm?: 'right' | 'left', showHand?: boolean}} options
   */
  async function _genericPlace (referenceBlock, faceVector, options) {
    let handToPlaceWith = 'main_hand'
    if (options.offhand) {
      if (!bot.inventory.slots[45]) {
        throw new Error('must be holding an item in the off-hand to place')
      }
      handToPlaceWith = 'off_hand'
    } else if (!bot.heldItem) {
      throw new Error('must be holding an item to place')
    }

    // Look at the center of the face
    let dx = 0.5 + faceVector.x * 0.5
    let dy = 0.5 + faceVector.y * 0.5
    let dz = 0.5 + faceVector.z * 0.5
    if (dy === 0.5) {
      if (options.half === 'top') dy += 0.25
      else if (options.half === 'bottom') dy -= 0.25
    }
    if (options.delta) {
      dx = options.delta.x
      dy = options.delta.y
      dz = options.delta.z
    }
    if (options.forceLook !== 'ignore') {
      await bot.lookAt(referenceBlock.position.offset(dx, dy, dz), options.forceLook)
    }
    const pos = referenceBlock.position

    // Bedrock: the server must see us sneaking, or the block's use action wins (upstream: "TODO: tell the server that
    // we are sneaking while doing this")
    const releaseSneak = await sneakForClick(referenceBlock)
    try {
      // Bedrock: the previous click must have been answered (its new held-item stack id) before this one goes out
      // (U16a: back-to-back / concurrent placements)
      const releaseTurn = await placer.acquire()
      try {
        // Bedrock: a jump-placement under the feet waits until the hitbox rose out of the destination (right before
        // the click: nothing else is awaited after it)
        await waitForClearance(pos.plus(faceVector))

        if (options.swingArm) {
          bot.swingArm(options.swingArm, options.showHand)
        }

        placer.click({
          position: pos,
          face: vectorToDirection(faceVector),
          cursor: { x: dx, y: dy, z: dz },
          hand: handToPlaceWith,
          heldItem: handToPlaceWith === 'off_hand' ? offhandNetworkItem() : undefined
        })
      } finally {
        releaseTurn()
      }
    } finally {
      // the release reaches the server with the next input, after the click (packets keep their order)
      releaseSneak()
    }

    return pos
  }

  /** the server copy of the item in hotbar slot `slot` (undefined: let the transaction take the held item) */
  function slotNetworkItem (slot) {
    const provider = bot._bedrock?.heldNetworkItem
    return typeof slot === 'number' && typeof provider?.slot === 'function' ? provider.slot(slot) : undefined
  }

  function offhandNetworkItem () {
    const provider = bot._bedrock?.heldNetworkItem
    return typeof provider?.offhand === 'function' ? provider.offhand() : undefined
  }

  /**
   * Item use on the looked-at block (Bedrock): BDS ignores the click_air of buckets and boats, the vanilla client
   * clicks the block under the crosshair instead (liquids included where the item acts on them). Meant for
   * bot.activateItem (lib/plugins/inventory.js, not U11's file). Returns false when `item` is not such an item or
   * nothing is in reach (the caller then sends its click_air).
   */
  function useOnLookedAtBlock (item, offHand = false) {
    const target = placement.blockTargetOf(item?.name)
    if (!target || !bot.entity) return false
    return clickLookedAt(target.liquids, offHand)
  }

  /**
   * click the face of the first block along the look (`liquids`: see placement.raycast); false when none in reach. The
   * target is taken now; the click goes out once the previous click was answered (at once when none is pending).
   */
  function clickLookedAt (liquids, offHand) {
    const hit = placement.raycast(bot, { liquids })
    if (!hit) return false
    // a deferred click keeps the hotbar slot of the call (its item as the server has it by then)
    const hotbarSlot = bot.quickBarSlot
    const click = () => placer.click({
      position: hit.position,
      face: hit.face,
      cursor: { x: hit.cursor.x, y: hit.cursor.y, z: hit.cursor.z },
      hand: offHand ? 'off_hand' : 'main_hand',
      hotbarSlot,
      heldItem: offHand ? offhandNetworkItem() : slotNetworkItem(hotbarSlot)
    })
    if (!placer.waiting()) {
      click() // nothing unanswered: synchronous, like the click_air it replaces
      return true
    }
    placer.acquire().then((releaseTurn) => {
      try {
        click()
      } finally {
        releaseTurn()
      }
    }).catch((err) => bot.emit('error', err))
    return true
  }

  /**
   * Bedrock recovery around the vendored place_block.js (U16a): BDS refuses a click whose block runtime id is not the
   * server's state of the clicked block — which happens when the server changed it right before (farmland and grass
   * paths turn into dirt under a placed block one tick after the placement). The answer to the click discloses it
   * (placer.stale): such a refusal is retried once with the block as it is now. A click that changed the clicked block
   * itself (a replaceable block, a slab merged into a double slab, …) is not stale: it rejects like upstream after one
   * click (FINAL-FIX-LIB).
   * BDS likewise refuses a click whose held item the server changed meanwhile (a pickup or /give merged into the held
   * stack: new stack id, placer.staleHeld; Java's block_place carries no item): retried once with the server's copy.
   */
  function withStaleRetry (placeBlockWithOptions) {
    return async function _placeBlockWithOptions (referenceBlock, faceVector, options) {
      try {
        return await placeBlockWithOptions(referenceBlock, faceVector, options)
      } catch (err) {
        if (!/^Server refused to place/.test(err?.message ?? '')) throw err
        if (!placer.stale(referenceBlock.position) && !placer.staleHeld(referenceBlock.position)) throw err
        const fresh = bot.blockAt(referenceBlock.position)
        if (!fresh || fresh.type === bot.registry.blocksByName.air?.id) throw err
        return await placeBlockWithOptions(fresh, faceVector, options)
      }
    }
  }
  if (implemented(bot._placeBlockWithOptions)) {
    // place_block.js is injected before this plugin (loader order); its placeBlock calls its own copy, so both go
    const placeBlockWithOptions = withStaleRetry(bot._placeBlockWithOptions)
    bot._placeBlockWithOptions = placeBlockWithOptions
    bot.placeBlock = async function placeBlock (referenceBlock, faceVector) {
      await placeBlockWithOptions(referenceBlock, faceVector, { swingArm: 'right' })
    }
  }

  bot._genericPlace = _genericPlace
  if (bot._bedrock) {
    bot._bedrock.placement = {
      click: placer.click,
      acquire: placer.acquire,
      stale: placer.stale,
      staleHeld: placer.staleHeld,
      flushStop: placer.flushStop,
      raycast: (opts) => placement.raycast(bot, opts),
      isInteractive: placement.isInteractive,
      blockTargetOf: placement.blockTargetOf,
      useOnLookedAtBlock,
      sneakForClick
    }
  }
  bot.on('end', () => placer.reset())
}

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

module.exports.vectorToDirection = vectorToDirection
