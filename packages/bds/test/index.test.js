'use strict'
const assert = require('assert')
const path = require('path')
const { spawnSync } = require('child_process')
const bds = require('..')

describe('@bedboo/bds (U0 API stub)', () => {
  const saved = {}
  beforeEach(() => {
    for (const k of ['BDS_HOST', 'BDS_PORT', 'BDS_CONTAINER']) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })

  it('exports the harness API', () => {
    assert.strictEqual(typeof bds.startServer, 'function')
    assert.strictEqual(typeof bds.createTestBot, 'function')
  })

  it('startServer() without BDS_HOST/BDS_PORT rejects with NotImplementedError (U1)', async () => {
    await assert.rejects(bds.startServer(), (err) => err.notImplemented === true && err.unit === 'U1')
  })

  it('startServer() uses an already-running server from BDS_HOST/BDS_PORT', async () => {
    process.env.BDS_HOST = '10.0.0.5'
    process.env.BDS_PORT = '40100'
    const server = await bds.startServer()
    assert.strictEqual(server.host, '10.0.0.5')
    assert.strictEqual(server.port, 40100)
    assert.strictEqual(server.external, true)
    await server.stop() // no-op for external servers
    await assert.rejects(server.command('list'), (err) => err.notImplemented === true)
  })

  it('externalServer() defaults the host and validates the port', () => {
    assert.deepStrictEqual(
      (({ host, port }) => ({ host, port }))(bds.externalServer({ BDS_PORT: '19133' })),
      { host: '127.0.0.1', port: 19133 })
    assert.strictEqual(bds.externalServer({}), null)
    assert.throws(() => bds.externalServer({ BDS_PORT: 'abc' }), /Invalid BDS_PORT/)
  })

  it('createTestBot() rejects with NotImplementedError (U1)', async () => {
    await assert.rejects(bds.createTestBot(), (err) => err.notImplemented === true && err.unit === 'U1')
  })

  it('CLI prints "not implemented (U1)" for commands', () => {
    const res = spawnSync(process.execPath, [path.join(__dirname, '../bin/bds.js'), 'pull'], { encoding: 'utf8' })
    assert.strictEqual(res.status, 1)
    assert.match(res.stderr, /not implemented \(U1\)/)
  })
})
