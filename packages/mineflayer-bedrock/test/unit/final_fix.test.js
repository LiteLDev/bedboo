'use strict'
// owner: FINAL-FIX-LIB (final-acceptance review fixes) — regression tests (no server) on a fake client with the
// recorded BDS join (flat world). The live counterparts are in test/external/finalFix.test.js.
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { serveInventory, wireItem, inventoryContent, tick: macrotask } = require('./helpers/inventory_server')

const G = -60
const UP = new Vec3(0, 1, 0)

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
  created.tick(3) // settle on the grass
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

describe('final-acceptance review fixes (FINAL-FIX-LIB)', function () {
  this.timeout(30000)

  describe('#1 / #3 placing: a click that changed the clicked block is not stale; a raced held stack is retried', () => {
    async function placing ({ survival = true } = {}) {
      const created = await spawned()
      const { bot, client } = created
      if (survival) bot.game.gameMode = 'survival'
      const rid = (name) => bot.registry.runtimeIdByStateId[bot.registry.blocksByName[name].defaultState]
      created.rid = rid
      created.setBlock = (pos, name) => client.receive('update_block', { position: { x: pos.x, y: pos.y, z: pos.z }, block_runtime_id: rid(name), flags: { _value: 3 }, layer: 0 })
      created.give = (slots, firstStackId) => client.receive('inventory_content', inventoryContent(bot, slots, { firstStackId }))
      created.clicks = () => client.sent('inventory_transaction').filter((p) => p.transaction.transaction_data.action_type === 'click_block').map((p) => p.transaction.transaction_data)
      created.placed = []
      bot.on('blockPlaced', (o, n) => created.placed.push(n.name + ' ' + n.position))
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

    // BDS (measured on 1.26.51.1): the block goes INTO the clicked position, the block across the face stays air →
    // upstream's place_block rejects with `Server refused` after ONE click (no second block above the reference)
    const cases = [
      { ref: 'snow_layer', item: 'dirt', after: 'dirt' },
      { ref: 'short_grass', item: 'dirt', after: 'dirt' },
      { ref: 'oak_slab', item: 'oak_slab', after: 'oak_double_slab' }
    ]
    for (const survival of [true, false]) {
      for (const { ref: refName, item, after } of cases) {
        it(`${survival ? 'survival' : 'creative'}: ${item} against ${refName} (→ ${after}): one click, upstream's refusal`, async () => {
          const { bot, give, setBlock, clicks, ticking, placed } = await placing({ survival })
          const ref = new Vec3(2, G, 0)
          setBlock(ref, refName)
          give({ 0: [item, 5] }, 28)
          const done = bot.placeBlock(bot.blockAt(ref), UP)
          await ticking(() => clicks().length === 1, 'click')
          // BDS: the held stack (used in survival, same count in creative), then the clicked block, then across the face
          give({ 0: [item, survival ? 4 : 5] }, 29)
          setBlock(ref, after)
          setBlock(ref.offset(0, 1, 0), 'air')
          await assert.rejects(done, new RegExp(`^Error: Server refused to place ${item} at \\(2, -59, 0\\): the block is still air$`))
          for (let i = 0; i < 10; i++) await macrotask()
          assert.strictEqual(clicks().length, 1, 'no retry on the merged / replaced block')
          assert.deepStrictEqual(placed, [])
        })
      }
    }

    it('the farmland → dirt race (a stale state, nothing used) is still retried', async () => {
      const { bot, give, setBlock, clicks, ticking, placed, rid } = await placing()
      const ref = new Vec3(2, G, 0)
      setBlock(ref, 'farmland')
      give({ 0: ['dirt', 5] }, 28)
      const done = bot.placeBlock(bot.blockAt(ref), new Vec3(1, 0, 0))
      await ticking(() => clicks().length === 1, 'first click')
      give({ 0: ['dirt', 5] }, 29)
      setBlock(ref, 'dirt')
      setBlock(new Vec3(3, G, 0), 'air')
      await ticking(() => clicks().length === 2, 'retried click')
      assert.strictEqual(clicks()[1].block_runtime_id, rid('dirt'))
      give({ 0: ['dirt', 4] }, 30)
      setBlock(ref, 'dirt')
      setBlock(new Vec3(3, G, 0), 'dirt')
      await done
      assert.deepStrictEqual(placed, [`dirt (3, ${G}, 0)`])
    })

    it('a click that used an item is never stale, whatever the clicked block became', async () => {
      const { bot, give, setBlock, clicks, ticking } = await placing()
      const ref = new Vec3(2, G, 0)
      setBlock(ref, 'farmland')
      give({ 0: ['dirt', 5] }, 28)
      const done = bot.placeBlock(bot.blockAt(ref), UP)
      await ticking(() => clicks().length === 1, 'click')
      give({ 0: ['dirt', 4] }, 29) // used: the block went somewhere
      setBlock(ref, 'dirt')
      setBlock(ref.offset(0, 1, 0), 'air')
      await assert.rejects(done, /^Error: Server refused to place dirt/)
      for (let i = 0; i < 10; i++) await macrotask()
      assert.strictEqual(clicks().length, 1)
      assert.strictEqual(bot._bedrock.placement.stale(ref), false)
    })

    it('a pickup merged into the held stack while the click was on its way: the refusal is retried with the server\'s copy', async () => {
      const { bot, client, give, setBlock, clicks, ticking, placed } = await placing()
      const ref = new Vec3(2, G - 1, 0)
      give({ 0: ['dirt', 9] }, 3)
      const done = bot.placeBlock(bot.blockAt(ref), UP)
      await ticking(() => clicks().length === 1, 'first click')
      assert.strictEqual(clicks()[0].held_item.stack_id, 3)
      // BDS: the pickup (inventory_transaction normal, slot 0 → 10 #5), the inventory, then the refusal burst
      client.receive('inventory_transaction', {
        transaction: {
          legacy: { legacy_request_id: 0 },
          transaction_type: 'normal',
          actions: [{ source_type: 'container', window_id: 'inventory', slot: 0, old_item: wireItem(bot, 'dirt', 9, 3), new_item: wireItem(bot, 'dirt', 10, 5) }]
        }
      })
      give({ 0: ['dirt', 10] }, 5)
      setBlock(ref, 'grass_block')
      setBlock(ref.offset(0, 1, 0), 'air')
      await ticking(() => clicks().length === 2, 'retried click')
      assert.strictEqual(clicks()[1].held_item.stack_id, 5, 'the server\'s copy of the held stack')
      assert.strictEqual(clicks()[1].held_item.count, 10)
      give({ 0: ['dirt', 9] }, 6)
      setBlock(ref, 'grass_block')
      setBlock(ref.offset(0, 1, 0), 'dirt')
      await done
      assert.deepStrictEqual(placed, [`dirt (2, ${G}, 0)`])
    })

    it('a held stack that grew (inventory_content only) before the refusal is retried once; a second refusal rejects', async () => {
      const { bot, give, setBlock, clicks, ticking } = await placing()
      const ref = new Vec3(2, G - 1, 0)
      give({ 0: ['dirt', 9] }, 3)
      const done = bot.placeBlock(bot.blockAt(ref), UP)
      await ticking(() => clicks().length === 1, 'first click')
      give({ 0: ['dirt', 10] }, 5)
      setBlock(ref, 'grass_block')
      setBlock(ref.offset(0, 1, 0), 'air')
      await ticking(() => clicks().length === 2, 'retried click')
      give({ 0: ['dirt', 10] }, 6)
      setBlock(ref, 'grass_block')
      setBlock(ref.offset(0, 1, 0), 'air')
      await assert.rejects(done, /^Error: Server refused to place dirt/)
      for (let i = 0; i < 10; i++) await macrotask()
      assert.strictEqual(clicks().length, 2, 'one retry only')
    })

    it('clickMayChange: replaceable blocks and merges', () => {
      const { clickMayChange } = require('../../lib/bedrock/placement')
      assert.strictEqual(clickMayChange({ name: 'snow_layer' }, 'dirt'), true)
      assert.strictEqual(clickMayChange({ name: 'short_grass' }, 'stone'), true)
      assert.strictEqual(clickMayChange({ name: 'light_block_7' }, 'stone'), true)
      assert.strictEqual(clickMayChange({ name: 'oak_slab' }, 'oak_slab'), true)
      assert.strictEqual(clickMayChange({ name: 'sea_pickle' }, 'sea_pickle'), true)
      assert.strictEqual(clickMayChange({ name: 'cake' }, 'red_candle'), true)
      assert.strictEqual(clickMayChange({ name: 'oak_slab' }, 'birch_slab'), false)
      assert.strictEqual(clickMayChange({ name: 'farmland' }, 'dirt'), false)
      assert.strictEqual(clickMayChange({ name: 'stone' }, 'dirt'), false)
      assert.strictEqual(clickMayChange({ name: 'dirt' }, 'dirt'), false, 'a full block of the held item does not merge')
      assert.strictEqual(clickMayChange({ name: 'oak_double_slab' }, 'oak_double_slab'), false)
      assert.strictEqual(clickMayChange({ name: 'white_candle' }, 'white_candle'), true)
      assert.strictEqual(clickMayChange(null, 'dirt'), false)
    })
  })

  describe('#4 door halves: the upper half takes the open state and facing of the lower half (BDS opens the lower one only)', () => {
    it('blockAt(upper).shapes follow the lower half; stateId / getProperties stay the server\'s; the hinge comes from the upper half', async () => {
      const { bot, client } = await spawned()
      const Block = require('prismarine-block')(bot.registry)
      const door = (pos, props) => {
        const stateId = Block.fromProperties('wooden_door', { 'minecraft:cardinal_direction': 'west', door_hinge_bit: 0, ...props }, 0).stateId
        client.receive('update_block', { position: { x: pos.x, y: pos.y, z: pos.z }, block_runtime_id: bot.registry.runtimeIdByStateId[stateId], flags: { _value: 3 }, layer: 0 })
        return stateId
      }
      const lower = new Vec3(3, G, 3)
      const upper = lower.offset(0, 1, 0)
      const shapesOf = (props) => Block.fromProperties('wooden_door', { 'minecraft:cardinal_direction': 'west', door_hinge_bit: 0, ...props }, 0).shapes
      door(lower, { upper_block_bit: 0, open_bit: 0 })
      const upperState = door(upper, { upper_block_bit: 1, open_bit: 0 })
      assert.deepStrictEqual(bot.blockAt(upper).shapes, shapesOf({ upper_block_bit: 1, open_bit: 0 }), 'closed: unchanged')
      door(lower, { upper_block_bit: 0, open_bit: 1 }) // opened (BDS: the lower half only)
      const top = bot.blockAt(upper)
      assert.deepStrictEqual(top.shapes, shapesOf({ upper_block_bit: 1, open_bit: 1 }), 'the open leaf at head height')
      assert.deepStrictEqual(top.shapes, bot.blockAt(lower).shapes)
      assert.strictEqual(top.stateId, upperState, 'the server\'s state')
      assert.strictEqual(top.getProperties().open_bit, 0)
      // a right-hinged door (hinge bit on the upper half): both halves open towards the same side
      door(upper, { upper_block_bit: 1, open_bit: 0, door_hinge_bit: 1 })
      assert.deepStrictEqual(bot.blockAt(lower).shapes, shapesOf({ upper_block_bit: 0, open_bit: 1, door_hinge_bit: 1 }))
      assert.deepStrictEqual(bot.blockAt(upper).shapes, shapesOf({ upper_block_bit: 1, open_bit: 1, door_hinge_bit: 1 }))
      // a lone half (the other one is not a door of that type) keeps its own shapes
      client.receive('update_block', { position: { x: lower.x, y: lower.y, z: lower.z }, block_runtime_id: bot.registry.runtimeIdByStateId[bot.registry.blocksByName.air.defaultState], flags: { _value: 3 }, layer: 0 })
      assert.deepStrictEqual(bot.blockAt(upper).shapes, shapesOf({ upper_block_bit: 1, open_bit: 0, door_hinge_bit: 1 }))
    })

    it('physics: walking through an open door collides with nothing at head height', async () => {
      const { bot, client } = await spawned()
      const Block = require('prismarine-block')(bot.registry)
      const set = (pos, props) => {
        const stateId = Block.fromProperties('wooden_door', { 'minecraft:cardinal_direction': 'west', door_hinge_bit: 0, ...props }, 0).stateId
        client.receive('update_block', { position: { x: pos.x, y: pos.y, z: pos.z }, block_runtime_id: bot.registry.runtimeIdByStateId[stateId], flags: { _value: 3 }, layer: 0 })
      }
      set(new Vec3(0, G, -2), { upper_block_bit: 0, open_bit: 1 })
      set(new Vec3(0, G + 1, -2), { upper_block_bit: 1, open_bit: 0 })
      // the bot's head (y G+1..G+1.8) inside the doorway: no shape of the upper half across x 0.2..0.8
      const top = bot.blockAt(new Vec3(0, G + 1, -2))
      for (const [x0, , , x1] of top.shapes) assert.ok(!(x1 > 0.2 && x0 < 0.8), `leaf across the way: ${JSON.stringify(top.shapes)}`)
    })
  })

  describe('#5 mineflayer-collectblock: cancelTask() during a dig (pathfinder idle) ends the job after that step', () => {
    async function collecting () {
      const created = await spawned()
      const { bot, client } = created
      bot.game.gameMode = 'survival'
      bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)
      bot.loadPlugin(require('mineflayer-tool').plugin)
      bot.loadPlugin(require('mineflayer-collectblock').plugin)
      await macrotask()
      const rid = bot.registry.runtimeIdByStateId[bot.registry.blocksByName.oak_log.defaultState]
      const logs = [new Vec3(2, G, 0), new Vec3(4, G, 0), new Vec3(6, G, 0)]
      for (const p of logs) client.receive('update_block', { position: { x: p.x, y: p.y, z: p.z }, block_runtime_id: rid, flags: { _value: 3 }, layer: 0 })
      created.gotos = []
      bot.pathfinder.goto = async (goal) => { created.gotos.push(goal.constructor.name) } // reached at once, idle after
      bot.tool.equipForBlock = async () => {}
      created.digs = []
      bot.dig = (block) => new Promise((resolve) => created.digs.push({ block, resolve }))
      created.logs = logs.map((p) => bot.blockAt(p))
      return created
    }

    it('cancelTask() resolves after the current dig (no further target); collect() resolves', async () => {
      const { bot, tick, digs, logs, gotos } = await collecting()
      let collected = false
      const job = bot.collectBlock.collect(logs).then(() => { collected = true })
      await until(() => digs.length === 1, 'first dig')
      assert.strictEqual(bot.pathfinder.isMoving(), false, 'the pathfinder is idle during the dig')
      const state = { cancelled: false }
      const cancel = bot.collectBlock.cancelTask().then(() => { state.cancelled = true })
      digs[0].resolve()
      for (let i = 0; i < 12 && !state.cancelled; i++) {
        tick()
        await macrotask()
      }
      await cancel
      await job
      assert.ok(collected && state.cancelled)
      assert.strictEqual(digs.length, 1, 'no second log')
      assert.deepStrictEqual(gotos, ['GoalLookAtBlock'])
      assert.ok(bot.collectBlock.targets.empty)
      // the next collect is not cancelled
      const next = bot.collectBlock.collect(logs[1])
      await until(() => digs.length === 2, 'the next job digs')
      digs[1].resolve()
      for (let i = 0; i < 12; i++) {
        tick()
        await macrotask()
      }
      await next
    })

    it('cancelTask() while waiting for a drop to be picked up ends the wait', async () => {
      const { bot, gotos } = await collecting()
      const Entity = require('prismarine-entity')(bot.registry)
      const entity = new Entity(4242)
      entity.position = new Vec3(2.5, G, 0.5)
      entity.isValid = true
      const job = bot.collectBlock.collect(entity)
      await until(() => gotos.length === 1, 'the walk to the drop')
      await macrotask() // waiting for the pickup (entityGone) now
      const started = Date.now()
      await bot.collectBlock.cancelTask()
      await job
      assert.ok(Date.now() - started < 1000)
    })
  })

  describe('#9 mineflayer-pathfinder: Bedrock XP orbs and projectiles are passable entities', () => {
    it('passableEntities has the Bedrock names; an XP orb is no obstacle (entity cost, pillaring, scaffolding)', async () => {
      const { bot } = await spawned()
      bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)
      const { Movements } = require('mineflayer-pathfinder')
      const moves = new Movements(bot)
      for (const name of ['xp_orb', 'xp_bottle', 'splash_potion', 'lingering_potion', 'fireworks_rocket', 'thrown_trident', 'fishing_hook', 'evocation_fang', 'wind_charge_projectile', 'ender_crystal', 'eye_of_ender_signal']) {
        assert.ok(bot.registry.entitiesByName[name], `${name} is a Bedrock entity`)
        assert.ok(moves.passableEntities.has(name), name)
      }
      const Entity = require('prismarine-entity')(bot.registry)
      const orb = new Entity(777)
      orb.name = 'xp_orb'
      orb.type = 'orb'
      orb.width = 0.25
      orb.height = 0.25
      orb.position = new Vec3(9.5, G, 9.5)
      bot.entities[777] = orb
      moves.updateCollisionIndex()
      assert.strictEqual(moves.getNumEntitiesAt(new Vec3(9, G, 9), 0, 0, 0), 0, 'not an obstacle')
      orb.name = 'pig' // control: a mob there is one
      moves.clearCollisionIndex()
      moves.updateCollisionIndex()
      assert.strictEqual(moves.getNumEntitiesAt(new Vec3(9, G, 9), 0, 0, 0), 1)
      delete bot.entities[777]
    })
  })

  describe('#6 Bedrock\'s sprint is sticky: a sprint-control release keeps sprinting while forward is held', () => {
    const flags = (p) => p.input_data ?? []
    it('released sprint key: still sprinting (sprint speed, no stop_sprinting) until forward is released', async () => {
      const { bot, client, tick } = await spawned()
      bot.game.gameMode = 'survival'
      bot.food = 20
      await bot.look(-Math.PI / 2, 0, true) // east
      const inputs = () => client.sent('player_auth_input')
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      tick(20)
      const sprintStep = inputs().at(-1).position.x - inputs().at(-2).position.x
      bot.setControlState('sprint', false)
      tick(20)
      const after = inputs().slice(-20)
      assert.ok(after.every((p) => flags(p).includes('sprinting') && !flags(p).includes('stop_sprinting')), 'still sprinting')
      assert.ok(after.every((p) => !flags(p).includes('sprint_down')), 'the key is up')
      const step = after.at(-1).position.x - after.at(-2).position.x
      assert.ok(Math.abs(step - sprintStep) < 1e-4, `sprint speed kept: ${step} vs ${sprintStep}`)
      assert.strictEqual(bot.getControlState('sprint'), false)
      bot.setControlState('forward', false)
      tick(1)
      assert.ok(flags(inputs().at(-1)).includes('stop_sprinting'))
      // a press 7+ ticks later walks
      tick(7)
      bot.setControlState('forward', true)
      tick(20)
      assert.ok(inputs().slice(-20).every((p) => !flags(p).includes('sprinting')), 'walking')
    })

    it('sneaking, backing or an item use ends it; a teleport too', async () => {
      for (const end of ['sneak', 'back']) {
        const { bot, client, tick } = await spawned()
        bot.game.gameMode = 'survival'
        bot.food = 20
        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)
        tick(3)
        bot.setControlState('sprint', false)
        tick(2)
        assert.ok(flags(client.sent('player_auth_input').at(-1)).includes('sprinting'))
        bot.setControlState(end, true)
        tick(1)
        assert.ok(flags(client.sent('player_auth_input').at(-1)).includes('stop_sprinting'), end)
        bot.setControlState(end, false)
        tick(3)
        assert.ok(!flags(client.sent('player_auth_input').at(-1)).includes('sprinting'), `${end}: not sprinting again`)
      }
    })
  })

  describe('#8 a raised shield (Bedrock: sneaking) survives clearControlStates() / a sneak release', () => {
    it('pathfinder-style clearControlStates keeps the shield up; deactivateItem lowers it', async () => {
      const { bot, client, tick } = await spawned()
      client.receive('inventory_content', inventoryContent(bot, { 0: ['shield', 1] }, { window: 'offhand', size: 1, firstStackId: 401 }))
      const last = () => client.sent('player_auth_input').at(-1).input_data
      bot.activateItem(true)
      tick(1)
      assert.ok(last().includes('sneaking'), 'raised')
      assert.strictEqual(bot.getControlState('sneak'), true)
      bot.clearControlStates() // mineflayer-pathfinder's fullStop / resetPath
      bot.setControlState('sneak', false) // pathfinder's sneak-placing release
      tick(2)
      assert.ok(last().includes('sneaking'), 'still raised')
      assert.strictEqual(bot.controlState.sneak, true)
      bot.setControlState('sneak', true) // the user's own sneak on top
      bot.deactivateItem()
      tick(1)
      assert.ok(last().includes('sneaking'), 'the user\'s sneak stays')
      bot.setControlState('sneak', false)
      tick(1)
      assert.ok(last().includes('stop_sneaking'), 'lowered')
      assert.strictEqual(bot.getControlState('sneak'), false)
    })
  })

  describe('#7 \'end\' is emitted asynchronously (like mineflayer: on the socket close after client.end())', () => {
    it('bot.quit(): end listeners run after quit() returned (state set right after quit() is seen); once', async () => {
      const { bot } = await spawned()
      const seen = []
      let stopping = false
      bot.on('end', (reason) => seen.push([reason, stopping]))
      bot.quit()
      stopping = true
      assert.deepStrictEqual(seen, [], 'not inside quit()')
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepStrictEqual(seen, [['disconnect.quitting', true]])
      bot.end('again')
      await new Promise((resolve) => setImmediate(resolve))
      assert.strictEqual(seen.length, 1, 'once')
      assert.strictEqual(bot._bedrock.lifecycle.state, 'ended')
    })

    it('the input clock stops at once (no input after quit())', async () => {
      const { bot, client, tick } = await spawned()
      bot.quit()
      const before = client.sent('player_auth_input').length
      tick(3)
      assert.strictEqual(client.sent('player_auth_input').length, before)
    })
  })

  describe('#2 a window click raced by a server-side change of its slot (pickup, /give) is planned again', () => {
    async function joined () {
      const created = await createFakeBot()
      await replayJoin(created.bot, created.client)
      created.server = serveInventory(created.bot, created.client)
      return created
    }
    const pickup = (bot, slot, name, count, stackId) => ({
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: 'normal',
        actions: [{ source_type: 'container', window_id: 'inventory', slot, old_item: wireItem(bot, null), new_item: wireItem(bot, name, count, stackId) }]
      }
    })

    it('the pickup lands while the request is in flight, BDS rejects it (49): clickWindow replans on the new stack and succeeds', async () => {
      const { bot, client, server } = await joined()
      client.receive('inventory_content', inventoryContent(bot, { 9: ['dirt', 42] }, { firstStackId: 127 }))
      await bot.clickWindow(9, 0, 0) // the inventory screen is open now, the stack on the cursor
      await bot.clickWindow(9, 0, 0) // and back
      const sid = bot.inventory.slots[9].stackId
      server.hold = true
      server.reject(49)
      const click = bot.clickWindow(9, 0, 0)
      await macrotask()
      assert.strictEqual(server.requests.length, 3)
      assert.strictEqual(server.requests[2].actions[0].source.stack_id, sid)
      client.receive('inventory_transaction', pickup(bot, 9, 'dirt', 43, 132)) // BDS processed the pickup first
      server.hold = false
      server.flush()
      await click
      assert.strictEqual(server.requests.length, 4, 'planned again once')
      const retry = server.requests[3].actions[0]
      assert.deepStrictEqual([retry.type_id, retry.count, retry.source.stack_id], ['take', 43, 132])
      assert.strictEqual(bot.inventory.selectedItem?.count, 43)
      assert.strictEqual(bot.inventory.slots[9], null)
    })

    it('a chained click (planned on the rejected one) is planned again too; transfer-style sequences finish', async () => {
      const { bot, client, server } = await joined()
      client.receive('inventory_content', inventoryContent(bot, { 9: ['dirt', 10] }, { firstStackId: 200 }))
      await bot.clickWindow(9, 0, 0)
      await bot.clickWindow(9, 0, 0)
      server.hold = true
      server.reject(49)
      server.reject(49) // the chained one names the first one's request id: rejected too
      const a = bot.clickWindow(9, 0, 0) // pick up
      const b = bot.clickWindow(10, 1, 0) // place one (planned on a's prediction)
      await macrotask()
      client.receive('inventory_transaction', pickup(bot, 9, 'dirt', 11, 240))
      server.hold = false
      server.flush()
      await Promise.all([a, b])
      assert.strictEqual(bot.inventory.slots[10]?.count, 1)
      assert.strictEqual(bot.inventory.selectedItem?.count, 10)
    })

    it('a rejection without a server-side change still throws mineflayer\'s message (no retry)', async () => {
      const { bot, client, server } = await joined()
      client.receive('inventory_content', inventoryContent(bot, { 9: ['dirt', 42] }, { firstStackId: 300 }))
      await bot.clickWindow(9, 0, 0)
      await bot.clickWindow(9, 0, 0)
      const planned = bot.inventory.slots[9]
      server.hold = true
      server.reject(49)
      const click = bot.clickWindow(9, 0, 0)
      await macrotask()
      // the server re-sends the state the request was planned on (and another slot): not a race
      client.receive('inventory_slot', { window_id: 'inventory', slot: 9, item: wireItem(bot, 'dirt', planned.count, planned.stackId) })
      client.receive('inventory_slot', { window_id: 'inventory', slot: 0, item: wireItem(bot, 'stone', 1, 999) })
      server.hold = false
      server.flush()
      await assert.rejects(click, /^Error: Server rejected transaction for clicking on slot 9, on window with id 0\.$/)
      assert.strictEqual(server.requests.length, 3)
    })
  })
})

module.exports = { spawned, until }
