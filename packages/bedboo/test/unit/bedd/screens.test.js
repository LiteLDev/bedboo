'use strict'
// Screen-level APIs and the remaining packets with transport 'bedd' (lib/bedd/screens.js, the router's generic `send`
// path, router_actions' block_pick_request and createBot's host/port → `join`): a real createBot against the fake
// Be.D.D. (test/unit/helpers/fake_bedd.js), whose `ui` op serves the screens the test puts in fake.state.ui.
const { describe, it, before, after } = require('node:test')
const assert = require('assert')
const { once } = require('events')
const bedboo = require('../../..')
const { createFakeBedd } = require('../helpers/fake_bedd')
const screens = require('../../../lib/bedd/screens')
const { packetIdOf } = require('../../../lib/bedd/router')
const { TEST_VERSION } = require('../../version')

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
  deserializer = deserializer ?? createDeserializer(TEST_VERSION)
  return deserializer.parsePacketBuffer(Buffer.from(buf, 'base64')).data
}

async function beddBot (fakeOpts = {}, botOpts = {}, setup) {
  const fake = await createFakeBedd({ live: 'join_flat', ...fakeOpts })
  setup?.(fake)
  const bot = bedboo.createBot({ transport: 'bedd', version: TEST_VERSION, bedd: fake.botOptions({ screens: { pollMs: 5 } }), logErrors: false, hideErrors: true, ...botOpts })
  const warnings = []
  bot._client.on('warning', (w) => warnings.push(w.message))
  await once(bot, 'spawn')
  await bot._client.bedd.ready
  return { fake, bot, warnings }
}

describe('bedd screens: finding nodes in a ui snapshot', () => {
  const snapshot = {
    snapshot: 's1',
    active: 'death_screen',
    roots: ['n1', 'n3'],
    nodes: {
      n1: { role: 'screen', name: 'hud_screen', children: ['n2'] },
      n2: { role: 'button', name: 'respawn_hint', text: 'Respawn', state: { visible: false } },
      n3: { role: 'screen', name: 'death_screen', children: ['n4', 'n5'] },
      n4: { role: 'button', name: 'main_menu_button', text: 'Main Menu' },
      n5: { role: 'button', name: 'respawn_button', text: 'Respawn' }
    }
  }

  it('maps every node to its screen and skips hidden or disabled nodes', () => {
    const map = screens.screensOf(snapshot)
    assert.strictEqual(map.get('n2'), 'hud_screen')
    assert.strictEqual(map.get('n5'), 'death_screen')
    assert.deepStrictEqual(screens.findNode(snapshot, screens.RESPAWN), { ref: 'n5', node: snapshot.nodes.n5, screen: 'death_screen' })
    assert.strictEqual(screens.findNode(snapshot, screens.WAKE), null)
  })

  it('prefers JSON UI controls over Ore UI page elements (source.kind dom)', () => {
    const withDom = {
      snapshot: 's2',
      active: 'death_screen',
      roots: ['e1', 'e3'],
      nodes: {
        e1: { role: 'screen', name: 'death_screen', children: ['e2', 'e5'] },
        e2: { role: 'button', name: 'respawn', text: 'Respawn', source: { kind: 'dom' } },
        e5: { role: 'button', name: 'respawn_button', text: 'Respawn', source: { kind: 'jsonui' } },
        e3: { role: 'screen', name: 'hud_screen', children: [] }
      }
    }
    assert.strictEqual(screens.findNode(withDom, screens.RESPAWN).ref, 'e5')
    delete withDom.nodes.e5
    assert.strictEqual(screens.findNode(withDom, screens.RESPAWN).ref, 'e2', 'an Ore UI element when nothing else matches')
    assert.ok(screens.SIGN_TEXT({ role: 'text_input', name: 'sign_text' }, { screen: 'sign_screen' }))
  })

  it('matches the bed screen, the sign editor and its Done button by role and name or text', () => {
    assert.ok(screens.WAKE({ role: 'button', name: 'wake_up_button', text: 'Leave Bed' }))
    assert.ok(screens.WAKE({ role: 'button', name: 'x', text: 'Leave Bed' }))
    assert.ok(!screens.WAKE({ role: 'label', name: 'wake_up_button' }))
    assert.ok(screens.SIGN_TEXT({ role: 'textbox', name: 'text_box' }, { screen: 'sign_screen' }))
    assert.ok(!screens.SIGN_TEXT({ role: 'textbox', name: 'chat_box' }, { screen: 'chat_screen' }))
    assert.ok(screens.DONE({ role: 'button', name: 'done_button', text: 'Done' }, { screen: 'sign_screen' }))
  })
})

describe('bedd screens: ui op (default sendAllow)', () => {
  let fake, bot, warnings

  before(async () => {
    ({ fake, bot, warnings } = await beddBot())
  }, { timeout: 60000 })

  after(async () => {
    bot?.end()
    await fake?.close()
  })

  it('supports the screen-level APIs through ui; the book still needs book_edit in sendAllow', () => {
    assert.strictEqual(bot._client.bedd.caps.ui, 'present')
    assert.strictEqual(bot._client.bedd.caps.join, 'present')
    for (const api of ['respawn', 'wake', 'updateSign']) assert.strictEqual(bot.bedrock.bedd.supports(api), true, api)
    assert.strictEqual(bot.bedrock.bedd.supports('writeBook'), false)
    assert.deepStrictEqual(bot.bedrock.bedd.sendAllow, [9, 77])
    assert.strictEqual(bot.bedrock.bedd.screens, bot._client.bedd.screens)
  })

  it('bot.respawn() while dead clicks the death screen\'s Respawn button', async () => {
    fake.state.uiActions.length = 0
    fake.state.ui = [{ name: 'hud_screen', nodes: [] }]
    const alive = bot.isAlive
    bot.isAlive = false
    try {
      bot.respawn()
      // the button shows a little later (the server's respawn state 0): the click waits for it
      await new Promise(resolve => setTimeout(resolve, 30))
      fake.state.ui = [{ name: 'hud_screen', nodes: [] }, { name: 'death_screen', nodes: [{ role: 'button', name: 'main_menu_button', text: 'Main Menu' }, { role: 'button', name: 'respawn_button', text: 'Respawn' }] }]
      await until(() => fake.state.uiActions.length > 0, { what: 'the respawn click' })
      await bot._client.bedd.screens.idle()
      assert.deepStrictEqual(fake.state.uiActions, [{ action: 'click', screen: 'death_screen', node: 'respawn_button' }])
    } finally {
      bot.isAlive = alive
      fake.state.ui = [{ name: 'hud_screen', nodes: [] }]
    }
  })

  it('bot.respawn() while alive does nothing', async () => {
    fake.state.uiActions.length = 0
    bot.respawn()
    await bot._client.bedd.screens.idle()
    assert.deepStrictEqual(fake.state.uiActions, [])
  })

  it('bot.wake() clicks the bed screen\'s Leave Bed button (player_action stop_sleeping is not in sendAllow)', async () => {
    fake.state.uiActions.length = 0
    fake.state.ui = [{ name: 'hud_screen', nodes: [] }, { name: 'in_bed_screen', nodes: [{ role: 'button', name: 'wake_up_button', text: 'Leave Bed' }] }]
    bot.isSleeping = true
    try {
      await bot.wake()
      await bot._client.bedd.screens.idle()
      assert.deepStrictEqual(fake.state.uiActions, [{ action: 'click', screen: 'in_bed_screen', node: 'wake_up_button' }])
      assert.strictEqual(fake.state.sent.length, 0, 'nothing sent as a packet')
    } finally {
      bot.isSleeping = false
      fake.state.ui = [{ name: 'hud_screen', nodes: [] }]
    }
  })

  it('bot.updateSign() types into the open sign editor and presses Done', async () => {
    fake.state.uiActions.length = 0
    fake.state.ui = [{ name: 'hud_screen', nodes: [] }, { name: 'sign_screen', nodes: [{ role: 'textbox', name: 'sign_text_box' }, { role: 'button', name: 'done_button', text: 'Done' }] }]
    try {
      const block = bot.blockAt(bot.entity.position.floored())
      bot.updateSign(block, 'hello\nbedd')
      await until(() => fake.state.uiActions.length >= 2, { what: 'the sign edit' })
      await bot._client.bedd.screens.idle()
      assert.deepStrictEqual(fake.state.uiActions, [
        { action: 'setText', screen: 'sign_screen', node: 'sign_text_box', text: 'hello\nbedd' },
        { action: 'click', screen: 'sign_screen', node: 'done_button' }
      ])
      assert.strictEqual(fake.state.sent.length, 0)
    } finally {
      fake.state.ui = [{ name: 'hud_screen', nodes: [] }]
    }
  })

  it('releasing the book closes the client\'s book screen with ESC', async () => {
    fake.calls.length = 0
    fake.state.showingMenu = true
    fake.state.topScreen = 'book_screen'
    try {
      bot._client.queue('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_release', actions: [], transaction_data: { action_type: 'release', hotbar_slot: 0, held_item: { network_id: 0 }, head_pos: { x: 0, y: 0, z: 0 } } } })
      await until(() => fake.callsOf('key').some(c => c.args.key === 'ESC'), { what: 'ESC' })
      await bot._client.bedd.screens.idle()
    } finally {
      fake.state.showingMenu = false
      fake.state.topScreen = 'hud_screen'
    }
  })

  it('a stale snapshot is read again before acting', async () => {
    fake.state.uiActions.length = 0
    fake.state.ui = [{ name: 'in_bed_screen', nodes: [{ role: 'button', name: 'wake_up_button', text: 'Leave Bed' }] }]
    // the screens change between the read and the first click: that click gets stale_snapshot
    let actions = 0
    const onCall = ({ op, args }) => { if (op === 'ui' && args.action && actions++ === 0) fake.state.uiSnapshot++ }
    fake.on('call', onCall)
    try {
      await bot._client.bedd.screens.click(screens.WAKE)
      assert.strictEqual(actions, 2, 'clicked again after a new read')
      assert.deepStrictEqual(fake.state.uiActions.map(a => a.node), ['wake_up_button'])
    } finally {
      fake.off('call', onCall)
      fake.state.ui = [{ name: 'hud_screen', nodes: [] }]
    }
  })

  it('block_pick_request: look at the block, then the pick button', async () => {
    fake.calls.length = 0
    bot._client.queue('block_pick_request', { x: 2, y: -60, z: 3, add_user_data: false, selected_slot: 0 })
    await until(() => fake.callsOf('button').some(c => c.args.button === 'pick'), { what: 'the pick click' })
    const order = fake.calls.filter(c => c.op === 'look' || c.op === 'button').map(c => c.op)
    assert.deepStrictEqual(order.slice(-2), ['look', 'button'])
    assert.deepStrictEqual(fake.callsOf('button').at(-1).args, { button: 'pick', action: 'click' })
  })

  it('bot.dismount() is a sneak tap', async () => {
    fake.calls.length = 0
    const vehicle = Object.values(bot.entities).find(e => e !== bot.entity)
    assert.ok(vehicle, 'some entity to ride')
    bot.vehicle = vehicle
    try {
      bot.dismount()
      await until(() => fake.callsOf('input').some(c => c.args.sneak === true), { what: 'the sneak tap' })
      assert.deepStrictEqual(fake.callsOf('input').find(c => c.args.sneak).args, { move: { x: 0, z: 0 }, jump: false, sneak: true, sprint: false, ttlMs: 200 })
    } finally {
      bot.vehicle = null
    }
  })

  it('show_credits after the End exit: ESC while credits_screen shows, never once more', async () => {
    fake.calls.length = 0
    fake.state.showingMenu = true
    fake.state.topScreen = 'credits_screen'
    let escs = 0
    // the first ESC shows the Skip button, the second exits
    const onCall = ({ op, args }) => {
      if (op !== 'key' || args.key !== 'ESC') return
      if (++escs === 2) {
        fake.state.showingMenu = false
        fake.state.topScreen = 'hud_screen'
      }
    }
    fake.on('call', onCall)
    try {
      fake.sendPacket('show_credits', { runtime_entity_id: bot.entity.runtimeId ?? 1n, status: 0 })
      await until(() => escs === 2, { what: 'two ESCs' })
      await bot._client.bedd.screens.idle()
      assert.strictEqual(escs, 2, 'no ESC once the credits are gone (it would open the pause screen)')
      // bedboo's own show_credits answer is client-owned: dropped
      assert.strictEqual(bot._client.bedd.router.counters.dropped.show_credits, 1)
    } finally {
      fake.off('call', onCall)
      fake.state.showingMenu = false
      fake.state.topScreen = 'hud_screen'
    }
  })

  it('bot.swingArm() is `action swing` (attack swings stay the client\'s own)', async () => {
    fake.calls.length = 0
    bot.swingArm()
    bot.swingArm('left')
    await until(() => fake.callsOf('action').filter(c => c.args.name === 'swing').length === 2, { what: 'two swings' })
    const swings = fake.callsOf('action').map(c => c.args)
    assert.deepStrictEqual(swings.filter(a => a.name === 'swing'), [{ name: 'swing' }, { name: 'swing', hand: 'off' }])
  })

  it('bot.setSettings({ viewDistance }) sets the client\'s render distance with `settings`', async () => {
    fake.calls.length = 0
    bot.setSettings({ viewDistance: 6 })
    await bot._client.bedd.router.idle()
    assert.deepStrictEqual(fake.callsOf('settings').map(c => c.args), [{ renderDistance: 6 }])
    assert.strictEqual(fake.state.renderDistance, 6)
  })

  it('an inventory resync is a no-op (the client owns its inventory)', async () => {
    assert.strictEqual(await bot._bedrock.inventoryModel.resync('test'), false)
  })

  it('a packet nobody translates names the sendAllow id that would send it', () => {
    assert.throws(() => bot._client.queue('set_default_game_type', { gamemode: 1 }), (err) => {
      assert.strictEqual(err.code, 'ERR_BEDD_UNSUPPORTED')
      assert.deepStrictEqual(err.missing, ['send'])
      assert.match(err.message, /packet id \d+ to sendAllow/)
      return true
    })
    assert.ok(!warnings.some(w => /host/.test(w)))
  })
})

describe('bedd screens: packets in sendAllow go out as is', () => {
  let fake, bot

  before(async () => {
    ({ fake, bot } = await beddBot({}, {}, (f) => { f.state.sendAllow = [9, 77, 36, 56, 97, 105] }))
  }, { timeout: 60000 })

  after(async () => {
    bot?.end()
    await fake?.close()
  })

  it('reports the APIs supported by the allowed ids', () => {
    assert.deepStrictEqual(bot._client.bedd.sendAllow, [9, 77, 36, 56, 97, 105])
    for (const api of ['writeBook', 'signBook', 'updateSign', 'wake']) assert.strictEqual(bot.bedrock.bedd.supports(api), true, api)
  })

  it('book_edit, block_entity_data and player_action stop_sleeping are sent through `send`', async () => {
    fake.state.sent.length = 0
    fake.state.uiActions.length = 0
    bot._client.queue('book_edit', { inventory_slot: 0, type: 'replace_page', page_number: 0, text: 'page one', photo_name: '' })
    const block = bot.blockAt(bot.entity.position.floored())
    bot.updateSign(block, 'as is')
    bot.isSleeping = true
    try {
      await bot.wake()
    } finally {
      bot.isSleeping = false
    }
    await bot._client.bedd.router.idle()
    const sent = fake.state.sent.map(decode)
    assert.deepStrictEqual(sent.map(p => p.name), ['book_edit', 'block_entity_data', 'player_action'])
    assert.strictEqual(sent[0].params.text, 'page one')
    assert.strictEqual(sent[2].params.action, 'stop_sleeping')
    assert.deepStrictEqual(fake.state.uiActions, [], 'no screen was touched')
    assert.strictEqual(bot._client.bedd.router.counters.shared.book_edit, 1)
  })

  it('an allowed packet the authority table calls unsupported goes out too (a plugin\'s own _client.write)', async () => {
    fake.state.sent.length = 0
    bot._client.write('set_default_game_type', { gamemode: 1 })
    await bot._client.bedd.router.idle()
    assert.deepStrictEqual(fake.state.sent.map(b => packetIdOf(Buffer.from(b, 'base64'))), [105])
  })

  it('client-owned packets are still dropped even when their id is allowed', async () => {
    fake.state.sent.length = 0
    bot._client.queue('player_action', { runtime_entity_id: 1n, action: 'respawn', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 })
    await bot._client.bedd.router.idle()
    assert.deepStrictEqual(fake.state.sent, [])
  })
})

describe('bedd screens: quit and viewDistance', () => {
  it('bot.quit() makes the client leave its world (join host:null), then detaches; bot.end() only detaches', async () => {
    const { fake, bot } = await beddBot()
    try {
      const ended = once(bot, 'end')
      bot.quit()
      const [reason] = await ended
      assert.strictEqual(reason, 'disconnect.quitting')
      assert.deepStrictEqual(fake.callsOf('join').filter(c => 'host' in c.args).map(c => c.args), [{ host: null }])
      assert.strictEqual(fake.state.leaves, 1)
    } finally {
      await fake.close()
    }
    const second = await beddBot()
    try {
      const ended = once(second.bot, 'end')
      second.bot.end()
      await ended
      assert.strictEqual(second.fake.state.leaves, 0, 'end() leaves the client where it is')
    } finally {
      await second.fake.close()
    }
  })

  it('createBot viewDistance is applied to the client once it spawns', async () => {
    const { fake, bot } = await beddBot({}, { viewDistance: 'tiny' })
    try {
      await until(() => fake.callsOf('settings').some(c => c.args.renderDistance), { what: 'settings' })
      assert.deepStrictEqual(fake.callsOf('settings').filter(c => c.args.renderDistance).map(c => c.args), [{ renderDistance: 6 }])
    } finally {
      bot.end()
      await fake.close()
    }
  })
})

describe('bedd screens: createBot host/port make the client join first', () => {
  it('joins the given server with `join` (wait) before the bot attaches, without an ignored-option warning', async () => {
    const fake = await createFakeBedd({ live: 'join_flat' })
    const bot = bedboo.createBot({ transport: 'bedd', version: TEST_VERSION, host: '127.0.0.1', port: 19140, bedd: fake.botOptions(), logErrors: false, hideErrors: true })
    const warned = []
    bot._warn = (...m) => warned.push(m.join(' '))
    try {
      await once(bot, 'spawn')
      assert.deepStrictEqual(fake.state.joins, [{ host: '127.0.0.1', port: 19140, wait: true, timeoutMs: 60000 }])
      assert.strictEqual(bot._client.bedd.joined.joined, true)
      assert.ok(!warned.some(w => /'host'|'port'/.test(w)), warned.join('\n'))
    } finally {
      bot.end()
      await fake.close()
    }
  })

  it('a client already on that server is left alone', async () => {
    const fake = await createFakeBedd({ live: 'join_flat' })
    const bot = bedboo.createBot({ transport: 'bedd', version: TEST_VERSION, host: '127.0.0.1', bedd: fake.botOptions(), logErrors: false, hideErrors: true })
    try {
      await once(bot, 'spawn')
      assert.deepStrictEqual(fake.state.joins, [])
      assert.strictEqual(bot._client.bedd.joined.already, true)
    } finally {
      bot.end()
      await fake.close()
    }
  })

  it('without the join op the bot fails with ERR_BEDD_JOIN', async () => {
    const fake = await createFakeBedd({ live: 'join_flat', caps: { join: 'absent' } })
    const bot = bedboo.createBot({ transport: 'bedd', version: TEST_VERSION, host: 'play.example.net', bedd: fake.botOptions(), logErrors: false, hideErrors: true })
    try {
      const [err] = await once(bot, 'error')
      assert.strictEqual(err.code, 'ERR_BEDD_JOIN')
      assert.match(err.message, /'join' is absent/)
    } finally {
      bot.end()
      await fake.close()
    }
  })

  it('a join the client gives up fails with ERR_BEDD_JOIN and the reason', async () => {
    const fake = await createFakeBedd({
      live: 'join_flat',
      handlers: { join: (args) => { if (args.host) throw Object.assign(new Error('the client gave up joining'), { code: 'join_failed' }); return { inLevel: false } } }
    })
    const bot = bedboo.createBot({ transport: 'bedd', version: TEST_VERSION, host: '127.0.0.1', port: 19999, bedd: fake.botOptions(), logErrors: false, hideErrors: true })
    try {
      const [err] = await once(bot, 'error')
      assert.strictEqual(err.code, 'ERR_BEDD_JOIN')
      assert.strictEqual(err.reason, 'join_failed')
    } finally {
      bot.end()
      await fake.close()
    }
  })
})
