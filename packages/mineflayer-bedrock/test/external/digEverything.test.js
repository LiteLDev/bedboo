// owner: U10 (digging)
'use strict'
/**
 * Adapted port of mineflayer 4.39.0 test/externalTests/digEverything.js: one test per diggable block of the
 * registry (Bedrock: 1,442 blocks), dug in survival, then the position must be empty.
 *
 * Adaptations (docs/parity/U10.md, docs/differences/U10.md#dig-everything):
 * - the block is staged with /setblock (default state) two blocks east of the bot instead of the console
 *   placeBlock helper (the same thing on Bedrock: `execute … setblock`), and it must still be there two ticks later —
 *   blocks that cannot exist there (doors' upper halves, plants needing water, …) or that /setblock refuses
 *   (education-edition / internal blocks) are skipped with the reason, like upstream's excludedBlocks list;
 * - instead of a diamond pickaxe for everything (~1 h on Bedrock's 1,442 blocks, mostly wood at hand speed) the bot
 *   picks the fastest of netherite pickaxe / axe / shovel / hoe and shears (all Efficiency V), a netherite sword and
 *   the bare hand (a stick), computed with bot.digTime like mineflayer-tool would;
 * - "empty" = air, or a liquid for blocks that leave water behind (ice, waterlogged blocks);
 * - Bedrock extras on every block: BDS reports the same break speed as bot.digTime's (level_event data) and never
 *   restores the block.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')
const { createRegistry } = require('../../lib/registry')
const digSpeed = require('../../lib/bedrock/dig_speed')

const LIQUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava'])
/** hotbar: tools (Efficiency V where it applies) and sticks standing in for the bare hand */
const HOTBAR = [
  { name: 'netherite_pickaxe', efficiency: 5 },
  { name: 'netherite_axe', efficiency: 5 },
  { name: 'netherite_shovel', efficiency: 5 },
  { name: 'netherite_hoe', efficiency: 5 },
  { name: 'shears', efficiency: 5 },
  { name: 'netherite_sword' },
  { name: 'stick' },
  { name: 'stick' },
  { name: 'stick' }
]
const HAND_SLOT = 6
/** blocks that cannot be dug reliably in this setup (like upstream's excludedBlocks) */
const EXCLUDED = {
  frosted_ice: 'melts into water within a few ticks (scheduled ticks, whatever randomtickspeed says)',
  allow: 'education-edition block: BDS never breaks it in survival (restores it)',
  deny: 'education-edition block: BDS never breaks it in survival (restores it)',
  border_block: 'education-edition block: BDS never breaks it in survival (restores it)'
}

function diggableBlocks () {
  const registry = createRegistry('1.26.51')
  return Object.values(registry.blocks)
    .filter((b) => b.diggable && b.hardness !== null && b.hardness >= 0)
    .map((b) => b.name)
    .sort()
}

describe('digEverything', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  const skipped = []
  let pos

  let Block
  before(async function () {
    this.timeout(300000)
    const { bot, server } = ctx
    Block = require('prismarine-block')(bot.registry)
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.resetState()
    bot.creative.stopFlying() // resetState flies (gravity 0, like upstream's testCommon)
    await bot.test.becomeSurvival()
    await bot.test.teleport(new Vec3(0, bot.test.groundY, 0))
    pos = new Vec3(2, bot.test.groundY, 0)
    const who = bot.test.ctx.who()
    for (let i = 0; i < HOTBAR.length; i++) {
      const spec = HOTBAR[i]
      await bot.test.setInventorySlot(36 + i, new Item(bot.registry.itemsByName[spec.name].id, 1))
      if (!spec.efficiency) continue
      bot.setQuickBarSlot(i)
      await bot.waitForTicks(2)
      const out = await server.commandOutput(`enchant ${who} efficiency ${spec.efficiency}`)
      assert.ok(out.some((l) => /Enchanting succeeded/.test(l)), out.join(' | '))
      for (let t = 0; t < 40 && !bot.inventory.slots[36 + i]?.enchants?.length; t++) await bot.waitForTicks(1)
      assert.deepStrictEqual(bot.inventory.slots[36 + i].enchants, [{ name: 'efficiency', lvl: spec.efficiency }])
    }
    bot.setQuickBarSlot(HAND_SLOT)
  })

  afterEach(async function () {
    // leftovers of a failed dig (water from ice, a block that stayed) must not leak into the next block
    const { server } = ctx
    if (!pos) return
    await server.commandOutput(`fill ${pos.x - 1} ${pos.y} ${pos.z - 1} ${pos.x + 1} ${pos.y + 1} ${pos.z + 1} air`)
    await server.commandOutput('kill @e[type=item]')
  })

  after(function () {
    if (skipped.length) console.log(`digEverything: ${skipped.length} blocks skipped:\n${skipped.map(([n, r]) => `  ${n}: ${r}`).join('\n')}`)
  })

  /** the hotbar slot that digs `block` fastest (ties: the hand, then the lowest slot) */
  function bestSlot (bot, block) {
    let best = { slot: HAND_SLOT, time: Infinity }
    for (const slot of [HAND_SLOT, 0, 1, 2, 3, 4, 5]) {
      const item = bot.inventory.slots[36 + slot]
      const time = digSpeed.digTime(bot.registry, block, {
        heldItemType: item?.type ?? null,
        enchantments: item?.enchants ?? [],
        effects: bot.entity.effects
      })
      if (time < best.time) best = { slot, time }
    }
    return best.slot
  }

  for (const name of diggableBlocks()) {
    it(name, async function () {
      const { bot, server } = ctx
      if (EXCLUDED[name]) {
        skipped.push([name, EXCLUDED[name]])
        this.skip()
      }
      // stage the block (default state; attachments facing down get a second try on the floor, then on a wall)
      const stage = async (spec) => {
        await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: spec })
        await bot.waitForTicks(2)
        return bot.blockAt(pos)
      }
      let staged
      try {
        staged = await stage(name)
        const facing = 'facing_direction' in (bot.registry.blocksByName[name] ? Block.fromStateId(bot.registry.blocksByName[name].defaultState, 0).getProperties() : {})
        if (staged?.name !== name && facing) {
          await server.commandOutput(`setblock ${pos.x} ${pos.y} ${pos.z} air`)
          staged = await stage(`${name} ["facing_direction"=1]`)
          if (staged?.name !== name) {
            await server.commandOutput(`setblock ${pos.x + 1} ${pos.y} ${pos.z} stone`)
            await server.commandOutput(`setblock ${pos.x} ${pos.y} ${pos.z} air`)
            staged = await stage(`${name} ["facing_direction"=4]`)
          }
        }
      } catch (err) {
        skipped.push([name, `/setblock refused: ${err.message.split('\n')[0]}`])
        this.skip()
      }
      if (staged?.name !== name) {
        skipped.push([name, `does not stay after /setblock (now ${staged?.name})`])
        this.skip()
      }
      const slot = bestSlot(bot, staged)
      if (bot.quickBarSlot !== slot) {
        bot.setQuickBarSlot(slot)
        await bot.waitForTicks(1)
      }
      await bot.dig(staged)
      // make sure that block is gone
      const after = bot.blockAt(pos)
      assert.ok(after.type === 0 || LIQUIDS.has(after.name), `${name} → ${after.name}`)
      const last = bot._bedrock.digging.last
      if (process.env.BEDBOO_DIG_TRACE) console.log(JSON.stringify({ ...last, position: undefined, slot }))
      assert.strictEqual(last.restores, 0, 'BDS restored the block')
      if (last.serverSpeedData !== null) assert.strictEqual(last.serverSpeedData, last.speedData, `break speed (×65535) BDS ${last.serverSpeedData} vs ours ${last.speedData}`)
    })
  }
})
