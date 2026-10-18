// owner: U17 (agent core & overworld milestones)
'use strict'

/**
 * Skill interface (shared by U17 and U18).
 *
 * A skill is `async (bot, args) => result`:
 * - `bot`    a spawned mineflayer-bedrock bot (only the public mineflayer API + ecosystem plugins
 *            loaded by the runner: pathfinder, pvp, collectblock, tool, armor-manager, auto-eat;
 *            never `bot._client` — skills must work exactly like on Java)
 * - `args`   plain JSON-serialisable object (logged by the runner)
 * - result   plain JSON-serialisable object describing what was achieved, e.g.
 *            `{ collected: { oak_log: 8 } }`; throw (reject) on failure with a descriptive Error
 * Skills must be cancellable through `args.signal` (AbortSignal) when they loop, and must not
 * use cheats (commands) — cheat-assisted setup belongs to scenario `setup` steps run by the runner.
 *
 * Skills are registered by name in src/skills/index.js.
 */

const { NotImplementedError } = require('./errors')

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

module.exports = { stubSkill }
