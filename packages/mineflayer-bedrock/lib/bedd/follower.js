// owner: BEDD-4 (physics follower + external tick clock)
'use strict'
/**
 * Transport 'bedd': the real Minecraft client moves the player and owns the tick. This module follows it.
 *
 * - The input queue runs on an external clock (`setExternalClock(true)`), so its 50 ms timer stays stopped.
 * - Every echoed `player_auth_input` (the client's `'serverbound'` event, payload `{ name, params, reserialized }`)
 *   is stored as `bot.bedrock.bedd.observed = { yaw, pitch, tick }`. yaw and pitch are Bedrock degrees, as on the
 *   wire, and tick is a number.
 * - The echo is then handed to the physics plugin (`bot._bedrock.physics.followEcho`). That copies it into
 *   bot.entity, emits 'move' and 'physicsTick', resolves look/lookAt, and pumps bedboo's input for the next tick.
 *
 * Loaded by client.bedd.attach(bot) through the guarded optional-module require: `attach(bot, client)`.
 * Outside bedd mode (`bot._bedrock.mode !== 'bedd'`) attach does nothing and returns null.
 */

const attached = new WeakMap() // bot → handle

/** bot.bedrock.bedd, created when missing (other bedd modules add their own members to the same object) */
function surface (bot) {
  if (!bot.bedrock.bedd || typeof bot.bedrock.bedd !== 'object') bot.bedrock.bedd = {}
  return bot.bedrock.bedd
}

/** the input queue's external clock is on (the queue may have been replaced since attach) */
function ensureExternalClock (bot) {
  const input = bot._bedrock?.input
  if (input && typeof input.setExternalClock === 'function' && !input.isExternalClock?.()) input.setExternalClock(true)
}

/**
 * @param {object} bot mineflayer-bedrock bot
 * @param {import('events').EventEmitter} [client] the bedd client (default bot._client)
 * @returns {{ detach: () => void } | null} null outside bedd mode; the existing handle when already attached
 */
function attach (bot, client = bot?._client) {
  if (bot?._bedrock?.mode !== 'bedd' || !bot.bedrock || !client || typeof client.on !== 'function') return null
  if (attached.has(bot)) return attached.get(bot)
  const bedd = surface(bot)
  if (!('observed' in bedd)) bedd.observed = null
  ensureExternalClock(bot)

  const onServerbound = (frame) => {
    if (frame?.name !== 'player_auth_input' || !frame.params) return
    if (bot._bedrock?.mode !== 'bedd') return
    const params = frame.params
    surface(bot).observed = {
      yaw: Number(params.yaw),
      pitch: Number(params.pitch),
      tick: params.tick === undefined || params.tick === null ? null : Number(params.tick)
    }
    ensureExternalClock(bot)
    try {
      bot._bedrock.physics?.followEcho?.(params)
    } catch (err) {
      bot.emit('error', err)
    }
  }

  const detach = () => {
    client.removeListener('serverbound', onServerbound)
    bot.removeListener('end', detach)
    attached.delete(bot)
  }
  client.on('serverbound', onServerbound)
  bot.on('end', detach)
  const handle = { detach }
  attached.set(bot, handle)
  return handle
}

module.exports = { attach }
