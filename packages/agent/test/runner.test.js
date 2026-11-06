'use strict'
const { describe, it } = require('node:test')
const assert = require('assert')
const { runSkill, runScenario, skills } = require('..')

const SKILLS = ['navigate', 'explore', 'gather', 'craft', 'smelt', 'mine', 'build', 'obtain', 'combat', 'portal', 'nether', 'end']

describe('@bedboo/agent runner', () => {
  it('auto-discovers every skill file with the `async (bot, args) => result` shape', () => {
    for (const name of SKILLS) assert.ok(Object.hasOwn(skills, name), `skill ${name} registered`)
    for (const [name, skill] of Object.entries(skills)) {
      assert.strictEqual(typeof skill, 'function', name)
      assert.strictEqual(skill.length, 2, `${name} takes (bot, args)`)
    }
  })

  it('a new file in src/skills registers itself (and `skills: {}` extras)', () => {
    const fs = require('fs')
    const os = require('os')
    const path = require('path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'))
    try {
      fs.writeFileSync(path.join(dir, 'dance.js'), 'module.exports = async function dance (bot, args) { return { danced: true } }\nmodule.exports.skills = { twirl: async (bot, args) => 1 }\n')
      fs.writeFileSync(path.join(dir, 'helpers.js'), 'module.exports = { notASkill: 1 }\n')
      const found = skills.discover(dir)
      assert.deepStrictEqual(Object.keys(found).sort(), ['dance', 'twirl'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runScenario runs steps in order, passes args + signal, stops at the first failure', async () => {
    const calls = []
    const fake = {
      a: async (bot, args) => { calls.push(['a', args.n, args.signal instanceof AbortSignal]); return { n: args.n } },
      boom: async () => { throw new Error('nope') }
    }
    const report = await runScenario({}, {
      name: 'demo',
      steps: [{ skill: 'a', args: { n: 1 } }, { skill: 'a', args: { n: 2 } }, { skill: 'boom' }, { skill: 'a', args: { n: 3 } }]
    }, { skills: fake })
    assert.strictEqual(report.ok, false)
    assert.deepStrictEqual(calls, [['a', 1, true], ['a', 2, true]])
    assert.deepStrictEqual(report.results.map(r => r.ok), [true, true, false])
    assert.deepStrictEqual(report.results[1].result, { n: 2 })
    assert.match(report.results[2].error.message, /nope/)
  })

  it('runSkill enforces the timeout and aborts the skill signal', async () => {
    let signal
    const slow = (bot, args) => { signal = args.signal; return new Promise(() => {}) }
    await assert.rejects(runSkill({}, 'slow', {}, { skills: { slow }, timeout: 20 }), /timed out/)
    assert.strictEqual(signal.aborted, true)
  })

  it('runSkill rejects unknown skills (including Object.prototype names)', async () => {
    await assert.rejects(runSkill({}, 'fly-to-the-moon'), /Unknown skill/)
    await assert.rejects(runSkill({}, 'constructor'), /Unknown skill/)
    await assert.rejects(runSkill({}, 'toString'), /Unknown skill/)
  })

  it('scenario.timeout bounds the whole scenario', async () => {
    const wait = (bot, args) => new Promise((resolve) => setTimeout(resolve, 30))
    const hang = () => new Promise(() => {})
    const report = await runScenario({}, { name: 't', timeout: 60, steps: [{ skill: 'wait' }, { skill: 'hang' }] }, { skills: { wait, hang } })
    assert.strictEqual(report.ok, false)
    assert.match(report.results[1].error.message, /timed out/)
  })
})
