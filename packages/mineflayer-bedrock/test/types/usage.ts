// Compile-only check of index.d.ts (`pnpm typecheck`): mineflayer-style usage must type-check
// unchanged against mineflayer-bedrock.
import { Vec3 } from 'vec3'
import {
  createBot, Bot, BotOptions, Chest, Furnace, EnchantmentTable, Villager, Anvil,
  Location, Painting, ScoreBoard, BossBar, Particle, testedVersions, latestSupportedVersion,
  oldestSupportedVersion, supportFeature, BedrockExtras
} from '../..'

const options: BotOptions = {
  host: '127.0.0.1',
  port: 19132,
  username: 'TypeBot',
  offline: true,
  version: '1.26.51',
  viewDistance: 'normal',
  physicsEnabled: true,
  plugins: { myPlugin: (bot: Bot) => { bot.chat('hi') } }
}
const bot: Bot = createBot(options)

bot.once('spawn', async () => {
  const pos: Vec3 = bot.entity.position
  const block = bot.blockAt(pos.offset(0, -1, 0))
  if (block) await bot.dig(block)
  bot.setControlState('forward', true)
  await bot.lookAt(pos.offset(1, 1.62, 0), true)
  await bot.waitForTicks(2)
  const held = bot.heldItem
  if (held) await bot.equip(held, 'hand')
  await bot.creative.setInventorySlot(36, null)
  const chest: Chest = await bot.openChest(block!)
  await chest.close()
  const furnace: Furnace = await bot.openFurnace(block!)
  const fuel: number = furnace.fuel
  const table: EnchantmentTable = await bot.openEnchantmentTable(block!)
  const anvil: Anvil = await bot.openAnvil(block!)
  const villager: Villager = await bot.openVillager(bot.nearestEntity()!)
  console.log(fuel, table.enchantments, anvil, villager.trades, bot.game.dimension, bot.time.timeOfDay)
})
bot.on('chat', (username: string, message: string) => { if (username !== bot.username) bot.chat(message) })
bot.on('physicsTick', () => {})
bot.on('kicked', (reason: string, loggedIn: boolean) => console.log(reason, loggedIn))

// bedrock-protocol client is exposed as bot._client
bot._client.queue('text', {})
const extras: BedrockExtras = bot.bedrock

const loc = new Location(new Vec3(1, 2, 3))
const painting = new Painting(1, new Vec3(0, 0, 0), 'kebab', new Vec3(0, 0, 1))
console.log(loc.chunkYIndex, painting.name, ScoreBoard, BossBar, Particle, extras)
console.log(testedVersions, latestSupportedVersion, oldestSupportedVersion, supportFeature('tallWorld', '1.26.51'))

// mineflayer.createBot({ client }) overload
createBot({ client: bot._client, username: 'x' })
