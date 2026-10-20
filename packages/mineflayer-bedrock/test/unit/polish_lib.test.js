'use strict'
// owner: POLISH-LIB (last library gaps found by the agent runs) — regression tests (no server) on a fake client with
// the recorded BDS join (flat world). The live counterparts are in test/external/polishLib.test.js.
// - falling blocks: update_block_synced (BDS 1.26.51.1 sends it — not update_block — when a block starts falling and
//   when it lands) updates the world like update_block, with blockUpdate events (pathfinder re-plans);
// - mineflayer-auto-eat patch: a failed equip clears the eating flag; strictErrors emits 'eatFail' too;
// - mineflayer-tool patch: equipForBlock(getFromChest) without a harvest tool and without chests fails with NoItem
//   (it recursed for ever: the process froze and ran out of memory);
// - inventory resync: a slot found out of date (un-raced stack id mismatch, a server transaction whose old item is
//   not ours) makes the model ask for the server's copy (inventory_mismatch); bot.bedrock.resyncInventory().
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { serveInventory, wireItem, inventoryContent, tick: macrotask } = require('./helpers/inventory_server')
const { toNetwork } = require('../../lib/bedrock/item')

const G = -60

async function spawned () {
  const created = await createFakeBot()
  await replayJoin(created.bot, created.client)
  created.client.clearSent()
  created.tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      created.clock.advance(50)
      created.bot._bedrock.input.pump()
    }
  }
  created.tick(3)
  const { bot, client } = created
  created.rid = (name) => bot.registry.runtimeIdByStateId[bot.registry.blocksByName[name].defaultState]
  created.setBlock = (pos, name) => client.receive('update_block', { position: { x: pos.x, y: pos.y, z: pos.z }, block_runtime_id: created.rid(name), flags: { _value: 3 }, layer: 0 })
  // the packet as BDS 1.26.51.1 sends it (live capture: gravel at 2,-58,0 starting to fall, landing at 2,-60,0);
  // entity_unique_id is the falling block's unique id as BDS writes it (unsigned varint64, read as zigzag)
  created.synced = (pos, name, transition, layer = 0) => client.receive('update_block_synced', {
    position: { x: pos.x, y: pos.y, z: pos.z },
    block_runtime_id: created.rid(name),
    flags: { _value: 3, neighbors: true, network: true, no_graphic: false, unused: false, priority: false },
    layer,
    entity_unique_id: transition === 'create' ? 9223372034707292164n : -9223372034707292165n,
    transition_type: transition
  })
  return created
}

describe('falling blocks: update_block_synced (POLISH-LIB)', function () {
  this.timeout(30000)

  it('start of the fall (create → air) and the landing (destroy → the block) update the world with blockUpdate events', async () => {
    const { bot, setBlock, synced } = await spawned()
    const top = new Vec3(2, G + 2, 0)
    const floor = new Vec3(2, G, 0)
    setBlock(top, 'gravel')
    assert.strictEqual(bot.blockAt(top).name, 'gravel')
    const seen = []
    bot.on('blockUpdate', (o, n) => seen.push(`${n.position}: ${o.name} → ${n.name}`))
    const atTop = []
    const atFloor = []
    bot.on(`blockUpdate:${top}`, (o, n) => atTop.push(n.name))
    bot.on(`blockUpdate:${floor}`, (o, n) => atFloor.push(n.name))
    synced(top, 'air', 'create') // BDS: the block becomes a falling_block entity
    assert.strictEqual(bot.blockAt(top).name, 'air', 'the start position is air as soon as the fall starts')
    synced(floor, 'gravel', 'destroy') // it lands: the entity becomes the block again
    assert.strictEqual(bot.blockAt(floor).name, 'gravel', 'the landing position is gravel at once')
    assert.deepStrictEqual(seen, [`${top}: gravel → air`, `${floor}: air → gravel`])
    assert.deepStrictEqual([atTop, atFloor], [['air'], ['gravel']])
  })

  it('layer 1 and a column still loading take it like update_block', async () => {
    const { bot, client, rid } = await spawned()
    const fence = new Vec3(4, G, 4)
    client.receive('update_block', { position: { x: 4, y: G, z: 4 }, block_runtime_id: rid('oak_fence'), flags: { _value: 3 }, layer: 0 })
    client.receive('update_block_synced', { position: { x: 4, y: G, z: 4 }, block_runtime_id: rid('water'), flags: { _value: 3 }, layer: 1, entity_unique_id: 0n, transition_type: 'entity' })
    assert.strictEqual(bot.blockAt(fence).superimposed?.name, 'water')
    // a column waiting for its sub-chunks keeps the change (no event), like update_block
    const far = new Vec3(100000, G, 100000)
    assert.strictEqual(bot.blockAt(far), null)
    assert.doesNotThrow(() => client.receive('update_block_synced', { position: { x: far.x, y: far.y, z: far.z }, block_runtime_id: rid('sand'), flags: { _value: 3 }, layer: 0, entity_unique_id: 0n, transition_type: 'destroy' }))
  })

  it('a dig of a block that falls away completes (its blockUpdate to air), like on Java', async () => {
    const { bot, tick, setBlock, synced } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, G + 1, 1)
    setBlock(target, 'sand')
    const events = []
    bot.on('diggingCompleted', () => events.push('completed'))
    bot.on('diggingAborted', () => events.push('aborted'))
    const done = bot.dig(bot.blockAt(target))
    await macrotask()
    tick(2)
    synced(target, 'air', 'create') // the block under it was removed meanwhile: it falls
    tick(1)
    await done
    assert.deepStrictEqual(events, ['completed'])
  })

  it('mineflayer-pathfinder re-plans when a falling block lands on its path (blockUpdate)', async () => {
    const { bot, tick, synced } = await spawned()
    bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)
    const { goals } = require('mineflayer-pathfinder')
    const resets = []
    bot.on('path_reset', (reason) => resets.push(reason))
    const computed = { path: null }
    bot.on('path_update', (r) => { if (r.status === 'success' || r.status === 'partial') computed.path = r.path })
    bot.pathfinder.setGoal(new goals.GoalBlock(6, G, 0))
    for (let i = 0; i < 40 && !computed.path; i++) {
      tick(1)
      await macrotask()
    }
    const { path } = computed
    assert.ok(path && path.length > 2, 'a path was computed')
    const onPath = path[path.length - 2]
    synced(new Vec3(Math.floor(onPath.x), Math.floor(onPath.y), Math.floor(onPath.z)), 'gravel', 'destroy')
    assert.ok(resets.includes('block_updated'), `path_reset: ${resets.join(', ')}`)
    bot.pathfinder.setGoal(null)
  })
})

describe('mineflayer-auto-eat patch: failures (POLISH-LIB)', function () {
  this.timeout(30000)

  async function eater (opts = {}) {
    const created = await spawned()
    const { bot } = created
    const { loader } = await import('mineflayer-auto-eat')
    bot.loadPlugin(loader)
    bot.autoEat.setOpts(opts)
    const Item = require('prismarine-item')(bot.registry)
    bot.inventory.updateSlot(9, new Item(bot.registry.itemsByName.bread.id, 5, 0)) // not in the hotbar: an equip first
    created.events = []
    for (const name of ['eatStart', 'eatFail', 'eatFinish']) bot.autoEat.on(name, (arg) => created.events.push(name + (arg instanceof Error ? `: ${arg.message}` : '')))
    return created
  }

  it('a failed equip clears the eating flag (upstream left it set: "Already eating!" for ever, no automatic meal again)', async () => {
    const { bot, events } = await eater()
    let equips = 0
    bot.util.inv.customEquip = async () => { equips++; return false }
    await assert.rejects(bot.autoEat.eat(), /^Error: Failed to equip: bread!/)
    assert.strictEqual(bot.autoEat.isEating, false)
    await assert.rejects(bot.autoEat.eat(), /^Error: Failed to equip: bread!/, 'tried again, not "Already eating!"')
    assert.strictEqual(equips, 2)
    // an equip that throws clears it too
    bot.util.inv.customEquip = async () => { throw new Error('window open') }
    await assert.rejects(bot.autoEat.eat(), /^Error: window open$/)
    assert.strictEqual(bot.autoEat.isEating, false)
    assert.deepStrictEqual(events, [], 'no meal started: no eatStart / eatFail / eatFinish (as upstream)')
    // automatic mode: not on the very next tick (that would repeat a failing equip ~20 times a second), 2 s later
    bot.util.inv.customEquip = async () => { equips++; return true }
    bot.food = 5
    bot.autoEat.setOpts({ eatingTimeout: 50 })
    bot.autoEat.statusCheck()
    await macrotask()
    assert.strictEqual(bot.autoEat.isEating, false, 'no retry on the next tick')
    assert.strictEqual(equips, 2)
    await new Promise((resolve) => setTimeout(resolve, 2050))
    bot.autoEat.statusCheck()
    await macrotask()
    assert.strictEqual(bot.autoEat.isEating, true, 'auto-eat started a meal')
    assert.strictEqual(equips, 3)
    await new Promise((resolve) => setTimeout(resolve, 120))
  })

  it("one 'eatFail' per failure: a wrapper that emits it itself with eat()'s error (the agent's guardAutoEat) is not counted twice", async () => {
    const { bot, events } = await eater({ eatingTimeout: 50 })
    bot.util.inv.customEquip = async () => true
    // the workaround code written for upstream's missing event under strictErrors
    const err = await bot.autoEat.eat().catch((e) => e)
    bot.autoEat.emit('eatFail', err)
    assert.deepStrictEqual(events, ['eatStart', 'eatFail: Eating timed out with a time of 50 milliseconds!', 'eatFinish'])
    // other failures still get theirs
    const other = new Error('another failure')
    assert.strictEqual(bot.autoEat.emit('eatFail', other), true)
    assert.strictEqual(events.at(-1), 'eatFail: another failure')
  })

  it("strictErrors (default): a failed meal emits 'eatFail' (then eatFinish) and eat() still rejects", async () => {
    const { bot, events } = await eater({ eatingTimeout: 50 })
    bot.util.inv.customEquip = async () => true
    assert.strictEqual(bot.autoEat.opts.strictErrors, true)
    await assert.rejects(bot.autoEat.eat(), /Eating timed out with a time of 50 milliseconds!/)
    assert.deepStrictEqual(events, ['eatStart', 'eatFail: Eating timed out with a time of 50 milliseconds!', 'eatFinish'])
    assert.strictEqual(bot.autoEat.isEating, false)
    // cancelEat() is a failure too
    events.length = 0
    const meal = bot.autoEat.eat({ food: 'bread' })
    await macrotask()
    bot.autoEat.cancelEat()
    await assert.rejects(meal, /Eating manually canceled!/)
    assert.deepStrictEqual(events, ['eatStart', 'eatFail: Eating manually canceled!', 'eatFinish'])
  })

  it("strictErrors false: 'eatFail' then eatFinish and eat() resolves, as upstream", async () => {
    const { bot, events } = await eater({ eatingTimeout: 50, strictErrors: false })
    bot.util.inv.customEquip = async () => true
    const logged = []
    const error = console.error
    console.error = (err) => logged.push(err?.message ?? String(err))
    try {
      await bot.autoEat.eat()
    } finally {
      console.error = error
    }
    assert.deepStrictEqual(events, ['eatStart', 'eatFail: Eating timed out with a time of 50 milliseconds!', 'eatFinish'])
    assert.deepStrictEqual(logged, ['Eating timed out with a time of 50 milliseconds!'])
  })
})

describe('mineflayer-tool patch: no harvest tool, no chest (POLISH-LIB)', function () {
  this.timeout(30000)

  it('equipForBlock({ requireHarvest, getFromChest }) without a pickaxe and without chests rejects with NoItem', async () => {
    const { bot, setBlock } = await spawned()
    bot.loadPlugin(require('mineflayer-tool').plugin)
    const ore = new Vec3(2, G, 0)
    setBlock(ore, 'coal_ore')
    let calls = 0
    const equipForBlock = bot.tool.equipForBlock.bind(bot.tool)
    // the recursion goes through this property: fail the test instead of freezing the process (unpatched behaviour)
    bot.tool.equipForBlock = (...args) => {
      if (++calls > 10) throw new Error('equipForBlock recursed')
      return equipForBlock(...args)
    }
    // mineflayer-collectblock's options
    await assert.rejects(bot.tool.equipForBlock(bot.blockAt(ore), { requireHarvest: true, getFromChest: true, maxTools: 2 }), (err) => err.name === 'NoItem')
    assert.strictEqual(calls, 1)
  })
})

describe('inventory resync: inventory_mismatch (POLISH-LIB)', function () {
  this.timeout(30000)

  async function joined () {
    const created = await createFakeBot()
    await replayJoin(created.bot, created.client)
    created.server = serveInventory(created.bot, created.client)
    created.mismatches = () => created.client.sent('inventory_transaction').filter((p) => p.transaction.transaction_type === 'inventory_mismatch')
    return created
  }
  const names = (window) => window.slots.map((it, i) => it ? `${i}:${it.name}x${it.count}` : null).filter(Boolean).join(' ')

  it('bot.bedrock.resyncInventory() sends inventory_mismatch and applies the server\'s copy (BDS answers with every window)', async () => {
    const { bot, client, server, mismatches } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['coal', 5], 1: ['dirt', 3] }, { firstStackId: 10 }))
    assert.strictEqual(names(bot.inventory), '36:coalx5 37:dirtx3')
    server.truth = { 0: ['coal', 12, 40], 1: ['dirt', 3, 11] } // e.g. a pickup the model missed
    const synced = await bot.bedrock.resyncInventory()
    assert.strictEqual(synced, true)
    assert.deepStrictEqual(mismatches(), [{ transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'inventory_mismatch', actions: [] } }])
    assert.strictEqual(names(bot.inventory), '36:coalx12 37:dirtx3')
    assert.strictEqual(bot.inventory.slots[36].stackId, 40)
    // the packet serializes
    const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
    assert.ok(createSerializer('1.26.51').createPacketBuffer({ name: 'inventory_transaction', params: mismatches()[0] }).length > 0)
    // no answer: resolves false after 2 s, never rejects
    server.ignoreResync = true
    const t0 = Date.now()
    assert.strictEqual(await bot.bedrock.resyncInventory(), false)
    assert.ok(Date.now() - t0 >= 1900)
  })

  it('an un-raced stack id mismatch (49) on a desynced slot: resync, then the click is planned again on the server\'s copy', async () => {
    const { bot, client, server, mismatches } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 9: ['dirt', 42] }, { firstStackId: 127 }))
    await bot.clickWindow(9, 0, 0)
    await bot.clickWindow(9, 0, 0) // the screen is open now
    // the model's copy of slot 9 goes out of date (no server packet tells it): BDS has 45 dirt with stack id 300
    server.truth = { 9: ['dirt', 45, 300] }
    server.reject(49) // the click names the old stack id
    await bot.clickWindow(9, 0, 0)
    assert.strictEqual(mismatches().length, 1, 'one resync')
    assert.strictEqual(server.requests.length, 4, 'planned again once')
    const retry = server.requests[3].actions[0]
    assert.deepStrictEqual([retry.type_id, retry.count, retry.source.stack_id], ['take', 45, 300])
    assert.strictEqual(bot.inventory.selectedItem?.count, 45)
    assert.strictEqual(bot.inventory.slots[9], null)
  })

  it('a 49 the resync does not explain (the server has what the click was planned on) still throws, without a retry', async () => {
    const { bot, client, server, mismatches } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 9: ['dirt', 42] }, { firstStackId: 300 }))
    await bot.clickWindow(9, 0, 0)
    await bot.clickWindow(9, 0, 0)
    server.reject(49)
    await assert.rejects(bot.clickWindow(9, 0, 0), /^Error: Server rejected transaction for clicking on slot 9, on window with id 0\.$/)
    assert.strictEqual(mismatches().length, 1, 'the server was asked')
    assert.strictEqual(server.requests.length, 3, 'no retry')
    assert.strictEqual(names(bot.inventory), '9:dirtx42')
  })

  it('a server transaction whose old item is not the local slot (pickup on a stale slot) asks for a resync; consistent ones do not', async () => {
    const { bot, client, server, mismatches } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['coal', 5] }, { firstStackId: 10 }))
    const pickup = (slot, oldItem, newItem) => client.receive('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: 'normal',
        actions: [
          { source_type: 'container', window_id: 0, slot, old_item: oldItem, new_item: newItem },
          { source_type: 'world_interaction', flags: 0, slot: 1, old_item: newItem, new_item: wireItem(bot, null) }
        ]
      }
    })
    // consistent: 5 → 6, then a /give style one into an empty slot
    pickup(0, wireItem(bot, 'coal', 5), wireItem(bot, 'coal', 6, 20))
    pickup(1, wireItem(bot, null), wireItem(bot, 'dirt', 1, 21))
    await macrotask()
    assert.strictEqual(mismatches().length, 0)
    assert.strictEqual(names(bot.inventory), '36:coalx6 37:dirtx1')
    // the server had 9 coal (we show 6): its pickup 9 → 10 is applied and the rest of the inventory is asked for
    server.truth = { 0: ['coal', 10, 22], 1: ['dirt', 1, 21], 2: ['stick', 2, 23] }
    pickup(0, wireItem(bot, 'coal', 9), wireItem(bot, 'coal', 10, 22))
    assert.strictEqual(bot.inventory.slots[36].count, 10, 'the server wins at once')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.strictEqual(mismatches().length, 1)
    assert.strictEqual(names(bot.inventory), '36:coalx10 37:dirtx1 38:stickx2')
    // automatic resyncs are rate limited (one per second)
    pickup(0, wireItem(bot, 'coal', 1), wireItem(bot, 'coal', 10, 24))
    await macrotask()
    assert.strictEqual(mismatches().length, 1)
  })

  it('a resend of the state a request was planned on (a resync, a command) while it is in flight does not replace its prediction', async () => {
    const { bot, client, server } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 9: ['dirt', 10], 10: ['stone', 5] }, { firstStackId: 100 }))
    await bot.clickWindow(9, 0, 0) // dirt on the cursor (the screen stays open)
    const model = bot._bedrock.inventoryModel
    const wire = (key) => {
      const it = model.read(key)
      return it ? toNetwork(bot.registry, it, { stackId: it.stackId }) : wireItem(bot, null)
    }
    const before = Array.from({ length: 36 }, (_, i) => wire(`p:${i}`))
    const cursor = wire('c')
    server.hold = true
    const click = bot.clickWindow(10, 0, 0) // swap: dirt into slot 10, the stone on the cursor
    await macrotask()
    assert.strictEqual(bot.inventory.slots[10].name, 'dirt', 'predicted')
    // the server resends the inventory as it was before it handled the click (same items, same stack ids)
    client.receive('inventory_content', { window_id: 'inventory', input: before, container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    client.receive('inventory_content', { window_id: 'ui', input: [cursor, ...Array.from({ length: 53 }, () => wireItem(bot, null))], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    assert.strictEqual(bot.inventory.slots[10].name, 'dirt', 'the prediction stays shown (a click planned now builds on it)')
    assert.strictEqual(bot.inventory.selectedItem?.name, 'stone')
    server.hold = false
    server.flush()
    await click
    assert.strictEqual(names(bot.inventory), '10:dirtx10', 'the accepted swap, not the resent stone with the dirt\'s count')
    assert.strictEqual(bot.inventory.selectedItem?.name, 'stone')
    assert.strictEqual(bot.inventory.selectedItem?.count, 5)
  })

  it('a pickup that lands on a slot while chained requests on it are in flight survives their rejection (it was lost: live trace)', async () => {
    // seen live (BDS 1.26.51.1, ores dug while the coal stack was moved by overlapping clicks): take 28 coal from
    // hotbar 2 (stack 236) → the pickup merges into it (29, stack 237) → a click planned on the carried 28 and the 29
    // shown → BDS rejects both; the rollbacks handed the pre-pickup stack down the chain and wrote it back: the model
    // showed 28 / 236 while the server had 29 / 237 (the pickup lost, every later click on it rejected)
    const { bot, client, server, mismatches } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 2: ['coal', 28] }, { firstStackId: 236 }))
    const model = bot._bedrock.inventoryModel
    await model.screen.open() // cursor moves need the inventory screen
    server.hold = true
    server.reject(49) // the take: the pickup changed its stack first
    server.reject(49) // the place: names the take's request id
    const take = model.execute(bot.inventory, [{ type: 'take', count: 28, src: 'p:2', dst: 'c' }])
    await macrotask()
    client.receive('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'normal', actions: [{ source_type: 'container', window_id: 0, slot: 2, old_item: wireItem(bot, 'coal', 28), new_item: wireItem(bot, 'coal', 29, 237) }] } })
    assert.strictEqual(bot.inventory.slots[38].count, 29, 'the server wins at once')
    const place = model.execute(bot.inventory, [{ type: 'place', count: 28, src: 'c', dst: 'p:2' }])
    await macrotask()
    assert.strictEqual(bot.inventory.slots[38].count, 57, 'predicted')
    server.hold = false
    server.flush()
    await assert.rejects(take, (err) => err.status === 49 && err.raced === true)
    await assert.rejects(place, (err) => err.status === 49 && err.chained === true)
    assert.strictEqual(names(bot.inventory), '38:coalx29')
    assert.strictEqual(bot.inventory.slots[38].stackId, 237, 'the server\'s stack')
    assert.strictEqual(bot.inventory.selectedItem, null)
    await macrotask()
    assert.strictEqual(mismatches().length, 0, 'explained rejections: no resync')
  })

  it('a request rejected because the one it was planned on was rejected is no desync (no resync)', async () => {
    const { bot, client, server, mismatches } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 9: ['dirt', 10] }, { firstStackId: 200 }))
    await bot.clickWindow(9, 0, 0)
    await bot.clickWindow(9, 0, 0)
    server.hold = true
    server.reject(50) // e.g. an invalid slot
    server.reject(49) // the chained one names the first one's request id
    const a = bot.clickWindow(9, 0, 0)
    const b = bot.clickWindow(10, 1, 0) // planned on a's prediction
    await macrotask()
    server.hold = false
    server.flush()
    await assert.rejects(a, /Server rejected transaction/)
    await assert.rejects(b, /Server rejected transaction/)
    await macrotask()
    assert.strictEqual(mismatches().length, 0)
    assert.strictEqual(names(bot.inventory), '9:dirtx10')
  })

  it('a fixed-steps request (not planned again) rejected with an un-raced 49 rejects at once; the resync heals the model meanwhile', async () => {
    const { bot, client, server, mismatches } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['dirt', 10] }, { firstStackId: 300 }))
    server.truth = { 0: ['dirt', 12, 301] }
    server.hold = true // the resync's answer comes later
    server.reject(49)
    const t0 = Date.now()
    const req = bot._bedrock.inventoryModel.execute(bot.inventory, [{ type: 'place', count: 1, src: 'p:0', dst: 'p:1' }])
    await macrotask()
    server.flush() // the rejection
    await assert.rejects(req, (err) => err.name === 'StackRequestError' && err.status === 49)
    assert.ok(Date.now() - t0 < 500, 'not held up by the resync')
    assert.strictEqual(mismatches().length, 1)
    server.hold = false
    server.flush() // the resync's answer
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.strictEqual(names(bot.inventory), '36:dirtx12')
  })

  it('a pickup on a slot a request is changing is not taken as a desync (the raced request is planned again instead)', async () => {
    const { bot, client, server, mismatches } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 9: ['dirt', 42] }, { firstStackId: 127 }))
    await bot.clickWindow(9, 0, 0)
    await bot.clickWindow(9, 0, 0)
    server.hold = true
    server.reject(49)
    const click = bot.clickWindow(9, 0, 0)
    await macrotask()
    client.receive('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'normal', actions: [{ source_type: 'container', window_id: 'inventory', slot: 9, old_item: wireItem(bot, null), new_item: wireItem(bot, 'dirt', 43, 132) }] } })
    server.hold = false
    server.flush()
    await click
    assert.strictEqual(mismatches().length, 0)
    assert.strictEqual(bot.inventory.selectedItem?.count, 43)
  })
})
