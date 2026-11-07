'use strict'
// client options, module exports, registry wiring from the recorded join
const { describe, it } = require('node:test')
const assert = require('assert')
const bedboo = require('../..')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { offlineFromAuth } = require('../../lib/client')
const { normalizeFormat } = require('../../lib/registry')
const { FAMILIES, resolveVersion, protocolFor, findFamily } = require('../../lib/bedrock/versions')
const { VERSION, PROTOCOL_VERSION, BDS_VERSION } = require('../../lib/bedrock/constants')

describe('core runtime: client, exports, registry', () => {
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
      assert.strictEqual(createClient({ username: 'e', version: '1.26.52.3' }).version, '1.26.51', 'a BDS build → its family')
      assert.strictEqual(createClient({ username: 'e', version: 'bedrock_1.26.60' }).version, '1.26.60')
      assert.strictEqual(createClient({ username: 'e', version: '1.21.50' }).version, '1.21.50', 'other versions: bedrock-protocol decides')
      assert.strictEqual(createClient({ username: 'd', auth: 'microsoft', offline: true }).offline, true, 'explicit offline wins')
    } finally {
      bedrock.createClient = original
    }
    assert.throws(() => offlineFromAuth('mojang'), /does not exist on Bedrock/)
    assert.throws(() => offlineFromAuth('something'), /unsupported auth/)
  })

  it('module exports: versions, supportFeature(feature, version) without a registry per call, classes', () => {
    assert.strictEqual(bedboo.latestSupportedVersion, '1.26.51')
    assert.strictEqual(bedboo.oldestSupportedVersion, '1.26.51')
    assert.deepStrictEqual(bedboo.testedVersions, ['1.26.51'])
    assert.strictEqual(bedboo.supportFeature('itemRegistryPacket'), true)
    assert.strictEqual(bedboo.supportFeature('blockHashes', '1.26.51'), true)
    assert.strictEqual(bedboo.supportFeature('blockHashes', 'bedrock_1.26.51'), true)
    assert.strictEqual(bedboo.supportFeature('tallWorld', '1.26.51'), true)
    const t0 = Date.now()
    for (let i = 0; i < 2000; i++) bedboo.supportFeature('tallWorld', '1.26.51')
    assert.ok(Date.now() - t0 < 200, 'no registry is built per call')
    assert.strictEqual(bedboo.supportFeature('blockStateId', '1.8'), false, 'other versions: minecraft-data like upstream')
    for (const cls of ['Location', 'Painting', 'ScoreBoard', 'BossBar']) {
      assert.strictEqual(bedboo[cls], require('mineflayer')[cls], cls)
    }
    // Particle is adapted to Bedrock packets; same loader shape, subclass of upstream's class
    const { Vec3 } = require('vec3')
    const Particle = bedboo.Particle(require('../../lib/registry').createRegistry())
    const particle = new Particle('heart', new Vec3(1, 2, 3), new Vec3(0, 0, 0))
    assert.deepStrictEqual([particle.id, particle.name, particle.count, particle.movementSpeed], [19, 'heart', 1, 0], 'Particle')
    assert.strictEqual(Object.getPrototypeOf(Particle).name, 'Particle', 'extends mineflayer\'s Particle')
  })

  it('versions: every stable BDS family, resolveVersion (family / build / bedrock_ key), protocolFor', () => {
    assert.deepStrictEqual(FAMILIES.map(f => [f.version, f.protocol]), [['1.26.40', 2168], ['1.26.45', 2169], ['1.26.51', 2193], ['1.26.60', 2225]])
    assert.deepStrictEqual(FAMILIES.flatMap(f => f.bds), ['1.26.42.1', '1.26.43.1', '1.26.44.3', '1.26.45.1', '1.26.50.5', '1.26.51.1', '1.26.52.3', '1.26.60.6', '1.26.61.1', '1.26.62.1', '1.26.63.1'])
    assert.strictEqual(resolveVersion('1.26.51'), '1.26.51')
    assert.strictEqual(resolveVersion('1.26.52.3'), '1.26.51')
    assert.strictEqual(resolveVersion('1.26.50.5'), '1.26.51')
    assert.strictEqual(resolveVersion('1.26.62.1'), '1.26.60')
    assert.strictEqual(resolveVersion('1.26.44.3'), '1.26.40')
    assert.strictEqual(resolveVersion('bedrock_1.26.45'), '1.26.45')
    assert.strictEqual(resolveVersion('bedrock_1.26.45.1'), '1.26.45')
    assert.strictEqual(protocolFor('1.26.60'), 2225)
    assert.strictEqual(protocolFor('1.26.43.1'), 2168)
    assert.strictEqual(findFamily('1.21.50'), null)
    for (const bad of ['1.21.50', '1.26.53.1', '', undefined, 2193]) {
      assert.throws(() => resolveVersion(bad), (err) => err.code === 'ERR_BEDBOO_VERSION' && /1\.26\.51 \(BDS 1\.26\.50\.5, 1\.26\.51\.1, 1\.26\.52\.3\)/.test(err.message), String(bad))
    }
    // the 1.26.51 defaults stay
    assert.deepStrictEqual([VERSION, PROTOCOL_VERSION, BDS_VERSION], ['1.26.51', 2193, '1.26.51.1'])
    assert.strictEqual(protocolFor(VERSION), PROTOCOL_VERSION)
    assert.strictEqual(resolveVersion(BDS_VERSION), VERSION)
  })

  it('testedVersions: families with @bedboo/bedrock-data data; createBot accepts a build, rejects untested families', async () => {
    const { versions } = require('@bedboo/bedrock-data')
    assert.deepStrictEqual(bedboo.testedVersions, FAMILIES.map(f => f.version).filter(v => versions.includes(v)))
    assert.ok(bedboo.testedVersions.includes(VERSION))
    for (const version of ['1.26.51.1', '1.26.52.3', 'bedrock_1.26.51']) {
      const { bot } = await createFakeBot({ version })
      assert.strictEqual(bot.version, '1.26.51', version)
      assert.strictEqual(bot.protocolVersion, 2193, version)
      assert.strictEqual(bedboo.supportFeature('blockHashes', version), true, version)
    }
    const untested = FAMILIES.find(f => !bedboo.testedVersions.includes(f.version))
    if (untested) {
      for (const version of [untested.version, untested.bds[0]]) {
        assert.throws(() => bedboo.createBot({ client: new (require('events'))(), version }),
          (err) => err.code === 'ERR_BEDBOO_VERSION' && err.message.includes(`${untested.version} (protocol ${untested.protocol}) is known but not tested yet`) &&
            err.message.includes('Supported versions: 1.26.51 (BDS'), version)
      }
    }
    // known but untested: answered by minecraft-data's bedrock_<family>, not looked up as a Java version
    for (const version of ['1.26.60', '1.26.62.1', '1.26.45']) assert.strictEqual(typeof bedboo.supportFeature('blockHashes', version), 'boolean', version)
    assert.throws(() => bedboo.createBot({ client: new (require('events'))(), version: '1.21.50' }), /Bedrock version '1\.21\.50' is not supported\. Supported versions: /)
  })

  it('supportFeature reads the feature table of the registry / requested version', () => {
    const { createSupportFeature, featureTable, FEATURES } = require('../../lib/bedrock/features')
    const { featuresFor } = require('@bedboo/bedrock-data')
    assert.strictEqual(featureTable('1.26.51'), featuresFor('1.26.51'))
    assert.strictEqual(featureTable('bedrock_1.26.51'), featuresFor('1.26.51'))
    assert.strictEqual(featureTable('1.26.52.3'), featuresFor('1.26.51'), 'a BDS build → its family')
    assert.strictEqual(featureTable('9.9.9'), FEATURES, 'a version without data: the default table')
    assert.strictEqual(featureTable(undefined), FEATURES)
    // a table that differs from the default: the registry's version picks it (no other version's table leaks)
    const bedrockData = require('@bedboo/bedrock-data')
    const original = bedrockData.featuresFor
    bedrockData.featuresFor = (v) => v === '1.26.51' ? { ...FEATURES, tallWorld: 'from-1.26.51' } : original(v)
    try {
      assert.strictEqual(createSupportFeature({ version: { minecraftVersion: '1.26.51' } })('tallWorld'), 'from-1.26.51')
      assert.strictEqual(createSupportFeature(null, { version: '1.26.51' })('tallWorld'), 'from-1.26.51')
      assert.strictEqual(createSupportFeature(null)('tallWorld'), FEATURES.tallWorld)
    } finally {
      bedrockData.featuresFor = original
    }
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
