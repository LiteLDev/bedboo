/*
 * Drive the real Minecraft client hosted by Be.D.D. (https://docs.levimc.org/bedboo/guide/bedd): the local client follows the nearest other player.
 *
 * Start a BeDD v2 game (`BeDD.exe launch --slot 2`), join a world (a server, or a LAN world), then:
 *   node bedd_follow.js                       (the only running BeDD game)
 *   node bedd_follow.js --instance <instance> (or --pid <pid>, or --url <ws://…> --token <token>)
 * and walk another player near the client. Say "stop" / "follow" in chat to pause / resume.
 * --version names the game's protocol family (default 1.26.60).
 */
const bedboo = require('bedboo')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

function arg (name) {
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 ? process.argv[at + 1] : undefined
}

const bedd = {}
if (arg('url')) Object.assign(bedd, { url: arg('url'), token: arg('token') })
if (arg('pid')) bedd.pid = Number(arg('pid'))
if (arg('instance')) bedd.instance = arg('instance')

const bot = bedboo.createBot({ transport: 'bedd', version: arg('version') ?? '1.26.60', bedd })
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
