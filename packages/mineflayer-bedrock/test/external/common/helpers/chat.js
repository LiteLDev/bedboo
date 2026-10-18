// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Chat helpers on the real chat API (installed after base/world/inventory/entities, see ../index.js).
 *
 * Upstream: mineflayer 4.39.0 test/externalTests/plugins/testCommon.js (MIT, Copyright (c) 2013 Andrew Kelley).
 *
 * - `tellAndListen(to, what, listen)`: upstream semantics on a mineflayer-bedrock bot — `bot.chat(what)`, resolve
 *   with the arguments of the first `chat` event from `to` whose message satisfies `listen` ([username, message,
 *   translate, jsonMsg]), 5 s timeout. Raw bots (or a bot whose chat patterns are stubs) keep the packet-level
 *   helper from base.js.
 * - `awaitChat(predicate, timeout)` (extra): the arguments of the next `chat` event satisfying `predicate`.
 */
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')

function install (bot, ctx) {
  const t = bot.test
  const usesChatApi = () => !bot._rawBot && ctx.implemented(bot.addChatPattern) && ctx.implemented(bot.chat)

  const rawTellAndListen = t.tellAndListen
  t.tellAndListen = (to, what, listen) => {
    if (!usesChatApi()) return rawTellAndListen(to, what, listen)
    const chatMessagePromise = onceWithCleanup(bot, 'chat', {
      timeout: ctx.TIMEOUT,
      checkCondition: (username, message) => username === to && listen(message)
    })
    bot.chat(what)
    return chatMessagePromise
  }

  t.awaitChat = (predicate = () => true, timeout = ctx.TIMEOUT) => onceWithCleanup(bot, 'chat', { timeout, checkCondition: predicate })
}

module.exports = install
