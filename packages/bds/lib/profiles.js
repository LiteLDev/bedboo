// owner: U1 (BDS harness & e2e infra)
'use strict'

/**
 * Test profiles: gamerules applied through the console right after "Server started." (before any
 * player joins). Suites opt in to randomness by passing `profile: 'none'` or overriding single rules
 * with `gamerules: { domobspawning: true }`. The difficulty is a server.properties value
 * (`difficulty` option, default `peaceful`), not part of the profile.
 *
 * BDS answers every rule with `Game rule <name> has been updated to <value>` (verified on 1.26.51.1).
 */
const PROFILES = Object.freeze({
  /** no mob spawning / day cycle / weather / random ticks / insomnia (phantoms) / fire spread / griefing; exact spawn point */
  deterministic: Object.freeze({
    domobspawning: false,
    dodaylightcycle: false,
    doweathercycle: false,
    randomtickspeed: 0,
    doinsomnia: false,
    dofiretick: false,
    mobgriefing: false,
    spawnradius: 0
  }),
  none: Object.freeze({})
})

/**
 * @param {'deterministic'|'none'} [profile]
 * @param {Record<string, boolean|number>} [overrides]
 * @returns {Record<string, boolean|number>} lower-cased rule → value
 */
function resolveGamerules (profile = 'deterministic', overrides = {}) {
  if (!PROFILES[profile]) throw new Error(`Unknown profile ${profile} (expected ${Object.keys(PROFILES).join('|')})`)
  const rules = { ...PROFILES[profile] }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!/^[A-Za-z]+$/.test(name)) throw new Error(`Invalid gamerule name ${name}`)
    if (typeof value !== 'boolean' && !(typeof value === 'number' && Number.isInteger(value))) {
      throw new TypeError(`gamerule ${name} must be a boolean or an integer`)
    }
    rules[name.toLowerCase()] = value
  }
  return rules
}

/** @returns {{ command: string, expect: RegExp }[]} console commands + their success output */
function gameruleCommands (rules) {
  return Object.entries(rules).map(([name, value]) => ({
    command: `gamerule ${name} ${value}`,
    expect: new RegExp(`^Game rule ${name} has been updated to ${value}$`, 'i'),
    failure: /^(Syntax error|Unknown|.*is not a valid|.*Invalid)/i
  }))
}

module.exports = { PROFILES, resolveGamerules, gameruleCommands }
