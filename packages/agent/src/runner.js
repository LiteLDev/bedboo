// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Scripted (no LLM) agent runner.
 *
 * A scenario is `{ name, setup?: string[], steps: Step[], timeout? }` where
 *   Step = { skill: string, args?: object, name?: string, timeout?: number }
 * `setup` are console commands applied by the test harness before the bot runs (cheat-assisted
 * prerequisites, world snapshots); the steps themselves must be cheat-free.
 *
 * `runScenario(bot, scenario, opts)` runs the steps in order with per-step timeouts and returns a
 * report `{ name, ok, results: [{ name, skill, ok, result?, error?, ms }] }`; it stops at the first
 * failed step. U17 extends this (milestone checks, retries, snapshots); U18 adds its skills.
 */
const defaultSkills = require('./skills')

const DEFAULT_STEP_TIMEOUT = 10 * 60 * 1000

/**
 * Run one skill with a timeout.
 * @param {object} bot
 * @param {string} name skill name (key of the skill registry)
 * @param {object} [args]
 * @param {{ skills?: Record<string, Function>, timeout?: number }} [opts]
 */
async function runSkill (bot, name, args = {}, { skills = defaultSkills, timeout = DEFAULT_STEP_TIMEOUT } = {}) {
  const skill = Object.hasOwn(skills, name) ? skills[name] : undefined
  if (typeof skill !== 'function') throw new Error(`Unknown skill: ${name}`)
  const controller = new AbortController()
  let timer
  try {
    return await Promise.race([
      skill(bot, { ...args, signal: controller.signal }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`Skill ${name} timed out after ${timeout} ms`))
        }, timeout)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {object} bot
 * @param {{ name: string, timeout?: number, steps: Array<{ skill: string, args?: object, name?: string, timeout?: number }> }} scenario
 *   `scenario.timeout` bounds the whole scenario; `step.timeout` (default 10 min) bounds one step
 * @param {{ skills?: Record<string, Function>, log?: (msg: string) => void }} [opts]
 */
async function runScenario (bot, scenario, { skills = defaultSkills, log = () => {} } = {}) {
  const results = []
  const deadline = scenario.timeout != null ? Date.now() + scenario.timeout : Infinity
  for (const step of scenario.steps) {
    const stepName = step.name ?? step.skill
    const started = Date.now()
    const timeout = Math.max(0, Math.min(step.timeout ?? DEFAULT_STEP_TIMEOUT, deadline - started))
    log(`[${scenario.name}] ${stepName} ${JSON.stringify(step.args ?? {})}`)
    try {
      const result = await runSkill(bot, step.skill, step.args, { skills, timeout })
      results.push({ name: stepName, skill: step.skill, ok: true, result, ms: Date.now() - started })
    } catch (error) {
      results.push({ name: stepName, skill: step.skill, ok: false, error, ms: Date.now() - started })
      log(`[${scenario.name}] ${stepName} failed: ${error.message}`)
      return { name: scenario.name, ok: false, results }
    }
  }
  return { name: scenario.name, ok: true, results }
}

module.exports = { runSkill, runScenario, skills: defaultSkills }
