'use strict'
// owner: U6 (chat, commands & HUD) — title, boss_bar, scoreboard, sound, particle, team plugins on packets shaped
// exactly like BDS 1.26.51.1 sent them (U0 capture + the U6 probes recorded in docs/differences/U6.md)
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin, afterSpawnRecords } = require('./helpers/fake')

async function joined () {
  const created = await createFakeBot()
  await replayJoin(created.bot, created.client)
  return created
}
function record (bot, event) {
  const calls = []
  bot.on(event, (...args) => calls.push(args))
  return calls
}
const setTitle = (type, text = '', times = [-1, -1, -1]) => ({ type, text, fade_in_time: times[0], stay_time: times[1], fade_out_time: times[2], xuid: '', platform_online_id: '', filtered_message: '' })
const bossEvent = (id, fields) => ({ target_entity_id: BigInt(id), type: 'show_bar', title: '', filtered_title: '', progress: 1, color: 'pink', overlay: 'progress', ...fields })

describe('HUD plugins: title, boss bars, scoreboards, sounds, particles, teams (U6)', function () {
  this.timeout(30000)

  it('title: set_title / set_subtitle (upstream parseTitle), *_json rawtext, set_durations, clear / reset', async () => {
    const { bot, client } = await joined()
    const titles = record(bot, 'title')
    const times = record(bot, 'title_times')
    const clears = record(bot, 'title_clear')
    client.receive('set_title', setTitle('set_title', '{"text":"Test Title"}')) // `/title @a title {"text":"Test Title"}`
    client.receive('set_title', setTitle('set_subtitle', '{"text":"Test Subtitle"}'))
    client.receive('set_title', setTitle('set_title', 'plain §aTitle'))
    client.receive('set_title', setTitle('set_title_json', '{"rawtext":[{"text":"Raw §aTitle"}]}\n'))
    client.receive('set_title', setTitle('set_subtitle_json', '{"rawtext":[{"translate":"entity.wither.name"}]}\n'))
    client.receive('set_title', setTitle('set_durations', '', [10, 20, 30]))
    client.receive('set_title', setTitle('clear'))
    client.receive('set_title', setTitle('reset'))
    client.receive('set_title', setTitle('action_bar_message', 'bar'))
    assert.deepStrictEqual(titles, [['Test Title', 'title'], ['Test Subtitle', 'subtitle'], ['plain §aTitle', 'title'], ['Raw Title', 'title'], ['Wither', 'subtitle']])
    assert.deepStrictEqual(times, [[10, 20, 30]])
    assert.strictEqual(clears.length, 2)
    // the recorded `title @a title Hello` of the capture
    const recorded = afterSpawnRecords().find(r => r.name === 'set_title').params
    client.receive('set_title', recorded)
    assert.deepStrictEqual(titles.at(-1), ['Hello', 'title'])
  })

  it('boss bars: show_bar creates then updates, remove_entity / hide_bar / dimension change delete; Bedrock colours, overlay → dividers', async () => {
    const { bot, client } = await joined()
    const created = record(bot, 'bossBarCreated')
    const updated = record(bot, 'bossBarUpdated')
    const deleted = record(bot, 'bossBarDeleted')
    const wither = -4294967290n
    client.receive('boss_event', bossEvent(wither, { title: 'Test Boss Bar', progress: 0.023333333432674408, color: 'rebecca_purple' }))
    assert.strictEqual(created.length, 1)
    const [bar] = created[0]
    assert.deepStrictEqual([bar.title.toString(), bar.health, bar.color, bar.dividers, bar.entityUUID], ['Test Boss Bar', 0.023333333432674408, 'rebecca_purple', 0, '-4294967290'])
    assert.strictEqual(bar.title.constructor.name, 'ChatMessage')
    client.receive('boss_event', bossEvent(wither, { title: 'Test Boss Bar', progress: 0.16333332657814026, color: 'rebecca_purple' }))
    assert.deepStrictEqual([updated.length, updated[0][0], bar.health], [1, bar, 0.16333332657814026])
    client.receive('boss_event', bossEvent(wither, { title: 'Test Boss Bar', progress: 0.16333332657814026, color: 'rebecca_purple' }))
    assert.strictEqual(updated.length, 1, 'the once-a-second show_bar repeat without a change is not an update')
    client.receive('boss_event', bossEvent(wither, { type: 'update_properties', color: 'blue', overlay: 'notched_10' }))
    assert.deepStrictEqual([bar.color, bar.dividers, updated.length], ['blue', 10, 2])
    client.receive('boss_event', bossEvent(wither, { type: 'set_bar_progress', progress: 0.5 }))
    client.receive('boss_event', bossEvent(wither, { type: 'set_bar_title', title: 'renamed' }))
    assert.deepStrictEqual([bar.health, bar.title.toString(), updated.length], [0.5, 'renamed', 4])
    // an unnamed boss: the title is a translation key
    client.receive('boss_event', bossEvent(-4294967274n, { title: 'entity.ender_dragon.name', color: 'purple' }))
    assert.deepStrictEqual(bot.bossBars.map(b => [b.title.toString(), b.color]), [['renamed', 'blue'], ['Ender Dragon', 'purple']])
    // no hide_bar when a boss dies or leaves the view: remove_entity deletes the bar
    client.receive('remove_entity', { entity_id_self: wither })
    assert.deepStrictEqual([deleted.length, deleted[0][0], bot.bossBars.length], [1, bar, 1])
    client.receive('boss_event', bossEvent(-4294967274n, { type: 'hide_bar' }))
    assert.deepStrictEqual([deleted.length, bot.bossBars.length], [2, 0])
    client.receive('boss_event', bossEvent(5n, { title: 'x' }))
    bot._bedrock.lifecycle.events.emit('dimensionChange', { dimension: 1 })
    assert.deepStrictEqual([deleted.length, bot.bossBars.length], [3, 0])
    client.receive('boss_event', bossEvent(99n, { type: 'set_bar_progress', progress: 0.1 }))
    assert.strictEqual(updated.length, 4, 'updates of unknown bars are ignored')
  })

  it('scoreboards: the BDS sequence of /scoreboard objectives add / setdisplay / players add|set|reset / remove', async () => {
    const { bot, client } = await joined()
    const ev = {}
    for (const name of ['scoreboardCreated', 'scoreboardDeleted', 'scoreboardTitleChanged', 'scoreUpdated', 'scoreRemoved', 'scoreboardPosition']) ev[name] = record(bot, name)
    const self = bot._bedrock.ids.selfUniqueId()
    const display = (slot, name, displayName = name) => client.receive('set_display_objective', { display_slot: slot, objective_name: name, display_name: displayName, criteria_name: name ? 'dummy' : '', sort_order: name ? 1 : 0 })
    const score = (entries) => client.receive('set_score', { entries })
    const player = (id, objective, value) => ({ entry_type: 'player', entry_type_name: 'changeplayer', scoreboard_id: BigInt(id), objective_name: objective, score: value, entity_unique_id: self })
    const remove = (id, objective) => ({ entry_type: 'remove', entry_type_name: 'remove', scoreboard_id: BigInt(id), objective_name: objective })

    display('sidebar', 'test1')
    score([player(1, 'test1', 5)])
    display('belowname', 'test1')
    display('list', 'test2', 'Test Two')
    score([player(1, 'test2', 3)])
    score([{ entry_type: 'fake_player', entry_type_name: 'changefakeplayer', scoreboard_id: 2n, objective_name: 'test2', score: 7, custom_name: 'fakeguy' }])
    score([player(1, 'test1', 9)])

    const { test1, test2 } = bot.scoreboards
    assert.deepStrictEqual(ev.scoreboardCreated.map(([sb]) => sb.name), ['test1', 'test2'])
    assert.deepStrictEqual([test1.title, test2.title, test2.name], ['test1', 'Test Two', 'test2'])
    assert.deepStrictEqual(ev.scoreboardPosition.map(([position, sb, previous]) => [position, sb.name, previous?.name]), [[1, 'test1', undefined], [2, 'test1', undefined], [0, 'test2', undefined]])
    assert.strictEqual(bot.scoreboard.sidebar, test1)
    assert.strictEqual(bot.scoreboard.belowName, test1)
    assert.strictEqual(bot.scoreboard.list, test2)
    assert.strictEqual(test1.itemsMap.U0Bot.value, 9)
    assert.deepStrictEqual(test2.items.map(i => [i.name, i.value]), [['fakeguy', 7], ['U0Bot', 3]])
    assert.strictEqual(test2.items[0].displayName.toString(), 'fakeguy', 'no teams: displayName is the name')
    const [sb, item] = ev.scoreUpdated.at(-1)
    assert.deepStrictEqual([sb, item, item.value], [test1, test1.itemsMap.U0Bot, 9])

    display('sidebar', 'test1', 'Renamed')
    assert.deepStrictEqual(ev.scoreboardTitleChanged.map(([s]) => s.title), ['Renamed'])
    display('sidebar', 'test1', 'Renamed')
    assert.strictEqual(ev.scoreboardTitleChanged.length, 1)

    score([remove(1, 'test1')]) // /scoreboard players reset U0Bot test1
    score([remove(2, 'test2')]) // /scoreboard players reset fakeguy
    assert.deepStrictEqual(ev.scoreRemoved.map(([s, i]) => [s.name, i.name, i.value]), [['test1', 'U0Bot', 9], ['test2', 'fakeguy', 7]])
    display('sidebar', '') // /scoreboard objectives setdisplay sidebar
    assert.strictEqual(bot.scoreboard.sidebar, undefined)
    score([remove(1, 'test2')])
    client.receive('remove_objective', { objective_name: 'test2' })
    client.receive('remove_objective', { objective_name: 'test1' })
    assert.deepStrictEqual(ev.scoreboardDeleted.map(([s]) => s.name), ['test2', 'test1'])
    assert.deepStrictEqual([Object.keys(bot.scoreboards), bot.scoreboard.list, bot.scoreboard.belowName], [[], undefined, undefined])
  })

  it('scoreboards: plain display names (even JSON-looking ones), player names from player_list, ascending sort order', async () => {
    const { bot, client } = await joined()
    const titles = record(bot, 'scoreboardTitleChanged')
    client.receive('set_display_objective', { display_slot: 'sidebar', objective_name: 'season', display_name: '2024', criteria_name: 'dummy', sort_order: 0 })
    client.receive('set_display_objective', { display_slot: 'list', objective_name: 'quoted', display_name: '"hi"', criteria_name: 'dummy', sort_order: 1 })
    const { season, quoted } = bot.scoreboards
    assert.deepStrictEqual([season.title, quoted.title], ['2024', '"hi"'])
    client.receive('set_display_objective', { display_slot: 'belowname', objective_name: 'season', display_name: '2024', criteria_name: 'dummy', sort_order: 0 })
    assert.strictEqual(titles.length, 0, 'same name: no title change')
    // another player's score: the name comes from player_list (and is forgotten when the player leaves)
    client.receive('player_list', { records: [{ type: 'add', uuid: 'aaaaaaaa-0000-0000-0000-000000000001', entity_unique_id: -77n, username: 'Steve Builder' }] })
    client.receive('set_score', {
      entries: [
        { entry_type: 'player', scoreboard_id: 5n, objective_name: 'season', score: 3, entity_unique_id: -77n },
        { entry_type: 'fake_player', scoreboard_id: 6n, objective_name: 'season', score: 1, custom_name: 'low' },
        { entry_type: 'fake_player', scoreboard_id: 7n, objective_name: 'season', score: 9, custom_name: 'high' }
      ]
    })
    assert.deepStrictEqual(season.items.map(i => i.name), ['low', 'Steve Builder', 'high'], 'ascending: lowest first')
    client.receive('set_display_objective', { display_slot: 'sidebar', objective_name: 'season', display_name: '2024', criteria_name: 'dummy', sort_order: 1 })
    assert.deepStrictEqual(season.items.map(i => i.name), ['high', 'Steve Builder', 'low'], 'descending (Java order)')
    client.receive('player_list', { records: [{ type: 'remove', uuid: 'aaaaaaaa-0000-0000-0000-000000000001' }] })
    client.receive('set_score', { entries: [{ entry_type: 'player', scoreboard_id: 8n, objective_name: 'season', score: 2, entity_unique_id: -77n }] })
    assert.ok('-77' in season.itemsMap, 'an unknown player is keyed by its unique id')
  })

  it('sounds: play_sound → soundEffectHeard (coordinates / 8), level_sound_event → soundEffectHeard by name (note pitch), unknown ids → hardcodedSoundEffectHeard', async () => {
    const { bot, client } = await joined()
    const heard = record(bot, 'soundEffectHeard')
    const hardcoded = record(bot, 'hardcodedSoundEffectHeard')
    client.receive('play_sound', { name: 'note.harp', coordinates: { x: 28, y: -480, z: 58 }, volume: 0.5, pitch: 1.5, loop_count: 0, bypass_listener_range_check: false })
    assert.deepStrictEqual(heard[0], ['note.harp', new Vec3(3.5, -60, 7.25), 0.5, 1.5])
    for (const r of afterSpawnRecords()) if (r.name === 'level_sound_event') client.receive(r.name, r.params)
    assert.ok(heard.some(([name, pos]) => name === 'armor.equip_iron' && pos.equals(new Vec3(0.5, -58.47998809814453, 0.5))))
    client.receive('level_sound_event', { sound_id: 'note', position: { x: 1, y: 2, z: 3 }, extra_data: 12, entity_type: '', is_baby_mob: false, is_global: false, entity_unique_id: -1n })
    assert.deepStrictEqual(heard.at(-1), ['note', new Vec3(1, 2, 3), 1, 1])
    client.receive('level_sound_event', { sound_id: 9999, position: { x: 1, y: 2, z: 3 }, extra_data: -1, entity_type: '', is_baby_mob: false, is_global: false, entity_unique_id: -1n })
    client.receive('level_sound_event', { sound_id: 81, position: { x: 1, y: 2, z: 3 }, extra_data: 24, entity_type: '', is_baby_mob: false, is_global: false, entity_unique_id: -1n })
    assert.deepStrictEqual(hardcoded, [[9999, 'master', new Vec3(1, 2, 3), 1, 1]])
    assert.deepStrictEqual(heard.at(-1), ['note', new Vec3(1, 2, 3), 1, 2], 'legacy numeric id → registry.sounds name, note 24 → pitch 2')
  })

  it('particles: spawn_particle_effect (effect id / registry name) and level_event add_particle_* → particle', async () => {
    const { bot, client } = await joined()
    const particles = record(bot, 'particle')
    client.receive('spawn_particle_effect', { dimension: 0, entity_id: -1n, position: { x: 3.5, y: -60, z: 7.25 }, particle_name: 'minecraft:heart_particle' })
    client.receive('spawn_particle_effect', { dimension: 0, entity_id: -1n, position: { x: 3.5, y: -60, z: 7.25 }, particle_name: 'bubble' })
    client.receive('level_event', { event: 'add_particle_heart', position: { x: 1, y: 2, z: 3 }, data: 0 })
    client.receive('level_event', { event: 16384 | 81, position: { x: 1, y: 2, z: 3 }, data: 0 })
    client.receive('level_event', { event: 'add_particle_smash_attack_ground_dust', position: { x: 1, y: 2, z: 3 }, data: 0 })
    for (const r of afterSpawnRecords()) if (r.name === 'level_event') client.receive(r.name, r.params) // rain, block destroy: not particles
    assert.strictEqual(particles.length, 5)
    const [effect, bubble, heart, raw, smash] = particles.map(([p]) => p)
    assert.deepStrictEqual([smash.id, smash.name], ['smash_attack_ground_dust', 'smash_attack_ground_dust'], 'not in the registry: the name')
    assert.deepStrictEqual([effect.id, effect.name, effect.position, effect.offset, effect.count, effect.movementSpeed, effect.longDistanceRender],
      ['minecraft:heart_particle', 'minecraft:heart_particle', new Vec3(3.5, -60, 7.25), new Vec3(0, 0, 0), 1, 0, false])
    assert.deepStrictEqual([bubble.id, bubble.name], [1, 'bubble'], 'a registry particle name resolves like upstream')
    assert.deepStrictEqual([heart.id, heart.name, heart.position], [19, 'heart', new Vec3(1, 2, 3)])
    assert.deepStrictEqual([raw.id, raw.name], [81, 'electric_spark'])
  })

  it('teams: bot.teams / bot.teamMap stay empty (no teams on Bedrock)', async () => {
    const { bot } = await joined()
    assert.deepStrictEqual([bot.teams, bot.teamMap], [{}, {}])
  })
})
