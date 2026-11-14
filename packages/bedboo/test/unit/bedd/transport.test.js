'use strict'
const { describe, it, before, after, beforeEach, afterEach } = require('node:test')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { once } = require('events')
const { PassThrough } = require('stream')
const fixtures = require('../../fixtures')
const bedboo = require('../../..')
const { createFakeBedd, encodePacket, toFrames } = require('../helpers/fake_bedd')
const { createFakeBot } = require('../helpers/fake')
const { createRpc, probeResult } = require('../../../lib/bedd/rpc')
const { createTapReader, createFrameParser, encodeFrame, KIND, FLAG } = require('../../../lib/bedd/tap')
const bedd = require('../../../lib/bedd')
const { createClient } = require('../../../lib/client')
const { TEST_VERSION, TEST_PROTOCOL } = require('../../version')

/** resolve once `fn()` is truthy (polls every 10 ms) */
async function until (fn, { timeout = 10000, what = 'condition' } = {}) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function botOn (fake, extra = {}, beddExtra = {}) {
  return bedboo.createBot({
    transport: 'bedd',
    version: TEST_VERSION,
    bedd: fake.botOptions({ modules: [], ...beddExtra }),
    logErrors: false,
    hideErrors: true,
    ...extra
  })
}

function endOf (bot) {
  return new Promise(resolve => bot.once('end', resolve))
}

describe("transport 'bedd'", () => {
  const fakes = []
  const bots = []
  async function fakeBedd (opts) {
    const fake = await createFakeBedd(opts)
    fakes.push(fake)
    return fake
  }
  afterEach(async () => {
    for (const bot of bots.splice(0)) bot.end()
    for (const fake of fakes.splice(0)) await fake.close()
  }, { timeout: 60000 })

  describe('createBot against a fake BeDD replaying join_flat', () => {
    const cap = fixtures.load('join_flat')
    const echoed = toFrames('join_flat').filter(f => f.kind === KIND.SERVERBOUND_ECHO).length

    it('spawns, loads chunks and inventory, emits serverbound echoes and never writes a packet', async () => {
      const fake = await fakeBedd({ live: 'join_flat' })
      const bot = botOn(fake)
      bots.push(bot)
      assert.strictEqual(bot._bedrock.mode, 'bedd')
      assert.ok(bot._client.bedd, 'client.bedd')
      const serverbound = []
      bot._client.on('serverbound', (p) => serverbound.push(p))
      const events = []
      for (const e of ['connect', 'login', 'spawn']) bot.once(e, () => events.push(e))
      await once(bot, 'spawn')

      assert.deepStrictEqual(events, ['connect', 'login', 'spawn'])
      assert.strictEqual(bot.username, 'U0Bot', 'name from the local player_list entry')
      assert.strictEqual(bot._client.profile.uuid, '103594cd-1da0-2ec6-fb7c-32af2c646f85')
      assert.ok(bot.entity.position, 'bot.entity')
      await until(() => serverbound.length === echoed, { what: `${echoed} echoes` })
      assert.ok(serverbound.some(p => p.name === 'player_auth_input' && p.params.position), 'player_auth_input echoes')
      assert.ok(serverbound.every(p => !['login', 'request_network_settings', 'client_to_server_handshake'].includes(p.name)))
      assert.strictEqual(typeof serverbound[0].reserialized, 'boolean')

      // chunks: the real client requested the sub-chunks; their answers fill the columns
      const feet = bot.entity.position.floored()
      const below = bot.blockAt(feet.offset(0, -1, 0))
      assert.ok(below, 'block below the spawn is loaded')
      assert.notStrictEqual(below.name, 'air', `block below the spawn is ${below.name}`)
      let solid = 0
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (bot.blockAt(feet.offset(dx, -1, dz))?.name !== 'air') solid++
      assert.ok(solid > 40, `ground around the spawn (${solid}/49 non-air)`)

      await until(() => bot.inventory.items().length > 0, { what: 'inventory items' })
      assert.ok(bot.inventory.items().some(i => i.name === 'oak_planks'), bot.inventory.items().map(i => i.name).join())

      // the bot's own sends never reach a pipe: the default route drops + counts them (and the client owns the
      // sub-chunk requests: blocks.js does not even ask)
      const dropped = bot._client.bedd.dropped
      assert.strictEqual(dropped.subchunk_request, undefined, 'no subchunk_request in bedd mode')
      assert.strictEqual(dropped.set_local_player_as_initialized, undefined, 'the transport never writes the spawn ack')
      const probeArgs = (c) => JSON.stringify(c.args) === JSON.stringify(bedd.PROBE_ARGS[c.op] ?? {})
      assert.ok(fake.calls.every(probeArgs), 'no action op reached the control connection')

      // caps: ping + every spec op probed without arguments (`ui` with a one-node read)
      assert.deepStrictEqual(fake.calls.slice(0, 1 + bedd.PROBE_OPS.length).map(c => c.op), ['ping', ...bedd.PROBE_OPS])
      assert.ok(fake.calls.slice(0, 1 + bedd.PROBE_OPS.length).every(probeArgs), 'probes carry no arguments')
      assert.deepStrictEqual(bot._client.bedd.sendAllow, [9, 77], 'the send probe tells the allowed ids')
      for (const op of bedd.PROBE_OPS) assert.strictEqual(bot._client.bedd.caps[op], 'present', op)
      assert.strictEqual(bot._client.bedd.supports('look'), true)
      assert.strictEqual(bot._client.bedd.rpc.supports('stack'), true)
      assert.strictEqual(bot._client.bedd.link.state, 'up')
      assert.deepStrictEqual(bot._client.bedd.capabilities, { ownsLogin: true, ownsLoadingScreen: true, ownsChunkRequests: true, ownsMovement: true })
      assert.ok(cap.records.length > 0)
    })

    it('LINK_DOWN ends the bot (kick + end), the pipes only detach', async () => {
      const fake = await fakeBedd({ live: 'join_flat' })
      const bot = botOn(fake)
      bots.push(bot)
      await once(bot, 'spawn')
      const kick = once(bot._client, 'kick')
      const ended = endOf(bot)
      fake.linkDown('the player left the world')
      const [kicked] = await kick
      assert.strictEqual(kicked.reason, 'bedd_link_down')
      assert.match(await ended, /bedd_link_down: the player left the world/)
      assert.strictEqual(bot._client.bedd.link.state, 'down')
      await until(() => fake.controlClients.size === 0, { what: 'control connection detached' })
    })

    it('DROPPED ends the bot', async () => {
      const fake = await fakeBedd({ live: 'join_flat' })
      const bot = botOn(fake)
      bots.push(bot)
      await once(bot, 'spawn')
      const ended = endOf(bot)
      fake.dropped(12)
      assert.match(await ended, /bedd_dropped/)
    })

    it('rejects a HELLO with another protocol version (error + end)', async () => {
      const fake = await fakeBedd({ hello: { protocol: 2000 }, live: 'join_flat' })
      const bot = botOn(fake)
      bots.push(bot)
      const errors = []
      bot.on('error', (err) => errors.push(err))
      let spawned = false
      bot.on('spawn', () => { spawned = true })
      await endOf(bot)
      assert.strictEqual(errors.length, 1)
      assert.strictEqual(errors[0].code, 'ERR_BEDD_PROTOCOL')
      assert.match(errors[0].message, /protocol 2000/)
      assert.strictEqual(spawned, false)
    })

    it('rejects a HELLO with another tap version', async () => {
      const fake = await fakeBedd({ hello: { tap: 2 } })
      const bot = botOn(fake)
      bots.push(bot)
      const [err] = await once(bot, 'error')
      assert.strictEqual(err.code, 'ERR_BEDD_HELLO')
    })

    it('errors and ends when the tap is disabled', async () => {
      const fake = await fakeBedd({ tap: false })
      const bot = botOn(fake)
      bots.push(bot)
      const [err] = await once(bot, 'error')
      assert.strictEqual(err.code, 'disabled')
      assert.match(err.message, /tap:false/)
      assert.strictEqual(bot._client.bedd.caps.tap, 'disabled', 'the tap status read says enabled: false')
      await endOf(bot)
    })

    it('errors with code busy when another client holds the tap', async () => {
      const fake = await fakeBedd({ live: 'join_flat' })
      const first = botOn(fake)
      bots.push(first)
      await once(first, 'spawn')
      const second = botOn(fake)
      bots.push(second)
      const [err] = await once(second, 'error')
      assert.strictEqual(err.code, 'busy')
      assert.match(err.message, /another client holds the tap/)
      await endOf(second)
      assert.strictEqual(fake.tapConnections, 1)
    })

    it('connects over WebSocket with ?token= and no Origin header; a wrong token is refused', async () => {
      const fake = await fakeBedd({ live: 'join_flat' })
      const bot = botOn(fake)
      bots.push(bot)
      await once(bot, 'spawn')
      assert.ok(fake.handshakes.length >= 2, 'control + tap connections')
      for (const h of fake.handshakes) {
        assert.strictEqual(h.path, '/v1')
        assert.strictEqual(h.token, fake.token)
        assert.strictEqual(h.origin, undefined, 'BeDD refuses any request carrying Origin')
      }
      assert.strictEqual(bot._client.bedd.url, fake.url)
      assert.deepStrictEqual(bot._client.bedd.control.modes.ui, ['ui'])
      assert.strictEqual(bot._client.bedd.control.defaultMode, 'bedboo')

      const wrong = botOn(fake, {}, { token: 'nope' })
      bots.push(wrong)
      const warnings = []
      wrong._client.on('warning', (w) => warnings.push(w))
      const [err] = await once(wrong, 'error')
      assert.strictEqual(err.code, 'ERR_BEDD_CONNECT')
      assert.match(err.message, /token/)
      assert.ok(warnings.some(w => /observation only/.test(w.message)))
    })

    it('a BeDD v1 (ping protocol 1) is refused with an upgrade hint', async () => {
      const fake = await fakeBedd({ protocol: 1, live: 'join_flat' })
      const bot = botOn(fake)
      bots.push(bot)
      const [err] = await once(bot, 'error')
      assert.strictEqual(err.code, 'ERR_BEDD_PROTOCOL')
      assert.match(err.message, /BeDD v1 uses named pipes; upgrade BeDD/)
      await endOf(bot)
      assert.strictEqual(fake.tapConnections, 0)
    })

    it('late attach: the journal replay spawns the bot, live frames racing the replay come after REPLAY_END', async () => {
      const spawnAt = cap.records.findIndex(r => r.dir === 'in' && r.name === 'play_status' && cap.parse(r).status === 'player_spawn')
      const journal = cap.records.slice(0, spawnAt + 1).filter(r => r.dir === 'in')
      const racing = [{ kind: KIND.CLIENTBOUND, payload: encodePacket('set_title', { type: 'set_title', text: 'live', fade_in_time: 0, stay_time: 0, fade_out_time: 0, xuid: '', platform_online_id: '', filtered_message: '' }) }]
      const fake = await fakeBedd({ journal, duringReplay: racing })
      const bot = botOn(fake)
      bots.push(bot)
      const order = []
      bot._client.on('packet', (des) => {
        if (des.data.name === 'set_title' || (des.data.name === 'play_status' && des.data.params.status === 'player_spawn')) order.push(`${des.data.name}:${des.bedd.replay}`)
      })
      bot._client.on('bedd_marker', (m) => order.push(m.m))
      await once(bot, 'spawn')
      await until(() => order.includes('set_title:false'), { what: 'live frame' })
      assert.deepStrictEqual(order, ['HELLO', 'REPLAY_BEGIN', 'play_status:true', 'REPLAY_END', 'set_title:false'])
      assert.deepStrictEqual(bot._client.bedd.replayed, { complete: true })
      assert.strictEqual(bot._client.bedd.journal.frames, journal.length)
    })

    it('a packet that does not decode is a warning and the stream goes on', async () => {
      const fake = await fakeBedd({
        live: [{ kind: KIND.CLIENTBOUND, payload: Buffer.from([0x0b, 0xff, 0xff]) }, { kind: 9, payload: Buffer.from('ignored kind') }, ...cap.records]
      })
      const bot = botOn(fake)
      bots.push(bot)
      const warnings = []
      bot._client.on('warning', (w) => warnings.push(w))
      await once(bot, 'spawn')
      assert.strictEqual(warnings.filter(w => w.code === 'ERR_BEDD_TAP_DECODE').length, 1)
      assert.strictEqual(warnings.find(w => w.code === 'ERR_BEDD_TAP_DECODE').packetId, 11)
    })

    it('when ping does not answer every op is absent and the tap still works (observation only)', async () => {
      const fake = await fakeBedd({ live: 'join_flat', caps: { ping: 'absent' } })
      const bot = botOn(fake)
      bots.push(bot)
      const warnings = []
      bot._client.on('warning', (w) => warnings.push(w))
      await once(bot, 'spawn')
      for (const op of bedd.PROBE_OPS) assert.strictEqual(bot._client.bedd.caps[op], 'absent', op)
      assert.strictEqual(bot._client.bedd.caps.ping, undefined)
      assert.ok(warnings.some(w => /observation only/.test(w.message)))
    })

    it('caps follow the probe answers: present, disabled (code), absent (unknown op)', async () => {
      const fake = await fakeBedd({ caps: { look: 'disabled', stack: 'absent', send: 'disabled' }, handlers: { world: () => { throw Object.assign(new Error('not in a level'), { code: 'not_in_level' }) } } })
      const bot = botOn(fake)
      bots.push(bot)
      const caps = await bot._client.bedd.ready
      assert.deepStrictEqual(
        bedd.PROBE_OPS.map(op => `${op}:${caps[op]}`),
        ['tap:present', 'world:present', 'look:disabled', 'input:present', 'slot:present', 'button:present', 'action:present', 'send:disabled', 'stack:absent', 'join:present', 'ui:present']
      )
      assert.strictEqual(bot._client.bedd.supports('look'), false)
      assert.strictEqual(caps.key, 'present', 'base ops are present once ping answers')
      assert.strictEqual(caps.screenshot, 'present', 'ops of ping.modes are present')
      assert.strictEqual(caps.ui, 'present')
      assert.strictEqual(fake.callsOf('stack').length, 0, 'an op ping.modes does not list is absent without a probe')
    })

    it('a control connection that closes mid-session turns every cap absent (with a warning); a stuck probe stops probing', async () => {
      const fake = await fakeBedd({ handlers: { input: () => fake.NO_REPLY } })
      const client = bedd.createBeddClient({ version: TEST_VERSION, bedd: fake.botOptions() })
      const caps = await client.bedd.ready
      assert.deepStrictEqual(bedd.PROBE_OPS.map(op => caps[op]), ['present', 'present', 'present', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent'])
      assert.deepStrictEqual(fake.calls.map(c => c.op), ['ping', 'tap', 'world', 'look', 'input'], 'no probe after the stuck one')
      const warned = once(client, 'warning')
      for (const socket of fake.controlClients) socket.destroy()
      const [warning] = await warned
      assert.match(warning.message, /observation only/)
      assert.strictEqual(client.bedd.supports('tap'), false)
      client.close()
    })

    it('bot.end() / quit() only detach (no disconnect packet, both WebSockets closed)', async () => {
      const fake = await fakeBedd({ live: 'join_flat' })
      const bot = botOn(fake)
      await once(bot, 'spawn')
      const tapClosed = once(fake, 'tapClose')
      const ended = endOf(bot)
      bot.quit()
      assert.strictEqual(await ended, 'disconnect.quitting')
      await tapClosed
      await until(() => fake.controlClients.size === 0, { what: 'control connection detached' })
      assert.strictEqual(bot._client.bedd.dropped.disconnect, undefined)
    })
  })

  describe('client.bedd route and modules', () => {
    it('queue/write go to client.bedd.route; the default drops and counts; a module may replace it', async () => {
      const fake = await fakeBedd({})
      const client = bedd.createBeddClient({ version: TEST_VERSION, bedd: fake.botOptions() })
      client.queue('player_auth_input', { tick: 1n })
      client.write('text', { message: 'hi' })
      client.queue('player_auth_input', { tick: 2n })
      assert.deepStrictEqual(client.bedd.dropped, { player_auth_input: 2, text: 1 })
      const routed = []
      const previous = client.bedd.route
      client.bedd.route = (name, params) => { routed.push(name); if (name !== 'text') previous(name, params) }
      client.write('text', { message: 'x' })
      client.queue('respawn', {})
      assert.deepStrictEqual(routed, ['text', 'respawn'])
      assert.deepStrictEqual(client.bedd.dropped, { player_auth_input: 2, text: 1, respawn: 1 })
      await client.bedd.ready
      client.close()
    })

    it('rpc.call sends { id, op, ...args } and returns the reply; errors carry the BeDD code', async () => {
      const fake = await fakeBedd({ handlers: { slot: (args) => { if (args.slot > 8) throw Object.assign(new Error('slot out of range'), { code: 'bad_args' }); return { slot: args.slot } } } })
      const client = bedd.createBeddClient({ version: TEST_VERSION, bedd: fake.botOptions() })
      await client.bedd.ready
      const reply = await client.bedd.rpc.call('slot', { slot: 3 })
      assert.strictEqual(reply.slot, 3)
      assert.deepStrictEqual(fake.callsOf('slot').at(-1).args, { slot: 3 })
      await assert.rejects(client.bedd.rpc.call('slot', { slot: 9 }), (err) => err.code === 'bad_args' && err.op === 'slot' && err.reply.error === 'slot out of range')
      await assert.rejects(client.bedd.rpc.call('nope'), (err) => err.code === 'ERR_BEDD_RPC' && /unknown op 'nope'/.test(err.message))
      client.close()
      await assert.rejects(client.bedd.rpc.call('slot', { slot: 1 }), { code: 'ERR_BEDD_RPC_CLOSED' })
    })

    it('createClient dispatches transport bedd; raknet/nethernet bots keep their mode', async () => {
      const fake = await fakeBedd({})
      const client = createClient({ transport: 'bedd', version: TEST_VERSION, bedd: fake.botOptions(), username: 'x' })
      assert.ok(client.bedd)
      assert.strictEqual(client.options.transport, 'bedd')
      const defaulted = createClient({ transport: 'bedd', bedd: fake.botOptions({ modules: [] }) })
      defaulted.close() // before it starts
      assert.strictEqual(defaulted.version, '1.26.60', 'bedd defaults to the game BeDD v2 runs')
      await client.bedd.ready
      client.close()
      const { bot } = await createFakeBot()
      assert.strictEqual(bot._bedrock.mode, 'raknet')
      assert.strictEqual(bot._client.bedd, undefined)
      bot.end()
      assert.throws(() => createClient({ transport: 'carrier-pigeon' }), /'raknet' \(default\), 'nethernet' or 'bedd'/)
    })

    describe('optional modules', () => {
      let dir
      before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedboo-bedd-mod-'))
        fs.writeFileSync(path.join(dir, 'good.js'), "exports.attach = (bot, client) => { client.bedd.route = () => 'good' }\n")
        fs.writeFileSync(path.join(dir, 'broken.js'), "throw new Error('broken module')\n")
        fs.writeFileSync(path.join(dir, 'needsdep.js'), "require('./does-not-exist-dep')\n")
      })
      after(() => fs.rmSync(dir, { recursive: true, force: true }))

      it('a missing module is skipped, a broken one or one missing a dependency throws', () => {
        assert.strictEqual(bedd.loadOptionalModule('absent', dir), null)
        assert.strictEqual(typeof bedd.loadOptionalModule('good', dir).attach, 'function')
        assert.throws(() => bedd.loadOptionalModule('broken', dir), /broken module/)
        assert.throws(() => bedd.loadOptionalModule('needsdep', dir), (err) => err.code === 'MODULE_NOT_FOUND' && /does-not-exist-dep/.test(err.message))
      })

      it('the manifest is the spec list; attach() loads present lib/bedd modules after the plugins', async () => {
        assert.deepStrictEqual([...bedd.OPTIONAL_MODULES], ['authority', 'router', 'router_actions', 'follower', 'surface', 'inventory', 'screens'])
        for (const name of bedd.OPTIONAL_MODULES) {
          const mod = bedd.loadOptionalModule(name)
          if (mod) assert.ok(typeof mod === 'object' || typeof mod === 'function', name)
        }
        const fake = await fakeBedd({})
        const bot = botOn(fake, {}, { modules: undefined })
        bots.push(bot)
        await bot._client.bedd.ready
        for (const name of Object.keys(bot._client.bedd.modules)) assert.ok(bedd.OPTIONAL_MODULES.includes(name))
        assert.ok(bot.inventory, 'plugins were injected before the modules')
      })
    })
  })

  describe('control RPC', () => {
    /** an injected WebSocket class: what the rpc sends lands in `lines`, `reply(obj)` answers */
    function pair () {
      const lines = []
      const p = { lines, urls: [] }
      p.WebSocket = class extends EventTarget {
        constructor (url) {
          super()
          p.urls.push(url)
          p.socket = this
          setImmediate(() => this.dispatchEvent(new Event('open')))
        }

        send (text) { lines.push(JSON.parse(text)) }
        close () { setImmediate(() => this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 }))) }
      }
      p.reply = (obj) => p.socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(obj) }))
      return p
    }

    it('sends the token as ?token= and each request as one text message', async () => {
      const p = pair()
      const rpc = createRpc({ url: 'ws://127.0.0.1:1/v1', token: 'ab12', WebSocket: p.WebSocket })
      const ping = rpc.call('ping')
      await until(() => p.lines.length === 1)
      assert.strictEqual(p.urls[0], 'ws://127.0.0.1:1/v1?token=ab12')
      assert.strictEqual(rpc.url, 'ws://127.0.0.1:1/v1', 'no token in rpc.url')
      p.reply({ ok: true, id: p.lines[0].id, protocol: 2 })
      assert.strictEqual((await ping).protocol, 2)
      rpc.close()
    })

    it('keeps one request in flight (FIFO) and drops a late reply to a timed-out request', async () => {
      const p = pair()
      const rpc = createRpc({ url: 'ws://x/v1', token: 't', WebSocket: p.WebSocket, timeoutMs: 100 })
      const a = rpc.call('look', {})
      const b = rpc.call('slot', { slot: 2 })
      await until(() => p.lines.length === 1)
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.strictEqual(p.lines.length, 1, 'second request waits for the first reply')
      await assert.rejects(a, { code: 'ERR_BEDD_RPC_TIMEOUT' })
      await until(() => p.lines.length === 2)
      p.reply({ ok: true, id: p.lines[0].id, yaw: 1 }) // late reply to `a`: dropped
      p.reply({ ok: true, id: p.lines[1].id, slot: 2 })
      assert.strictEqual((await b).slot, 2)
      assert.deepStrictEqual(p.lines[1], { slot: 2, id: p.lines[1].id, op: 'slot' })
      rpc.close()
    })

    it('an op timeoutMs argument extends the transport timeout', async () => {
      const p = pair()
      const rpc = createRpc({ url: 'ws://x/v1', token: 't', WebSocket: p.WebSocket, timeoutMs: 50 })
      const look = rpc.call('look', { yaw: 1, pitch: 2, timeoutMs: 100 })
      await new Promise(resolve => setTimeout(resolve, 120))
      await until(() => p.lines.length === 1)
      p.reply({ ok: true, id: p.lines[0].id, yaw: 1, pitch: 2, tick: 5 })
      assert.strictEqual((await look).tick, 5)
      rpc.close()
    })

    it('probe maps replies to present / disabled / absent', () => {
      assert.strictEqual(probeResult({ code: 'disabled', reply: {} }), 'disabled')
      assert.strictEqual(probeResult({ code: 'ERR_BEDD_RPC', message: "unknown op 'look'", reply: {} }), 'absent')
      assert.strictEqual(probeResult({ code: 'ERR_BEDD_RPC_TIMEOUT', message: 'timed out' }), 'absent')
      assert.strictEqual(probeResult({ code: 'not_in_level', message: 'not in a level', reply: {} }), 'present')
    })

    it('a failed connection rejects the queued calls', async () => {
      const server = require('net').createServer()
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = server.address().port
      await new Promise(resolve => server.close(resolve)) // a port nobody listens on
      const rpc = createRpc({ url: `ws://127.0.0.1:${port}/v1`, token: 't' })
      await assert.rejects(rpc.call('ping'), { code: 'ERR_BEDD_RPC_CLOSED' })
      assert.strictEqual(await rpc.probe('look'), 'absent')
    })
  })

  describe('endpoint discovery', () => {
    let home
    const dead = 0x7ffffff0 // no such pid
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'bedboo-bedd-home-')) })
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

    function runFile (ep) {
      fs.mkdirSync(path.join(home, 'run'), { recursive: true })
      fs.writeFileSync(path.join(home, 'run', `${ep.pid}.json`), JSON.stringify({ protocol: 2, kind: 'client', url: `ws://127.0.0.1:${1000 + (ep.pid % 1000)}/v1`, token: `t${ep.pid}`, ...ep }))
    }

    it('home is $BEDD_HOME, else %LOCALAPPDATA%\\BeDD', () => {
      assert.strictEqual(bedd.beddHome({ BEDD_HOME: home }), path.resolve(home))
      assert.strictEqual(bedd.beddHome({ LOCALAPPDATA: path.join(home, 'Local') }), path.join(home, 'Local', 'BeDD'))
    })

    it('{} picks the only running client; dead pids, servers and bad files are skipped', () => {
      runFile({ pid: process.pid, instance: 'base-2', label: 'me' })
      runFile({ pid: dead, instance: 'base-3' })
      runFile({ pid: process.ppid, kind: 'server', instance: 'bds' })
      fs.writeFileSync(path.join(home, 'run', 'garbage.json'), '{ not json')
      const ep = bedd.resolveEndpoint({ home })
      assert.deepStrictEqual([ep.pid, ep.instance, ep.token], [process.pid, 'base-2', `t${process.pid}`])
      assert.deepStrictEqual(bedd.listEndpoints({ home }).map(e => e.pid).sort(), [process.pid, process.ppid].sort())
      assert.strictEqual(bedd.resolveEndpoint({ home, instance: 'BASE-2' }).pid, process.pid, 'instance names match case-insensitively')
      assert.strictEqual(bedd.resolveEndpoint({ home, pid: process.pid }).url, `ws://127.0.0.1:${1000 + (process.pid % 1000)}/v1`)
      assert.throws(() => bedd.resolveEndpoint({ home, pid: dead }), { code: 'ERR_BEDD_DISCOVERY' })
      assert.throws(() => bedd.resolveEndpoint({ home, pid: process.ppid }), /is a server, not a game client/)
      assert.throws(() => bedd.resolveEndpoint({ home, instance: 'base-3' }), /no running BeDD game of instance 'base-3'; running: pid/)
    })

    it('no game, or several, is an error naming what to pass', () => {
      assert.throws(() => bedd.resolveEndpoint({ home }), /no BeDD game is running .*BeDD.exe launch --slot 2/)
      runFile({ pid: process.pid, instance: 'a' })
      runFile({ pid: process.ppid, instance: 'b' })
      assert.throws(() => bedd.resolveEndpoint({ home }), /2 BeDD games are running .*pass bedd.pid or bedd.instance/)
      assert.strictEqual(bedd.resolveEndpoint({ home, instance: 'b' }).pid, process.ppid)
    })

    it('url + token are used as given; the v1 pipe options throw', () => {
      assert.deepStrictEqual(bedd.resolveEndpoint({ url: 'ws://127.0.0.1:5/v1', token: 'x' }), { url: 'ws://127.0.0.1:5/v1', token: 'x' })
      assert.throws(() => bedd.resolveEndpoint({ url: 'ws://127.0.0.1:5/v1' }), /needs bedd.token/)
      assert.throws(() => bedd.resolveEndpoint({ url: 'http://x', token: 'x' }), /ws:\/\/ URL/)
      assert.throws(() => bedboo.createBot({ transport: 'bedd', bedd: { url: 'ws://127.0.0.1:5/v1' } }), /needs bedd.token/, 'malformed options throw from createBot')
      const bot = bedboo.createBot({ transport: 'bedd', bedd: { url: 'ws://127.0.0.1:1/v1?token=SECRET', token: 'SECRET', modules: [] }, logErrors: false, hideErrors: true })
      bot.on('error', () => {})
      assert.ok(!bot._client.bedd.url.includes('SECRET'), bot._client.bedd.url)
      assert.strictEqual(bot.version, '1.26.60')
      bot.end()
      for (const key of ['pipe', 'tapPipe', 'connect']) {
        assert.throws(() => bedboo.createBot({ transport: 'bedd', bedd: { [key]: '\\\\.\\pipe\\BeDD' } }), new RegExp(`bedd.${key} was removed: BeDD v2 has no named pipes`))
      }
    })

    it('createBot finds the game through its run file (bedd: {} and bedd: { pid })', async () => {
      const fake = await createFakeBedd({ live: 'join_flat' })
      try {
        fake.writeRunFile(home)
        for (const given of [{}, { pid: process.pid }, { instance: 'fake-1' }]) {
          const bot = bedboo.createBot({ transport: 'bedd', version: TEST_VERSION, bedd: { home, modules: [], ...given }, logErrors: false, hideErrors: true })
          await once(bot, 'spawn')
          assert.strictEqual(bot._client.bedd.endpoint.pid, process.pid)
          assert.strictEqual(bot._client.bedd.url, fake.url)
          const ended = endOf(bot)
          const tapClosed = once(fake, 'tapClose')
          bot.end()
          await ended
          await tapClosed // the next bot can subscribe
        }
      } finally {
        await fake.close()
      }
    })

    it('without a running game the bot errors (ERR_BEDD_DISCOVERY) and ends', async () => {
      const bot = bedboo.createBot({ transport: 'bedd', version: TEST_VERSION, bedd: { home, modules: [] }, logErrors: false, hideErrors: true })
      const [err] = await once(bot, 'error')
      assert.strictEqual(err.code, 'ERR_BEDD_DISCOVERY')
      assert.match(err.message, /no BeDD game is running/)
      await endOf(bot)
    })
  })

  describe('tap framing', () => {
    it('parses frames split at any byte and frames sharing a chunk', () => {
      const frames = [
        encodeFrame(KIND.MARKER, 0, { m: 'HELLO' }, { seq: 1n, tUs: 7n }),
        encodeFrame(KIND.CLIENTBOUND, FLAG.REPLAY | FLAG.RESERIALIZED, Buffer.from([1, 2, 3]), { seq: 2n }),
        encodeFrame(KIND.SERVERBOUND_ECHO, FLAG.LOCAL, Buffer.alloc(0), { seq: 3n })
      ]
      const all = Buffer.concat(frames)
      for (const step of [1, 3, 7, all.length]) {
        const parser = createFrameParser()
        const out = []
        for (let i = 0; i < all.length; i += step) out.push(...parser.push(all.subarray(i, i + step)))
        assert.deepStrictEqual(out.map(f => [f.kind, f.flags, f.seq, f.payload.length]), [[4, 0, 1n, 13], [1, 3, 2n, 3], [2, 4, 3n, 0]], `step ${step}`)
        assert.strictEqual(out[0].tUs, 7n)
      }
      assert.throws(() => createFrameParser().push(Buffer.from([5, 0, 0, 0, 0, 0, 0, 0, 0])), { code: 'ERR_BEDD_TAP_FRAME' })
    })

    it('a stream that does not start with HELLO is refused', async () => {
      const stream = new PassThrough()
      const reader = createTapReader(stream, { version: TEST_VERSION, protocol: TEST_PROTOCOL, decoder: { decode: () => { throw new Error('unused') } } })
      const failed = once(reader, 'error')
      stream.write(encodeFrame(KIND.CLIENTBOUND, 0, Buffer.from([1])))
      const [err] = await failed
      assert.strictEqual(err.code, 'ERR_BEDD_HELLO')
    })

    it('decodes join_flat with createDeserializer + ShieldItemID (no decode warnings)', async () => {
      const stream = new PassThrough()
      const reader = createTapReader(stream, { version: TEST_VERSION, protocol: TEST_PROTOCOL })
      const names = []
      const warnings = []
      reader.on('packet', (p) => names.push(p.name))
      reader.on('warning', (w) => warnings.push(w))
      stream.write(encodeFrame(KIND.MARKER, 0, { m: 'HELLO', tap: 1, protocol: TEST_PROTOCOL }))
      const frames = toFrames('join_flat')
      for (const f of frames) stream.write(encodeFrame(f.kind, f.flags, f.payload))
      await until(() => names.length + warnings.length === frames.length)
      assert.deepStrictEqual(warnings, [])
      assert.ok(names.includes('inventory_content') && names.includes('start_game') && names.includes('subchunk'))
      reader.close()
    })
  })
})
