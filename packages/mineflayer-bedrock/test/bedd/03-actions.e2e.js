// owner: BEDD-6 (real-client e2e + docs)
'use strict'
// Real-client e2e (docs/bedd.md): dig dirt in survival, place a block, open and close a chest, eat. Each test sets its
// blocks and items up with commands (BDS console, or as the player through `send`) inside the arena of common.js.
const assert = require('assert')
const { Vec3 } = require('vec3')
const {
  gate, session, need, needCommands, run, until, sleep, nextServerbound,
  serverBlockIs, serverItemCount, botItemCount, prepareArena, giveHotbar
} = require('./common')

describe('bedd: block and item actions (real client)', function () {
  let s
  before(async function () {
    gate(this)
    s = await session()
  })

  /** a block `name` at arena + (dx, 0, dz), seen on the tap */
  async function setBlock (dx, dz, name) {
    const arena = await prepareArena(s)
    const pos = arena.offset(dx, 0, dz)
    await run(s, `setblock ${pos.x} ${pos.y} ${pos.z} ${name}`)
    await until(() => s.bot.blockAt(pos)?.name === name, { what: `${name} at ${pos} on the tap` })
    return pos
  }

  async function standAtArenaCentre () {
    const arena = await prepareArena(s)
    if (s.bot.entity.position.distanceTo(arena.offset(0.5, 0, 0.5)) > 1) {
      await run(s, `tp @s ${arena.x + 0.5} ${arena.y} ${arena.z + 0.5}`)
      await until(() => s.bot.entity.position.distanceTo(arena.offset(0.5, 0, 0.5)) < 1, { what: 'the teleport on the tap' })
    }
  }

  it('digs dirt in survival', async function () {
    need(this, s, 'dig', ['look', 'button'])
    needCommands(this, s)
    const { bot } = s
    await standAtArenaCentre()
    const pos = await setBlock(2, 0, 'dirt')
    if (s.console) assert.strictEqual(await serverBlockIs(s, pos, 'dirt'), true)
    await bot.dig(bot.blockAt(pos), true)
    await until(() => bot.blockAt(pos)?.name === 'air', { what: 'the dug block to be air on the tap', timeout: 5000 })
    if (s.console) assert.strictEqual(await serverBlockIs(s, pos, 'air'), true, 'BDS: the block is gone')
  })

  it('places a block', async function () {
    need(this, s, 'placeBlock', ['look', 'button'])
    needCommands(this, s)
    const { bot } = s
    await standAtArenaCentre()
    await giveHotbar(s, 0, 'dirt', 4)
    bot.setQuickBarSlot(0)
    await until(() => bot.heldItem?.name === 'dirt', { what: 'dirt in hand' })
    const arena = await prepareArena(s)
    const target = arena.offset(-2, 0, 1)
    await run(s, `setblock ${target.x} ${target.y} ${target.z} air`)
    const reference = bot.blockAt(target.offset(0, -1, 0)) // the stone floor
    assert.ok(reference && reference.name !== 'air', `floor at ${reference?.position}`)
    await bot.placeBlock(reference, new Vec3(0, 1, 0))
    await until(() => bot.blockAt(target)?.name === 'dirt', { what: 'the placed dirt on the tap', timeout: 5000 })
    if (s.console) assert.strictEqual(await serverBlockIs(s, target, 'dirt'), true, 'BDS: the block was placed')
    await run(s, `setblock ${target.x} ${target.y} ${target.z} air`)
  })

  it('opens and closes a chest', async function () {
    need(this, s, 'openChest', ['look', 'button'])
    needCommands(this, s)
    const { bot } = s
    await standAtArenaCentre()
    const pos = await setBlock(0, 2, 'chest')
    const chest = await bot.openChest(bot.blockAt(pos))
    assert.ok(bot.currentWindow, 'bot.currentWindow after container_open')
    assert.ok(chest, 'openChest resolved with the window')
    const closeEcho = nextServerbound(s, 'container_close', () => true, 5000).catch(() => null)
    chest.close()
    await until(() => !bot.currentWindow, { what: 'currentWindow cleared' })
    assert.ok(await closeEcho, 'the client sent container_close (ESC)')
    await sleep(300)
  })

  it('eats', async function () {
    need(this, s, 'consume', ['look', 'button'])
    needCommands(this, s)
    const { bot } = s
    await standAtArenaCentre()
    // a golden apple can always be eaten, whatever the food level or difficulty
    await run(s, 'clear @s golden_apple').catch(() => {})
    await giveHotbar(s, 1, 'golden_apple', 2)
    bot.setQuickBarSlot(1)
    await until(() => bot.heldItem?.name === 'golden_apple', { what: 'golden apple in hand' })
    await bot.consume()
    await until(() => botItemCount(bot, 'golden_apple') === 1, { what: 'one golden apple eaten (tapped inventory)', timeout: 5000 })
    if (s.console) assert.strictEqual(await serverItemCount(s, 'golden_apple'), 1, 'BDS: one golden apple left')
    await run(s, 'clear @s golden_apple').catch(() => {})
  })
})
