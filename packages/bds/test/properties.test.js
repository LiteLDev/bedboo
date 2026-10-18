'use strict'
const assert = require('assert')
const properties = require('../lib/properties')
const profiles = require('../lib/profiles')

const ports = { v4: 41002, v6: 41003 }
const TEMPLATE = `# comment kept
server-name=Dedicated Server
gamemode=survival
online-mode=true
enable-lan-visibility=true
transport=nethernet
server-port=19132
server-portv6=19133
level-type=DEFAULT
player-idle-timeout=30
allow-list=false
`

describe('server.properties writer', () => {
  it('applies harness defaults, the enforced keys and the slot ports', () => {
    const v = properties.resolve({ ports })
    assert.strictEqual(v['enable-lan-visibility'], 'false')
    assert.strictEqual(v.transport, 'raknet')
    assert.strictEqual(v['online-mode'], 'false')
    assert.strictEqual(v['allow-list'], 'false')
    assert.strictEqual(v['player-idle-timeout'], '0')
    assert.strictEqual(v['server-port'], '41002')
    assert.strictEqual(v['server-portv6'], '41003')
    assert.strictEqual(v.gamemode, 'creative')
    assert.strictEqual(v.difficulty, 'peaceful')
    assert.strictEqual(v['level-type'], 'FLAT')
    assert.strictEqual(v['allow-cheats'], 'true')
    assert.strictEqual(v['default-player-permission-level'], 'operator')
  })

  it('maps options: gamemode, difficulty, world, seed, level name', () => {
    const v = properties.resolve({ ports, gamemode: 'survival', difficulty: 'hard', seed: 1234, levelName: 'w1' })
    assert.deepStrictEqual([v.gamemode, v.difficulty, v['level-type'], v['level-seed'], v['level-name']], ['survival', 'hard', 'DEFAULT', '1234', 'w1'])
    assert.strictEqual(properties.resolve({ ports, world: 'default' })['level-type'], 'DEFAULT')
    assert.strictEqual(properties.resolve({ ports, world: 'flat', seed: 'x' })['level-type'], 'FLAT')
    assert.throws(() => properties.resolve({ ports, gamemode: 'spectator' }), /Invalid gamemode/)
    assert.throws(() => properties.resolve({ ports, difficulty: 'insane' }), /Invalid difficulty/)
    assert.throws(() => properties.resolve({ ports, world: 'amplified' }), /Invalid world/)
    assert.throws(() => properties.resolve({ ports, levelName: '../evil' }), /Invalid level-name/)
  })

  it('accepts overrides but never for enforced keys or ports', () => {
    const v = properties.resolve({ ports, properties: { 'max-players': 3, 'allow-cheats': false, 'online-mode': 'false' } })
    assert.strictEqual(v['max-players'], '3')
    assert.strictEqual(v['allow-cheats'], 'false')
    for (const [key, value] of [['online-mode', true], ['enable-lan-visibility', 'true'], ['transport', 'nethernet'], ['allow-list', true], ['player-idle-timeout', 30]]) {
      assert.throws(() => properties.resolve({ ports, properties: { [key]: value } }), /enforced by the harness/, key)
    }
    assert.throws(() => properties.resolve({ ports, properties: { 'server-port': 19132 } }), /assigned from the slot/)
    assert.throws(() => properties.resolve({ ports, properties: { motd: 'a\nb' } }), /single line/)
    assert.throws(() => properties.resolve({ ports, properties: { motd: {} } }), /string, number or boolean/)
    assert.throws(() => properties.resolve({}), /ports are required/)
  })

  it('renders over the BDS template: comments kept, values replaced, missing keys appended', () => {
    const v = properties.resolve({ ports, properties: { 'custom-key': 'x' } })
    const text = properties.render(TEMPLATE, v)
    assert.ok(text.startsWith('# comment kept\n'))
    const obj = properties.toObject(text)
    assert.strictEqual(obj['online-mode'], 'false')
    assert.strictEqual(obj['enable-lan-visibility'], 'false')
    assert.strictEqual(obj.transport, 'raknet')
    assert.strictEqual(obj['server-port'], '41002')
    assert.strictEqual(obj['player-idle-timeout'], '0')
    assert.strictEqual(obj['custom-key'], 'x')
    assert.strictEqual(obj['level-name'], 'bedboo')
    // each key exactly once
    const keys = properties.parse(text).filter((l) => l.key).map((l) => l.key)
    assert.strictEqual(new Set(keys).size, keys.length)
    assert.ok(text.endsWith('\n'))
  })
})

describe('gamerule profiles', () => {
  it('deterministic profile + overrides', () => {
    const rules = profiles.resolveGamerules()
    assert.deepStrictEqual(rules, {
      domobspawning: false,
      dodaylightcycle: false,
      doweathercycle: false,
      randomtickspeed: 0,
      doinsomnia: false,
      dofiretick: false,
      mobgriefing: false,
      spawnradius: 0
    })
    assert.deepStrictEqual(profiles.resolveGamerules('none'), {})
    assert.strictEqual(profiles.resolveGamerules('deterministic', { doMobSpawning: true }).domobspawning, true)
    assert.throws(() => profiles.resolveGamerules('chaos'), /Unknown profile/)
    assert.throws(() => profiles.resolveGamerules('none', { 'x y': true }), /Invalid gamerule/)
    assert.throws(() => profiles.resolveGamerules('none', { a: 'yes' }), /boolean or an integer/)
  })

  it('gamerule commands and their expected BDS answers', () => {
    const [cmd] = profiles.gameruleCommands({ domobspawning: false })
    assert.strictEqual(cmd.command, 'gamerule domobspawning false')
    assert.ok(cmd.expect.test('Game rule domobspawning has been updated to false'))
    assert.ok(!cmd.expect.test('Game rule domobspawning has been updated to true'))
    assert.ok(cmd.failure.test('Syntax error: Unexpected "x": at "gamerule >>x<<"'))
  })
})
