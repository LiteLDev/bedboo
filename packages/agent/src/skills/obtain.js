// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * obtain(item, count): get `count` × `item` into the inventory by whatever it takes, recursively —
 * already carried → crafted (any of the recipe's ingredient alternatives, a crafting table placed when needed) →
 * smelted (furnace recipes from src/data, fuel chosen by cost) → mined / gathered (blocks whose drops include it,
 * with a tool that can harvest them, obtained first) → dropped by a passive mob in sight.
 *
 * The plan comes from src/planner.js over the live world model (src/knowledge.js). Only its first step is executed,
 * then the agent plans again: the world decides how many drops a block gives, which tree is closest, whether a tool
 * broke. A step that fails is penalised for this item (after 3 failures that way is dropped) and the next plan
 * routes around it.
 *
 * Skill `obtain` — args: { item, count?: 1, maxSteps?: 80 }
 *                  result: { item, count, steps: [{ action, item, count, ms }], ms }
 */
const { SkillError, checkAbort, isAbort } = require('../errors')
const { defineSkill, log, progress, agentOf } = require('../skill')
const inventory = require('../inventory')
const knowledge = require('../knowledge')
const planner = require('../planner')
const dig = require('../dig')
const data = require('../data')
const craft = require('./craft')
const smelt = require('./smelt')

/** human-readable one-liner of a plan */
function describe (steps) {
  return steps.map((s) => `${s.action} ${s.count} ${s.item}${s.blocks ? ` (${s.blocks.slice(0, 2).join('/')})` : ''}`).join(' → ')
}

/**
 * Execute one planner step.
 * @returns {Promise<object>} the skill result
 */
async function execute (bot, step, { signal }) {
  switch (step.action) {
    case 'craft':
      return craft.craftItem(bot, step.item, step.count, { signal })
    case 'smelt':
      return smelt.smeltItem(bot, { item: step.item, count: step.count, input: step.input, fuel: step.fuel, signal })
    case 'mine':
    case 'gather':
      return dig.collectBlocks(bot, {
        item: step.item,
        count: step.count,
        blocks: step.blocks,
        maxDistance: step.action === 'mine' ? 128 : 64,
        exploreDistance: 320,
        signal,
        timeout: 360000
      })
    case 'kill':
      return hunt(bot, { mobs: step.mobs, item: step.item, count: step.count, signal })
    default:
      throw new SkillError(`unknown step ${step.action}`, { code: 'FAILED' })
  }
}

/** kill passive mobs in sight for their drops (mineflayer combat helpers of skills/combat.js) */
/** animals the bot could not get at (per bot: entity id → until) */
const unreachablePrey = new WeakMap()
function preyOk (bot, e) {
  const until = unreachablePrey.get(bot)?.get(e.id)
  return !(until > Date.now())
}

async function hunt (bot, { mobs, item, count, signal, radius = 64 }) {
  const combat = require('./combat')
  const start = inventory.count(bot, item)
  let kills = 0
  for (let i = 0; i < count * 3 && inventory.count(bot, item) - start < count; i++) {
    checkAbort(signal)
    const target = bot.nearestEntity((e) => mobs.includes(e.name) && preyOk(bot, e) && e.position.distanceTo(bot.entity.position) <= radius)
    if (!target) throw new SkillError(`no ${mobs.join('/')} in sight`, { code: 'NOT_FOUND' })
    const r = await combat.fight(bot, target, { signal, timeout: 15000 }) // a fleeing animal is not worth more
    if (r.outcome === 'died') throw new SkillError('died while hunting', { code: 'DIED' })
    if (r.outcome === 'timeout') {
      // behind a fence / across water: leave that one alone for a while
      if (!unreachablePrey.has(bot)) unreachablePrey.set(bot, new Map())
      unreachablePrey.get(bot).set(target.id, Date.now() + 120000)
    }
    if (r.outcome === 'killed') {
      kills++
      await dig.pickupNear(bot, target.position.clone(), { signal, item, radius: 4 })
    }
  }
  const collected = inventory.count(bot, item) - start
  if (collected <= 0) throw new SkillError(`killed ${kills} ${mobs.join('/')} but picked up no ${item}`, { code: 'FAILED' })
  return { killed: kills, collected: { [item]: collected } }
}

/**
 * @param {object} bot
 * @param {{ item: string, count?: number, maxSteps?: number, signal?: AbortSignal }} args
 */
async function obtain (bot, { item, count = 1, maxSteps = 80, signal } = {}) {
  if (!item) throw new SkillError('obtain needs args.item', { code: 'FAILED' })
  if (!bot.registry.itemsByName[item]) throw new SkillError(`unknown item ${item}`, { code: 'NO_PLAN' })
  const started = Date.now()
  const failures = new Map()
  const done = []
  for (let i = 0; i < maxSteps; i++) {
    checkAbort(signal)
    await agentOf(bot)?.safety?.idle(signal)
    if (inventory.count(bot, item) >= count) {
      progress(bot, 'obtained', { item, count: inventory.count(bot, item) })
      return { item, count: inventory.count(bot, item), steps: done, ms: Date.now() - started }
    }
    const model = knowledge.worldModel(bot, { failures })
    const p = planner.plan({ item, count }, model)
    if (!p.ok) throw new SkillError(`cannot obtain ${count} ${item}: ${p.reason}`, { code: 'NO_PLAN', details: { failures: Object.fromEntries(failures) } })
    const step = mergeGathers(p.steps)
    if (!step) throw new SkillError(`obtain ${item}: empty plan`, { code: 'NO_PLAN' })
    log(bot, `obtain ${count} ${item}: ${describe(p.steps)} (~${Math.round(p.cost)} s)`)
    const t0 = Date.now()
    try {
      await execute(bot, step, { signal })
      done.push({ action: step.action, item: step.item, count: step.count, ms: Date.now() - t0 })
    } catch (err) {
      if (isAbort(err) || err.code === 'DIED') throw err
      const k = failureKey(step)
      failures.set(k, (failures.get(k) ?? 0) + 1)
      done.push({ action: step.action, item: step.item, count: step.count, ms: Date.now() - t0, error: err.message })
      log(bot, `obtain: ${step.action} ${step.item} failed (${err.code ?? err.name}): ${err.message}`)
      progress(bot, 'step-failed', { action: step.action, item: step.item, code: err.code, error: err.message })
      if (/could not place/.test(err.message)) await makeRoom(bot, signal)
    }
  }
  throw new SkillError(`obtain ${count} ${item}: gave up after ${maxSteps} steps`, { code: 'FAILED', details: { steps: done } })
}

/**
 * The first step; when it digs blocks, every later dig of the same item in the plan is done in the same trip (the
 * planner acquires per need: 3 logs for 3 different crafts would be 3 walks to the forest).
 */
function mergeGathers (steps) {
  const first = steps[0]
  if (!first || (first.action !== 'mine' && first.action !== 'gather')) return first
  const count = steps.filter((s) => s.action === first.action && s.item === first.item).reduce((n, s) => n + s.count, 0)
  return { ...first, count }
}

/** no room for a station here (a 1×1 shaft, a ledge): walk a few blocks away to more open ground */
async function makeRoom (bot, signal) {
  const { goals } = require('mineflayer-pathfinder')
  const navigate = require('./navigate')
  const p = bot.entity.position
  await navigate.goto(bot, new goals.GoalInvert(new goals.GoalNear(p.x, p.y, p.z, 4)), { signal, timeout: 20000, attempts: 1, legs: false })
    .catch((err) => { if (isAbort(err)) throw err; log(bot, `obtain: could not move away: ${err.message}`) })
}

function failureKey (step) {
  if (step.action === 'mine' || step.action === 'gather') return `${step.action}:${step.item}`
  if (step.action === 'kill') return `kill:${step.item}`
  return `${step.action}:${step.item}`
}

const skill = defineSkill('obtain', (bot, args) => obtain(bot, args), {
  description: 'get N of an item: craft / smelt / mine / gather / hunt recursively (re-planned after every step)'
})

/**
 * Obtain several items in order. @returns {Promise<{ results: object[] }>}
 */
async function obtainAll (bot, { items, signal }) {
  const results = []
  for (const { item, count = 1 } of items) results.push(await obtain(bot, { item, count, signal }))
  return { results }
}

module.exports = Object.assign(skill, { obtain, obtainAll, execute, hunt, preyOk, describe, FOODS: data.FOODS })
