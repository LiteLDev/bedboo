// owner: BEDD-1 (transport 'bedd': control RPC, tap reader, createBeddClient, optional-module manifest)
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { once } = require('events')
const { PassThrough } = require('stream')
const fixtures = require('../../fixtures')
const mineflayerBedrock = require('../../..')
const { createFakeBedd, encodePacket, toFrames } = require('../helpers/fake_bedd')
const { createFakeBot } = require('../helpers/fake')
const { createRpc, probeResult } = require('../../../lib/bedd/rpc')
const { createTapReader, createFrameParser, encodeFrame, KIND, FLAG } = require('../../../lib/bedd/tap')
const bedd = require('../../../lib/bedd')
const { createClient } = require('../../../lib/client')

/** resolve once `fn()` is truthy (polls every 10 ms) */
async function until (fn, { timeout = 10000, what = 'condition' } = {}) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function botOn (fake, extra = {}, beddExtra = {}) {
  return mineflayerBedrock.createBot({
    transport: 'bedd',
    bedd: fake.botOptions({ modules: [], ...beddExtra }),
    logErrors: false,
    hideErrors: true,
    ...extra
  })
}

function endOf (bot) {
  return new Promise(resolve => bot.once('end', resolve))
}

describe("transport 'bedd' (BEDD-1)", function () {
  this.timeout(30000)
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
  })

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
      assert.ok(!fake.calls.some(c => Object.keys(c.args).length > 0), 'no action op reached the control pipe')

      // caps: ping + every spec op probed without arguments
      assert.deepStrictEqual(fake.calls.slice(0, 1 + bedd.PROBE_OPS.length).map(c => c.op), ['ping', ...bedd.PROBE_OPS])
      assert.ok(fake.calls.slice(0, 1 + bedd.PROBE_OPS.length).every(c => Object.keys(c.args).length === 0), 'probes carry no arguments')
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
      await until(() => fake.controlClients.size === 0, { what: 'control pipe detached' })
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

    it('errors and ends when the tap pipe is missing', async () => {
      const fake = await fakeBedd({ tap: false })
      const bot = botOn(fake)
      bots.push(bot)
      const [err] = await once(bot, 'error')
      assert.strictEqual(err.code, 'ERR_BEDD_CONNECT')
      await endOf(bot)
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

    it('without a control pipe every op is absent and the tap still works (observation only)', async () => {
      const fake = await fakeBedd({ live: 'join_flat' })
      const bot = botOn(fake, {}, { pipe: fake.path + '-missing', tapPipe: fake.tapPath })
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
        ['tap:present', 'world:present', 'look:disabled', 'input:present', 'slot:present', 'button:present', 'action:present', 'send:disabled', 'stack:absent']
      )
      assert.strictEqual(bot._client.bedd.supports('look'), false)
      assert.strictEqual(caps.key, 'present', 'protocol-1 ops are present once ping answers')
    })

    it('a control pipe that closes mid-session turns every cap absent (with a warning); a stuck probe stops probing', async () => {
      const fake = await fakeBedd({ handlers: { input: () => fake.NO_REPLY } })
      const client = bedd.createBeddClient({ bedd: fake.botOptions() })
      const caps = await client.bedd.ready
      assert.deepStrictEqual(bedd.PROBE_OPS.map(op => caps[op]), ['present', 'present', 'present', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent'])
      assert.deepStrictEqual(fake.calls.map(c => c.op), ['ping', 'tap', 'world', 'look', 'input'], 'no probe after the stuck one')
      const warned = once(client, 'warning')
      for (const socket of fake.controlClients) socket.destroy()
      const [warning] = await warned
      assert.match(warning.message, /observation only/)
      assert.strictEqual(client.bedd.supports('tap'), false)
      client.close()
    })

    it('bot.end() / quit() only detach (no disconnect packet, both pipes closed)', async () => {
      const fake = await fakeBedd({ live: 'join_flat' })
      const bot = botOn(fake)
      await once(bot, 'spawn')
      const tapClosed = once(fake, 'tapClose')
      const ended = endOf(bot)
      bot.quit()
      assert.strictEqual(await ended, 'disconnect.quitting')
      await tapClosed
      await until(() => fake.controlClients.size === 0, { what: 'control pipe detached' })
      assert.strictEqual(bot._client.bedd.dropped.disconnect, undefined)
    })
  })

  describe('client.bedd route and modules', () => {
    it('queue/write go to client.bedd.route; the default drops and counts; a module may replace it', async () => {
      const fake = await fakeBedd({})
      const client = bedd.createBeddClient({ bedd: fake.botOptions() })
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
      const client = bedd.createBeddClient({ bedd: fake.botOptions() })
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
      const client = createClient({ transport: 'bedd', bedd: fake.botOptions(), username: 'x' })
      assert.ok(client.bedd)
      assert.strictEqual(client.options.transport, 'bedd')
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
        assert.deepStrictEqual([...bedd.OPTIONAL_MODULES], ['authority', 'router', 'router_actions', 'follower', 'surface', 'inventory'])
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
    /** a Duplex pair: what the rpc writes comes out of `server`, what `server` gets written reaches the rpc */
    function pair () {
      const toServer = new PassThrough()
      const toClient = new PassThrough()
      const clientSide = new (require('stream').Duplex)({
        read () {},
        write (chunk, enc, cb) { toServer.write(chunk); cb() }
      })
      toClient.on('data', (d) => clientSide.push(d))
      const lines = []
      let buf = ''
      toServer.on('data', (d) => {
        buf += d
        let nl
        while ((nl = buf.indexOf('\n')) !== -1) { lines.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1) }
      })
      return { clientSide, lines, reply: (obj) => toClient.write(JSON.stringify(obj) + '\n') }
    }

    it('keeps one request in flight (FIFO) and drops a late reply to a timed-out request', async () => {
      const p = pair()
      const rpc = createRpc({ path: 'x', connect: () => p.clientSide, timeoutMs: 100 })
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
      const rpc = createRpc({ path: 'x', connect: () => p.clientSide, timeoutMs: 50 })
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
      const rpc = createRpc({ path: path.join(os.tmpdir(), `bedboo-no-such-pipe-${process.pid}`) })
      await assert.rejects(rpc.call('ping'), { code: 'ERR_BEDD_RPC_CLOSED' })
      assert.strictEqual(await rpc.probe('look'), 'absent')
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
      const reader = createTapReader(stream, { version: '1.26.51', protocol: 2193, decoder: { decode: () => { throw new Error('unused') } } })
      const failed = once(reader, 'error')
      stream.write(encodeFrame(KIND.CLIENTBOUND, 0, Buffer.from([1])))
      const [err] = await failed
      assert.strictEqual(err.code, 'ERR_BEDD_HELLO')
    })

    it('decodes join_flat with createDeserializer + ShieldItemID (no decode warnings)', async () => {
      const stream = new PassThrough()
      const reader = createTapReader(stream, { version: '1.26.51', protocol: 2193 })
      const names = []
      const warnings = []
      reader.on('packet', (p) => names.push(p.name))
      reader.on('warning', (w) => warnings.push(w))
      stream.write(encodeFrame(KIND.MARKER, 0, { m: 'HELLO', tap: 1, protocol: 2193 }))
      const frames = toFrames('join_flat')
      for (const f of frames) stream.write(encodeFrame(f.kind, f.flags, f.payload))
      await until(() => names.length + warnings.length === frames.length)
      assert.deepStrictEqual(warnings, [])
      assert.ok(names.includes('inventory_content') && names.includes('start_game') && names.includes('subchunk'))
      reader.close()
    })
  })
})
