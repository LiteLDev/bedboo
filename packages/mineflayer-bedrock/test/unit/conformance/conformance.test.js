'use strict'
/**
 * Conformance of mineflayer-bedrock with mineflayer 4.39.0 — no server needed.
 *
 * Reference surface (./reference.js): built from upstream itself — a real mineflayer bot (fake Java
 * client) + its window openers + a static scan of its lib/ + its index.d.ts (TypeScript compiler) +
 * master's abilities plugin. `bot.connect` and other d.ts-only drift are excluded.
 * Bedrock surface (./bedrock.js): a mineflayer-bedrock bot on a fake bedrock-protocol client, the same
 * window probe, and a replay of the recorded BDS join (test/fixtures join_flat).
 *
 * Fails now: missing members/exports, wrong arity, wrong sync/promise kind, wrong value type, top-level
 * extras (Bedrock-only members belong under bot.bedrock), index.d.ts gaps.
 * Pending (fails only in strict mode, ./config.js): notImplemented stubs, members not yet produced by the
 * join replay, window members that cannot be probed, join replay errors.
 *
 *   cd packages/mineflayer-bedrock
 *   node --test --require ./test/strict-features.js test/unit/conformance/conformance.test.js   # this suite only
 *   BEDBOO_CONFORMANCE_STRICT=0 node --test …   # non-failing mode
 *   BEDBOO_CONFORMANCE_REPORT=1 node --test …   # list every pending item
 */
const { describe, it, before } = require('node:test')
const assert = require('assert')
const { buildReference } = require('./reference')
const { injectSurface, postJoinSurface, dtsSurface } = require('./bedrock')
const { compare } = require('./compare')
const { isStrict } = require('./config')

const STRICT = isStrict()

function format (findings) {
  return findings.map(f => `  - ${f.item}${f.kind ? ` (${f.kind})` : ''}: ${f.message}`).join('\n')
}

describe(`conformance with mineflayer 4.39.0 (${STRICT ? 'strict' : 'non-strict'} mode)`, () => {
  let ref, findings

  before(async () => {
    ref = await buildReference()
    const inject = await injectSurface()
    let post
    try {
      post = await postJoinSurface()
    } catch (err) {
      post = { failed: err }
    }
    findings = compare(ref, { ...inject, post, dts: dtsSurface() })
  }, { timeout: 60000 })

  function check (areas) {
    const relevant = findings.filter(f => areas.includes(f.area))
    const failing = relevant.filter(f => f.severity === 'fail' || (STRICT && f.severity === 'pending'))
    assert.ok(failing.length === 0, `${failing.length} conformance failure(s):\n${format(failing)}`)
  }

  it('the reference surface is complete (sanity)', () => {
    assert.ok(Object.keys(ref.exports).length >= 10)
    assert.ok(Object.values(ref.members).filter(m => m.kind === 'method').length > 100)
    assert.ok(Object.keys(ref.events).length > 100)
    assert.ok(!ref.members['bot.connect'], 'bot.connect (d.ts only) must be excluded')
    for (const p of ['bot.signBook', 'bot.findPlayer', 'bot.findPlayers', 'bot.isAlive', 'bot.vehicle', 'bot.uuidToUsername', 'bot.rainState', 'bot.abilities']) {
      assert.ok(ref.members[p], `${p} (runtime only) must be in the reference`)
    }
    assert.ok(ref.events.abilities && ref.events['chat:name'] && ref.events.entityPlaced)
    assert.ok(ref.windows['Furnace.putFuel'] && ref.windows['Window.deposit'] && ref.windows['Villager.trade'])
  })

  it('module exports match mineflayer', () => check(['exports']))

  it('plugins inject without emitting \'error\'', () => check(['inject']))

  it('bot properties exist with compatible value types', () => check(['properties']))

  it('bot methods exist with upstream arity and sync/promise kind', () => check(['methods']))

  it('no top-level members beyond mineflayer\'s (Bedrock extras live under bot.bedrock)', () => check(['extras']))

  it('members created on join (bot.entity, bot.game.*, …) after replaying the recorded BDS join', () => check(['join']))

  it('window classes (Chest/Dispenser/Furnace/EnchantmentTable/Anvil/Villager) members', () => check(['windows']))

  it('index.d.ts declares the mineflayer 4.39.0 types', () => check(['dts']))

  it('pending items', (t) => {
    const pending = findings.filter(f => f.severity === 'pending')
    if (process.env.BEDBOO_CONFORMANCE_REPORT) console.log(format(pending))
    if (STRICT) assert.ok(pending.length === 0, `${pending.length} pending item(s) in strict mode:\n${format(pending)}`)
    else if (pending.length) t.skip(`pending: ${pending.length} item(s)`)
  })
})
