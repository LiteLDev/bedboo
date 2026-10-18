// owner: U5 (physics & movement) — shared helpers of the physics e2e suites (physics*.test.js)
'use strict'
const { Vec3 } = require('vec3')
const { queryTargetPosition } = require('./common/helpers/base')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** run console commands in order, failing on errors */
async function commands (server, list) {
  for (const cmd of list) {
    const out = await server.commandOutput(cmd)
    if (out.some((line) => /error|unknown|syntax|couldn't|cannot/i.test(line) && !/couldn't be placed|No blocks/i.test(line))) {
      throw new Error(`${cmd}: ${out.join(' | ')}`)
    }
  }
}

/**
 * Records the server corrections of the local player. `mispredictions` excludes the unavoidable ones whose server state
 * equals our prediction for that tick (an input already in flight when the server teleported / knocked back the bot).
 */
function correctionRecorder (bot) {
  const list = []
  const off = bot._bedrock.physics.onCorrection((c) => list.push(c))
  let inputs = 0
  const offSent = bot._bedrock.input.onSent(() => { inputs++ })
  return {
    list,
    reset () { list.length = 0; inputs = 0 },
    get count () { return list.length },
    get inputs () { return inputs },
    mispredictions (eps = 1e-3) { return list.filter((c) => c.error === null || c.error > eps) },
    /** longest run of corrections less than `gap` ticks apart */
    maxConsecutive (gap = 20) {
      let best = 0
      let run = 0
      let prev = null
      for (const c of list) {
        run = prev !== null && c.tick !== null && c.tick - prev < BigInt(gap) ? run + 1 : 1
        best = Math.max(best, run)
        prev = c.tick
      }
      return best
    },
    stop () { off(); offSent() }
  }
}

/** server-side feet position of the bot (querytarget) */
function serverPosition (bot, server) {
  return queryTargetPosition(server, bot.username)
}

/** wait `n` physics ticks with every control released */
async function idle (bot, n = 10) {
  bot.clearControlStates()
  await bot.waitForTicks(n)
}

/** teleport (console) and wait until the bot settled */
async function place (bot, pos, settleMs = 600) {
  await bot.test.teleport(pos)
  await sleep(settleMs)
}

module.exports = { sleep, commands, correctionRecorder, serverPosition, idle, place, Vec3 }
