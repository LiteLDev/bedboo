// owner: U16b (README quick start; examples/** is U15's — this file is listed in U16b's PR)
/*
 * The README's quick start, runnable: an echo bot that walks to you when you say "come".
 *
 *   node examples/readme_quickstart.js <host> <port> [<name>] [microsoft]
 *
 * Identical to the README snippet except for the command-line arguments and the `loaded` → `Ready!` handshake the
 * e2e test (test/external/readmeQuickstart.test.js, via bot.test.runExample) uses, like upstream's examples.
 */
const mineflayer = require('mineflayer-bedrock') // instead of require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

if (process.argv.length < 4 || process.argv.length > 6) {
  console.log('Usage : node readme_quickstart.js <host> <port> [<name>] [microsoft]')
  process.exit(1)
}

const bot = mineflayer.createBot({
  host: process.argv[2],
  port: parseInt(process.argv[3]),
  username: process.argv[4] ?? 'quickstart',
  auth: process.argv[5] === 'microsoft' ? 'microsoft' : 'offline'
})

bot.loadPlugin(pathfinder)

bot.on('chat', async (username, message) => {
  if (username === bot.username) return
  if (message === 'loaded') { // test harness handshake (upstream examples do the same)
    await bot.waitForChunksToLoad()
    return bot.chat('Ready!')
  }
  if (message !== 'come') return bot.chat(message) // echo

  const target = bot.players[username]?.entity
  if (!target) return bot.chat("I can't see you")
  const { x, y, z } = target.position
  bot.pathfinder.setMovements(new Movements(bot))
  try {
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1))
    bot.chat('here!')
  } catch (err) {
    bot.chat(`I can't get there: ${err.message}`) // no path, or a new "come" changed the goal
  }
})

bot.on('kicked', console.log)
bot.on('error', console.log)
