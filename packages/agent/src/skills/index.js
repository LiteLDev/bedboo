// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Skill registry: name → `async (bot, args) => result` (see ../skill.js), auto-discovered.
 *
 * Every `*.js` file in this directory (except this one) is required; a module that exports a function registers it
 * under the file's base name (`mine.js` → `mine`), and `module.exports.skills = { name: fn }` registers more names.
 * Units add skills by adding files (U18: combat, portal, nether, end) — never by editing this one.
 */
const fs = require('fs')
const path = require('path')

function discover (dir = __dirname) {
  // `discover` lives on the prototype: never an own key, so it can't be run as a skill (runSkill checks Object.hasOwn)
  const registry = Object.create({ discover })
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('.')).sort()
  for (const file of files) {
    const mod = require(path.join(dir, file))
    const name = path.basename(file, '.js')
    if (typeof mod === 'function') registry[name] = mod
    if (mod && typeof mod.skills === 'object') {
      for (const [extra, fn] of Object.entries(mod.skills)) {
        if (typeof fn === 'function') registry[extra] = fn
      }
    }
  }
  return registry
}

module.exports = discover()
