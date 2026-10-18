// owner: U4 (core runtime)
'use strict'
/**
 * kick / end / quit against a real BDS 1.26.51.1 (Bedrock extra, U4).
 */
const assert = require('assert')
const { once } = require('events')
const { useServer } = require('./common')
const mineflayerBedrock = require('../..')

let counter = 0
const uniqueName = (prefix) => `${prefix}${process.pid % 1000}${counter++}`

async function onlinePlayers (server) {
  const lines = await server.commandOutput('list')
  const i = lines.findIndex(l => /players online/.test(l))
  return (lines[i + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

async function until (fn, timeout = 10000) {
  const end = Date.now() + timeout
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

describe('core: kick, end and quit (U4)', function () {
  this.timeout(120000)
  const env = useServer({ gamemode: 'creative' })

  it('console kick → kicked(reason, true) then end', async () => {
    const { server } = env
    const username = uniqueName('kick')
    const bot = mineflayerBedrock.createBot({ host: server.host, port: server.port, username })
    await once(bot, 'spawn')
    const kicked = once(bot, 'kicked')
    const ended = once(bot, 'end')
    await server.commandOutput(`kick ${username} bye core`)
    const [reason, loggedIn] = await kicked
    assert.strictEqual(reason, 'bye core')
    assert.strictEqual(loggedIn, true)
    assert.strictEqual(typeof (await ended)[0], 'string')
    assert.strictEqual(bot._bedrock.lifecycle.state, 'ended')
  })

  it('bot.quit() → end("disconnect.quitting"), the server lets the player go; the same name rejoins', async () => {
    const { server } = env
    const username = uniqueName('quit')
    const bot = mineflayerBedrock.createBot({ host: server.host, port: server.port, username })
    await once(bot, 'spawn')
    assert.ok((await onlinePlayers(server)).includes(username))
    const ended = once(bot, 'end')
    bot.quit()
    assert.deepStrictEqual(await ended, ['disconnect.quitting'])
    await until(async () => !(await onlinePlayers(server)).includes(username))
    const again = mineflayerBedrock.createBot({ host: server.host, port: server.port, username })
    await once(again, 'spawn')
    const endedAgain = once(again, 'end')
    again.end('custom reason')
    assert.deepStrictEqual(await endedAgain, ['custom reason'])
  })

  it('a refused connection (nothing listening) ends with an error, never spawns', async () => {
    const bot = mineflayerBedrock.createBot({ host: '127.0.0.1', port: 9, username: uniqueName('nobody'), connectTimeout: 2000, logErrors: false })
    let spawned = false
    bot.on('spawn', () => { spawned = true })
    const errored = new Promise(resolve => bot.once('error', resolve))
    const ended = new Promise(resolve => bot.once('end', resolve)) // (events.once would reject on 'error')
    assert.match((await errored).message, /timed out|refused|closed/i)
    await ended
    assert.strictEqual(spawned, false)
  })
})
