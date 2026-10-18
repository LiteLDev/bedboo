// owner: U1 (BDS harness & e2e infra)
'use strict'
/**
 * stress: N servers (default 6 = BEDBOO_MAX_SERVERS) started in parallel, a raw client joins each.
 * Not part of the default run (skipped unless BEDBOO_STRESS=1); needs every slot:
 *
 *   BEDBOO_STRESS=1 BEDBOO_WORKER_SLOTS=6 corepack pnpm test:e2e -- --grep stress
 */
const assert = require('assert')
const { startServer, createRawBot, inject, bds } = require('./common')

describe('stress: parallel BDS servers', function () {
  this.timeout(10 * 60 * 1000)
  const count = Number(process.env.BEDBOO_STRESS_SERVERS ?? bds.config.limits().maxServers)
  const servers = []

  before(function () {
    if (!process.env.BEDBOO_STRESS) this.skip()
    const { workerSlots, maxServers } = bds.config.limits()
    assert.ok(workerSlots >= count && maxServers >= count, `needs BEDBOO_WORKER_SLOTS and BEDBOO_MAX_SERVERS >= ${count}`)
  })

  after(async function () {
    await Promise.all(servers.map((s) => s.stop().catch(() => {})))
  })

  it(`starts ${count} servers in parallel and a raw client joins each`, async () => {
    const t0 = Date.now()
    const started = await Promise.all(Array.from({ length: count }, (_, i) => startServer({ name: `stress-${process.pid}-${i}` }).then((s) => {
      servers.push(s)
      return s
    })))
    console.log(`      ${count} servers ready in ${Date.now() - t0} ms on ports ${started.map((s) => s.port).join(', ')}`)
    assert.strictEqual(new Set(started.map((s) => s.port)).size, count, 'distinct ports')
    assert.strictEqual(new Set(started.map((s) => s.slot)).size, count, 'distinct slots')

    const t1 = Date.now()
    await Promise.all(started.map(async (server, i) => {
      const bot = createRawBot({ host: server.host, port: server.port, username: `stress${i}` })
      try {
        const ctx = inject(bot, server)
        let chunk = null
        bot._client.on('level_chunk', (p) => { chunk ??= p })
        await ctx.waitForSpawn()
        chunk ??= await ctx.packet('level_chunk', () => true, 30000).promise
        assert.ok(chunk.highest_subchunk_count != null)
        assert.match(await server.commandWithOutput('list', /players online/), /There are 1\//)
      } finally {
        bot.end()
      }
    }))
    console.log(`      ${count} clients joined in ${Date.now() - t1} ms`)
  })
})
