// owner: W3-FIX-B (wave-3 fix-ups: inventory, entities, chat, world)
'use strict'
/**
 * Bedrock extra (W3-FIX-B), against a real BDS 1.26.51.1: the liquid layer (waterlogging) of blocks that replace a
 * water source or a waterlogged block. BDS sends only the layer-0 change; the bot applies Bedrock's liquid-layer rule
 * (and asks the server for the sub-chunk when the rule is not certain). The watching bot's view is compared with a
 * bot that joins afterwards and reads the sub-chunks fresh.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot, createTestBot } = require('./common')

describe('coreWorld › liquid layer: waterlogging follows layer-0 block updates (W3-FIX-B)', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })

  const view = (bot, p) => {
    const b = bot.blockAt(p)
    return `${b?.name}${b?.superimposed ? '+' + b.superimposed.name : ''}${b?.isWaterlogged ? ' (wl)' : ''}`
  }

  it('water → fence / ladder / carpet is waterlogged, waterlogged → stone / air / water is not, like a fresh join sees it', async () => {
    const { bot } = env
    const Y = bot.test.groundY
    const cases = [
      ['water', 'oak_fence'],
      ['water', 'ladder'],
      ['water', 'stone'],
      ['water', 'oak_fence', 'stone'],
      ['water', 'oak_fence', 'air'],
      ['water', 'oak_fence', 'oak_slab'],
      ['water', 'oak_fence', 'white_carpet'],
      ['water ["liquid_depth"=1]', 'oak_fence'],
      ['water', 'oak_fence', 'water'],
      ['water', 'oak_fence', 'glass'],
      ['lava', 'oak_fence']
    ]
    const positions = cases.map((_, i) => new Vec3(4 + (i % 4) * 3, Y, 4 + Math.floor(i / 4) * 3))
    // a glass ring around each spot keeps the water from flowing
    for (const p of positions) await env.server.commandOutput(`fill ${p.x - 1} ${Y} ${p.z - 1} ${p.x + 1} ${Y} ${p.z + 1} glass`)
    const sawWaterloggedFence = new Promise(resolve => bot.on('blockUpdate', (o, n) => { if (n?.name === 'oak_fence' && n.isWaterlogged && n.position.equals(positions[0])) resolve() }))
    for (let i = 0; i < cases.length; i++) {
      for (const step of cases[i]) {
        await bot.test.setBlock({ x: positions[i].x, y: Y, z: positions[i].z, blockName: step })
      }
    }
    await sawWaterloggedFence
    await bot.test.wait(1000) // the sub-chunk answers
    const fresh = await createTestBot({ server: env.server, username: `w3fb${process.pid % 1000}` })
    try {
      await fresh.bot.waitForChunksToLoad()
      const watcher = positions.map(p => view(bot, p))
      const truth = positions.map(p => view(fresh.bot, p))
      assert.deepStrictEqual(watcher, truth)
      assert.deepStrictEqual(truth, [
        'oak_fence+water (wl)', 'ladder+water (wl)', 'stone', 'stone', 'water', 'oak_slab+water (wl)',
        'white_carpet+water (wl)', 'oak_fence', 'water', 'glass', 'oak_fence'
      ])
    } finally {
      fresh.bot.end('done')
    }
  })
})
