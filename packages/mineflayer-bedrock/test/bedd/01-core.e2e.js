// owner: BEDD-6 (real-client e2e + docs)
'use strict'
// Real-client e2e (docs/bedd.md): attach, spawn and position, chat and commands, the unsupported-API error code.
const assert = require('assert')
const crypto = require('crypto')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { gate, session, caps, need, needCommands, run, target, until, nextServerbound, serverPosition } = require('./common')

describe('bedd: core (real client)', function () {
  let s
  before(async function () {
    gate(this)
    s = await session()
  })

  it('spawns with a position that matches the client', async function () {
    const { bot } = s
    assert.strictEqual(bot._bedrock.mode, 'bedd')
    assert.ok(typeof bot.username === 'string' && bot.username.length > 0, 'username from start_game/player_list')
    assert.ok(caps(s).tap === 'present' || caps(s).tap === undefined, `tap cap: ${caps(s).tap}`)
    const pos = bot.entity.position
    for (const k of ['x', 'y', 'z']) assert.ok(Number.isFinite(pos[k]), `position.${k} is finite`)
    assert.ok(bot.game?.gameMode, 'bot.game.gameMode')
    // tapped self state: the next echoed player_auth_input is the client's own position (eye level)
    const echo = await nextServerbound(s, 'player_auth_input', () => true, 5000).catch(() => null)
    if (echo) {
      const feetY = echo.position.y - 1.62
      await until(() => Math.abs(bot.entity.position.y - feetY) < 1 && Math.abs(bot.entity.position.x - echo.position.x) < 1,
        { what: 'bot.entity to follow the echoed player_auth_input', timeout: 3000 })
    }
    const server = await serverPosition(s)
    if (server) assert.ok(server.pos.distanceTo(bot.entity.position) < 1.5, `BDS ${server.pos} vs bot ${bot.entity.position}`)
  })

  it('chat, /say and a command round-trip with command_output', async function () {
    need(this, s, 'chat', ['send'])
    const { bot } = s
    const word = 'bedd' + crypto.randomBytes(3).toString('hex')

    // resolves with the first messagestr containing `text` (timeout: rejects with a message naming it)
    const seen = (text) => onceWithCleanup(bot, 'messagestr', { timeout: 10000, checkCondition: (msg) => String(msg).includes(text) })
      .catch((err) => { throw new Error(`no message containing ${text}: ${err.message}`) })

    // plain chat: the client sends the text packet (echo), the server broadcasts it back (tapped text packet)
    const [, chatEcho] = await Promise.all([
      seen(word + 'c'),
      nextServerbound(s, 'text', (p) => String(p.message).includes(word + 'c'), 10000),
      Promise.resolve().then(() => bot.chat(word + 'c'))
    ])
    assert.ok(chatEcho, 'the client sent the text packet (serverbound echo)')

    // /say: command_request through `send`, uuid preserved → command_output correlated by bedboo's chat plugin
    const [, req] = await Promise.all([
      seen(word + 's'),
      nextServerbound(s, 'command_request', (p) => String(p.command).includes(word + 's'), 10000),
      Promise.resolve().then(() => bot.chat('/say ' + word + 's'))
    ])
    assert.ok(req.origin?.uuid, 'command_request carries an origin uuid')

    // a command with an observable side effect, correlated by uuid (bot._bedrock.commands.request)
    const out = await bot._bedrock.commands.request(`/tag @s add ${word}`, { timeout: 10000 })
    assert.ok(out.success_count > 0, `tag add: ${JSON.stringify(out.output)}`)
    if (s.console) {
      const lines = await s.console.commandOutput(`tag ${target(s.name)} list`)
      assert.ok(lines.some((l) => l.includes(word)), `BDS tag list: ${lines.join(' | ')}`)
    }
    await run(s, `tag @s remove ${word}`).catch(() => {})
  })

  it('an unsupported API rejects with ERR_BEDD_UNSUPPORTED', async function () {
    const { bot } = s
    const supports = bot.bedrock?.bedd?.supports
    if (typeof supports !== 'function') this.skip() // capability surface (BB5) not in this build
    // clickWindow is unsupported unless the `stack` cap routes item_stack_request (BB7); the screen-level ones always are
    const candidates = [
      ['clickWindow', () => bot.clickWindow(0, 0, 0)],
      ['writeBook', () => bot.writeBook(bot.inventory.hotbarStart, ['x'])],
      ['updateSign', () => bot.updateSign(bot.blockAt(bot.entity.position), 'x')]
    ]
    const pick = candidates.find(([name]) => !supports.call(bot.bedrock.bedd, name))
    if (!pick) this.skip()
    let err = null
    try {
      await pick[1]()
    } catch (e) {
      err = e
    }
    assert.ok(err, `${pick[0]} should throw or reject`)
    assert.strictEqual(err.code, 'ERR_BEDD_UNSUPPORTED', `${pick[0]}: ${err.stack}`)
    assert.strictEqual(err.bedd, true)
  })

  it('setup commands reach the world (console or player commands)', async function () {
    needCommands(this, s)
    const lines = await run(s, 'time query daytime')
    assert.ok(lines.length > 0, 'time query printed something')
  })
})
