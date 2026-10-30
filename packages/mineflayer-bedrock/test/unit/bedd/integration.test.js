'use strict'
// bedd integration (every bedd module together): a real createBot({ transport: 'bedd' }) against the fake Be.D.D.
// (test/unit/helpers/fake_bedd.js) with the default optional-module manifest (authority, router, router_actions,
// follower, surface, inventory). The fake plays the real client: it replays join_flat on the tap, echoes one
// player_auth_input per tick carrying the rotation the `look` op set, answers `action inventory` / ESC with the
// screens the client would open, and submits `stack` requests with its own ids (counting down from -0x40000001 like
// BD9), answering through the tap. Each bot API must come out as the right control ops.
const assert = require('assert')
const { once } = require('events')
const { Vec3 } = require('vec3')
const mineflayerBedrock = require('../../..')
const { createFakeBedd, NO_REPLY } = require('../helpers/fake_bedd')
const { inventoryContent } = require('../helpers/inventory_server')
const { OPTIONAL_MODULES } = require('../../../lib/bedd')
const { toBedrockYaw, toBedrockPitch } = require('../../../lib/bedrock/conversions')

const UP = new Vec3(0, 1, 0)

async function until (fn, { timeout = 10000, what = 'condition' } = {}) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

let deserializer
function decode (buf) {
  const { createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  deserializer = deserializer ?? createDeserializer('1.26.51')
  return deserializer.parsePacketBuffer(Buffer.from(buf, 'base64')).data
}

/** what BDS answers to `request` (from the bot's own prediction; see test/unit/bedd/inventory.test.js) */
function answer (bot, request, nextStackId) {
  const model = bot._bedrock.inventoryModel
  const containers = new Map()
  for (const action of request.actions) {
    for (const info of [action.source, action.destination]) {
      if (!info || info.slot_type.container_id === 'creative_output') continue
      const id = info.slot_type.container_id
      if (!containers.has(id)) containers.set(id, new Map())
      const key = model.keyOfResponse(id, info.slot)
      const item = key ? model.read(key) : null
      const slot = { slot: info.slot, hotbar_slot: info.slot, count: item ? item.count : 0, custom_name: '', filtered_custom_name: '', durability_correction: 0 }
      if (item) slot.item_stack_id = item.stackId > 0 ? item.stackId : nextStackId()
      containers.get(id).set(info.slot, slot)
    }
  }
  return { status: 'ok', request_id: request.request_id, containers: [...containers].map(([id, slots]) => ({ slot_type: { container_id: id }, slots: [...slots.values()] })) }
}

/**
 * The fake real client. `game.bot` is set once the bot exists (the `stack` answer reads its prediction).
 */
async function fakeGame (opts = {}) {
  const game = { bot: null, stackIds: 5000, clientId: -0x3fffffff, submitted: [], responseFirst: false, windowId: 2 }
  const fake = await createFakeBedd({
    live: 'join_flat',
    ...opts,
    handlers: {
      action (args, fake) {
        if (!args.name) return { names: ['drop', 'dropAll', 'inventory', 'perspective', 'pause'] }
        if (args.name === 'inventory') {
          // the client opens its inventory screen; BDS answers the interact with container_open
          fake.state.showingMenu = true
          fake.state.mouseGrabbed = false
          setImmediate(() => fake.sendPacket('container_open', { window_id: game.windowId++, window_type: 'inventory', coordinates: { x: 0, y: -59, z: 0 }, runtime_entity_id: -1n }))
        }
        return {}
      },
      key (args, fake) {
        if (args.key === 'ESC' && fake.state.showingMenu) {
          fake.state.showingMenu = false
          fake.state.mouseGrabbed = true
          setImmediate(() => fake.sendPacket('container_close', { window_id: game.windowId - 1, window_type: 'none', server: false }))
        }
        return {}
      },
      stack (args) {
        if (!args.buf) return { enabled: true }
        const { name, params } = decode(args.buf)
        assert.strictEqual(name, 'item_stack_request')
        assert.strictEqual(params.requests.length, 1)
        const request = params.requests[0]
        const bedbooId = request.request_id
        game.clientId -= 2 // BD9: -0x40000001, -0x40000003, … (odd negatives, never bedboo's -1, -3, …)
        const id = game.clientId
        // BD9 renames the request's self references (stack ids naming the request itself) to the id it assigns
        const own = (info) => info && info.stack_id === bedbooId ? { ...info, stack_id: id } : info
        const clientRequest = { ...request, request_id: id, actions: request.actions.map(a => ({ ...a, source: own(a.source), destination: own(a.destination) })) }
        game.submitted.push([request, clientRequest])
        const respond = () => fake.sendPacket('item_stack_response', { responses: [answer(game.bot, clientRequest, () => game.stackIds++)] })
        const reply = { via: 'manager', requestIds: [id], map: { [String(bedbooId)]: id } }
        if (!game.responseFirst) {
          setTimeout(respond, 10) // BD9 replies right after submitting, ~10 ms before the server's answer
          return reply
        }
        // the tap may deliver the answer before the reply (two pipes, no ordering between them)
        respond()
        return new Promise(resolve => setTimeout(() => resolve(reply), 100))
      },
      ...opts.handlers
    }
  })
  game.fake = fake
  return game
}

/** one echoed player_auth_input per 50 ms, at the rotation the client has (fake.state, set by `look`) */
function startEchoes (game, template) {
  let tick = BigInt(template.tick ?? 0)
  const timer = setInterval(() => {
    tick += 1n
    game.fake.sendPacket('player_auth_input', { ...template, tick, yaw: game.fake.state.yaw, pitch: game.fake.state.pitch, head_yaw: game.fake.state.yaw, block_action: undefined, item_stack_request: undefined, input_data: template.input_data }, { dir: 'out' })
  }, 50)
  return () => clearInterval(timer)
}

describe('bedd integration: createBot({ transport: \'bedd\' }) with every module, against the fake Be.D.D.', function () {
  this.timeout(60000)
  let game, bot, stopEchoes

  before(async () => {
    game = await fakeGame()
    bot = mineflayerBedrock.createBot({ transport: 'bedd', bedd: game.fake.botOptions(), logErrors: false, hideErrors: true })
    game.bot = bot
    let template = null
    bot._client.on('serverbound', (p) => { if (p.name === 'player_auth_input' && !p.replay) template = p.params })
    await once(bot, 'spawn')
    await bot._client.bedd.ready
    await until(() => template, { what: 'an echoed player_auth_input' })
    stopEchoes = startEchoes(game, template)
    await until(() => bot.bedrock.bedd?.observed, { what: 'the follower' })
    game.fake.calls.length = 0
  })

  after(async () => {
    stopEchoes?.()
    bot?.end()
    await game?.fake.close()
  })

  const ops = (op) => game.fake.callsOf(op).map(c => c.args)

  it('loads every module of the manifest once, in order; the router owns the route and the shared registry', () => {
    assert.deepStrictEqual(Object.keys(bot._client.bedd.modules), [...OPTIONAL_MODULES])
    assert.strictEqual(bot._client.bedd.route, bot._client.bedd.router.route)
    const routes = bot._client.bedd.routes
    for (const name of ['block_action', 'inventory_transaction', 'item_stack_request']) assert.strictEqual(routes.get(name).length, 1, name)
    // attach is idempotent: the loader's call, a second call and the modules' own guards
    bot._client.bedd.attach(bot)
    for (const name of ['block_action', 'inventory_transaction', 'item_stack_request']) assert.strictEqual(routes.get(name).length, 1, name)
    assert.strictEqual(bot._bedrock.mode, 'bedd')
    assert.strictEqual(bot._bedrock.input.isExternalClock(), true, 'the follower drives the input clock')
    assert.deepStrictEqual(bot._client.bedd.caps.stack, 'present')
    assert.strictEqual(bot.bedrock.bedd.supports('dig'), true)
    assert.strictEqual(bot.bedrock.bedd.supports('craft'), true)
  })

  it('movement: setControlState → input {move, sprint, ttlMs}, clearControlStates → ttlMs:0', async () => {
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    await until(() => ops('input').some(a => a.move?.z === 1 && a.sprint), { what: 'input forward + sprint' })
    const sent = ops('input').find(a => a.move?.z === 1)
    assert.strictEqual(sent.ttlMs, 300)
    bot.clearControlStates()
    await until(() => ops('input').at(-1)?.ttlMs === 0, { what: 'input cleared' })
    assert.deepStrictEqual(ops('input').at(-1).move, { x: 0, z: 0 })
  })

  it('look: bot.look → look {yaw, pitch} in Bedrock degrees; resolves once the echo converges', async () => {
    await bot.look(Math.PI / 2, 0.3) // mineflayer radians: yaw +90° (west, -x), pitch up
    const last = ops('look').at(-1)
    assert.ok(last, 'a look op')
    const near = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180) < 0.01
    assert.ok(near(last.yaw, toBedrockYaw(Math.PI / 2)), `yaw ${last.yaw}`)
    assert.ok(near(last.pitch, toBedrockPitch(0.3)), `pitch ${last.pitch}`)
    assert.ok(Math.abs(bot.bedrock.bedd.observed.yaw - last.yaw) < 0.5, 'the echo carries the client\'s new rotation')
  })

  it('slot: setQuickBarSlot → slot {slot}', async () => {
    bot.setQuickBarSlot(3)
    await until(() => ops('slot').some(a => a.slot === 3), { what: 'slot 3' })
    bot.setQuickBarSlot(0)
    await until(() => ops('slot').some(a => a.slot === 0), { what: 'slot 0' })
  })

  it('chat and command: send {buf} with the text / command_request bytes (the command uuid kept)', async () => {
    bot.chat('hello from bedboo')
    bot.chat('/say hi')
    await until(() => ops('send').length >= 2, { what: 'two send calls' })
    const [text, command] = ops('send').map(a => decode(a.buf))
    assert.strictEqual(text.name, 'text')
    assert.strictEqual(text.params.message, 'hello from bedboo')
    assert.strictEqual(command.name, 'command_request')
    assert.strictEqual(command.params.command, '/say hi')
    assert.match(command.params.origin.uuid, /^[0-9a-f-]{36}$/)
  })

  it('dig: look at the block, button attack down releaseOn:blockChange; update_block to air resolves, attack up', async () => {
    bot.game.gameMode = 'survival'
    const pos = bot.entity.position.floored().offset(1, 0, 0)
    const rid = (name) => bot.registry.runtimeIdByStateId[bot.registry.blocksByName[name].defaultState]
    game.fake.sendPacket('update_block', { position: { x: pos.x, y: pos.y, z: pos.z }, block_runtime_id: rid('dirt'), flags: { _value: 3 }, layer: 0 })
    await until(() => bot.blockAt(pos)?.name === 'dirt', { what: 'the dirt block' })
    game.fake.calls.length = 0
    const dug = bot.dig(bot.blockAt(pos))
    await until(() => ops('button').some(a => a.button === 'attack' && a.action === 'down'), { what: 'attack down' })
    const down = ops('button').find(a => a.button === 'attack' && a.action === 'down')
    assert.strictEqual(down.releaseOn, 'blockChange')
    assert.ok(game.fake.calls.findIndex(c => c.op === 'look') < game.fake.calls.findIndex(c => c.op === 'button'), 'the look precedes the press')
    // the real client breaks the block; the server's update_block reaches the tap
    game.fake.sendPacket('update_block', { position: { x: pos.x, y: pos.y, z: pos.z }, block_runtime_id: rid('air'), flags: { _value: 3 }, layer: 0 })
    await dug
    await until(() => ops('button').some(a => a.button === 'attack' && a.action === 'up'), { what: 'attack up' })
    assert.strictEqual(bot.blockAt(pos).name, 'air')
  })

  it('inventory via stack: clickWindow and craft go out as stack {buf}; the client-id responses settle them', async () => {
    game.fake.sendPacket('inventory_content', inventoryContent(bot, { 0: ['dirt', 5], 9: ['oak_log', 2] }, { firstStackId: 100 }))
    await until(() => bot.inventory.slots[36]?.name === 'dirt' && bot.inventory.slots[9]?.name === 'oak_log', { what: 'the inventory' })
    game.fake.calls.length = 0
    // a click whose answer reaches the tap before the stack reply (held until the reply names its client id)
    game.responseFirst = true
    await bot.clickWindow(9, 0, 0)
    game.responseFirst = false
    await bot.clickWindow(9, 0, 0)
    assert.strictEqual(bot.inventory.slots[9]?.name, 'oak_log')
    assert.ok(ops('action').some(a => a.name === 'inventory'), 'the inventory screen was opened through the action op')
    const [planks] = bot.recipesFor(bot.registry.itemsByName.oak_planks.id, null, 1, null)
    await bot.craft(planks, 1, null)
    await until(() => bot.inventory.items().some(i => i.name === 'oak_planks'), { what: 'the planks' })
    assert.ok(ops('stack').length >= 3, `stack calls: ${ops('stack').length}`)
    const [request, clientRequest] = game.submitted.at(-1)
    assert.ok(clientRequest.request_id < -0x40000000 && request.request_id > -0x40000000, 'bedboo and the client keep their own id ranges')
    assert.strictEqual(bot._bedrock.stackRequests.pending.size, 0)
    assert.strictEqual(bot._bedrock.beddInventory.map.size, 0)
    assert.ok(bot._bedrock.beddInventory.stats.held >= 1, 'the early response was held')
  })

  it('place: placeBlock → look at the clicked point, then button use click; resolves on update_block', async () => {
    await until(() => bot.inventory.slots[36]?.name === 'dirt', { what: 'dirt in the hotbar' })
    bot.setQuickBarSlot(0)
    const ref = bot.entity.position.floored().offset(-1, -1, 0)
    await until(() => bot.blockAt(ref) && bot.blockAt(ref).name !== 'air', { what: 'ground' })
    game.fake.calls.length = 0
    const placed = bot.placeBlock(bot.blockAt(ref), UP)
    await until(() => ops('button').some(a => a.button === 'use' && a.action === 'click'), { what: 'use click' })
    assert.ok(game.fake.calls.findIndex(c => c.op === 'look') < game.fake.calls.findIndex(c => c.op === 'button'))
    const rid = bot.registry.runtimeIdByStateId[bot.registry.blocksByName.dirt.defaultState]
    const at = ref.plus(UP)
    game.fake.sendPacket('update_block', { position: { x: at.x, y: at.y, z: at.z }, block_runtime_id: rid, flags: { _value: 3 }, layer: 0 })
    await placed
    assert.strictEqual(bot.blockAt(at).name, 'dirt')
  })

  it('attack: bot.attack(entity) → look at its centre, then button attack click', async () => {
    const p = bot.entity.position
    game.fake.sendPacket('add_entity', {
      unique_id: -1050n,
      runtime_id: 1050n,
      entity_type: 'minecraft:zombie',
      position: { x: p.x + 2, y: p.y, z: p.z },
      velocity: { x: 0, y: 0, z: 0 },
      pitch: 0,
      yaw: 0,
      head_yaw: 0,
      body_yaw: 0,
      attributes: [],
      metadata: [],
      properties: { ints: [], floats: [] },
      links: []
    })
    await until(() => bot.entities[1050], { what: 'the zombie' })
    game.fake.calls.length = 0
    bot.attack(bot.entities[1050])
    await until(() => ops('button').some(a => a.button === 'attack' && a.action === 'click'), { what: 'attack click' })
    assert.ok(game.fake.calls.findIndex(c => c.op === 'look') < game.fake.calls.findIndex(c => c.op === 'button'))
  })

  it('unsupported: a v2 API rejects with ERR_BEDD_UNSUPPORTED before sending anything; so does a raw unsupported packet', async () => {
    game.fake.calls.length = 0
    assert.strictEqual(bot.bedrock.bedd.supports('writeBook'), false)
    await assert.rejects(bot.writeBook(0, ['page']), (err) => err.code === 'ERR_BEDD_UNSUPPORTED' && err.bedd === true)
    const events = []
    bot.once('bedd_unsupported_packet', (e) => events.push(e))
    assert.throws(() => bot._client.queue('book_edit', { type: 'replace_page', slot: 0 }), { code: 'ERR_BEDD_UNSUPPORTED' })
    assert.deepStrictEqual(events.map(e => e.name), ['book_edit'])
    assert.deepStrictEqual(game.fake.calls.filter(c => !['world'].includes(c.op)), [])
  })
})

describe('bedd integration: no stack op', function () {
  this.timeout(60000)

  it('clickWindow and craft reject with ERR_BEDD_UNSUPPORTED and nothing reaches the control pipe', async () => {
    const game = await fakeGame({ caps: { stack: 'absent' }, handlers: { stack: () => NO_REPLY } })
    const bot = mineflayerBedrock.createBot({ transport: 'bedd', bedd: game.fake.botOptions(), logErrors: false, hideErrors: true })
    game.bot = bot
    try {
      await once(bot, 'spawn')
      await bot._client.bedd.ready
      game.fake.sendPacket('inventory_content', inventoryContent(bot, { 0: ['dirt', 5], 9: ['oak_log', 2] }, { firstStackId: 100 }))
      await until(() => bot.inventory.slots[9]?.name === 'oak_log', { what: 'the inventory' })
      assert.strictEqual(bot.bedrock.bedd.supports('clickWindow'), false)
      await assert.rejects(bot.clickWindow(9, 0, 0), { code: 'ERR_BEDD_UNSUPPORTED' })
      const [planks] = bot.recipesFor(bot.registry.itemsByName.oak_planks.id, null, 1, null)
      await assert.rejects(bot.craft(planks, 1, null), { code: 'ERR_BEDD_UNSUPPORTED' })
      assert.throws(() => bot._bedrock.stackRequests.create([]), { code: 'ERR_BEDD_UNSUPPORTED' })
      assert.strictEqual(game.fake.callsOf('stack').filter(c => c.args.buf).length, 0)
      assert.strictEqual(bot.inventory.slots[9]?.count, 2)
    } finally {
      bot.end()
      await game.fake.close()
    }
  })
})
