// owner: U16b (mob combat matrix, NetherNet, user docs)
'use strict'
/**
 * NetherNet transport smoke (Bedrock extra, plan U16): `createBot({ transport: 'nethernet' })` against a BDS started
 * with `transport=nethernet` (BDS 1.26.51's default transport): join, spawn, chat both ways, a block update, walking,
 * quit — plus HTTP discovery and the server-key pin.
 *
 * Signalling is HTTP on the server port (`POST http://host:port/v1/join/<network id>`; PrismarineJS/bedrock-protocol#831
 * and node-nethernet#32 backported as pnpm patches), so LAN visibility stays off and no exclusive slot is needed.
 *
 * Tagged `nethernet` and kept out of the default run (NetherNet is opt-in; RakNet is the default transport): it runs
 * when selected with `--grep nethernet` or with `BEDBOO_NETHERNET=1`:
 *
 *   corepack pnpm test:e2e -- --grep nethernet
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { once } = require('events')
const { useBot, createRawBot } = require('./common')

/** whether mocha's --grep / --fgrep mentions `re` (the suite is opt-in) */
function grepSelects (re) {
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    let value
    if (['--grep', '-g', '--fgrep', '-f'].includes(arg)) value = argv[i + 1]
    else if (/^--f?grep=/.test(arg)) value = arg.slice(arg.indexOf('=') + 1)
    if (value && re.test(value)) return true
  }
  return false
}

const SELECTED = process.env.BEDBOO_NETHERNET === '1' || grepSelects(/nethernet/i)

describe('nethernet transport (U16b): createBot over NetherNet (HTTP signalling)', function () {
  this.timeout(120000)
  if (!SELECTED) {
    it('nethernet smoke (opt-in: --grep nethernet or BEDBOO_NETHERNET=1)', function () { this.skip() })
    return
  }
  if (process.env.BDS_HOST || process.env.BDS_PORT) {
    // an external server's transport is unknown (and usually RakNet): the suite needs a harness server it starts
    it('nethernet smoke (needs a harness server: unset BDS_HOST / BDS_PORT)', function () { this.skip() })
    return
  }
  const env = useBot({ server: { transport: 'nethernet' }, botOptions: { transport: 'nethernet' }, username: 'nnbot' })

  it('nethernet: the bot joined and spawned over NetherNet (not RakNet)', async () => {
    const { bot, server } = env
    assert.strictEqual(server.properties.transport, 'nethernet')
    assert.strictEqual(server.properties['enable-lan-visibility'], 'false')
    assert.strictEqual(bot._client.options.transport, 'nethernet')
    assert.strictEqual(bot._client.options.nethernet.signalling, 'http')
    assert.strictEqual(bot._client.connection.constructor.name, 'NethernetClient')
    assert.ok(bot.entity && bot.entity.position, 'spawned')
    assert.strictEqual(bot.game.dimension, 'overworld')
    assert.ok(Object.keys(bot.world.async.columns).length > 0, 'chunks arrived')
  })

  it('nethernet: chat both ways', async () => {
    const { bot, server } = env
    // the bot's own chat is echoed back by BDS
    const echoed = once(bot, 'chat', { signal: AbortSignal.timeout(10000) })
    bot.chat('hello over nethernet')
    const [username, message] = await echoed
    assert.strictEqual(username, bot.username)
    assert.strictEqual(message, 'hello over nethernet')
    // server → bot
    const heard = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no system message')), 10000)
      bot.on('messagestr', function onMsg (msg) {
        if (!msg.includes('from the console')) return
        clearTimeout(timer)
        bot.removeListener('messagestr', onMsg)
        resolve(msg)
      })
    })
    await server.command('say from the console')
    assert.match(await heard, /from the console/)
  })

  it('nethernet: a block update reaches the bot, and the bot walks', async () => {
    const { bot } = env
    await bot.test.becomeCreative()
    const pos = new Vec3(2, bot.test.groundY, 2)
    const updated = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no blockUpdate')), 10000)
      bot.on('blockUpdate', function onUpdate (oldBlock, newBlock) {
        if (!newBlock.position.equals(pos) || newBlock.name !== 'gold_block') return
        clearTimeout(timer)
        bot.removeListener('blockUpdate', onUpdate)
        resolve(newBlock)
      })
    })
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'gold_block' })
    await updated
    assert.strictEqual(bot.blockAt(pos).name, 'gold_block')
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'air' })

    // movement over the data channel: player_auth_input every tick, the server agrees
    await bot.test.becomeSurvival()
    await bot.test.teleport(new Vec3(-3, bot.test.groundY, -3))
    await bot.waitForTicks(10)
    const start = bot.entity.position.clone()
    let corrections = 0
    const onCorrection = () => corrections++
    bot._client.on('correct_player_move_prediction', onCorrection)
    try {
      await bot.look(Math.PI, 0, true) // south (+z)
      bot.setControlState('forward', true)
      await bot.waitForTicks(20)
      bot.setControlState('forward', false)
      await bot.waitForTicks(10)
    } finally {
      bot._client.removeListener('correct_player_move_prediction', onCorrection)
      bot.clearControlStates()
    }
    const walked = bot.entity.position.z - start.z
    assert.ok(walked > 2, `walked ${walked.toFixed(2)} blocks south`)
    assert.ok(corrections <= 3, `${corrections} corrections`)
    await bot.test.becomeCreative()
  })

  it('nethernet: HTTP discovery answers on the server port', async () => {
    const { server } = env
    const { ping } = require('bedrock-protocol')
    const ad = await ping({ host: server.host, port: server.port, transport: 'nethernet', nethernet: { signalling: 'http' }, timeout: 5000 })
    assert.strictEqual(ad.transport, 'nethernet')
    assert.strictEqual(ad.signalling, 'http')
  })

  it('nethernet: the server key can be pinned (a wrong pin is refused)', async () => {
    const { server } = env
    const join = async (username, nethernet) => {
      const raw = createRawBot({ host: server.host, port: server.port, username, transport: 'nethernet', nethernet })
      const errors = []
      raw._client.on('error', (err) => errors.push(err))
      // (not events.once: it rejects on 'error', and the refused pin is reported as an 'error' before 'close')
      let timer
      const outcome = new Promise((resolve) => {
        raw._client.once('spawn', () => resolve(true))
        raw._client.once('close', () => resolve(false))
        timer = setTimeout(() => resolve(null), 30000)
      })
      try {
        return { spawned: await outcome, errors }
      } finally {
        clearTimeout(timer)
        raw.end('test done')
      }
    }
    let seen = null
    const first = await join('nnkey1', { onServerKey: (fingerprint) => { seen = fingerprint; return true } })
    assert.strictEqual(first.spawned, true, `joined with an approved key (${first.errors.map((e) => e.message)})`)
    assert.match(seen, /^sha256:[0-9a-f]{64}$/)

    const pinned = await join('nnkey2', { serverKey: seen })
    assert.strictEqual(pinned.spawned, true, `joined with the pinned key (${pinned.errors.map((e) => e.message)})`)

    const wrong = await join('nnkey3', { serverKey: 'sha256:' + '0'.repeat(64) })
    assert.strictEqual(wrong.spawned, false, 'a wrong pin must not join')
    assert.ok(wrong.errors.some((e) => /Untrusted Nethernet server key/.test(e.message)), wrong.errors.map((e) => e.message).join('; '))
  })

  it('nethernet: quit disconnects cleanly', async () => {
    const { bot, server } = env
    const since = new Date()
    const ended = once(bot, 'end', { signal: AbortSignal.timeout(10000) })
    bot.quit()
    const [reason] = await ended
    assert.strictEqual(reason, 'disconnect.quitting')
    await server.waitForLog(new RegExp(`Player disconnected: ${bot.username}`), { since, timeout: 10000 })
  })
})
