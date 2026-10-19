'use strict'
// owner: U17 — the Agent's task handling and the safety lock, on a fake bot (no server)
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { Agent } = require('../src/runner')
const { Safety } = require('../src/safety')
const { sleep } = require('../src/skill')

function fakeBot () {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.health = 20
  bot.isAlive = true
  bot.game = { dimension: 'overworld' }
  bot.inventory = { items: () => [], slots: [] }
  bot.clearControlStates = () => {}
  return bot
}

describe('Agent tasks (U17)', () => {
  it('run(): result, events and the report entry', async () => {
    const skills = { hello: async (bot, args) => ({ hi: args.name }) }
    const agent = new Agent({ bot: fakeBot(), skills })
    agent.startedAt = Date.now()
    const events = []
    agent.on('event', (e) => events.push(e.type))
    assert.deepStrictEqual(await agent.run('hello', { name: 'x' }), { hi: 'x' })
    assert.deepStrictEqual(events, ['task-start', 'task-end'])
    assert.strictEqual(agent.tasks[0].ok, true)
    assert.strictEqual(agent.report().tasks.length, 1)
  })

  it('a death aborts the task, the agent recovers and retries it', async () => {
    const bot = fakeBot()
    let attempts = 0
    const skills = {
      dig: async (bot, { signal }) => {
        attempts++
        if (attempts === 1) {
          setTimeout(() => { bot.health = 0; bot.emit('death'); bot.health = 20 }, 20)
          await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
        }
        return { attempts }
      }
    }
    const agent = new Agent({ bot, skills, recoverItems: false })
    agent.startedAt = Date.now()
    bot.on('death', () => agent.onDeath()) // what start() wires up
    const r = await agent.run('dig', {}, { retries: 1 })
    assert.deepStrictEqual(r, { attempts: 2 })
    assert.strictEqual(agent.deaths.length, 1)
    assert.strictEqual(agent.tasks[0].attempts, 2)
    assert.strictEqual(agent.tasks[0].errors[0].code, 'DIED')
  })

  it('a failing step stops the scenario; verify() runs only on success and gets the start inventory', async () => {
    const skills = { ok: async () => ({}), boom: async () => { throw Object.assign(new Error('nope'), { code: 'NOT_FOUND' }) } }
    const agent = new Agent({ bot: fakeBot(), skills, keepFed: false })
    agent.startedAt = Date.now()
    let verified = null
    const good = await agent.runScenario({ name: 'good', steps: [{ skill: 'ok' }], verify: (a, start) => { verified = start; return { fine: true } } })
    assert.strictEqual(good.ok, true)
    assert.deepStrictEqual(good.verified, { fine: true })
    assert.deepStrictEqual(verified, {})
    const bad = await agent.runScenario({ name: 'bad', steps: [{ skill: 'boom' }, { skill: 'ok' }], verify: () => { throw new Error('not reached') } })
    assert.strictEqual(bad.ok, false)
    assert.match(bad.error.message, /nope/)
  })
})

describe('Safety lock (U17)', () => {
  it('idle() waits while a behaviour has the controls, rejects on abort', async () => {
    const safety = new Safety(fakeBot())
    await safety.idle()
    assert.ok(safety.claim('fight'))
    assert.ok(!safety.claim('eat'), 'one behaviour at a time')
    let released = false
    const waiting = safety.idle().then(() => { released = true })
    await sleep(10)
    assert.strictEqual(released, false)
    safety.release('eat') // not the owner: no effect
    await sleep(10)
    assert.strictEqual(released, false)
    safety.release('fight')
    await waiting
    assert.strictEqual(released, true)

    safety.claim('flee')
    const controller = new AbortController()
    const aborted = assert.rejects(safety.idle(controller.signal), (err) => err.code === 'ABORTED')
    controller.abort()
    await aborted
    await assert.rejects(safety.idle(controller.signal), (err) => err.code === 'ABORTED', 'already aborted')
  })
})
