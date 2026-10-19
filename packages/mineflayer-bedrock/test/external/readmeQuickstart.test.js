// owner: U16b (mob combat matrix, NetherNet, user docs)
'use strict'
/**
 * README quick start (Bedrock extra, plan U16): `examples/readme_quickstart.js` — the README's mineflayer-identical
 * example (`require('mineflayer-bedrock')`, `createBot({ host, port, username, auth: 'offline' })`, chat echo,
 * mineflayer-pathfinder) — runs as a child process through `bot.test.runExample` (upstream's example-test protocol)
 * against a real BDS: it echoes chat and walks to the player who says "come".
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

describe('readme quickstart (U16b): the README example runs against BDS', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })

  /** the next chat message from `username` satisfying `match` */
  function chatFrom (bot, username, match, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { bot.removeListener('chat', onChat); reject(new Error(`no chat from ${username} within ${timeout} ms`)) }, timeout)
      function onChat (from, message) {
        if (from !== username || !match(message)) return
        clearTimeout(timer)
        bot.removeListener('chat', onChat)
        resolve(message)
      }
      bot.on('chat', onChat)
    })
  }

  it('readme quickstart: the example echoes chat and comes to the player (pathfinder)', async () => {
    const { bot } = env
    await bot.test.resetState()
    if (bot.creative?.stopFlying) bot.creative.stopFlying()
    await bot.test.runExample('examples/readme_quickstart.js', async (name) => {
      assert.strictEqual(name, 'quickstart')
      // echo
      const echoed = chatFrom(bot, name, (m) => m === 'hello bedrock')
      bot.chat('hello bedrock')
      await echoed
      // "come": the runner parked the example at (50, groundY, 0); stand 6 blocks west of it and call it
      await bot.test.teleport(new Vec3(44, bot.test.groundY, 0))
      await bot.waitForTicks(10)
      const arrived = chatFrom(bot, name, (m) => m === 'here!' || m === "I can't see you")
      bot.chat('come')
      assert.strictEqual(await arrived, 'here!')
      const child = bot.players[name]?.entity
      assert.ok(child, `${name} is visible`)
      const distance = child.position.distanceTo(bot.entity.position)
      assert.ok(distance <= 2.5, `the example walked to the player (distance ${distance.toFixed(2)})`)
    })
  })
})
