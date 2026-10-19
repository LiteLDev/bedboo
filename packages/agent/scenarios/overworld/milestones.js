// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Overworld milestones M1–M5. Each is a scenario for `Agent#runScenario` (src/runner.js): cheat-free skill steps plus
 * a `verify(agent, start)` that checks the outcome against the inventory / the world (`start` = the inventory counts
 * when the milestone began). Every milestone starts where the previous one ended (a world snapshot; the offline
 * player's inventory and position are saved with the world), M1 from the fresh world's spawn with nothing.
 *
 *   M1  wood → planks → crafting table → wooden pickaxe → cobblestone → stone pickaxe, axe and sword
 *   M2  iron: iron ore mined, a furnace built, iron smelted with coal / charcoal; iron pickaxe, iron sword, bucket
 *   M3  diamond: down to the deepslate diamond layer, ≥ 3 diamonds, a diamond pickaxe
 *   M4  the house5x5 blueprint near the world spawn, verified block by block
 *   M5  one item from each overworld ore: coal, copper, iron, gold, redstone, lapis, diamond, emerald
 */
const { Vec3 } = require('vec3')
const { compile, verify: verifyBlueprint, BLUEPRINTS } = require('../../src/blueprint')
const inventory = require('../../src/inventory')

const MINUTES = 60 * 1000

function need (agent, items) {
  const have = inventory.counts(agent.bot)
  const missing = Object.entries(items).filter(([name, n]) => (have[name] ?? 0) < n)
  if (missing.length) throw new Error(`missing ${missing.map(([n, c]) => `${c} ${n} (have ${have[n] ?? 0})`).join(', ')}`)
  return have
}

/** events of a type the agent recorded */
const eventsOf = (agent, type) => agent.events.filter((e) => e.type === type)

const M1 = {
  id: 'M1',
  name: 'M1 wood and stone tools',
  timeout: 10 * MINUTES,
  steps: [
    { skill: 'obtain', name: 'stone pickaxe', args: { item: 'stone_pickaxe', count: 1 } },
    { skill: 'obtain', name: 'stone axe', args: { item: 'stone_axe', count: 1 } },
    { skill: 'obtain', name: 'stone sword', args: { item: 'stone_sword', count: 1 } }
  ],
  verify (agent) {
    const have = need(agent, { stone_pickaxe: 1, stone_axe: 1, stone_sword: 1 })
    const crafted = eventsOf(agent, 'craft').map((e) => e.item)
    for (const item of ['oak_planks', 'crafting_table', 'stick', 'wooden_pickaxe', 'stone_pickaxe'].filter((i) => i !== 'oak_planks')) {
      if (!crafted.includes(item)) throw new Error(`${item} was not crafted (crafted: ${crafted.join(', ')})`)
    }
    if (!crafted.some((i) => /_planks$/.test(i))) throw new Error('no planks crafted')
    if (!eventsOf(agent, 'mine').some((e) => /stone|deepslate/.test(e.block))) throw new Error('no stone mined')
    return { tools: ['stone_pickaxe', 'stone_axe', 'stone_sword'].map((t) => `${t}×${have[t]}`), crafted }
  }
}

const M2 = {
  id: 'M2',
  name: 'M2 iron tools',
  timeout: 10 * MINUTES,
  steps: [
    { skill: 'obtain', name: 'iron pickaxe', args: { item: 'iron_pickaxe', count: 1 } },
    { skill: 'obtain', name: 'iron sword', args: { item: 'iron_sword', count: 1 } },
    { skill: 'obtain', name: 'bucket', args: { item: 'bucket', count: 1 } }
  ],
  verify (agent) {
    need(agent, { iron_pickaxe: 1, iron_sword: 1, bucket: 1 })
    const smelted = eventsOf(agent, 'smelt').filter((e) => e.item === 'iron_ingot')
    if (!smelted.length) throw new Error('no iron was smelted')
    if (!eventsOf(agent, 'mine').some((e) => /iron_ore/.test(e.block))) throw new Error('no iron ore mined')
    return { smelted: smelted.map((e) => `${e.count} iron_ingot (${e.input}, fuel ${e.fuel})`) }
  }
}

const M3 = {
  id: 'M3',
  name: 'M3 diamonds',
  timeout: 10 * MINUTES,
  steps: [
    { skill: 'obtain', name: '3 diamonds', args: { item: 'diamond', count: 3 } },
    { skill: 'obtain', name: 'diamond pickaxe', args: { item: 'diamond_pickaxe', count: 1 } }
  ],
  verify (agent) {
    need(agent, { diamond_pickaxe: 1 })
    const diamonds = eventsOf(agent, 'mine').filter((e) => /diamond_ore/.test(e.block))
    if (diamonds.length < 3) throw new Error(`${diamonds.length} diamond ores mined`)
    // the deepslate layer (y ≤ 8): at least one of them is a deepslate diamond ore
    if (!diamonds.some((e) => e.block === 'deepslate_diamond_ore')) throw new Error(`no deepslate diamond ore among ${diamonds.map((e) => `${e.block}@${e.at.y}`)}`)
    const deepest = Math.min(...diamonds.map((e) => e.at.y))
    return { diamondOres: diamonds.map((e) => `${e.block}@${e.at.y}`), deepest }
  }
}

const M4 = {
  id: 'M4',
  name: 'M4 house near spawn',
  timeout: 10 * MINUTES,
  steps: [
    { skill: 'surface', name: 'back to the surface' },
    { skill: 'navigate', name: 'to the world spawn', args: { spawn: true, goal: 'xz', range: 6 } },
    { skill: 'build', name: 'house5x5', args: { blueprint: 'house5x5', radius: 20 } }
  ],
  verify (agent) {
    const build = agent.tasks.find((t) => t.skill === 'build' && t.ok)
    if (!build) throw new Error('no build')
    const origin = build.result.origin
    const compiled = compile(BLUEPRINTS.house5x5, origin)
    const v = verifyBlueprint(compiled, (p) => agent.bot.blockAt(p))
    if (!v.ok) throw new Error(`${v.mismatches.length} block(s) wrong: ${JSON.stringify(v.mismatches.slice(0, 5))}`)
    const spawn = agent.bot.spawnPoint
    const d = Math.hypot(origin.x - spawn.x, origin.z - spawn.z)
    if (d > 48) throw new Error(`the house is ${d.toFixed(0)} blocks from the spawn`)
    return { origin, checked: v.checked, fromSpawn: Math.round(d) }
  }
}

const ORE_DROPS = ['coal', 'raw_copper', 'raw_iron', 'raw_gold', 'redstone', 'lapis_lazuli', 'diamond', 'emerald']

const M5 = {
  id: 'M5',
  name: 'M5 every overworld ore',
  timeout: 10 * MINUTES,
  steps: [
    { skill: 'mine', name: 'shallow ores', args: { all: [{ item: 'coal' }, { item: 'raw_copper' }, { item: 'raw_iron' }] } },
    { skill: 'mine', name: 'emerald (mountains)', args: { item: 'emerald', count: 1 } },
    { skill: 'mine', name: 'deep ores', args: { all: [{ item: 'lapis_lazuli' }, { item: 'raw_gold' }, { item: 'redstone' }, { item: 'diamond' }] } }
  ],
  verify (agent) {
    // what the mine steps picked up (the inventory alone can mislead: coal may have been burnt to cook food since)
    const gained = Object.fromEntries(ORE_DROPS.map((d) => [d, 0]))
    for (const t of agent.tasks.filter((t) => t.skill === 'mine' && t.ok)) {
      const parts = t.result?.results ? Object.values(t.result.results) : [t.result]
      for (const r of parts) for (const [item, n] of Object.entries(r?.collected ?? {})) if (item in gained) gained[item] += n
    }
    const short = ORE_DROPS.filter((d) => gained[d] <= 0)
    if (short.length) throw new Error(`no ${short.join(', ')} mined`)
    // this run of the scenario only (a chained run's event log holds the earlier milestones' digs too)
    const since = agent.events.filter((e) => e.type === 'scenario-start' && e.scenario === M5.name).at(-1)?.t ?? 0
    const ores = new Set(eventsOf(agent, 'mine').filter((e) => e.t >= since).map((e) => e.block).filter((b) => /_ore$/.test(b)))
    for (const kind of ['coal', 'copper', 'iron', 'gold', 'redstone', 'lapis', 'diamond', 'emerald']) {
      if (![...ores].some((b) => b.replace(/^(deepslate_|lit_)+/, '') === `${kind}_ore`)) throw new Error(`no ${kind} ore dug`)
    }
    return { mined: [...ores], gained }
  }
}

const MILESTONES = [M1, M2, M3, M4, M5]

module.exports = { MILESTONES, M1, M2, M3, M4, M5, ORE_DROPS, need, Vec3 }
