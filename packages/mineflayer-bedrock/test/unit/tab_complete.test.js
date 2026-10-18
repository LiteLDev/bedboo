'use strict'
// owner: U6 (chat, commands & HUD) — bot.tabComplete: client-side completion from the recorded BDS 1.26.51.1
// available_commands (lib/bedrock/commands.js)
const assert = require('assert')
const fixtures = require('../fixtures')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { createCommandTree, tokenize } = require('../../lib/bedrock/commands')

const availableCommands = () => fixtures.load('join_flat').first('available_commands')
const names = (matches) => matches.map(m => m.match)

describe('tabComplete from available_commands (U6)', function () {
  this.timeout(30000)
  let tree
  before(() => {
    tree = createCommandTree()
    tree.update(availableCommands())
  })
  const players = ['U0Bot', 'Steve Builder']
  const complete = (s, opts) => tree.complete(s, { players, ...opts })

  it('upstream complete test shape: /weather → its arguments as [{ match, tooltip }] (Bedrock adds "query")', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    const matches = await bot.tabComplete('/weather ')
    assert.deepStrictEqual(matches, [
      { match: 'clear', tooltip: undefined },
      { match: 'query', tooltip: undefined },
      { match: 'rain', tooltip: undefined },
      { match: 'thunder', tooltip: undefined }
    ])
    assert.deepStrictEqual(await bot.tabComplete('/weather'), [{ match: 'weather', tooltip: undefined }])
    assert.deepStrictEqual(names(await bot.tabComplete('weather r', true)), ['rain'], 'assumeCommand')
    assert.deepStrictEqual(names(await bot.tabComplete('hello U0', false, false)), ['U0Bot'], 'chat: player names')
  })

  it('waits for available_commands (timeout like upstream), follows update_soft_enum', async () => {
    const { bot, client } = await createFakeBot()
    await assert.rejects(bot.tabComplete('/weather ', false, true, 30), /did not fire within timeout/)
    const pending = bot.tabComplete('/time set ', false, true, 1000)
    client.receive('available_commands', availableCommands())
    assert.deepStrictEqual(names(await pending), ['day', 'midnight', 'night', 'noon', 'sunrise', 'sunset'])
    client.receive('update_soft_enum', { enum_type: 'ScoreboardObjectives', options: ['kills', 'deaths'], action_type: 'add' })
    assert.deepStrictEqual(names(await bot.tabComplete('/scoreboard objectives remove ')), ['deaths', 'kills'])
    client.receive('update_soft_enum', { enum_type: 'ScoreboardObjectives', options: ['kills'], action_type: 'remove' })
    assert.deepStrictEqual(names(await bot.tabComplete('/scoreboard objectives remove ')), ['deaths'])
    assert.strictEqual(bot._bedrock.commands.tree.ready, true)
  })

  it('command names and aliases by prefix, sorted; "/" lists every command', () => {
    assert.deepStrictEqual(complete('/ti'), ['tickingarea', 'time', 'title', 'titleraw'])
    assert.deepStrictEqual(complete('/tp'), ['tp'])
    assert.deepStrictEqual(complete('/MSG'), ['msg'])
    const all = complete('/')
    assert.ok(all.length > 80 && all.includes('weather') && all.includes('teleport') && all.includes('tp'))
    assert.deepStrictEqual(all, [...all].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())))
  })

  it('arguments: enums, enum indices bedrock-protocol renamed, targets (players + selectors), coordinates', () => {
    assert.deepStrictEqual(complete('/gamemode c'), ['c', 'creative'])
    assert.deepStrictEqual(complete('/difficulty p'), ['p', 'peaceful'], 'enum index 71 arrives as "block_states"')
    assert.deepStrictEqual(complete('/gamemode creative '), ['"Steve Builder"', '@a', '@e', '@initiator', '@p', '@r', '@s', 'U0Bot'])
    assert.deepStrictEqual(complete('/kill @'), ['@a', '@e', '@initiator', '@p', '@r', '@s'])
    assert.deepStrictEqual(complete('/summon pi'), ['pig', 'piglin', 'piglin_brute', 'pillager'])
    assert.deepStrictEqual(complete('/setblock '), ['~', '~ ~', '~ ~ ~'])
    assert.deepStrictEqual(complete('/setblock ~ ~ '), ['~'])
    assert.deepStrictEqual(complete('/time set noon '), [], 'nothing after the last parameter')
    assert.deepStrictEqual(complete('/time nonsense '), [], 'an unknown enum value rules the overloads out')
    assert.deepStrictEqual(complete('/say hello '), [], 'free text')
    assert.deepStrictEqual(complete('/nosuchcommand '), [])
  })

  it('execute: chained subcommands and "run <command>" recurse', () => {
    assert.ok(complete('/execute ').includes('as') && complete('/execute ').includes('run'))
    assert.ok(complete('/execute as @a at @s ').includes('positioned'))
    assert.deepStrictEqual(complete('/execute as @a at @s run weather '), ['clear', 'query', 'rain', 'thunder'])
    assert.deepStrictEqual(complete('/execute as @a run ti'), ['tickingarea', 'time', 'title', 'titleraw'])
  })

  it('tokenizer keeps selectors, quoted names, JSON and block states together', () => {
    assert.deepStrictEqual(tokenize('tp @e[type=pig, c=1] "Steve Builder" '), { words: ['tp', '@e[type=pig, c=1]', '"Steve Builder"'], partial: '' })
    assert.deepStrictEqual(tokenize('tellraw @a {"rawtext":[{"text":"a b"}]} x'), { words: ['tellraw', '@a', '{"rawtext":[{"text":"a b"}]}'], partial: 'x' })
    assert.deepStrictEqual(tokenize('weather'), { words: [], partial: 'weather' })
  })
})
