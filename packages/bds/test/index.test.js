'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { spawnSync } = require('child_process')
const bds = require('..')

const CLI = path.join(__dirname, '../bin/bds.js')

describe('@bedboo/bds API', () => {
  const saved = {}
  beforeEach(() => {
    for (const k of ['BDS_HOST', 'BDS_PORT', 'BDS_CONTAINER']) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })

  it('exports the harness API', () => {
    for (const fn of ['startServer', 'createTestBot', 'externalServer', 'attachServer', 'pull', 'reap', 'clean', 'listSlots', 'listSnapshots', 'readSnapshot', 'deleteSnapshot']) {
      assert.strictEqual(typeof bds[fn], 'function', fn)
    }
    assert.strictEqual(typeof bds.BdsServer, 'function')
    assert.strictEqual(typeof bds.Console, 'function')
    assert.strictEqual(bds.config.BDS_VERSION, '1.26.51.1')
  })

  it('udpPortFree() tells whether a port BDS reported in use is free again (port-in-use retry)', async () => {
    const { udpPortFree } = require('../lib/server')
    const socket = require('dgram').createSocket('udp4')
    await new Promise((resolve) => socket.bind(0, resolve))
    const { port } = socket.address()
    assert.strictEqual(await udpPortFree(port), false)
    await new Promise((resolve) => socket.close(resolve))
    assert.strictEqual(await udpPortFree(port), true)
  })

  it('startServer() uses an already-running server from BDS_HOST/BDS_PORT', async () => {
    process.env.BDS_HOST = '10.0.0.5'
    process.env.BDS_PORT = '40100'
    const server = await bds.startServer()
    assert.strictEqual(server.host, '10.0.0.5')
    assert.strictEqual(server.port, 40100)
    assert.strictEqual(server.external, true)
    await assert.rejects(server.command('list'), /set BDS_CONTAINER/)
    await assert.rejects(server.snapshot('x'), /harness server/)
    await assert.rejects(server.restart(), /harness server/)
    await server.stop() // only detaches
  })

  it('externalServer() defaults the host and validates the port', () => {
    assert.deepStrictEqual(
      (({ host, port }) => ({ host, port }))(bds.externalServer({ BDS_PORT: '19133' })),
      { host: '127.0.0.1', port: 19133 })
    assert.strictEqual(bds.externalServer({}), null)
    assert.throws(() => bds.externalServer({ BDS_PORT: 'abc' }), /Invalid BDS_PORT/)
    assert.strictEqual(bds.externalServer({ BDS_PORT: '1', BDS_CONTAINER: 'c' }).container, 'c')
  })

  it('createTestBot() needs createBot', async () => {
    await assert.rejects(bds.createTestBot({ server: {} }), /needs opts.createBot/)
  })

  it('createTestBot() connects a bot to the given server and waits for spawn', async () => {
    const server = { host: '127.0.0.1', port: 41234, external: false, stop: async () => { throw new Error('must not stop a given server') } }
    let created
    const createBot = (options) => {
      created = options
      const bot = new EventEmitter()
      bot.end = () => { bot.ended = true }
      setTimeout(() => bot.emit('spawn'), 10)
      return bot
    }
    let onCreateBot
    const { bot, stop } = await bds.createTestBot({ server, createBot, botOptions: { viewDistance: 'tiny' }, onCreate: (b) => { onCreateBot = b } })
    assert.deepStrictEqual(created, { host: '127.0.0.1', port: 41234, username: 'flatbot', viewDistance: 'tiny' })
    assert.strictEqual(onCreateBot, bot)
    await stop()
    assert.strictEqual(bot.ended, true)
  })

  it('createTestBot() rejects when the bot ends or never spawns', async () => {
    const server = { host: 'h', port: 1, external: true, stop: async () => {} }
    const ending = () => { const b = new EventEmitter(); b.end = () => {}; setTimeout(() => b.emit('end', 'socketClosed'), 5); return b }
    await assert.rejects(bds.createTestBot({ server, createBot: ending }), /ended before spawning: socketClosed/)
    const silent = () => { const b = new EventEmitter(); b.end = () => {}; return b }
    await assert.rejects(bds.createTestBot({ server, createBot: silent, timeout: 50 }), /did not spawn .* within 50 ms/)
  })
})

describe('bds CLI', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

  it('prints usage', () => {
    const help = run(['--help'])
    assert.strictEqual(help.status, 0)
    for (const cmd of ['pull', 'up', 'cmd', 'logs', 'down', 'clean', 'snapshot', 'restore', 'ls']) assert.match(help.stdout, new RegExp(`\\n  ${cmd}\\b`))
    assert.strictEqual(run([]).status, 1)
    assert.strictEqual(run(['--', '--help']).status, 0, 'pnpm forwards a literal --')
  })

  it('rejects unknown commands and missing arguments', () => {
    const res = run(['frobnicate'])
    assert.strictEqual(res.status, 1)
    assert.match(res.stderr, /unknown command frobnicate/)
    assert.match(run(['cmd']).stderr, /usage: bds cmd/)
    assert.match(run(['snapshot', 'x']).stderr, /usage: bds snapshot/)
    assert.match(run(['up', '--gamerule', 'novalue']).stderr, /--gamerule expects <key>=<value>/)
    assert.match(run(['up', '--gamerule', 'randomtickspeed=']).stderr, /expected true, false or an integer/)
    assert.match(run(['up', '--gamerule', 'domobspawning=yes']).stderr, /expected true, false or an integer/)
  })

  it('lists and deletes snapshots in BEDBOO_CACHE', () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bedboo-cli-'))
    try {
      assert.match(run(['snapshots'], { BEDBOO_CACHE: cache }).stdout, /no snapshots/)
      fs.mkdirSync(path.join(cache, 'snapshots/s1/world'), { recursive: true })
      fs.writeFileSync(path.join(cache, 'snapshots/s1/meta.json'), JSON.stringify({ name: 's1', createdAt: 'now', levelType: 'FLAT', files: 3 }))
      assert.match(run(['snapshots'], { BEDBOO_CACHE: cache }).stdout, /^s1 {2}now {2}FLAT {2}3 files/m)
      assert.strictEqual(run(['snapshots', '--delete', 's1'], { BEDBOO_CACHE: cache }).status, 0)
      assert.ok(!fs.existsSync(path.join(cache, 'snapshots/s1')))
      assert.match(run(['snapshots', '--delete', '../x'], { BEDBOO_CACHE: cache }).stderr, /Invalid snapshot name/)
    } finally {
      fs.rmSync(cache, { recursive: true, force: true })
    }
  })
})
