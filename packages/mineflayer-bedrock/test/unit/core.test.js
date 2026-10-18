'use strict'
// owner: U4 (core runtime) — client options, module exports, registry wiring from the recorded join
const assert = require('assert')
const mineflayerBedrock = require('../..')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { offlineFromAuth } = require('../../lib/client')
const { normalizeFormat } = require('../../lib/registry')

describe('core runtime: client, exports, registry (U4)', function () {
  this.timeout(30000)

  it('createClient maps mineflayer options onto bedrock-protocol (auth, defaults, mineflayer-only options dropped)', () => {
    const bedrock = require('bedrock-protocol')
    const original = bedrock.createClient
    const calls = []
    bedrock.createClient = (opts) => { calls.push(opts); return opts }
    try {
      const { createClient } = require('../../lib/client')
      const offline = createClient({ username: 'a', viewDistance: 'far', plugins: {}, auth: 'offline' })
      assert.strictEqual(offline.offline, true)
      assert.strictEqual(offline.host, '127.0.0.1')
      assert.strictEqual(offline.port, 19132)
      assert.strictEqual(offline.version, '1.26.51')
      assert.strictEqual(offline.skipPing, true)
      assert.strictEqual(offline.transport, 'raknet')
      assert.strictEqual(offline.conLog, null)
      for (const key of ['viewDistance', 'plugins', 'auth']) assert.ok(!(key in offline), key)
      const onMsaCode = () => {}
      const online = createClient({ username: 'b', auth: 'microsoft', profilesFolder: '/tmp/x', onMsaCode, host: 'example.org', port: '19133', version: false })
      assert.strictEqual(online.offline, false)
      assert.strictEqual(online.profilesFolder, '/tmp/x')
      assert.strictEqual(online.onMsaCode, onMsaCode)
      assert.strictEqual(online.port, 19133)
      assert.strictEqual(online.version, '1.26.51')
      assert.strictEqual(createClient({ username: 'c' }).offline, true, 'offline by default')
      assert.strictEqual(createClient({ username: 'd', auth: 'microsoft', offline: true }).offline, true, 'explicit offline wins')
    } finally {
      bedrock.createClient = original
    }
    assert.throws(() => offlineFromAuth('mojang'), /does not exist on Bedrock/)
    assert.throws(() => offlineFromAuth('something'), /unsupported auth/)
  })

  it('module exports: versions, supportFeature(feature, version) without a registry per call, classes', () => {
    assert.strictEqual(mineflayerBedrock.latestSupportedVersion, '1.26.51')
    assert.strictEqual(mineflayerBedrock.oldestSupportedVersion, '1.26.51')
    assert.deepStrictEqual(mineflayerBedrock.testedVersions, ['1.26.51'])
    assert.strictEqual(mineflayerBedrock.supportFeature('itemRegistryPacket'), true)
    assert.strictEqual(mineflayerBedrock.supportFeature('blockHashes', '1.26.51'), true)
    assert.strictEqual(mineflayerBedrock.supportFeature('blockHashes', 'bedrock_1.26.51'), true)
    assert.strictEqual(mineflayerBedrock.supportFeature('tallWorld', '1.26.51'), true)
    const t0 = Date.now()
    for (let i = 0; i < 2000; i++) mineflayerBedrock.supportFeature('tallWorld', '1.26.51')
    assert.ok(Date.now() - t0 < 200, 'no registry is built per call')
    assert.strictEqual(mineflayerBedrock.supportFeature('blockStateId', '1.8'), false, 'other versions: minecraft-data like upstream')
    for (const cls of ['Location', 'Painting', 'ScoreBoard', 'BossBar']) {
      assert.strictEqual(mineflayerBedrock[cls], require('mineflayer')[cls], cls)
    }
    // U6: Particle is adapted to Bedrock packets; same loader shape, subclass of upstream's class
    const { Vec3 } = require('vec3')
    const Particle = mineflayerBedrock.Particle(require('../../lib/registry').createRegistry())
    const particle = new Particle('heart', new Vec3(1, 2, 3), new Vec3(0, 0, 0))
    assert.deepStrictEqual([particle.id, particle.name, particle.count, particle.movementSpeed], [19, 'heart', 1, 0], 'Particle')
    assert.strictEqual(Object.getPrototypeOf(Particle).name, 'Particle', 'extends mineflayer\'s Particle')
  })

  it('bot.version / majorVersion / protocolVersion / supportFeature', async () => {
    const { bot } = await createFakeBot()
    assert.strictEqual(bot.version, '1.26.51')
    assert.strictEqual(bot.majorVersion, '1.26')
    assert.strictEqual(bot.protocolVersion, 2193)
    assert.strictEqual(bot.supportFeature('blockHashes'), true)
    assert.strictEqual(bot.registry.type, 'bedrock')
  })

  it('registry from start_game + item_registry (before any plugin listener), normalized Bedrock language formats', async () => {
    const { bot, client } = await createFakeBot()
    assert.strictEqual(bot._bedrock.startGame, null)
    await replayJoin(bot, client)
    assert.strictEqual(bot._bedrock.startGame.runtime_entity_id, 91n)
    const grass = bot.registry.blocksByName.grass_block.defaultState
    const runtimeId = bot.registry.runtimeIdByStateId[grass]
    assert.strictEqual(bot.registry.blocksByRuntimeId[runtimeId].stateId, grass)
    assert.strictEqual(bot.registry.itemsByName.diamond_pickaxe.id, bot._bedrock.ids.itemNetworkId('diamond_pickaxe'))
    assert.strictEqual(bot.registry.language['commands.time.set'], 'Set the time to %1$s')
    assert.strictEqual(normalizeFormat('%d%% of %1$d %.2f %2 %s %%'), '%s%% of %1$s %s %2$s %s %%')
    assert.strictEqual(normalizeFormat('no format'), 'no format')
  })
})
