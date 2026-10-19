'use strict'
// owner: U16 (wave 5, U16a parity hardening) — regression tests for the wave-4 review findings (no server), on a fake
// client with the recorded BDS join (flat world). The live counterparts are in test/external/hardening.test.js.
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const nbt = require('prismarine-nbt')
const { serveInventory, wireItem, inventoryContent, tick: macrotask } = require('./helpers/inventory_server')

async function spawned (options) {
  const created = await createFakeBot(options)
  await replayJoin(created.bot, created.client)
  created.client.clearSent()
  created.tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      created.clock.advance(50)
      created.bot._bedrock.input.pump()
    }
  }
  created.inputs = () => created.client.sent('player_auth_input')
  created.actions = () => created.inputs().map((p) => (p.block_action ?? []).map((a) => a.action))
  created.tick(3) // settle on the grass
  return created
}

/** the server's update_block for `pos` (layer 0) */
function serverSets (bot, client, pos, name, layer = 0) {
  const registry = bot.registry
  const runtimeId = registry.runtimeIdByStateId[registry.blocksByName[name].defaultState]
  client.receive('update_block', {
    position: { x: pos.x, y: pos.y, z: pos.z },
    block_runtime_id: runtimeId,
    flags: { _value: 3, neighbors: true, network: true, no_graphic: false, unused: false, priority: false },
    layer
  })
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** a joined fake bot with the inventory server (stack requests answered) and recorded activations */
async function joined ({ survival = true } = {}) {
  const created = await createFakeBot()
  await replayJoin(created.bot, created.client)
  created.server = serveInventory(created.bot, created.client)
  const { bot } = created
  created.activations = []
  bot.activateBlock = async (block) => { created.activations.push(block) }
  bot.activateEntity = async (entity) => { created.activations.push(entity) }
  if (survival) bot.game.gameMode = 'survival'
  bot.experience.level = 30
  return created
}

/** wait until `fn()` is truthy (each check after a macrotask) */
async function until (fn, what = 'condition', ms = 3000) {
  const end = Date.now() + ms
  for (let i = 0; i < 200 || Date.now() < end; i++) {
    if (fn()) return
    if (i < 200) await macrotask()
    else await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const blockNamed = (bot, name, pos = new Vec3(1, -60, 0)) => {
  const Block = require('prismarine-block')(bot.registry)
  const block = Block.fromStateId(bot.registry.blocksByName[name].defaultState, 0)
  block.position = pos
  return block
}

describe('wave-4 review fixes (U16a)', function () {
  this.timeout(30000)

  describe('#3 digging air', () => {
    it('air has hardness 0 (raw minecraft-data / Java), digTime(air) === 0 in survival and creative', async () => {
      const { bot } = await spawned()
      assert.strictEqual(bot.registry.blocksByName.air.hardness, 0)
      const air = bot.blockAt(new Vec3(3, -59, 3))
      assert.strictEqual(air.name, 'air')
      bot.game.gameMode = 'survival'
      assert.strictEqual(bot.digTime(air), 0)
      assert.strictEqual(air.digTime(null, false, false, false, [], {}), 0, 'prismarine-block agrees')
      bot.game.gameMode = 'creative'
      assert.strictEqual(bot.digTime(air), 0)
    })

    it('bot.dig(air) resolves at once with diggingCompleted(air), sends no block action (upstream resolves)', async () => {
      const { bot, actions, tick } = await spawned()
      bot.game.gameMode = 'survival'
      const air = bot.blockAt(new Vec3(3, -59, 3))
      const events = []
      bot.on('diggingCompleted', (b) => events.push(b.name + ' ' + b.position))
      await bot.dig(air, true)
      assert.deepStrictEqual(events, ['air (3, -59, 3)'])
      assert.strictEqual(bot.targetDigBlock, null)
      assert.ok(typeof bot.lastDigTime === 'number')
      tick(2)
      assert.ok(actions().every((a) => a.length === 0), 'no start_break for air')
    })

    it('a stale block that is air in the world by now (a door\'s other half) completes like upstream', async () => {
      const { bot, client, actions, tick } = await spawned()
      bot.game.gameMode = 'survival'
      const pos = new Vec3(2, -60, 0)
      serverSets(bot, client, pos, 'dirt')
      const stale = bot.blockAt(pos)
      serverSets(bot, client, pos, 'air')
      let completed = null
      bot.once('diggingCompleted', (b) => { completed = b })
      await bot.dig(stale, true)
      assert.strictEqual(completed?.name, 'air')
      tick(2)
      assert.ok(actions().every((a) => a.length === 0))
    })

    it('a stale air Block whose position holds a block by now is not "completed": the dig goes to the server', async () => {
      const { bot, client, actions, tick } = await spawned()
      bot.game.gameMode = 'survival'
      const pos = new Vec3(2, -60, 0)
      const staleAir = bot.blockAt(pos)
      assert.strictEqual(staleAir.name, 'air')
      serverSets(bot, client, pos, 'stone')
      let completed = false
      bot.once('diggingCompleted', () => { completed = true })
      const done = bot.dig(staleAir, true)
      done.catch(() => {})
      await settle()
      tick(1)
      assert.strictEqual(completed, false)
      assert.ok(actions().some((a) => a.includes('start_break')), 'sent to the server')
      bot.stopDigging()
      await assert.rejects(done, /Digging aborted/)
    })
  })

  describe('double-tapped forward (U15 open item): BDS sprints, the bot predicts it', () => {
    async function walk (pattern) {
      const created = await spawned()
      const { bot, tick, inputs } = created
      bot.game.gameMode = 'survival'
      bot.food = 20
      created.client.clearSent()
      for (const [forward, ticks] of pattern) {
        bot.setControlState('forward', forward)
        tick(ticks)
      }
      return { bot, sent: inputs() }
    }
    const flags = (p) => p.input_data ?? []

    it('forward pressed again within 6 ticks of its previous press: sprinting (start_sprinting, no sprint key) until released', async () => {
      const { sent } = await walk([[true, 3], [false, 1], [true, 10], [false, 2]])
      const sprinting = sent.map((p) => flags(p).includes('sprinting'))
      assert.deepStrictEqual(sprinting.slice(0, 4), [false, false, false, false], 'the first press walks')
      assert.ok(sprinting.slice(4, 14).every(Boolean), 'the second press sprints')
      assert.ok(flags(sent[4]).includes('start_sprinting'))
      assert.ok(!sent.some((p) => flags(p).includes('sprint_down')), 'no sprint key: the double tap')
      assert.ok(flags(sent[14]).includes('stop_sprinting') && !sprinting[15], 'released: walking again')
    })

    it('7 ticks between the presses, a held forward, sneaking or hunger: no sprint', async () => {
      for (const pattern of [[[true, 5], [false, 2], [true, 6]], [[true, 20]]]) {
        const { sent } = await walk(pattern)
        assert.ok(!sent.some((p) => flags(p).includes('sprinting')), JSON.stringify(pattern))
      }
      const { bot, tick, inputs } = await spawned()
      bot.game.gameMode = 'survival'
      bot.food = 6
      for (const [forward, ticks] of [[true, 2], [false, 1], [true, 5]]) {
        bot.setControlState('forward', forward)
        tick(ticks)
      }
      assert.ok(!inputs().some((p) => flags(p).includes('sprinting')), 'food 6: no sprint')
      bot.food = 20
      bot.setControlState('sneak', true)
      for (const [forward, ticks] of [[false, 1], [true, 2], [false, 1], [true, 5]]) {
        bot.setControlState('forward', forward)
        tick(ticks)
      }
      assert.ok(!inputs().some((p) => flags(p).includes('sprinting')), 'sneaking: no sprint')
    })
  })

  describe('#12 books longer than BDS keeps', () => {
    it('writeBook / signBook with more than 50 pages reject at once (nothing moved or sent)', async () => {
      const { bot, client } = await joined()
      client.receive('inventory_content', inventoryContent(bot, { 9: ['writable_book', 1] }))
      client.clearSent()
      const pages = Array.from({ length: 51 }, (_, i) => `page ${i}`)
      await assert.rejects(bot.writeBook(9, pages), /at most 50 pages/)
      await assert.rejects(bot.signBook(9, pages, 'a', 'b'), /at most 50 pages/)
      assert.deepStrictEqual(client.sent('item_stack_request'), [])
      assert.deepStrictEqual(client.sent('book_edit'), [])
      assert.strictEqual(bot.inventory.slots[9]?.name, 'writable_book')
    })

    it('a failed edit still puts the book back and restores the held slot', async () => {
      const { bot, client } = await joined()
      client.receive('inventory_content', inventoryContent(bot, { 9: ['writable_book', 1] }))
      bot.setQuickBarSlot(4)
      bot.activateItem = () => { throw new Error('use refused') }
      await assert.rejects(bot.writeBook(9, ['x']), /use refused/)
      assert.strictEqual(bot.quickBarSlot, 4)
      assert.strictEqual(bot.inventory.slots[9]?.name, 'writable_book', 'the book is back in its slot')
      assert.strictEqual(bot.inventory.slots[36], null)
    })
  })

  describe('#8 enchanting options without enchantments', () => {
    it('the predicted item is the target unchanged (no empty `ench` list), as BDS leaves it', async () => {
      const { bot, client, server, activations } = await joined()
      client.receive('inventory_content', inventoryContent(bot, { 0: ['fishing_rod', 1], 1: ['lapis_lazuli', 5] }, { firstStackId: 60 }))
      client.receive('player_enchant_options', { options: [] })
      const opening = bot.openEnchantmentTable(blockNamed(bot, 'enchanting_table'))
      await until(() => activations.length === 1, 'activation')
      client.receive('container_open', { window_id: 3, window_type: 'enchantment', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
      client.receive('inventory_content', { window_id: 3, input: [wireItem(bot, null), wireItem(bot, null)], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
      const table = await opening
      await table.putLapis(table.findInventoryItem(bot.registry.itemsByName.lapis_lazuli.id))
      await table.putTargetItem(table.findInventoryItem(bot.registry.itemsByName.fishing_rod.id))
      // live BDS 1.26.51.1, fishing rod at a table without bookshelves: options 0 and 1 carry no enchantment
      client.receive('player_enchant_options', {
        options: [
          { cost: 1, slot_flags: 4096, equip_enchants: [], held_enchants: [], self_enchants: [], name: 'a', option_id: -10 },
          { cost: 4, slot_flags: 4096, equip_enchants: [], held_enchants: [], self_enchants: [], name: 'b', option_id: 10 },
          { cost: 7, slot_flags: 4096, equip_enchants: [], held_enchants: [{ id: 23, level: 1 }], self_enchants: [], name: 'c', option_id: -11 }
        ]
      })
      assert.deepStrictEqual(table.enchantments[0], { level: 1, expected: { enchant: -1, level: -1 } })
      server.requests.length = 0
      const item = await table.enchant(0)
      assert.strictEqual(item.name, 'fishing_rod')
      assert.strictEqual(item.nbt, null, 'no NBT added')
      assert.deepStrictEqual(item.enchants, [])
      const [request] = server.requests
      const result = request.actions[1].result_items[0]
      assert.strictEqual(result.name, 'minecraft:fishing_rod')
      assert.strictEqual(result.extra.has_nbt, 'false', 'results_deprecated carries the item without NBT')
      // an option with enchantments still writes them
      await table.enchant(2)
      assert.deepStrictEqual(nbt.simplify(server.requests[1].actions[1].result_items[0].extra.nbt.nbt).ench, [{ id: 23, lvl: 1 }])
    })
  })

  describe('#6 / #7 crafting', () => {
    it('a 2×2 craft is planned after the inventory screen opened: a pickup meanwhile does not break it', async () => {
      const { bot, client, server } = await joined()
      const id = (name) => bot.registry.itemsByName[name].id
      const hotbar = { 0: ['oak_log', 1] }
      for (let i = 1; i < 9; i++) hotbar[i] = ['dirt', 64]
      client.receive('inventory_content', inventoryContent(bot, hotbar, { firstStackId: 20 }))
      const [planks] = bot.recipesFor(id('oak_planks'), null, 1, null)
      // hold the screen's container_open; a pickup lands in slot 9 (the first empty one, where the result was planned)
      server.hold = true
      const crafting = bot.craft(planks, 1, null)
      await until(() => client.sent('interact').some((p) => p.action_id === 'open_inventory'), 'open_inventory')
      client.receive('inventory_slot', { window_id: 'inventory', slot: 9, item: wireItem(bot, 'oak_sapling', 1, 77), container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
      server.hold = false
      server.flush()
      await crafting
      assert.strictEqual(server.requests.length, 1)
      const place = server.requests[0].actions.at(-1)
      assert.strictEqual(place.source.slot_type.container_id, 'creative_output')
      assert.notStrictEqual(place.destination.slot, 9, 'the result goes elsewhere than the picked-up sapling')
      assert.strictEqual(bot.inventory.slots[9].name, 'oak_sapling')
      assert.strictEqual(bot.inventory.count(id('oak_planks')), 4)
    })

    it('shapeless tag cells expand on their own: brown + red mushroom + bowl make mushroom stew', async () => {
      const { bot, client } = await joined()
      const id = (name) => bot.registry.itemsByName[name].id
      client.receive('inventory_content', inventoryContent(bot, { 0: ['brown_mushroom', 1], 1: ['red_mushroom', 1], 2: ['bowl', 1] }))
      const stews = bot.recipesFor(id('mushroom_stew'), null, 1, null)
      assert.strictEqual(stews.length, 1)
      const names = stews[0].delta.filter((d) => d.count < 0).map((d) => bot.registry.items[d.id].name).sort()
      assert.deepStrictEqual(names, ['bowl', 'brown_mushroom', 'red_mushroom'])
      assert.strictEqual(bot.recipesAll(id('mushroom_stew'), null, null).length, 6, 'every pair of brown / red / shelf mushrooms')
      // suspicious stew: a flower + two mushrooms of any kind
      client.receive('inventory_content', inventoryContent(bot, { 0: ['brown_mushroom', 1], 1: ['red_mushroom', 1], 2: ['bowl', 1], 3: ['poppy', 1] }))
      assert.ok(bot.recipesFor(id('suspicious_stew'), null, 1, null).length >= 1)
      // shaped recipes keep one member for every cell of a tag (upstream): no mixed-wood crafting table
      const tables = bot.recipesAll(id('crafting_table'), null, null)
      for (const r of tables) assert.strictEqual(new Set(r.inShape.flat().map((it) => it.id)).size, 1)
    })
  })

  describe('#10 burning furnaces are other blocks on Bedrock', () => {
    it('openFurnace accepts lit_furnace / lit_blast_furnace / lit_smoker (window type and cook time of the unlit block)', async () => {
      for (const [name, type, ticks] of [['lit_furnace', 'furnace', 200], ['lit_blast_furnace', 'blast_furnace', 100], ['lit_smoker', 'smoker', 100]]) {
        const { bot, client, activations } = await joined()
        const opening = bot.openFurnace(blockNamed(bot, name))
        await until(() => activations.length === 1, 'activation')
        assert.strictEqual(activations[0].name, name)
        client.receive('container_open', { window_id: 3, window_type: type, coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
        client.receive('inventory_content', { window_id: 3, input: [wireItem(bot, null), wireItem(bot, null), wireItem(bot, null)], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
        const furnace = await opening
        assert.strictEqual(furnace.type, `minecraft:${type}`)
        assert.strictEqual(furnace.totalProgress, ticks)
      }
    })

    it('bot.bedrock.blockVariants: findBlock({ matching }) finds a furnace while it burns', async () => {
      const { bot, client } = await spawned()
      const id = (name) => bot.registry.blocksByName[name].id
      assert.deepStrictEqual(bot.bedrock.blockVariants('furnace'), [id('furnace'), id('lit_furnace')])
      assert.deepStrictEqual(bot.bedrock.blockVariants(id('lit_smoker')), [id('smoker'), id('lit_smoker')])
      assert.deepStrictEqual(bot.bedrock.blockVariants('powered_repeater'), [id('unpowered_repeater'), id('powered_repeater')])
      assert.deepStrictEqual(bot.bedrock.blockVariants('stone'), [id('stone')])
      assert.deepStrictEqual(bot.bedrock.blockVariants('no_such_block'), [])
      serverSets(bot, client, new Vec3(2, -60, 2), 'lit_furnace')
      assert.strictEqual(bot.findBlock({ matching: id('furnace'), maxDistance: 8 }), null, 'Java-style lookup misses it (documented)')
      const found = bot.findBlock({ matching: bot.bedrock.blockVariants('furnace'), maxDistance: 8 })
      assert.strictEqual(found?.name, 'lit_furnace')
    })
  })

  describe('#11 liquid-layer re-requests are bounded', () => {
    async function liquidSetup () {
      const created = await spawned()
      const { bot, client } = created
      const reg = bot.registry
      const Chunk = require('prismarine-chunk')(reg)
      const Block = require('prismarine-block')(reg)
      const rid = (name, props) => {
        const state = props ? Block.fromProperties(name, props, 0).stateId : reg.blocksByName[name].defaultState
        return reg.runtimeIdByStateId[state]
      }
      created.layer0 = (x, z, name, props) => client.receive('update_block', { position: { x, y: -60, z }, block_runtime_id: rid(name, props), flags: { _value: 3 }, layer: 0 })
      /** the server's answer to a re-request: the sub-chunk with the given blocks ([x, z, name0, props0, name1]) */
      created.answer = (blocks) => {
        const column = new Chunk({ x: 0, z: 0, minY: -64, worldHeight: 384 })
        for (const [x, z, name0, props0, name1] of blocks) {
          column.setBlockStateId(new Vec3(x, -60, z), props0 ? Block.fromProperties(name0, props0, 0).stateId : reg.blocksByName[name0].defaultState)
          if (name1) {
            const pos = new Vec3(x, -60, z)
            pos.l = 1
            column.setBlockStateId(pos, reg.blocksByName[name1].defaultState)
          }
        }
        const section = column.getSectionAtIndex(-4)
        section.y = -4 & 0xff
        return column.networkEncodeSubChunkNoCache(-4).then(payload => client.receive('subchunk', { cache_enabled: false, dimension: 0, origin: { x: 0, y: 0, z: 0 }, entries: [{ dx: 0, dy: -4, dz: 0, result: 'success', payload, heightmap_type: 'no_data', render_heightmap_type: 'no_data' }] }))
      }
      created.refreshes = () => client.sent('subchunk_request').filter(r => r.requests.length === 1)
      created.view = (x, z) => {
        const b = bot.blockAt(new Vec3(x, -60, z))
        return `${b.name}${b.superimposed ? '+' + b.superimposed.name : ''}`
      }
      return created
    }

    it('a block toggling its state every round trip (a trapdoor on a redstone clock) asks once, and the answer applies', async () => {
      const { client, layer0, answer, refreshes, view } = await liquidSetup()
      layer0(4, 4, 'water')
      client.clearSent()
      layer0(4, 4, 'trapdoor')
      assert.strictEqual(refreshes().length, 1)
      for (let i = 0; i < 50; i++) {
        const open = i % 2 === 0 ? 1 : 0
        layer0(4, 4, 'trapdoor', { open_bit: open })
        await answer([[4, 4, 'trapdoor', { open_bit: 1 - open }, 'water']])
      }
      assert.strictEqual(refreshes().length, 1, 'state changes of the same block do not ask again')
      assert.strictEqual(view(4, 4), 'trapdoor+water')
    })

    it('a block changing type every round trip is asked for at most 8 times in 10 s, then the prediction stands', async () => {
      const { client, layer0, answer, refreshes } = await liquidSetup()
      layer0(6, 6, 'water')
      client.clearSent()
      layer0(6, 6, 'torch')
      for (let i = 0; i < 40; i++) {
        layer0(6, 6, i % 2 === 0 ? 'oak_fence' : 'torch')
        await answer([[6, 6, i % 2 === 0 ? 'torch' : 'oak_fence', null, 'water']])
      }
      assert.strictEqual(refreshes().length, 8, 'asked 8 times in 10 s, then the prediction stands')
    })
  })

  describe('#4 / #5 placing', () => {
    const G = -60
    const UP = new Vec3(0, 1, 0)
    async function placing () {
      const created = await spawned()
      const { bot, client } = created
      const rid = (name) => bot.registry.runtimeIdByStateId[bot.registry.blocksByName[name].defaultState]
      created.setBlock = (pos, name) => client.receive('update_block', { position: { x: pos.x, y: pos.y, z: pos.z }, block_runtime_id: rid(name), flags: { _value: 3 }, layer: 0 })
      created.give = (slots, firstStackId) => client.receive('inventory_content', inventoryContent(bot, slots, { firstStackId }))
      created.clicks = () => client.sent('inventory_transaction').filter((p) => p.transaction.transaction_data.action_type === 'click_block').map((p) => p.transaction.transaction_data)
      /** until(), ticking the input clock (placeBlock looks at the face first) */
      created.ticking = async (fn, what) => {
        for (let i = 0; i < 100; i++) {
          if (fn()) return
          created.tick()
          await macrotask()
        }
        throw new Error(`timed out waiting for ${what}`)
      }
      return created
    }

    it('concurrent placements: the second click waits for the server\'s copy of the held item (new stack id)', async () => {
      const { bot, give, setBlock, clicks, tick } = await placing()
      give({ 0: ['dirt', 5] }, 28)
      const a = bot._placeBlockWithOptions(bot.blockAt(new Vec3(1, G - 1, 0)), UP, { forceLook: 'ignore' })
      const b = bot._placeBlockWithOptions(bot.blockAt(new Vec3(-1, G - 1, 0)), UP, { forceLook: 'ignore' })
      await until(() => clicks().length === 1, 'first click')
      await settle()
      tick()
      assert.strictEqual(clicks().length, 1, 'the second click waits for the answer')
      assert.strictEqual(clicks()[0].held_item.stack_id, 28)
      // BDS: inventory_content (the used stack, new stack id) then the update_block burst
      give({ 0: ['dirt', 4] }, 29)
      setBlock(new Vec3(1, G - 1, 0), 'grass_block')
      setBlock(new Vec3(1, G, 0), 'dirt')
      await until(() => clicks().length === 2, 'second click')
      assert.strictEqual(clicks()[1].held_item.stack_id, 29, 'the server\'s new stack id')
      give({ 0: ['dirt', 3] }, 30)
      setBlock(new Vec3(-1, G - 1, 0), 'grass_block')
      setBlock(new Vec3(-1, G, 0), 'dirt')
      await Promise.all([a, b])
    })

    it('a click the server does not answer holds the next one back at most ANSWER_TIMEOUT_MS', async () => {
      const { bot, give, clicks } = await placing()
      give({ 0: ['dirt', 5] }, 28)
      const placer = bot._bedrock.placement
      const first = placer.acquire()
      const release1 = await first
      placer.click({ position: new Vec3(1, G - 1, 0), face: 1 })
      release1()
      const started = Date.now()
      const release2 = await placer.acquire()
      const waited = Date.now() - started
      release2()
      assert.ok(waited >= 400 && waited < 1500, `waited ${waited} ms`)
      assert.strictEqual(clicks().length, 1)
    })

    it('a bucket use while a placement holds the turn goes out after it, with the slot of the call', async () => {
      const { bot, client, give, setBlock, clicks } = await placing()
      setBlock(new Vec3(0, G, -2), 'water')
      give({ 0: ['bucket', 1], 1: ['dirt', 5] }, 28)
      await bot.lookAt(new Vec3(0.5, G + 0.5, -1.5), true)
      const placer = bot._bedrock.placement
      const release = await placer.acquire() // a placement waiting for its clearance / sneak acknowledgement
      assert.strictEqual(placer.useOnLookedAtBlock(bot.heldItem), true)
      assert.strictEqual(clicks().length, 0, 'deferred behind the held turn')
      bot.setQuickBarSlot(1) // the caller switches slots right away
      release()
      await until(() => clicks().length === 1, 'the deferred bucket click')
      const d = clicks()[0]
      assert.strictEqual(d.hotbar_slot, 0)
      assert.strictEqual(bot.registry.items[d.held_item.network_id].name, 'bucket')
      assert.deepStrictEqual(d.block_position, { x: 0, y: G, z: -2 })
      assert.ok(client.sent('inventory_transaction').length >= 1)
    })

    it('a refusal of a click with a stale block state (farmland that just turned into dirt) is retried with the fresh block', async () => {
      const { bot, give, setBlock, clicks, ticking } = await placing()
      const ref = new Vec3(2, G, 0)
      setBlock(ref, 'farmland')
      give({ 0: ['dirt', 5] }, 28)
      const placed = []
      bot.on('blockPlaced', (o, n) => placed.push(n.name + ' ' + n.position))
      const done = bot.placeBlock(bot.blockAt(ref), new Vec3(1, 0, 0))
      await ticking(() => clicks().length === 1, 'first click')
      const farmland = bot.registry.runtimeIdByStateId[bot.registry.blocksByName.farmland.defaultState]
      assert.strictEqual(clicks()[0].block_runtime_id, farmland)
      // BDS: the server's block is dirt by now → refused: the answer carries dirt for the clicked block, air across
      give({ 0: ['dirt', 5] }, 29)
      setBlock(ref, 'dirt')
      setBlock(new Vec3(3, G, 0), 'air')
      await ticking(() => clicks().length === 2, 'retried click')
      const dirt = bot.registry.runtimeIdByStateId[bot.registry.blocksByName.dirt.defaultState]
      assert.strictEqual(clicks()[1].block_runtime_id, dirt, 'the retry carries the fresh state')
      assert.strictEqual(clicks()[1].held_item.stack_id, 29)
      give({ 0: ['dirt', 4] }, 30)
      setBlock(ref, 'dirt')
      setBlock(new Vec3(3, G, 0), 'dirt')
      await done
      assert.deepStrictEqual(placed, [`dirt (3, ${G}, 0)`])
    })

    it('a refusal that is not about a stale state still rejects like upstream (no retry)', async () => {
      const { bot, give, setBlock, clicks, ticking } = await placing()
      give({ 0: ['dirt', 5] }, 28)
      const ref = new Vec3(2, G - 1, 0)
      const done = bot.placeBlock(bot.blockAt(ref), UP)
      await ticking(() => clicks().length === 1, 'click')
      setBlock(ref, bot.blockAt(ref).name) // the clicked block as the click described it
      setBlock(new Vec3(2, G, 0), 'air')
      await assert.rejects(done, /^Error: Server refused to place dirt at \(2, -60, 0\): the block is still air$/)
      assert.strictEqual(clicks().length, 1)
    })
  })

  describe('#9 a container whose entity or block is gone', () => {
    const nbtItem = (name, count, damage = 0) => nbt.comp({ Count: nbt.byte(count), Damage: nbt.short(damage), Name: nbt.string(`minecraft:${name}`), WasPickedUp: nbt.byte(0) })
    const recipe = ({ buyA, buyCountA, sell, netId }) => ({
      buyA, buyCountA: nbt.int(buyCountA), buyCountB: nbt.int(0), demand: nbt.int(0), maxUses: nbt.int(12), netId: nbt.int(netId), priceMultiplierA: nbt.float(0.05), priceMultiplierB: nbt.float(0), rewardExp: nbt.byte(1), sell, tier: nbt.int(0), traderExp: nbt.int(2), uses: nbt.int(0)
    })
    const updateTrade = (windowId, uniqueId) => ({
      window_id: windowId,
      window_type: 'trading',
      size: 0,
      trade_tier: 0,
      villager_unique_id: uniqueId,
      entity_unique_id: 1n,
      display_name: 'entity.wandering_trader.name',
      new_trading_ui: true,
      economic_trades: true,
      offers: nbt.comp({ Recipes: nbt.list(nbt.comp([recipe({ buyA: nbtItem('emerald', 5), buyCountA: 5, sell: nbtItem('blue_ice', 1), netId: 4953 })])), TierExpRequirements: nbt.list(nbt.comp([{ 0: nbt.int(0) }])) })
    })
    async function openTrader (created, windowId, uniqueId) {
      const { bot, client, activations } = created
      const entity = { id: Number(-uniqueId), uniqueId, name: 'wandering_trader', entityType: bot.registry.entitiesByName.wandering_trader.id, position: new Vec3(2, -60, 0) }
      const before = activations.length
      const opening = bot.openVillager(entity)
      await until(() => activations.length === before + 1, 'activation')
      client.receive('update_trade', updateTrade(windowId, uniqueId))
      client.receive('inventory_content', { window_id: windowId, input: [wireItem(bot, null), wireItem(bot, null), wireItem(bot, null)], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
      return { entity, villager: await opening }
    }

    it('the trader dies: windowClose, currentWindow null, container_close without a doomed return request; the next trade window returns the items', async () => {
      const created = await joined()
      const { bot, client, server } = created
      const emerald = bot.registry.itemsByName.emerald.id
      client.receive('inventory_content', inventoryContent(bot, { 0: ['emerald', 20] }, { firstStackId: 20 }))
      const { entity, villager } = await openTrader(created, 2, -77n)
      await bot.moveSlotItem(villager.findInventoryItem(emerald).slot, 0)
      assert.strictEqual(villager.slots[0]?.count, 20)
      assert.strictEqual(bot.inventory.count(emerald), 0)
      client.clearSent()
      server.requests.length = 0
      const closes = []
      bot.on('windowClose', (w) => closes.push(w))
      bot.emit('entityGone', entity) // BDS: remove_entity only
      assert.deepStrictEqual(closes, [villager])
      assert.strictEqual(bot.currentWindow, null)
      await macrotask()
      assert.deepStrictEqual(client.sent('container_close').map((p) => p.window_id), [2])
      assert.strictEqual(server.requests.length, 0, 'BDS refuses requests on the dead screen (status 49)')
      // the emeralds stay in the ui trade slot (server side too); the next trade window shows them and returns them
      const next = await openTrader(created, 3, -78n)
      assert.strictEqual(next.villager.slots[0], null, 'returned on open')
      assert.strictEqual(bot.inventory.count(emerald), 20)
      assert.strictEqual(server.requests.length, 1)
      assert.strictEqual(server.requests[0].actions[0].source.slot_type.container_id, 'trade2_ingredient1')
    })

    it('a station block that is gone (a furnace broken) closes its window; the furnace lighting up does not', async () => {
      const created = await joined()
      const { bot, client, activations } = created
      const rid = (name) => bot.registry.runtimeIdByStateId[bot.registry.blocksByName[name].defaultState]
      const setBlock = (name) => client.receive('update_block', { position: { x: 1, y: -60, z: 0 }, block_runtime_id: rid(name), flags: { _value: 3 }, layer: 0 })
      setBlock('furnace')
      const opening = bot.openFurnace(bot.blockAt(new Vec3(1, -60, 0)))
      await until(() => activations.length === 1, 'activation')
      client.receive('container_open', { window_id: 3, window_type: 'furnace', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
      client.receive('inventory_content', { window_id: 3, input: [wireItem(bot, null), wireItem(bot, null), wireItem(bot, null)], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
      const furnace = await opening
      setBlock('lit_furnace')
      assert.strictEqual(bot.currentWindow, furnace, 'a lit furnace is the same furnace')
      const closed = []
      bot.on('windowClose', (w) => closed.push(w))
      setBlock('air')
      assert.deepStrictEqual(closed, [furnace])
      assert.strictEqual(bot.currentWindow, null)
    })
  })
})
