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
const { defineSkill, log, progress, agentOf, waitTicks } = require('../skill')
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

/** animals the bot could not get at (per bot: entity id → until) */
const unreachablePrey = new WeakMap()
function preyOk (bot, e) {
  const until = unreachablePrey.get(bot)?.get(e.id)
  return !(until > Date.now())
}

/**
 * Chase an animal with the pathfinder (a hit animal flees; fences, ledges and water are walked around, nothing is
 * dug) and hit it whenever it is in reach. skills/combat.js `fight` walks straight at its target, which suits a
 * hostile coming at the bot but loses a chicken behind the first fence. Safety (a hostile, lava, …) takes the
 * controls when it must; the chase goes on afterwards.
 * @returns {Promise<'killed'|'gone'|'timeout'|'died'>}
 */
async function strike (bot, target, { signal, timeout = 20000 } = {}) {
  const combat = require('./combat')
  const navigate = require('./navigate')
  const { goals } = require('mineflayer-pathfinder')
  const dead = combat.deadEntities(bot)
  const safety = agentOf(bot)?.safety
  // the chase's own movements (no digging, no towering) must not outlive it: later goto calls may rely on the default
  const movementsBefore = bot.pathfinder.movements
  /** the best melee weapon in the hand (auto-eat puts food there to eat) */
  const arm = async () => {
    const weapon = combat.bestWeapon(bot)
    if (weapon && bot.heldItem !== weapon && !bot.autoEat?.isEating) await bot.equip(weapon, 'hand').catch(() => {})
  }
  await arm()
  let until = Date.now() + timeout
  let following = false
  let nextHit = 0
  // no path: a closed door next to the bot (its own house) may be the way out — pathfinder does not always take it
  let noPath = false
  let nextDoorTry = 0
  const onPath = (r) => { if (r.status === 'noPath' && following) noPath = true }
  bot.on('path_update', onPath)
  try {
    for (;;) {
      checkAbort(signal)
      if (bot.health <= 0) return 'died'
      if (dead.has(target)) return 'killed'
      if (!bot.entities[target.id]) return 'gone'
      if (Date.now() > until) return 'timeout'
      if (safety?.busy) {
        // a fight / lava escape: not the animal's fault, the time does not count
        following = false
        const t = Date.now()
        await safety.idle(signal)
        until += Date.now() - t
        noPath = false
        continue
      }
      if (noPath && Date.now() >= nextDoorTry) {
        noPath = false
        nextDoorTry = Date.now() + 3000
        bot.pathfinder.setGoal(null)
        following = false
        await navigate.throughDoor(bot, bot.entity.position.floored(), signal, target.position)
        continue
      }
      if (!following) {
        bot.pathfinder.setMovements(navigate.movements(bot, { canDig: false, allow1by1towers: false }))
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 1), true)
        following = true
      }
      if (combat.hitboxDistance(bot, target) <= 2.9 && Date.now() >= nextHit) {
        await arm()
        await bot.lookAt(target.position.offset(0, combat.hitboxSize(target).height * 0.6, 0), true)
        bot.attack(target)
        nextHit = Date.now() + 500 // the hurt cooldown (10 ticks)
      }
      await waitTicks(bot, 1, signal)
    }
  } finally {
    bot.removeListener('path_update', onPath)
    if (!safety?.busy) try { bot.pathfinder.setGoal(null) } catch {}
    if (movementsBefore) bot.pathfinder.setMovements(movementsBefore)
  }
}

/**
 * Kill passive mobs in sight for their drops (chased with the pathfinder, see strike). `item` may be a list: then
 * `count` of any ONE of them (3 wool of one colour for a bed).
 */
async function hunt (bot, { mobs, item, count, signal, radius = 64, filter = () => true }) {
  const items = [].concat(item)
  const start = Object.fromEntries(items.map((i) => [i, inventory.count(bot, i)]))
  // a hungry bot eats the meat as soon as it is picked up (mineflayer-auto-eat): that counts as collected
  // ('eatFinish' also follows a failed meal: 'eatFail' comes right before it then)
  let eaten = 0
  let failed = false
  const onFail = () => { failed = true }
  const onEat = (o) => {
    if (!failed && items.includes(o?.food?.name)) eaten++
    failed = false
  }
  bot.autoEat?.on?.('eatFail', onFail)
  bot.autoEat?.on?.('eatFinish', onEat)
  const best = () => items.reduce((b, i) => inventory.count(bot, i) - start[i] > inventory.count(bot, b) - start[b] ? i : b, items[0])
  const collected = () => inventory.count(bot, best()) - start[best()] + eaten
  const dead = require('./combat').deadEntities(bot)
  let kills = 0
  try {
    for (let i = 0; i < count * 3 && collected() < count; i++) {
      checkAbort(signal)
      // (a mob killed a moment ago stays in bot.entities during its death animation)
      const target = bot.nearestEntity((e) => mobs.includes(e.name) && !dead.has(e) && preyOk(bot, e) && e.position.distanceTo(bot.entity.position) <= radius && filter(e))
      if (!target) throw new SkillError(`no ${mobs.join('/')} in sight`, { code: 'NOT_FOUND' })
      const outcome = await strike(bot, target, { signal, timeout: 20000 }) // a fleeing animal is not worth more
      log(bot, `hunt: ${target.name} at ${target.position.floored()} → ${outcome}`)
      if (outcome === 'died') throw new SkillError('died while hunting', { code: 'DIED' })
      if (outcome === 'timeout') {
        // behind a fence / across water: leave that one alone for a while
        if (!unreachablePrey.has(bot)) unreachablePrey.set(bot, new Map())
        unreachablePrey.get(bot).set(target.id, Date.now() + 120000)
      }
      if (outcome === 'killed') {
        kills++
        const had = inventory.counts(bot)
        await dig.pickupNear(bot, target.position.clone(), { signal, radius: 5, wait: 1500, timeout: 10000 })
        const got = Object.entries(inventory.counts(bot)).filter(([n, c]) => c > (had[n] ?? 0)).map(([n, c]) => `${c - (had[n] ?? 0)} ${n}`)
        progress(bot, 'pickup', { from: target.name, got })
      }
    }
  } finally {
    bot.autoEat?.removeListener?.('eatFail', onFail)
    bot.autoEat?.removeListener?.('eatFinish', onEat)
  }
  if (collected() <= 0) throw new SkillError(`killed ${kills} ${mobs.join('/')} but picked up no ${items.join('/')}`, { code: 'FAILED' })
  return { killed: kills, collected: { [best()]: collected() } }
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
  const forgiven = new Map()
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
    const safety = agentOf(bot)?.safety
    const interventionsBefore = safety?.interventions.length ?? 0
    try {
      await execute(bot, step, { signal })
      done.push({ action: step.action, item: step.item, count: step.count, ms: Date.now() - t0 })
    } catch (err) {
      if (isAbort(err) || err.code === 'DIED') throw err
      const k = failureKey(step)
      // a fight / a lava escape in the middle (the furnace window closed, the path stopped) is not this way's fault
      // (at most 3 times per way, so a way that keeps failing during fights is still dropped eventually)
      const interrupted = !!safety && (safety.busy || safety.interventions.length > interventionsBefore || safety.recentlyBusy(3000)) &&
        !['NO_PLAN', 'MISSING'].includes(err.code) && (forgiven.get(k) ?? 0) < 3
      if (interrupted) forgiven.set(k, (forgiven.get(k) ?? 0) + 1)
      else failures.set(k, (failures.get(k) ?? 0) + 1)
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
 * Skill `hunt` — args: { mobs: string[], item: string|string[], count?: 1, total?: false, radius?: 48, explore?: true,
 * timeout?: 150000 }: kill passive mobs (chased with the pathfinder) until `count` more `item`s were picked up (a list
 * of items: `count` of any one of them; `total`: until that many are carried); when none is in sight, walk a spiral
 * on the surface until one is. result: { collected: { [item]: n }, killed }
 */
async function huntSkill (bot, { mobs, item, count = 1, total = false, radius = 48, explore: mayExplore = true, timeout = 150000, signal } = {}) {
  if (!mobs?.length || !item) throw new SkillError('hunt needs args.mobs and args.item', { code: 'FAILED' })
  const started = Date.now()
  const items = [].concat(item)
  const start = Object.fromEntries(items.map((i) => [i, inventory.count(bot, i)]))
  let killed = 0
  // a list of items: `count` of any one of them (`total`: carried in all, else gained)
  const got = () => Math.max(...items.map((i) => inventory.count(bot, i) - (total ? 0 : start[i])))
  while (got() < count) {
    checkAbort(signal)
    if (Date.now() - started > timeout) break
    await agentOf(bot)?.safety?.idle(signal)
    const dead = require('./combat').deadEntities(bot)
    const inSight = () => bot.nearestEntity((e) => mobs.includes(e.name) && !dead.has(e) && preyOk(bot, e) && e.position.distanceTo(bot.entity.position) <= radius)
    if (!inSight()) {
      if (!mayExplore) break
      log(bot, `hunt: no ${mobs.join('/')} in sight; exploring`)
      const r = await require('./explore').explore(bot, { until: inSight, maxDistance: 160, leg: 32, signal, timeout: Math.max(15000, timeout - (Date.now() - started)) })
      if (!r.found) break
    }
    try {
      const r = await hunt(bot, { mobs, item, count: count - got(), signal, radius })
      killed += r.killed
    } catch (err) {
      if (isAbort(err) || err.code === 'DIED') throw err
      log(bot, `hunt: ${err.message}`)
      await waitTicks(bot, 10, signal)
    }
  }
  const best = items.reduce((b, i) => inventory.count(bot, i) - start[i] > inventory.count(bot, b) - start[b] ? i : b, items[0])
  if (got() < count) throw new SkillError(`hunted ${got()} of ${count} ${items.length > 1 ? 'of one of ' : ''}${items.join('/')} (${killed} ${mobs.join('/')} killed)`, { code: 'NOT_FOUND', details: { killed } })
  return { collected: { [best]: got() }, killed }
}

/**
 * Obtain several items in order. @returns {Promise<{ results: object[] }>}
 */
async function obtainAll (bot, { items, signal }) {
  const results = []
  for (const { item, count = 1 } of items) results.push(await obtain(bot, { item, count, signal }))
  return { results }
}

module.exports = Object.assign(skill, { skills: { hunt: defineSkill('hunt', (bot, args) => huntSkill(bot, args), { description: 'kill passive mobs for an item (exploring for them)' }) }, obtain, obtainAll, execute, hunt, huntSkill, preyOk, describe, FOODS: data.FOODS })
