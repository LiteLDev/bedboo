// owner: U1 (BDS harness & e2e infra)
'use strict'
/**
 * The BDS harness itself against a real server: raw client join, console round trips, the
 * deterministic profile, snapshots. `smoke:` tests are the quick subset every unit runs.
 */
const assert = require('assert')
const { useServer, createRawBot, inject, startServer } = require('./common')

describe('smoke: BDS harness', function () {
  this.timeout(120000)
  const env = useServer()
  let bot

  afterEach(() => {
    bot?.end('test done')
    bot = null
  })

  it('raw client joins, spawns, receives level_chunk; console command output is read back', async () => {
    const { server } = env
    bot = createRawBot({ host: server.host, port: server.port, username: 'smoke' + Math.floor(Math.random() * 1e4) })
    const ctx = inject(bot, server)
    let firstChunk = null
    bot._client.on('level_chunk', (p) => { firstChunk ??= p })
    await ctx.waitForSpawn()
    const chunk = firstChunk ?? await ctx.packet('level_chunk', () => true, 15000).promise
    assert.ok(chunk.highest_subchunk_count != null, 'level_chunk in sub-chunk request mode')
    assert.ok(Math.abs(ctx.state.position.y - -60) < 1e-3, `feet on the flat world ground (${ctx.state.position})`)

    // `list` prints "There are 1/10 players online:" and the names on the next line
    const out = await server.commandWithOutput('list', /players online/)
    assert.match(out, /There are 1\/\d+ players online/)
    await server.awaitCommandsProcessed()
    const names = server.logs(5).join('\n')
    assert.ok(names.includes(ctx.username()), `player list contains ${ctx.username()}: ${names}`)

    // querytarget prints the player's data as JSON
    const q = await server.commandWithOutput(`querytarget ${ctx.who()}`, /^Target data|No targets/)
    assert.match(q, /^Target data/)
  })

  it('console commands run in order (marker) and report errors', async () => {
    const { server } = env
    const t0 = Date.now()
    await server.awaitCommandsProcessed()
    assert.ok(Date.now() - t0 < 5000)
    const err = await server.commandWithOutput('nosuchcommand_xyz', /Unknown command/)
    assert.match(err, /Unknown command: nosuchcommand_xyz/)
    const since = await server.command('time set 1000')
    const line = await server.waitForLog(/Set the time to 1000/, { since })
    assert.match(line, /INFO\] Set the time to 1000/)
  })
})

describe('BDS harness: profile and snapshots', function () {
  this.timeout(180000)
  const env = useServer({ gamemode: 'creative' })

  it('applies the deterministic gamerule profile', async function () {
    if (env.server.external) this.skip()
    const rules = await env.server.commandWithOutput('gamerule', /doMobSpawning = /)
    for (const expected of ['doMobSpawning = false', 'doDayLightCycle = false', 'doWeatherCycle = false',
      'randomTickSpeed = 0', 'doInsomnia = false', 'doFireTick = false', 'mobGriefing = false', 'spawnRadius = 0']) {
      assert.ok(rules.includes(expected), `${expected} in ${rules}`)
    }
    assert.strictEqual(env.server.properties.difficulty, 'peaceful')
    assert.strictEqual(env.server.properties['enable-lan-visibility'], 'false')
    assert.deepStrictEqual(env.server.startupErrors, [])
  })

  it('snapshot() saves the world, restore() and startServer({ snapshot }) bring it back', async function () {
    if (env.server.external) this.skip()
    const { server } = env
    const name = `u1-harness-${process.pid}`
    const msgRe = /^Block placed|couldn't be placed|outside of the world|No targets|error/i
    const setblock = (block) => server.commandWithOutput(`setblock 3 -60 3 ${block}`, msgRe)
    const isBlock = async (block) => /Successfully found/.test(await server.commandWithOutput(`testforblock 3 -60 3 ${block}`,
      /Successfully found|is .*\(expected|outside of the world|Cannot test|error/i))
    // BDS only loads chunks around players: keep one connected while editing/testing the world
    const join = async () => {
      const bot = createRawBot({ host: server.host, port: server.port, username: 'snapper' })
      await inject(bot, server).waitForSpawn()
      return bot
    }
    let bot = await join()
    const rejoin = async () => {
      bot.end()
      bot = await join()
    }
    try {
      // a change made right before the snapshot is in it (graceful stop saves everything)
      assert.match(await setblock('gold_block'), /^Block placed/)
      const snap = await server.snapshot(name, { overwrite: true })
      assert.ok(snap.files > 0)
      assert.strictEqual(snap.levelName, server.levelName)
      assert.strictEqual(snap.levelType, 'FLAT')
      await assert.rejects(server.snapshot(name), /exists/)
      await rejoin() // the snapshot restarted the server
      assert.ok(await isBlock('gold_block'))

      assert.match(await setblock('diamond_block'), /^Block placed/)
      await server.restore(name)
      await rejoin()
      assert.ok(await isBlock('gold_block'), 'gold block restored from the snapshot')
      // gamerules live in level.dat: the profile survives snapshot + restore
      assert.match(await server.commandWithOutput('gamerule', /doMobSpawning = /), /doMobSpawning = false/)

      // a second server started from the snapshot (second slot of this worker)
      const other = await startServer({ snapshot: name, profile: 'none' })
      try {
        assert.strictEqual(other.snapshotName, name)
        const b2 = createRawBot({ host: other.host, port: other.port, username: 'snapper2' })
        await inject(b2, other).waitForSpawn()
        assert.match(await other.commandWithOutput('testforblock 3 -60 3 gold_block', /Successfully found|expected|error/i), /Successfully found/)
        b2.end()
      } finally {
        await other.stop()
      }
    } finally {
      bot.end()
      require('@bedboo/bds').deleteSnapshot(name)
    }
  })
})
