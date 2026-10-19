const mineflayer = require('mineflayer-bedrock')
// mineflayer-bedrock: mineflayer-auto-eat 5 is an ES module with a new API (upstream's example targets the old one):
// load it with import(), configure it with setOpts() / enableAuto() / disableAuto(), and listen to its own events
const autoeat = import('mineflayer-auto-eat')

const bot = mineflayer.createBot({
  host: process.argv[2],
  port: process.argv[3],
  username: process.argv[4],
  password: process.argv[5]
})

// Load the plugin
autoeat.then(({ loader }) => bot.loadPlugin(loader))

bot.once('spawn', async () => {
  await autoeat
  bot.autoEat.setOpts({
    priority: 'foodPoints',
    minHunger: 14,
    bannedFood: []
  })
  // The bot eats food automatically and emits these events when it starts eating and stops eating.

  bot.autoEat.on('eatStart', () => {
    console.log('Auto Eat started!')
  })

  bot.autoEat.on('eatFinish', () => {
    console.log('Auto Eat stopped!')
  })
})

bot.on('health', () => {
  if (!bot.autoEat) return
  if (bot.food === 20) bot.autoEat.disableAuto()
  // Disable the plugin if the bot is at 20 food points
  else bot.autoEat.enableAuto() // Else enable the plugin again
})
