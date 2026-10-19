// owner: U17 (agent core & overworld milestones)
'use strict'

/**
 * Skill interface (shared by U17 and U18).
 *
 * A skill is `async (bot, args) => result`:
 * - `bot`    a spawned mineflayer-bedrock bot (only the public mineflayer API + ecosystem plugins
 *            loaded by the runner: pathfinder, pvp, collectblock, tool, armor-manager, auto-eat;
 *            never `bot._client` — skills must work exactly like on Java)
 * - `args`   plain JSON-serialisable object (logged by the runner) + `signal` (AbortSignal, set by the runner)
 * - result   plain JSON-serialisable object describing what was achieved, e.g.
 *            `{ collected: { oak_log: 8 } }`; throw (reject) on failure — preferably a `SkillError` with a `code`
 * Skills must be cancellable through `args.signal` when they loop, and must not use cheats (commands) —
 * cheat-assisted setup belongs to scenario `setup` steps run by the harness.
 *
 * Registration: every `src/skills/<name>.js` that exports a function is the skill `<name>` (auto-discovered by
 * src/skills/index.js); a module may also export `skills: { otherName: fn }` to register more than one.
 *
 * Skills report progress with `log(bot, msg)` / `progress(bot, type, data)`: the Agent (src/runner.js) attached to
 * the bot turns them into its event stream and JSON report; without an Agent they are dropped (or printed with
 * `BEDBOO_AGENT_LOG=1`). Skills that wait use `sleep(ms, signal)` / `withTimeout()` so an abort stops them.
 */

const { NotImplementedError, AbortError, SkillError } = require('./errors')

/**
 * Stub skill for an owner unit (rejects with NotImplementedError).
 * @param {string} unit e.g. 'U17'
 * @param {string} name skill name
 */
function stubSkill (unit, name) {
  const skill = async function (bot, args) {
    throw new NotImplementedError(unit, `skill ${name}`)
  }
  Object.defineProperty(skill, 'name', { value: name })
  skill.notImplemented = true
  skill.unit = unit
  return skill
}

/**
 * Name a skill function and attach metadata (shown by the runner / README).
 * @param {string} name
 * @param {(bot: object, args: object) => Promise<object>} fn
 * @param {{ description?: string, args?: object }} [meta]
 */
function defineSkill (name, fn, meta = {}) {
  const skill = async function (bot, args) { return fn(bot, args ?? {}) }
  Object.defineProperty(skill, 'name', { value: name })
  skill.skillName = name
  skill.description = meta.description ?? ''
  if (meta.args) skill.args = meta.args
  return skill
}

// ---- per-bot context: the Agent registers its logger / event sink here -------------------------------------------

const contexts = new WeakMap()

/** @typedef {{ log: (msg: string) => void, progress: (type: string, data?: object) => void, agent?: object }} SkillContext */

/** attach a context to a bot (the Agent does it) */
function setContext (bot, ctx) {
  contexts.set(bot, ctx)
}

/** @returns {SkillContext} */
function context (bot) {
  let ctx = contexts.get(bot)
  if (!ctx) {
    const print = process.env.BEDBOO_AGENT_LOG ? (msg) => console.error(`[agent] ${msg}`) : () => {}
    ctx = { log: print, progress: (type, data) => print(`${type} ${JSON.stringify(data ?? {})}`) }
    contexts.set(bot, ctx)
  }
  return ctx
}

/** skill log line (goes to the Agent's event stream) */
function log (bot, msg) {
  context(bot).log(msg)
}

/** structured progress event (goes to the Agent's event stream and report) */
function progress (bot, type, data) {
  context(bot).progress(type, data)
}

/**
 * "Still working, standing still on purpose" (waiting for a furnace, a fish, the morning): keeps the Agent's stuck
 * watchdog quiet. Not recorded in the report.
 */
function heartbeat (bot) {
  const ctx = contexts.get(bot)
  if (ctx?.agent) ctx.progress('heartbeat')
}

/** the Agent driving this bot, if any */
function agentOf (bot) {
  return contexts.get(bot)?.agent ?? null
}

// ---- abortable waiting --------------------------------------------------------------------------------------------

/** resolves after `ms`, rejects with AbortError when `signal` aborts first */
function sleep (ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError())
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(new AbortError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Race `promise` against a timeout and the abort signal.
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {{ signal?: AbortSignal, message?: string, onTimeout?: () => void }} [opts]
 * @returns {Promise<T>}
 * @template T
 */
function withTimeout (promise, ms, { signal, message, onTimeout } = {}) {
  let timer
  let onAbort
  const guard = new Promise((resolve, reject) => {
    if (Number.isFinite(ms)) {
      timer = setTimeout(() => {
        try { onTimeout?.() } catch {}
        reject(new SkillError(message ?? `timed out after ${ms} ms`, { code: 'TIMEOUT' }))
      }, ms)
    }
    if (signal) {
      onAbort = () => { try { onTimeout?.() } catch {} reject(new AbortError()) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  promise.catch(() => {}) // a loser's late rejection is not unhandled
  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })
}

/** wait `n` physics ticks (wall clock fallback: no physicsTick while dead / unloaded) */
function waitTicks (bot, n, signal) {
  const ticks = Math.max(1, Math.round(n))
  let timer
  const fallback = new Promise((resolve) => { timer = setTimeout(resolve, ticks * 50 + 1000) })
  return withTimeout(Promise.race([bot.waitForTicks(ticks).catch(() => {}), fallback]), Infinity, { signal })
    .finally(() => clearTimeout(timer))
}

module.exports = { stubSkill, defineSkill, setContext, context, log, progress, heartbeat, agentOf, sleep, withTimeout, waitTicks }
