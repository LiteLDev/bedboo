// owner: U4 (wave 2: clock + stationary sender) → U5 (wave 3: drain/tick, physics integration)
'use strict'
const { stubSync } = require('./errors')
const { TICK_MS } = require('./constants')

/**
 * Tick clock + per-tick `player_auth_input` input queue, exposed as `bot._bedrock.input`.
 *
 * Bedrock movement is always server-authoritative with rewind: from spawn on, the client must send
 * one `player_auth_input` per server tick. The clock is anchored on `start_game.current_tick` and
 * re-anchored by `correct_player_move_prediction.tick`:
 *
 *     tick = anchorTick + round((now - anchorTime) / 50)
 *
 * The physics loop (U5) performs one physics step per elapsed server tick and drains the queue
 * into that tick's packet. Producers never write `player_auth_input` themselves; they enqueue:
 *
 * - `addFlags(flags)`            one-shot input_data flag names for the next packet, e.g. ['start_sprinting']
 * - `hold(flag, on)`             level flags sent every tick while held, e.g. hold('sneaking', true)
 * - `queueBlockAction(action)`   { action, position, face } (server-auth digging; U10)
 * - `queueItemStackRequest(req)` one ItemStackRequest per tick at most (U8)
 * - `setVehicle(id, rotation)`   predicted vehicle runtime id + vehicle rotation (U14) or (null) to clear
 * - `suspend(reason)` / `resume(reason)` stop/restart sending (loading screen, death, dimension change);
 *   sending resumes only when every reason has been resumed
 *
 * @typedef {object} InputQueue
 * @property {(tick: bigint|number, at?: number) => void} anchor  (re)anchor the clock
 * @property {(now?: number) => bigint} currentTick server tick estimate for `now` (ms, performance-like clock)
 * @property {(flags: string[]) => void} addFlags
 * @property {(flag: string, on: boolean) => void} hold
 * @property {(action: { action: string, position: {x:number,y:number,z:number}, face: number }) => void} queueBlockAction
 * @property {(request: object) => void} queueItemStackRequest
 * @property {(vehicleRuntimeId: bigint|number|null, rotation?: {x:number,z:number}) => void} setVehicle
 * @property {(reason: string) => void} suspend
 * @property {(reason: string) => void} resume
 * @property {() => boolean} isSuspended
 */

/**
 * @param {object} bot
 * @param {{ now?: () => number }} [opts] injectable clock for tests (defaults to performance.now)
 * @returns {InputQueue}
 */
function createInputQueue (bot, opts = {}) {
  const now = opts.now ?? (() => performance.now())
  let anchorTick = 0n
  let anchorTime = now()
  const suspendReasons = new Set()

  return {
    anchor (tick, at = now()) {
      anchorTick = BigInt(tick)
      anchorTime = at
    },
    currentTick (at = now()) {
      return anchorTick + BigInt(Math.round((at - anchorTime) / TICK_MS))
    },
    suspend (reason) { suspendReasons.add(reason) },
    resume (reason) { suspendReasons.delete(reason) },
    isSuspended () { return suspendReasons.size > 0 },
    addFlags: stubSync('U4', 'bot._bedrock.input.addFlags', 1),
    hold: stubSync('U4', 'bot._bedrock.input.hold', 2),
    queueBlockAction: stubSync('U4', 'bot._bedrock.input.queueBlockAction', 1),
    queueItemStackRequest: stubSync('U4', 'bot._bedrock.input.queueItemStackRequest', 1),
    setVehicle: stubSync('U4', 'bot._bedrock.input.setVehicle', 2)
  }
}

module.exports = { createInputQueue }
