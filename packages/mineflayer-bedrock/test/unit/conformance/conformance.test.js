'use strict'
// owner: U3 (parity tooling)
/**
 * Conformance of mineflayer-bedrock with mineflayer 4.39.0 — no server needed.
 *
 * Reference surface (./reference.js): built from upstream itself — a real mineflayer bot (fake Java
 * client) + its window openers + a static scan of its lib/ + docs/upstream/index.d.ts (TypeScript
 * compiler) + master's abilities plugin. `bot.connect` and other d.ts-only drift are excluded.
 * Bedrock surface (./bedrock.js): a mineflayer-bedrock bot on a fake bedrock-protocol client, the same
 * window probe, and a replay of the recorded BDS join (test/fixtures join_flat).
 *
 * Fails now: missing members/exports, wrong arity, wrong sync/promise kind, wrong value type, top-level
 * extras (Bedrock-only members belong under bot.bedrock), index.d.ts gaps, events without a parity row,
 * parity fragment errors (`corepack pnpm parity --check`).
 * Pending (fails only in strict mode, ./config.js): notImplemented stubs, members not yet produced by the
 * join replay, window members that cannot be probed, events without an asserting test, join replay errors.
 *
 *   cd packages/mineflayer-bedrock
 *   npx mocha --no-config --timeout 60000 test/unit/conformance/conformance.test.js   # this suite only
 *   BEDBOO_CONFORMANCE_STRICT=1 npx mocha …                                           # failing mode
 *   BEDBOO_CONFORMANCE_REPORT=1 npx mocha …                                           # list every pending item
 */
const assert = require('assert')
const path = require('path')
const { buildReference, referenceItems, REPO_ROOT } = require('./reference')
const { injectSurface, postJoinSurface, dtsSurface } = require('./bedrock')
const { compare } = require('./compare')
const { isStrict } = require('./config')
const { assemble } = require(path.join(REPO_ROOT, 'scripts/parity/lib/assemble'))

const STRICT = isStrict()

function format (findings) {
  return findings.map(f => `  - ${f.item}${f.kind ? ` (${f.kind})` : ''}: ${f.message}${f.unit ? ` [${f.unit}]` : ''}`).join('\n')
}

describe(`conformance with mineflayer 4.39.0 (${STRICT ? 'strict' : 'non-strict'} mode)`, function () {
  this.timeout(60000)
  let ref, findings, parity

  before(async function () {
    ref = await buildReference()
    const inject = await injectSurface()
    let post
    try {
      post = await postJoinSurface()
    } catch (err) {
      post = { failed: err }
    }
    parity = assemble({
      repoRoot: REPO_ROOT,
      reference: { mineflayer: ref.meta.mineflayer, items: referenceItems(ref), excluded: ref.excluded }
    })
    findings = compare(ref, { ...inject, post, dts: dtsSurface() }, { parity })
  })

  function check (areas) {
    const relevant = findings.filter(f => areas.includes(f.area))
    const failing = relevant.filter(f => f.severity === 'fail' || (STRICT && f.severity === 'pending'))
    assert.ok(failing.length === 0, `${failing.length} conformance failure(s):\n${format(failing)}`)
  }

  it('the reference surface is complete (sanity)', () => {
    assert.ok(Object.keys(ref.exports).length >= 10)
    assert.ok(Object.values(ref.members).filter(m => m.kind === 'method').length > 100)
    assert.ok(Object.keys(ref.events).length > 100)
    assert.strictEqual(ref.tests.external.length, 46)
    assert.ok(ref.tests.internal.length > 20)
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

  it('every mineflayer event is tracked in the parity fragments (with an asserting test in strict mode)', () => check(['events']))

  it('index.d.ts declares the mineflayer 4.39.0 types', () => check(['dts']))

  it('parity fragments are consistent (corepack pnpm parity --check)', () => {
    const errors = parity.problems.filter(p => p.level === 'error')
    assert.ok(errors.length === 0, `${errors.length} parity error(s):\n${errors.map(p => `  - ${p.code}: ${p.message}${p.file ? ` (${p.file}:${p.line})` : ''}`).join('\n')}`)
  })

  it('pending items', function () {
    const pending = findings.filter(f => f.severity === 'pending')
    const perUnit = {}
    for (const f of pending) perUnit[f.unit ?? '?'] = (perUnit[f.unit ?? '?'] || 0) + 1
    const units = Object.entries(perUnit).sort(([a], [b]) => (Number(a.slice(1)) || 0) - (Number(b.slice(1)) || 0))
    this.test.title = pending.length
      ? `pending: ${pending.length} item(s) — ${units.map(([u, n]) => `${u} ${n}`).join(', ')}`
      : 'pending: none'
    if (process.env.BEDBOO_CONFORMANCE_REPORT) console.log(format(pending))
    if (STRICT) assert.ok(pending.length === 0, `${pending.length} pending item(s) in strict mode:\n${format(pending)}`)
    else if (pending.length) this.skip()
  })
})
