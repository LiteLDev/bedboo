// owner: U4 (core runtime)
'use strict'
/**
 * Stationary soak (Bedrock extra, U4): a bot stands still for 10 minutes (BEDBOO_SOAK_MS) without being
 * disconnected and without correct_player_move_prediction storms; one player_auth_input per server tick the
 * whole time. Long: runs only with BEDBOO_SOAK=1 (`BEDBOO_SOAK=1 corepack pnpm test:e2e -- --grep soak`).
 */
const assert = require('assert')
const { once } = require('events')
const { useServer } = require('./common')
const { queryTargetPosition } = require('./common/helpers/base')
const mineflayerBedrock = require('../..')

const DURATION = Number(process.env.BEDBOO_SOAK_MS ?? 10 * 60 * 1000)

describe('soak: stationary bot for 10 minutes (U4)', function () {
  this.timeout(DURATION + 120000)
  before(function () {
    if (process.env.BEDBOO_SOAK !== '1') this.skip() // long: opt in with BEDBOO_SOAK=1
  })
  const env = useServer({ gamemode: 'survival' })

  it('stays connected, sends one input per tick, gets no corrections', async () => {
    const { server } = env
    const username = `soak${process.pid % 1000}`
    const bot = mineflayerBedrock.createBot({ host: server.host, port: server.port, username })
    const status = { ended: null }
    bot.on('end', (reason) => { status.ended = reason })
    await once(bot, 'spawn')
    await new Promise(resolve => setTimeout(resolve, 2000))
    let inputs = 0
    let gaps = 0
    let last = null
    const queue = bot._client.queue.bind(bot._client)
    bot._client.queue = (name, params) => {
      if (name === 'player_auth_input') {
        inputs++
        if (last !== null && params.tick !== last + 1n) gaps++
        last = params.tick
      }
      return queue(name, params)
    }
    const corrections = []
    bot._client.on('correct_player_move_prediction', (p) => corrections.push(p.tick))
    let ticks = 0
    bot.on('physicsTick', () => ticks++)
    const t0 = performance.now()
    const minutes = []
    while (performance.now() - t0 < DURATION && status.ended === null) {
      await new Promise(resolve => setTimeout(resolve, Math.min(60000, DURATION)))
      minutes.push({ inputs, corrections: corrections.length })
    }
    const seconds = (performance.now() - t0) / 1000
    console.log(`soak: ${seconds.toFixed(0)} s, ${inputs} inputs, ${ticks} physics ticks, ${corrections.length} corrections, ${gaps} tick gaps`, JSON.stringify(minutes))
    assert.strictEqual(status.ended, null, `disconnected: ${status.ended}`)
    assert.ok(Math.abs(inputs - seconds * 20) <= seconds * 0.01 + 5, `${inputs} inputs in ${seconds.toFixed(1)} s`)
    assert.strictEqual(gaps, 0, 'catch-up never skipped a tick')
    assert.ok(corrections.length <= 2, `corrections: ${corrections.length}`)
    const serverPos = await queryTargetPosition(server, username)
    assert.ok(serverPos.distanceTo(bot.entity.position) < 0.01)
    bot.quit()
  })
})
