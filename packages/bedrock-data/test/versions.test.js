'use strict'
const { describe, it } = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const data = require('..')
const sources = require('../scripts/sources')
const tables = require('../scripts/tables')

data.install()

describe('@bedboo/bedrock-data per-version features', () => {
  it('featuresFor(1.26.51) is the default table', () => {
    assert.strictEqual(data.featuresFor('1.26.51'), data.features)
    assert.strictEqual(data.featuresFor('bedrock_1.26.51'), data.features)
    assert.strictEqual(data.bedrockFeaturesFor('1.26.51'), data.bedrockFeatures)
    assert.strictEqual(data.FEATURES, data.features)
  })

  it('throws for a version without data', () => {
    assert.throws(() => data.featuresFor('1.2.3'), /no data for Bedrock 1\.2\.3/)
    assert.throws(() => data.bedrockFeaturesFor('bedrock_1.26.30'), /no data for Bedrock bedrock_1\.26\.30/)
  })

  for (const version of data.versions) {
    describe(version, () => {
      it('has a frozen table with every base feature name', () => {
        const table = data.featuresFor(version)
        assert.ok(Object.isFrozen(table))
        assert.deepStrictEqual(Object.keys(table).sort(), Object.keys(data.features).sort())
      })

      it('agrees with minecraft-data on every Bedrock feature it does not override', () => {
        const mcData = require('minecraft-data')('bedrock_' + version)
        const file = path.join(__dirname, '..', 'data', version, 'features.js')
        const overrides = fs.existsSync(file) ? require(file) : {}
        const names = require('minecraft-data/minecraft-data/data/bedrock/common/features.json').map(f => f.name)
        for (const name of names) {
          if (Object.hasOwn(overrides, name)) {
            assert.deepStrictEqual(data.bedrockFeaturesFor(version)[name], overrides[name], name)
            continue
          }
          assert.deepStrictEqual(data.bedrockFeaturesFor(version)[name], mcData.supportFeature(name), name)
          assert.deepStrictEqual(data.featuresFor(version)[name], mcData.supportFeature(name), name)
        }
      })

      it('optionalsHavePresenceFlag matches the player_auth_input layout of its minecraft-data protocol', () => {
        const fields = require('minecraft-data')('bedrock_' + version).protocol.types.packet_player_auth_input[1].map(f => f.name)
        assert.strictEqual(data.featuresFor(version).optionalsHavePresenceFlag, fields.includes('transaction_presence'))
      })
    })
  }
})

describe('@bedboo/bedrock-data generator inputs', () => {
  it('every data version has pinned sources and a live probe', () => {
    for (const version of data.versions) {
      assert.ok(sources.VERSIONS.includes(version), `scripts/sources.js pins ${version}`)
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'probe', version + '.json')), `scripts/probe/${version}.json`)
    }
  })

  it('the lock has a sha256 for every pinned source of every version', () => {
    const lock = require('../scripts/sources.lock.json')
    for (const version of sources.VERSIONS) {
      assert.deepStrictEqual(Object.keys(lock[version] ?? {}).sort(), Object.keys(sources.sourcesFor(version)).sort(), version)
      for (const sha of Object.values(lock[version])) assert.match(sha, /^[0-9a-f]{64}$/)
    }
  })

  it('sourcesFor(default) is SOURCES and source paths are keyed by commit', () => {
    assert.strictEqual(sources.sourcesFor(), sources.SOURCES)
    assert.strictEqual(sources.sourcesFor(sources.DEFAULT_VERSION), sources.SOURCES)
    const s = sources.SOURCES['cloudburst/blocks.json']
    assert.ok(sources.sourcePath('cloudburst/blocks.json').includes(s.sha.slice(0, 12)))
    assert.strictEqual(s.url, `https://raw.githubusercontent.com/${s.repo}/${s.sha}/blocks.json`)
    assert.throws(() => sources.sourcesFor('1.2.3'), /no pinned sources for data version 1\.2\.3/)
  })

  it('parses --version / --all', () => {
    const argv = (...a) => ['node', 'script', ...a]
    assert.deepStrictEqual(sources.versionsFromArgv(argv()), ['1.26.51'])
    assert.deepStrictEqual(sources.versionsFromArgv(argv('--check', '--version', '1.26.51')), ['1.26.51'])
    assert.deepStrictEqual(sources.versionsFromArgv(argv('--version', '1.26.51', '--version', '1.26.51')), ['1.26.51'])
    assert.deepStrictEqual(sources.versionsFromArgv(argv('--all')), sources.VERSIONS)
    assert.deepStrictEqual(sources.versionsFromArgv(argv('--version', 'all')), sources.VERSIONS)
    assert.throws(() => sources.versionsFromArgv(argv('--version')), /needs a value/)
    assert.throws(() => sources.versionsFromArgv(argv('--version', '1.2.3')), /no pinned sources/)
    assert.strictEqual(sources.versionFromArgv(argv('--port', '1', '--version', '1.26.51')), '1.26.51')
  })

  it('tables.forVersion starts from the base tables', () => {
    for (const version of sources.VERSIONS) {
      const t = tables.forVersion(version)
      for (const name of ['EFFECTS', 'BIOME_IDS_ADDED', 'ENTITY_SIZES']) assert.ok(t[name], `${version} ${name}`)
    }
    assert.strictEqual(tables.forVersion('1.26.51').EFFECTS, tables.EFFECTS)
  })
})
