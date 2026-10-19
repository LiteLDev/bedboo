// owner: U16b (mob combat matrix, NetherNet, user docs)
'use strict'
/**
 * Mob combat matrix (Bedrock extra, plan U16): a survival bot on difficulty normal fights every hostile mob family in a
 * summoned arena and must kill it by its own hand and survive.
 *
 * - Public mineflayer API only, through the combat library seeded in @bedboo/agent (packages/agent/src/skills/combat.js):
 *   `bot.equip` (diamond sword, full diamond armor, shield in the off-hand, bow + arrows; given with console `/give`),
 *   `nearestEntity`, `lookAt`/`look`, `setControlState` (approach, sprint, jump, strafe, back off, retreat),
 *   `attack` every 10 ticks (Bedrock has no attack cooldown, but a hurt mob is invulnerable for 10 ticks),
 *   `activateItem`/`deactivateItem` (bow: draw 20 ticks, aimed with gravity and lead; shield when cornered), and the
 *   `entityHurt` / `entityDead` / `entityGone` / `death` events. No effects (regeneration/resistance) are given: none
 *   were needed.
 * - Arenas: a hollow stone-brick box built with `/fill … hollow` (27×7×27, 5 blocks of headroom: flying mobs —
 *   ghast, phantom, blaze — stay within melee or bow reach, shulker levitation ends at the ceiling) at the overworld
 *   spawn at midnight; piglins and hoglins are fought in a blackstone box in the Nether (`/execute in nether`) since
 *   they zombify in the overworld after ~15 s.
 * - Mob specifics: zombie/husk/drowned summoned as adults (`minecraft:as_adult`), piglin/hoglin as adults
 *   (`minecraft:spawn_adult`); slimes and magma cubes are re-summoned until their size is ≥ 2 (Bedrock's
 *   `minecraft:spawn_large` event only sets the hitbox, the split count follows the size variant) and every split
 *   must be killed too; the enderman is neutral and provoked by attacking it (no staring; arrows never hurt it, so the
 *   library never shoots it); creepers are hit from the edge of the reach and the bot backs off after each hit.
 * - A row passes when the mob died (`entityDead`) within 1.5 s of one of the bot's hits (3 s of an arrow) after an
 *   `entityHurt`, all its splits died, and the bot did not die.
 *
 * Random by nature (AI, knockback, potions): the gate is ≥ 4/5 per mob (CONTRIBUTING). Runs per mob:
 * `BEDBOO_COMBAT_RUNS=5` (gate; a row then needs ⌈0.8·runs⌉ passes); default 1 run with one retry (logged).
 * `BEDBOO_COMBAT_REPORT=<file>` appends every run as JSON lines (the per-mob pass table is printed after the suite).
 * One mob: `corepack pnpm test:e2e -- --grep "combat matrix.*creeper"`.
 */
const assert = require('assert')
const fs = require('fs')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')
const combat = require('../../../agent/src/skills/combat')

const RUNS = Math.max(1, Number(process.env.BEDBOO_COMBAT_RUNS) || 1)
const REQUIRED = RUNS === 1 ? 1 : Math.ceil(RUNS * 0.8)
const ATTEMPTS = RUNS === 1 ? 2 : RUNS
const REPORT = process.env.BEDBOO_COMBAT_REPORT

/**
 * arenas: dimension, hollow box corners (none: open ground), the bot's and the mob's start positions (feet).
 * The enderman fights on open ground: it teleports away when hurt, and from outside a box (or its roof) it would not
 * come back in.
 */
const ARENAS = {
  overworld: { dimension: 'overworld', execute: 'overworld', block: 'stone_bricks', from: new Vec3(-13, -61, -13), to: new Vec3(13, -55, 13), bot: new Vec3(-4, -60, 0), mob: new Vec3(4, -60, 0) },
  open: { dimension: 'overworld', execute: 'overworld', bot: new Vec3(76, -60, 0), mob: new Vec3(84, -60, 0) },
  nether: { dimension: 'the_nether', execute: 'nether', block: 'blackstone', from: new Vec3(-13, 99, -13), to: new Vec3(13, 105, 13), bot: new Vec3(-4, 100, 0), mob: new Vec3(4, 100, 0) }
}

/** the matrix: name, arena, summon event, slime-like splitting, notes for the table */
const MOBS = [
  { name: 'zombie', event: 'minecraft:as_adult' },
  { name: 'husk', event: 'minecraft:as_adult' },
  { name: 'drowned', event: 'minecraft:as_adult' },
  { name: 'skeleton' },
  { name: 'stray' },
  { name: 'spider' },
  { name: 'cave_spider' },
  { name: 'creeper' },
  { name: 'enderman', arena: 'open' },
  { name: 'slime', splits: true },
  { name: 'witch' },
  { name: 'pillager' },
  { name: 'blaze' },
  { name: 'piglin', arena: 'nether', event: 'minecraft:spawn_adult' },
  { name: 'hoglin', arena: 'nether', event: 'minecraft:spawn_adult' },
  { name: 'wither_skeleton' },
  { name: 'ghast' },
  { name: 'magma_cube', splits: true },
  { name: 'shulker' },
  { name: 'endermite' },
  { name: 'phantom' }
]

const EQUIPMENT = ['diamond_sword', 'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'shield', 'bow']

describe('combat matrix (U16b): a survival bot kills every hostile mob family on difficulty normal', function () {
  this.timeout(ATTEMPTS * 150000 + 60000)
  const env = useBot({ server: { gamemode: 'survival', difficulty: 'normal' } })
  const table = new Map() // mob → [{ ok, reason, … }]
  const built = new Set()

  const cmd = (command) => env.server.commandOutput(command)
  async function expectCmd (command, ok) {
    const out = await cmd(command)
    if (!out.some((l) => ok.test(l))) throw new Error(`${command}: ${out.join(' | ')}`)
    return out
  }
  const who = () => env.bot.test.ctx.who()

  before(async function () {
    this.timeout(120000)
    const { bot } = env
    combat.deadEntities(bot)
    await bot.test.setGameMode('creative')
    await bot.test.clearInventory()
    for (const item of EQUIPMENT) await bot.test.give(item, 1)
    await bot.test.give('arrow', 64)
    await cmd('time set midnight') // nothing burns (the arenas are roofed anyway)
    const equipped = await combat.equipForCombat(bot)
    assert.strictEqual(equipped.weapon, 'diamond_sword')
    assert.deepStrictEqual(equipped.armor, ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'])
    assert.strictEqual(equipped.shield, true)
  })

  after(function () {
    if (!table.size) return
    console.log('\n      combat matrix (runs per mob: passes / runs, failure reasons)')
    console.log('      | mob | passes | median ms | failures |')
    console.log('      |---|---|---|---|')
    for (const [mob, runs] of table) {
      const passes = runs.filter((r) => r.ok).length
      const ms = runs.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b)
      const median = ms.length ? ms[Math.floor(ms.length / 2)] : '-'
      const reasons = runs.filter((r) => !r.ok).map((r) => r.reason).join('; ') || '-'
      console.log(`      | ${mob} | ${passes}/${runs.length} | ${median} | ${reasons} |`)
    }
  })

  /** move the bot (creative) into the arena's dimension, build the arena there once, park the bot at its start */
  async function enterArena (arenaName) {
    const { bot } = env
    const arena = ARENAS[arenaName]
    await bot.test.setGameMode('creative')
    if (bot.game.dimension !== arena.dimension || (arena.block && !built.has(arenaName)) || bot.entity.position.distanceTo(arena.bot) > 24) {
      const p = arena.bot
      const travelled = bot.game.dimension !== arena.dimension
      const arrived = travelled
        ? bot.test.botEvent('spawn', () => bot.game.dimension === arena.dimension, 60000)
        : null
      await expectCmd(`execute in ${arena.execute} run tp ${who()} ${p.x} ${p.y} ${p.z}`, /^Teleported/)
      if (arrived) await arrived.promise
      await bot.waitForChunksToLoad()
      if (arena.block && !built.has(arenaName)) {
        const { from, to, block } = arena
        // the chunks must be loaded server side: retry while BDS answers "outside of the world"
        for (let i = 0; ; i++) {
          const out = await cmd(`execute in ${arena.execute} run fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} ${block} hollow`)
          if (out.some((l) => /blocks? filled|No blocks were filled/i.test(l))) break
          if (i >= 20) throw new Error(`arena ${arenaName}: ${out.join(' | ')}`)
          await bot.test.wait(500)
        }
        built.add(arenaName)
      }
    }
    await cmd(`execute in ${arena.execute} run kill @e[type=!player]`)
    const moved = bot.test.ctx.event('move', (pos) => pos.distanceTo(arena.bot) < 0.9, 20000)
    moved.catch(() => {})
    await expectCmd(`execute in ${arena.execute} run tp ${who()} ${arena.bot.x} ${arena.bot.y} ${arena.bot.z} facing ${arena.mob.x} ${arena.mob.y + 1.6} ${arena.mob.z}`, /^Teleported/)
    await moved.catch(() => {})
    return arena
  }

  /** summon `mob` and resolve with the mineflayer entity (slimes / magma cubes: re-summoned until size ≥ 2) */
  async function summon (mob, arena) {
    const { bot } = env
    for (let i = 0; i < 12; i++) {
      const spawned = bot.test.botEvent('entitySpawn', (e) => e.name === mob.name, 10000)
      spawned.promise.catch(() => {})
      const event = mob.event ? ` 0 0 ${mob.event}` : ''
      await expectCmd(`execute in ${arena.execute} run summon ${mob.name} ${arena.mob.x} ${arena.mob.y} ${arena.mob.z}${event}`, /successfully summoned/i)
      const [entity] = await spawned.promise
      if (!mob.splits) return entity
      await bot.waitForTicks(4) // the size arrives with the spawn (variant 1, 2 or 4)
      if ((entity.metadata?.variant ?? 0) >= 2) return entity
      await cmd(`execute in ${arena.execute} run kill @e[type=${mob.name}]`)
      await bot.test.wait(300)
    }
    throw new Error(`no ${mob.name} of size ≥ 2 after 12 summons`)
  }

  /** one fight; resolves with { ok, reason, ms, … } (never throws for a lost fight) */
  async function fightOnce (mob) {
    const { bot } = env
    const arena = await enterArena(mob.arena ?? 'overworld')
    await cmd(`effect ${who()} clear`)
    await cmd(`effect ${who()} instant_health 1 10 true`)
    await cmd(`effect ${who()} saturation 1 10 true`)
    if (bot.inventory.count(bot.registry.itemsByName.arrow.id) < 32) await bot.test.give('arrow', 64)
    for (const item of EQUIPMENT) {
      const has = bot.inventory.items().some((i) => i.name === item) || bot.inventory.slots.slice(5, 9).some((i) => i?.name === item) || bot.inventory.slots[45]?.name === item
      if (!has) await bot.test.give(item, 1) // worn out (armor durability, the bow)
    }
    await bot.test.wait(300)
    await bot.test.setGameMode('survival')
    await combat.equipForCombat(bot)

    let botDied = false
    const onDeath = () => { botDied = true }
    const spawnedSplits = []
    const deadSplits = new Set()
    const onSpawn = (e) => { if (mob.splits && e.name === mob.name) spawnedSplits.push(e) }
    const onDead = (e) => { if (mob.splits && e.name === mob.name) deadSplits.add(e) }
    bot.on('death', onDeath)
    bot.on('entitySpawn', onSpawn)
    bot.on('entityDead', onDead)
    const started = Date.now()
    let record
    try {
      const target = await summon(mob, arena)
      const opts = { radius: 32, timeout: 90000, fightTimeout: 60000, log: (m) => console.log(`        ${mob.name}: ${m}`) }
      let fights
      if (mob.splits) {
        const all = await combat.fightAll(bot, { ...opts, names: [mob.name], settleMs: 2500 })
        fights = all.fights
      } else {
        const first = await combat.fight(bot, target, { ...opts, timeout: 60000 })
        fights = [first]
        if (first.outcome === 'gone') {
          // out of tracking range (an enderman teleporting away): fight it when it comes back
          const rest = await combat.fightAll(bot, { ...opts, names: [mob.name], includeNeutral: true, timeout: 45000 })
          fights.push(...rest.fights)
        }
      }
      const killed = fights.filter((f) => f.outcome === 'killed')
      const byBot = killed.filter((f) => f.byBot)
      const sum = (k) => fights.reduce((n, f) => n + f[k], 0)
      record = {
        mob: mob.name,
        ms: Date.now() - started,
        attacks: sum('attacks'),
        shots: sum('shots'),
        hurts: sum('hurts'),
        kills: killed.length,
        health: Math.round(bot.health * 10) / 10,
        outcomes: fights.map((f) => f.outcome).join(',')
      }
      const leftovers = mob.splits ? spawnedSplits.filter((e) => !deadSplits.has(e) && bot.entities[e.id]) : []
      if (botDied) record.reason = `the bot died (${record.outcomes})`
      else if (!killed.length) record.reason = `not killed: ${record.outcomes}, ${record.hurts} hurts / ${record.attacks} attacks / ${record.shots} shots, health ${record.health}`
      else if (byBot.length < killed.length) record.reason = `${killed.length - byBot.length} kill(s) not by the bot's hand`
      else if (leftovers.length) record.reason = `${leftovers.length} split(s) left alive`
      record.ok = !record.reason
    } catch (err) {
      record = { mob: mob.name, ok: false, reason: `error: ${err.message}`, ms: Date.now() - started }
    } finally {
      bot.removeListener('death', onDeath)
      bot.removeListener('entitySpawn', onSpawn)
      bot.removeListener('entityDead', onDead)
      try { bot.clearControlStates() } catch {}
    }
    if (botDied || !bot.isAlive) {
      // respawn (autoRespawn) before the next fight
      if (!bot.isAlive) await bot.test.botEvent('spawn', () => true, 20000).promise.catch(() => {})
    }
    return record
  }

  for (const mob of MOBS) {
    it(`combat matrix: ${mob.name}${mob.arena === 'nether' ? ' (nether arena)' : mob.arena === 'open' ? ' (open ground)' : ''}`, async function () {
      const runs = []
      for (let i = 0; i < ATTEMPTS; i++) {
        if (RUNS === 1 && runs.some((r) => r.ok)) break
        const r = await fightOnce(mob)
        r.run = i + 1
        runs.push(r)
        console.log(`        ${mob.name} #${r.run}: ${r.ok ? 'ok' : 'FAIL ' + r.reason} — ${r.ms} ms, ${r.attacks ?? 0} attacks, ${r.shots ?? 0} shots, ${r.hurts ?? 0} hurts, ${r.kills ?? 0} kills, health ${r.health ?? '?'}`)
        if (REPORT) fs.appendFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), ...r }) + '\n')
      }
      table.set(mob.name, runs)
      const passes = runs.filter((r) => r.ok).length
      assert.ok(passes >= REQUIRED, `${mob.name}: ${passes}/${runs.length} fights won (need ${REQUIRED}): ${runs.filter((r) => !r.ok).map((r) => r.reason).join('; ')}`)
    })
  }
})
