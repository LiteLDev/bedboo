// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/scoreboard.js (MIT, Copyright (c) 2013 Andrew Kelley) against BDS 1.26.51.1.
 *
 * Upstream's body is commented out ("TODO: This is failing randomly"), so the verbatim port is an empty test. The
 * second test is that commented-out scenario adapted to Bedrock (docs/differences/U6.md#scoreboards): only the
 * `dummy` criterion exists, and the client only learns about DISPLAYED objectives (test3 is never sent).
 */
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('scoreboard', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => env.bot.test.resetState())

  it('scoreboard', async () => {
    env.bot.test.sayEverywhere('### Starting scoreboard')
    // TODO: This is failing randomly, investigate and fix (upstream: the whole body is commented out)
  })

  it('scoreboard objectives, display slots, scores and removal (upstream scenario adapted)', async () => {
    const { bot } = env
    const say = (cmd) => bot.test.sayEverywhere(cmd)
    const name = bot.username
    const created = []
    bot.on('scoreboardCreated', (sb) => created.push(sb.name))
    const positions = []
    bot.on('scoreboardPosition', (position, sb) => positions.push([position, sb.name]))

    await say('/scoreboard objectives add test1 dummy')
    await say('/scoreboard objectives add test2 dummy')
    await say('/scoreboard objectives add test3 dummy "Third"')
    const createdBoth = new Promise(resolve => bot.on('scoreboardCreated', () => created.length === 2 && resolve()))
    await say('/scoreboard objectives setdisplay sidebar test1')
    await say('/scoreboard objectives setdisplay belowname test1')
    await say('/scoreboard objectives setdisplay list test2')
    if (created.length !== 2) await createdBoth
    await bot.test.wait(500)

    assert.deepStrictEqual(created, ['test1', 'test2'], 'only displayed objectives reach a Bedrock client')
    assert.notStrictEqual(bot.scoreboards.test1, undefined)
    assert.notStrictEqual(bot.scoreboards.test2, undefined)
    assert.strictEqual(bot.scoreboards.test3, undefined)

    const { test1, test2 } = bot.scoreboards
    assert.strictEqual(test2.name, test2.title)
    assert.strictEqual(test1, bot.scoreboard.sidebar)
    assert.strictEqual(test1, bot.scoreboard.belowName)
    assert.strictEqual(test2, bot.scoreboard.list)
    assert.deepStrictEqual(positions, [[1, 'test1'], [2, 'test1'], [0, 'test2']])

    // upstream: `/kill` changes the health / deathCount scores; Bedrock: set them with /scoreboard players
    let promise = once(bot, 'scoreUpdated', 10000)
    await say(`/scoreboard players add ${name} test1 5`)
    let [scoreboard, updated] = await promise
    assert.strictEqual(scoreboard, test1)
    assert.strictEqual(scoreboard.itemsMap[name], updated)
    assert.strictEqual(updated.value, 5)

    promise = once(bot, 'scoreUpdated', 10000)
    await say('/scoreboard players set fakeguy test2 7')
    ;[scoreboard, updated] = await promise
    assert.deepStrictEqual([scoreboard, updated.name, updated.value, updated.displayName.toString()], [test2, 'fakeguy', 7, 'fakeguy'])

    promise = once(bot, 'scoreRemoved', 10000)
    await say(`/scoreboard players reset ${name} test1`)
    const [fromBoard, removed] = await promise
    assert.deepStrictEqual([fromBoard, removed.name, removed.value], [test1, name, 5])
    assert.strictEqual(test1.itemsMap[name], undefined)

    promise = once(bot, 'scoreboardDeleted', 10000)
    await say('/scoreboard objectives remove test2')
    const [deleted] = await promise
    assert.strictEqual(deleted, test2)
    assert.strictEqual(bot.scoreboards.test2, undefined)
    assert.strictEqual(bot.scoreboard.list, undefined)

    await say('/scoreboard objectives setdisplay sidebar')
    await bot.test.wait(300)
    assert.strictEqual(bot.scoreboard.sidebar, undefined, 'clearing a display slot')
    assert.strictEqual(bot.scoreboard.belowName, test1)
    await say('/scoreboard objectives remove test1')
    await say('/scoreboard objectives remove test3')
  })
})
