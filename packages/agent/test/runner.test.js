'use strict'
const assert = require('assert')
const { runSkill, runScenario, skills } = require('..')

const OWNERS = {
  navigate: 'U17',
  gather: 'U17',
  craft: 'U17',
  smelt: 'U17',
  mine: 'U17',
  build: 'U17',
  combat: 'U18',
  portal: 'U18',
  nether: 'U18',
  end: 'U18'
}

describe('@bedboo/agent runner (U0 skeleton)', () => {
  it('registers every planned skill with the `async (bot, args) => result` shape', () => {
    assert.deepStrictEqual(Object.keys(skills).sort(), Object.keys(OWNERS).sort())
    for (const [name, skill] of Object.entries(skills)) {
      assert.strictEqual(typeof skill, 'function', name)
      assert.strictEqual(skill.length, 2, `${name} takes (bot, args)`)
    }
  })

  it('skill stubs reject with NotImplementedError of their owner unit', async () => {
    for (const [name, unit] of Object.entries(OWNERS)) {
      await assert.rejects(skills[name]({}, {}), (err) => err.notImplemented === true && err.unit === unit, name)
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
