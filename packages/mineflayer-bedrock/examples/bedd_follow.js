/*
 * Drive the real Minecraft client hosted by Be.D.D. (docs/bedd.md): the local client follows the nearest other player.
 *
 * Start the BeDD game with tap, gameHooks and allowSend on, join a world (a server, or a LAN world), then:
 *   node bedd_follow.js --pipe \\.\pipe\BeDD-1.26.51.01-hi20
 * and walk another player near the client. Say "stop" / "follow" in chat to pause / resume.
 */
const mineflayer = require('mineflayer-bedrock')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const at = process.argv.indexOf('--pipe')
const pipe = at !== -1 ? process.argv[at + 1] : process.env.BEDBOO_BEDD_PIPE
if (!pipe) {
  console.log('Usage : node bedd_follow.js --pipe \\\\.\\pipe\\<BeDD pipe name>')
  process.exit(1)
}

const bot = mineflayer.createBot({ transport: 'bedd', bedd: { pipe } })
bot.loadPlugin(pathfinder)

let following = true
let target = null

bot.once('spawn', () => {
  const movements = new Movements(bot)
  movements.canDig = false // keep the user's world intact
  bot.pathfinder.setMovements(movements)
  const caps = bot.bedrock?.bedd?.caps ?? {}
  console.log(`attached to ${bot.username}; caps: ${Object.entries(caps).map(([op, v]) => `${op}=${v}`).join(' ')}`)
  setInterval(retarget, 1000)
})

function retarget () {
  if (!following) return
  const nearest = bot.nearestEntity((e) => e.type === 'player' && e.username !== bot.username)
  if (!nearest || nearest === target) return
  target = nearest
  console.log(`following ${nearest.username}`)
  bot.pathfinder.setGoal(new goals.GoalFollow(nearest, 2), true)
}

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  if (message === 'stop') {
    following = false
    target = null
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
  } else if (message === 'follow') {
    following = true
  }
})

bot.on('entityGone', (entity) => {
  if (entity !== target) return
  target = null
  bot.pathfinder.setGoal(null)
})

bot.on('kicked', (reason) => console.log('link down:', reason))
bot.on('error', (err) => console.log('error:', err.message))
bot.on('end', () => process.exit(0))
