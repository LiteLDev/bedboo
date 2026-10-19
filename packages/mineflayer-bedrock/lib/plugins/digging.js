// owner: U10 (digging)
// Adapted from mineflayer 4.39.0 lib/plugins/digging.js (MIT, Copyright (c) 2013 Andrew Kelley): dig() argument checks,
//   digFace vector / 'raycast' face selection, the look, the swing interval, stopDigging (+ the Java cancellation-face
//   oddity), the death handler, canDigBlock, digTime's inputs and _getBlockAtEyeLevel are kept; Java's block_dig packets
//   are replaced by Bedrock block actions and the completion waits for the server.
// Surface: bot.targetDigBlock, bot.targetDigFace, bot.lastDigTime, bot.dig(block, forceLook, digFace),
//   bot.stopDigging() (no-op while not digging, as upstream), bot.canDigBlock(block), bot.digTime(block),
//   bot._getBlockAtEyeLevel()
// Events: 'diggingCompleted' (block), 'diggingAborted' (block)
// Bedrock (BDS 1.26.51.1, measured live — docs/differences/U10.md#protocol):
// - server-authoritative breaking (start_game.server_authoritative_block_breaking, always true on BDS): block actions
//   ride player_auth_input (bot._bedrock.input.queueBlockAction). `start_break` = the mouse is pressed on the block:
//   from that input on BDS adds the break progress itself every tick (start tick included) and destroys the block in
//   the tick the progress reaches 1, while the break is held — no per-tick action is needed (`continue_break` is a
//   restart on BDS: it sends block_stop_break + block_start_break to every viewer each tick, so it is not sent).
//   `predict_break` (the client's "it broke") is accepted from the input in which BDS completes the break; an
//   earlier one is answered with an update_block restoring the block. It goes out when BDS' own progress reports
//   (level_event block_break_speed, one per server tick) show the break one tick from done — the earliest accepted
//   input while client and server run in step, later when the server runs behind, never early; without reports:
//   our own count, one input after the completing one (one tick of margin). Completion = the
//   server's update_block turning the block into air (or a liquid: waterlogged blocks, ice); then `abort_break`
//   releases the server's break state — without it BDS keeps breaking whatever is placed at that position later —
//   and the dig settles once that input went out.
//   stopDigging = `abort_break`. The tool's Damage comes back as inventory_slot (no `mine_block` stack request: BDS
//   only accepts one in the exact tick the break completes, and syncs the durability itself without it).
// - creative: start_break + predict_break in one input (BDS breaks instantly, no drops).
// - legacy servers (server_authoritative_block_breaking false): start_break, crack_break every tick, then
//   stop_break + an item_use `break_block` transaction after digTime, the block predicted locally like upstream.
// - digTime: lib/bedrock/dig_speed.js (Bedrock Haste / Conduit Power / Mining Fatigue factors); the speed BDS
//   reports for the break (level_event block_start_break / block_break_speed data) replaces the estimate when they
//   disagree. bot._bedrock.digging = { active(), last, history } keeps per-dig diagnostics (tests).
'use strict'
const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const BlockFaces = require('prismarine-world').iterators.BlockFace
const { createTask } = require('mineflayer/lib/promise_utils')
const digSpeed = require('../bedrock/dig_speed')
const { buildUseItemOn } = require('../bedrock/transactions')

module.exports = inject

/** ticks without any sign of the server breaking the block (after predict_break) before giving up */
const CONFIRM_TIMEOUT_TICKS = 40
const SWING_INTERVAL_MS = 350
/** a broken block may turn into a liquid (waterlogged blocks, kelp, ice; a bubble column over soul sand / magma) */
const LIQUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'bubble_column'])
/** blocks a dig only partly removes (one egg of several): any other state of the same block completes the dig */
const PARTIAL_BREAKS = new Set(['turtle_egg'])
const HISTORY_SIZE = 32
/** float sums of the per-tick progress (e.g. 15 × 1/15) may land just under 1 */
const PROGRESS_EPSILON = 1e-9
/** inputs BDS gets to report its break progress before the client-side count may time predict_break */
const REPORT_GRACE_INPUTS = 3
/** inputs after predict_break in which an unchanged update_block of the block counts as BDS restoring it */
const RESTORE_WINDOW_INPUTS = 4
/** a completed dig settles once its abort_break went out, or after this long (input suspended) */
const RELEASE_TIMEOUT_MS = 250

function inject (bot) {
  let swingInterval = null
  /** the dig in progress (protocol state), null while idle */
  let current = null
  /** completed digs waiting for their abort_break to go out: { position, finish, timer } */
  const releases = []
  const history = []

  bot.targetDigBlock = null
  bot.targetDigFace = null
  bot.lastDigTime = null

  const input = () => bot._bedrock.input
  const airType = () => bot.registry.blocksByName.air.id

  function serverAuthoritative () {
    return bot._bedrock?.startGame?.server_authoritative_block_breaking !== false
  }

  function queueAction (action, position, face) {
    input().queueBlockAction({ action, position, face })
  }

  function samePosition (a, b) {
    return Math.floor(a.x) === b.x && Math.floor(a.y) === b.y && Math.floor(a.z) === b.z
  }

  /** the face the line of sight from the eyes to the block center enters the block through */
  function faceTowardsEyes (position) {
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
    const center = position.offset(0.5, 0.5, 0.5)
    const d = center.minus(eye)
    let best = null
    for (const [axis, neg, pos] of [['x', BlockFaces.WEST, BlockFaces.EAST], ['y', BlockFaces.BOTTOM, BlockFaces.TOP], ['z', BlockFaces.NORTH, BlockFaces.SOUTH]]) {
      if (d[axis] === 0) continue
      const plane = d[axis] > 0 ? position[axis] : position[axis] + 1
      const t = (plane - eye[axis]) / d[axis]
      if (!best || t > best.t) best = { t, face: d[axis] > 0 ? neg : pos }
    }
    return best && best.t >= 0 ? best.face : BlockFaces.TOP
  }

  function isBroken (newBlock, dug) {
    if (newBlock.type === airType() || LIQUIDS.has(newBlock.name)) return true
    return PARTIAL_BREAKS.has(dug.name) && newBlock.type === dug.type && newBlock.stateId !== dug.stateId
  }

  function record (state, outcome) {
    const entry = {
      outcome,
      block: state.block.name,
      position: state.position.clone(),
      face: state.face,
      creative: state.creative,
      legacy: state.legacy,
      digTime: state.digTime,
      ticks: state.ticks,
      startTick: state.startTick === null ? null : Number(state.startTick),
      predictIndex: state.predictIndex,
      endIndex: state.index,
      startedAt: state.startedAt,
      endedAt: performance.now(),
      speedData: digSpeed.speedData(state.delta),
      serverSpeedData: state.serverData,
      restores: state.restores
    }
    bot._bedrock.digging.last = entry
    history.push(entry)
    if (history.length > HISTORY_SIZE) history.shift()
    return entry
  }

  async function dig (block, forceLook, digFace) {
    if (block === null || block === undefined) {
      throw new Error('dig was called with an undefined or null block')
    }

    if (!digFace || typeof digFace === 'function') {
      digFace = 'auto'
    }

    const waitTime = bot.digTime(block)
    if (waitTime === Infinity) {
      throw new Error(`dig time for ${block?.name ?? block} is Infinity`)
    }

    bot.targetDigFace = 1 // Default (top)
    let face = 1 // this dig's face (bot.targetDigFace is cleared when a previous dig stops or finishes meanwhile)

    if (forceLook !== 'ignore') {
      if (digFace?.x || digFace?.y || digFace?.z) {
        // Determine the block face the bot should mine
        if (digFace.x) {
          bot.targetDigFace = face = digFace.x > 0 ? BlockFaces.EAST : BlockFaces.WEST
        } else if (digFace.y) {
          bot.targetDigFace = face = digFace.y > 0 ? BlockFaces.TOP : BlockFaces.BOTTOM
        } else if (digFace.z) {
          bot.targetDigFace = face = digFace.z > 0 ? BlockFaces.SOUTH : BlockFaces.NORTH
        }
        await bot.lookAt(
          block.position.offset(0.5, 0.5, 0.5).offset((digFace.x ?? 0) * 0.5, (digFace.y ?? 0) * 0.5, (digFace.z ?? 0) * 0.5),
          forceLook
        )
      } else if (digFace === 'raycast') {
        // Check faces that could be seen from the current position. If the delta is smaller then 0.5 that means the
        // bot can most likely not see the face as the block is 1 block thick
        // this could be false for blocks that have a smaller bounding box than 1x1x1
        const dx = bot.entity.position.x - (block.position.x + 0.5)
        const dy = bot.entity.position.y + bot.entity.eyeHeight - (block.position.y + 0.5)
        const dz = bot.entity.position.z - (block.position.z + 0.5)
        // Check y first then x and z
        const visibleFaces = {
          y: Math.sign(Math.abs(dy) > 0.5 ? dy : 0),
          x: Math.sign(Math.abs(dx) > 0.5 ? dx : 0),
          z: Math.sign(Math.abs(dz) > 0.5 ? dz : 0)
        }
        const validFaces = []
        const closerBlocks = []
        for (const i in visibleFaces) {
          if (!visibleFaces[i]) continue // skip as this face is not visible
          // target position on the target block face. -> 0.5 + (current face) * 0.5
          const targetPos = block.position.offset(
            0.5 + (i === 'x' ? visibleFaces[i] * 0.5 : 0),
            0.5 + (i === 'y' ? visibleFaces[i] * 0.5 : 0),
            0.5 + (i === 'z' ? visibleFaces[i] * 0.5 : 0)
          )
          const startPos = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
          const rayBlock = bot.world.raycast(startPos, targetPos.clone().subtract(startPos).normalize(), 5)
          if (rayBlock) {
            if (startPos.distanceTo(rayBlock.intersect) < startPos.distanceTo(targetPos)) {
              // Block is closer then the raycasted block
              closerBlocks.push(rayBlock)
              // continue since if distance is ever less, then we did not intersect the block we wanted,
              // meaning that the position of the intersected block is not what we want.
              continue
            }
            const rayPos = rayBlock.position
            if (
              rayPos.x === block.position.x &&
              rayPos.y === block.position.y &&
              rayPos.z === block.position.z
            ) {
              validFaces.push({
                face: rayBlock.face,
                targetPos: rayBlock.intersect
              })
            }
          }
        }

        if (validFaces.length > 0) {
          // Chose closest valid face
          let closest
          let distSqrt = 999
          for (const i in validFaces) {
            const tPos = validFaces[i].targetPos
            const cDist = new Vec3(tPos.x, tPos.y, tPos.z).distanceSquared(
              bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
            )
            if (distSqrt > cDist) {
              closest = validFaces[i]
              distSqrt = cDist
            }
          }
          await bot.lookAt(closest.targetPos, forceLook)
          bot.targetDigFace = face = closest.face
        } else if (closerBlocks.length === 0 && block.shapes.length === 0) {
          // no other blocks were detected and the block has no shapes.
          // The block in question is replaceable (like tall grass) so we can just dig it
          // TODO: do AABB + ray intercept check to this position for digFace.
          await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook)
        } else {
          // Block is obstructed return error?
          throw new Error('Block not in view')
        }
      } else {
        // Bedrock: the face the line of sight hits, like the vanilla client (upstream sends 1, the top face)
        bot.targetDigFace = face = faceTowardsEyes(block.position)
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook)
      }
    }

    // In vanilla the client will cancel digging the current block once the other block is at the crosshair.
    // Todo: don't wait until lookAt is at middle of the block, but at the edge of it.
    if (bot.targetDigBlock) bot.stopDigging()
    bot.targetDigFace = face

    const task = createTask()
    const position = new Vec3(Math.floor(block.position.x), Math.floor(block.position.y), Math.floor(block.position.z))
    const creative = bot.game?.gameMode === 'creative'
    // the speed as of now (after the look): it decides the instant break and drives the per-tick progress
    const delta = currentDelta(block)
    const state = {
      block,
      position,
      face,
      creative,
      legacy: !serverAuthoritative(),
      digTime: waitTime,
      ticks: creative ? 0 : digSpeed.ticksFor(delta),
      delta,
      serverSpeed: null,
      serverData: null,
      lastServerIndex: null, // the last input after which BDS reported progress on this block
      serverProgress: 0, // BDS' progress from its per-tick block_break_speed reports
      serverTicks: 0,
      index: -1, // inputs sent since (and including) the one carrying start_break
      startTick: null,
      startedAt: null,
      progress: 0,
      predicted: false,
      predictIndex: null,
      restores: 0,
      done: false
    }
    current = state
    bot.targetDigBlock = block

    queueAction('start_break', position, face)
    if (state.legacy) {
      // client-authoritative breaking: finish after digTime, predicting the block locally like upstream
      state.timer = setTimeout(() => finishLegacy(state), waitTime)
    } else if (creative || delta >= 1) {
      // instant break (creative, or progress ≥ 1 in the first tick): start and predict in the same input
      queueAction('predict_break', position, face)
      state.predicted = true
      state.predictIndex = 0
    }
    bot.swingArm()

    swingInterval = setInterval(() => {
      bot.swingArm()
    }, SWING_INTERVAL_MS)
    swingInterval.unref?.()

    const eventName = `blockUpdate:${block.position}`
    bot.on(eventName, onBlockUpdate)

    const currentBlock = block
    bot.stopDigging = () => {
      if (!bot.targetDigBlock) return
      // The server's update that breaks the block is being dispatched: 'blockUpdate' listeners run before this dig's
      // per-position one, and mineflayer-pathfinder stops digging on any change near its path. Complete like upstream
      // (its finishDigging clears targetDigBlock before the local update, so that stopDigging is a no-op) (U15)
      const now = bot.blockAt(position)
      if (!state.done && now && isBroken(now, state.block)) return onBlockUpdate(state.block, now)

      // Replicate the odd vanilla cancellation face value.
      // When the cancellation is because of a new dig request on another block it's the same as the new dig start face. In all other cases it's 0.
      const stoppedBecauseOfNewDigRequest = !currentBlock.position.equals(bot.targetDigBlock.position)
      const cancellationDiggingFace = !stoppedBecauseOfNewDigRequest ? bot.targetDigFace : 0

      abort(state, cancellationDiggingFace, new Error('Digging aborted'))
    }

    function onBlockUpdate (oldBlock, newBlock) {
      // All block update listeners receive (null, null) when the world is unloaded. So newBlock can be null.
      if (!newBlock || state.done) return
      if (!isBroken(newBlock, state.block)) {
        // BDS answers a premature predict_break with the block as it is (a restore: an update that changes nothing,
        // as the block is never removed locally) within a tick or two; the dig goes on (the break is held). Changes of
        // the block (redstone ore lighting up, a tripwire's state) are not restores, nor are the re-sends of
        // block-entity blocks (a sign one tick after it was placed, a vault's state now and then).
        const afterPredict = state.predicted && state.index - state.predictIndex <= RESTORE_WINDOW_INPUTS
        const unchanged = newBlock.stateId === state.block.stateId && oldBlock?.stateId === newBlock.stateId
        if (afterPredict && unchanged && !newBlock.entity) state.restores++
        return
      }
      bot.removeListener(eventName, onBlockUpdate)
      clearInterval(swingInterval)
      swingInterval = null
      clearTimeout(state.timer)
      state.done = true
      if (current === state) current = null
      bot.targetDigBlock = null
      bot.targetDigFace = null
      bot.lastDigTime = performance.now()
      record(state, 'completed')
      const finish = () => {
        bot.emit('diggingCompleted', newBlock)
        task.finish()
      }
      if (state.legacy) return finish()
      // release the server's break state (BDS would otherwise break the next block placed here) and settle once that
      // input went out: whatever the caller does next (placing a block here, digging the next one) reaches BDS after it
      queueAction('abort_break', position, face)
      const release = { position, finish, timer: null }
      release.timer = setTimeout(() => settleRelease(release), RELEASE_TIMEOUT_MS)
      release.timer.unref?.()
      releases.push(release)
    }

    function abort (s, abortFace, err) {
      bot.removeListener(eventName, onBlockUpdate)
      clearInterval(swingInterval)
      swingInterval = null
      clearTimeout(s.timer)
      s.done = true
      if (current === s) current = null
      queueAction('abort_break', s.position, abortFace)
      const aborted = bot.targetDigBlock
      bot.targetDigBlock = null
      bot.targetDigFace = null
      bot.lastDigTime = performance.now()
      record(s, 'aborted')
      bot.emit('diggingAborted', aborted)
      bot.stopDigging = noop
      task.cancel(err)
    }
    state.abort = (err) => abort(state, state.face, err)

    await task.promise
  }

  /** legacy (client-authoritative) completion: stop_break + break_block transaction, block predicted locally */
  function finishLegacy (state) {
    if (state.done || current !== state) return
    queueAction('stop_break', state.position, state.face)
    const packet = buildUseItemOn(bot, { position: state.position, face: state.face }).transaction
    packet.transaction.transaction_data.action_type = 'break_block'
    bot._client.queue('inventory_transaction', packet)
    bot._updateBlockState(state.position, bot.registry.blocksByName.air.defaultState ?? 0)
  }

  function settleRelease (release) {
    const i = releases.indexOf(release)
    if (i < 0) return
    releases.splice(i, 1)
    clearTimeout(release.timer)
    release.finish()
  }

  /** per-tick driver: runs after every player_auth_input (the next queued action goes into the next input) */
  function onInputSent (packet, tick) {
    if (releases.length) {
      for (const release of [...releases]) {
        if ((packet.block_action ?? []).some((a) => a.action === 'abort_break' && samePosition(a.position, release.position))) settleRelease(release)
      }
    }
    const state = current
    if (!state || state.done) return
    if (state.index === -1) {
      const started = (packet.block_action ?? []).some((a) => a.action === 'start_break' && samePosition(a.position, state.position))
      if (!started) return
      state.index = 0
      state.startTick = tick
      state.startedAt = performance.now()
    } else {
      state.index++
    }
    if (state.legacy) {
      queueAction('crack_break', state.position, state.face)
      return
    }
    state.progress += state.serverSpeed ?? state.delta
    if (!state.predicted) {
      // fallback when BDS does not report its progress (never, or not for 2 s): by our own count BDS destroys the
      // block in this input; predict in the next one (one tick of margin)
      const silent = state.lastServerIndex === null || state.index - state.lastServerIndex >= CONFIRM_TIMEOUT_TICKS
      if (silent && state.index >= REPORT_GRACE_INPUTS && state.progress >= 1 - PROGRESS_EPSILON) predict(state)
    } else if (state.index - Math.max(state.predictIndex, state.lastServerIndex ?? -1) >= CONFIRM_TIMEOUT_TICKS) {
      // nothing from the server for 2 s although we predicted the break (BDS keeps reporting the speed every tick
      // while it is still breaking, e.g. when our estimate was too fast): it will not break the block
      state.abort(new Error(`Digging aborted: the server did not break ${state.block.name} at ${state.position}`))
    }
  }

  function predict (state) {
    queueAction('predict_break', state.position, state.face)
    state.predicted = true
    state.predictIndex = state.index + 1
  }

  /**
   * The server's view of the break (level_event data = progress per tick × 65535, floored): block_start_break when it
   * starts, then block_break_speed every server tick it adds progress (also to the breaker). predict_break goes out
   * once the reported progress is one tick from 1: BDS completes the break in that tick on its own, so the
   * prediction (in our next input) can never reach it early, however late the server runs (the client-side count in
   * onInputSent is the fallback).
   */
  function onLevelEvent (packet) {
    const state = current
    if (!state || state.done || state.legacy || state.index < 0) return
    if (packet.event !== 'block_start_break' && packet.event !== 'block_break_speed') return
    if (!packet.position || !samePosition(packet.position, state.position)) return
    const data = Number(packet.data)
    if (!(data > 0)) return
    // (positions only: another player breaking the same block is indistinguishable; at worst predict_break goes out
    // early, BDS restores the block and the dig goes on until BDS breaks it)
    state.lastServerIndex = state.index
    // the first report is the dug block's (once it is destroyed BDS, still holding, reports what replaced it — e.g.
    // the water of ice — in the same batch as the update_block)
    if (state.serverData === null) state.serverData = data
    // our estimate is exact while it agrees with the server's report; otherwise follow the server
    state.serverSpeed = digSpeed.speedData(state.delta) === data ? null : data / digSpeed.SPEED_SCALE
    if (packet.event !== 'block_break_speed') return
    const speed = state.serverSpeed ?? state.delta
    state.serverProgress += speed
    state.serverTicks++
    if (!state.predicted && state.serverProgress + speed >= 1 - PROGRESS_EPSILON) predict(state)
  }

  bot._bedrock.input?.onSent?.(onInputSent)
  bot._client.on('level_event', onLevelEvent)

  bot.on('death', () => {
    try {
      bot.removeAllListeners('diggingAborted')
      bot.removeAllListeners('diggingCompleted')
      bot.stopDigging()
    } catch (_) {}
  })

  // positions belong to the old world after a dimension change (and blocks.js resetWorld drops per-position
  // blockUpdate listeners): the dig cannot finish there
  bot._bedrock.lifecycle?.events?.on?.('dimensionChange', () => {
    try {
      bot.stopDigging()
    } catch (_) {}
  })

  // no more inputs (nor update_block) after a disconnect: settle a pending dig instead of leaving it hanging
  bot.on('end', () => {
    clearInterval(swingInterval)
    swingInterval = null
    current?.abort(new Error('Digging aborted: the connection ended'))
    for (const release of [...releases]) settleRelease(release)
  })

  function canDigBlock (block) {
    return (
      block &&
      block.diggable &&
      block.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1
    )
  }

  /** the inputs of digTime (upstream: held item + helmet enchantments, creative, eye-level water, onGround, effects) */
  function digInputs () {
    let type = null
    let enchantments = []

    // Retrieve currently held item ID and active enchantments from heldItem
    const currentlyHeldItem = bot.heldItem
    if (currentlyHeldItem) {
      type = currentlyHeldItem.type
      enchantments = currentlyHeldItem.enchants
    }

    // Append helmet enchantments (because Aqua Affinity actually affects dig speed)
    const headEquipmentSlot = bot.getEquipmentDestSlot('head')
    const headEquippedItem = bot.inventory.slots[headEquipmentSlot]
    if (headEquippedItem) {
      const helmetEnchantments = headEquippedItem.enchants
      enchantments = enchantments.concat(helmetEnchantments)
    }

    return {
      heldItemType: type,
      creative: bot.game.gameMode === 'creative',
      inWater: eyeInWater(),
      notOnGround: !bot.entity.onGround,
      enchantments,
      effects: bot.entity.effects
    }
  }

  /** upstream checks the eye-level block's name; Bedrock also counts a waterlogged block (water in layer 1) */
  function eyeInWater () {
    const block = bot._getBlockAtEyeLevel()
    if (!block) return false
    return ['water', 'flowing_water'].includes(block.name) || !!block.isWaterlogged
  }

  function currentDelta (block) {
    return digSpeed.breakDelta(bot.registry, block, digInputs())
  }

  function digTime (block) {
    return digSpeed.digTime(bot.registry, block, digInputs())
  }

  bot._getBlockAtEyeLevel = () => bot.entity.position && bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
  bot.dig = dig
  bot.stopDigging = noop
  bot.canDigBlock = canDigBlock
  bot.digTime = digTime
  bot._bedrock.digging = {
    /** protocol state of the dig in progress (null while idle) */
    active: () => current,
    /** diagnostics of the last finished dig (completed / aborted) */
    last: null,
    history,
    /**
     * prismarine-block `block.digTime(heldItemType, creative, inWater, notOnGround, enchantments, effects)` with the
     * Bedrock effect factors (lib/bedrock/dig_speed.js) — the cost estimates of the patched mineflayer-pathfinder /
     * mineflayer-tool call it for every candidate tool (U15)
     */
    blockDigTime: (block, heldItemType = null, creative = false, inWater = false, notOnGround = false, enchantments = [], effects = {}) =>
      digSpeed.digTime(bot.registry, block, { heldItemType, creative, inWater, notOnGround, enchantments, effects })
  }
}

function noop (err) {
  if (err) throw err
}
