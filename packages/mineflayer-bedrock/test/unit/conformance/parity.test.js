'use strict'
// owner: U3 (parity tooling)
// Unit tests of the parity assembler (scripts/parity), run with the mineflayer-bedrock unit suite.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { REPO_ROOT, buildReference, referenceItems } = require('./reference')
const { canonicalItem, itemKey, category, displayItem, parseOwners, fragmentUnit } = require(path.join(REPO_ROOT, 'scripts/parity/lib/items'))
const { splitRow, parseTables, anchors, slug, cell } = require(path.join(REPO_ROOT, 'scripts/parity/lib/markdown'))
const { assemble } = require(path.join(REPO_ROOT, 'scripts/parity/lib/assemble'))
const { renderParity, renderDifferences, relinkCell } = require(path.join(REPO_ROOT, 'scripts/parity/lib/render'))
const { main } = require(path.join(REPO_ROOT, 'scripts/parity'))

const HEADER = '| item | kind | owner | status | asserting test |\n|---|---|---|---|---|\n'
const tmpRoots = []

/** A throw-away repo layout: docs/parity, docs/differences, packages/mineflayer-bedrock/test/… */
function tmpRepo (files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bedboo-parity-'))
  tmpRoots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  for (const d of ['docs/parity', 'docs/differences']) fs.mkdirSync(path.join(root, d), { recursive: true })
  return root
}

function codes (result, level = 'error') {
  return result.problems.filter(p => p.level === level).map(p => p.code).sort()
}

describe('parity tooling (scripts/parity)', () => {
  after(() => {
    for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  describe('item names', () => {
    it('canonicalises seed-style items', () => {
      const cases = [
        ['`bot.equip`', 'method', 'bot.equip'],
        ['`bot.connect` (d.ts only; not defined at runtime upstream)', 'method', 'bot.connect'],
        ['`Particle` (adapted by U6)', 'export', 'Particle'],
        ['`Window (base) .deposit(itemType, metadata, count, nbt)`', 'method', 'Window.deposit'],
        ['`Chest/Container .close()`', 'method', 'Chest.close'],
        ['`Furnace "update" event`', 'event', 'Furnace:update'],
        ['`Furnace .fuel`', 'property', 'Furnace.fuel'],
        ['`villager.trade(tradeIndex, [times])`', 'method', 'Villager.trade'],
        ['`blockUpdate:(x, y, z)`', 'event', 'blockUpdate:(x, y, z)'],
        ['`windowOpen`', 'event', 'windowOpen'],
        ['`chestLidMove`', 'event', 'chestLidMove'],
        ['`anvil`', 'test', 'anvil'],
        ['`internalTest › entities › metadata`', 'test', 'internalTest › entities › metadata']
      ]
      for (const [cell, kind, name] of cases) assert.strictEqual(canonicalItem(cell, kind).name, name, cell)
      assert.strictEqual(itemKey('method', '`bot.dig(block)`'), 'method|bot.dig')
      assert.strictEqual(category('method', '`Furnace .takeFuel()`'), 'window')
      assert.strictEqual(category('test', '`internalTest › bed`'), 'internal-test')
      assert.deepStrictEqual(parseOwners('U4 → U5'), ['U4', 'U5'])
      assert.strictEqual(fragmentUnit('U3-internal-tests.md'), 'U3')
    })

    it('every reference item round-trips through its display name', async () => {
      const ref = await buildReference()
      for (const item of referenceItems(ref)) {
        assert.strictEqual(canonicalItem(item.display, item.kind).name, item.name, item.display)
        assert.strictEqual(category(item.kind, item.display), item.category, item.display)
      }
      assert.strictEqual(displayItem('event', 'Villager:ready'), '`Villager "ready" event`')
    })
  })

  describe('markdown', () => {
    it('splits rows on unescaped pipes outside code spans', () => {
      assert.deepStrictEqual(splitRow('| `a|b` | c \\| d | e |'), ['`a|b`', 'c \\| d', 'e'])
    })

    it('escapes every pipe of a written cell (also consecutive ones)', () => {
      assert.strictEqual(cell('x || y \\| z'), 'x \\|\\| y \\| z')
      assert.deepStrictEqual(splitRow(`| ${cell('a || b')} | c |`), ['a \\|\\| b', 'c'])
    })

    it('reads tables with annotated headers and skips code fences', () => {
      const text = '# T\n## Section\n| item | kind (property/method) | owner |\n|---|---|---|\n| `x` | method | U1 |\n\n```md\n| a | b |\n|---|---|\n```\n'
      const tables = parseTables(text)
      assert.strictEqual(tables.length, 1)
      assert.deepStrictEqual(tables[0].header, ['item', 'kind', 'owner'])
      assert.strictEqual(tables[0].heading, 'Section')
      assert.strictEqual(tables[0].rows[0].line, 5)
    })

    it('collects explicit and heading anchors', () => {
      const a = anchors('### No teams {#no-teams}\n## Bedrock `names` here\n<a id="x"></a>')
      assert.ok(a.has('no-teams') && a.has('x') && a.has(slug('Bedrock `names` here')))
    })

    it('relinks relative links from a fragment to docs/', () => {
      const docs = path.join(REPO_ROOT, 'docs')
      assert.strictEqual(relinkCell('[e](../differences/U6.md#no-teams)', path.join(docs, 'parity'), docs), '[e](differences/U6.md#no-teams)')
      assert.strictEqual(relinkCell('[w](https://x.y/z)', path.join(docs, 'parity'), docs), '[w](https://x.y/z)')
    })
  })

  describe('assemble', () => {
    it('unit fragments override the seed; a multi-wave hand-off picks the later unit', () => {
      const root = tmpRepo({
        'docs/parity/U0-seed.md': HEADER + '| `bot.look` | method | U4 → U5 | todo |  |\n| `bot.equip` | method | U8 | todo |  |\n',
        'docs/parity/U4.md': HEADER + '| `bot.look` | method | U4 → U5 | todo | stationary stub only |\n',
        'docs/parity/U5.md': HEADER + '| `bot.look` | method | U4 → U5 | done | `t/look.test.js` › "look" |\n',
        'packages/mineflayer-bedrock/t/look.test.js': ''
      })
      const r = assemble({ repoRoot: root })
      assert.deepStrictEqual(codes(r), [])
      const look = r.byKey.get('method|bot.look')
      assert.strictEqual(look.status, 'done')
      assert.strictEqual(look.source, 'U5.md')
      assert.strictEqual(r.byKey.get('method|bot.equip').source, 'U0-seed.md')
      assert.strictEqual(r.summary.byUnit.U5.done, 1)
      assert.strictEqual(r.summary.byUnit.U8.todo, 1)
    })

    it('flags duplicate claims, foreign rows, missing owners and bad kinds/statuses', () => {
      const root = tmpRepo({
        'docs/parity/U0-seed.md': HEADER + '| `bot.attack` | method | U7 | todo |  |\n| `bot.nobody` | property |  | todo |  |\n| `bot.weird` | thing | U4 | maybe |  |\n',
        'docs/parity/U7.md': HEADER + '| `bot.attack` | method | U7 | todo |  |\n',
        'docs/parity/U8.md': HEADER + '| `bot.attack` | method | U8 | todo |  |\n| `bot.equip` | method | U7 | todo |  |\n'
      })
      const r = assemble({ repoRoot: root })
      assert.deepStrictEqual(codes(r), ['bad-kind', 'bad-status', 'duplicate', 'foreign-row', 'foreign-row', 'no-owner'])
    })

    it('rejects fragments not named after a unit and one unit listing an item twice', () => {
      const root = tmpRepo({
        'docs/parity/U0-seed.md': HEADER + '| `bot.equip` | method | U8 | todo |  |\n',
        'docs/parity/notes.md': HEADER + '| `bot.equip` | method | U8 | done | `x.test.js` |\n',
        'docs/parity/U8.md': HEADER + '| `bot.equip` | method | U8 | todo |  |\n',
        'docs/parity/U8-windows.md': HEADER + '| `bot.equip` | method | U8 | todo |  |\n'
      })
      const r = assemble({ repoRoot: root })
      assert.deepStrictEqual(codes(r), ['bad-fragment', 'duplicate'])
      assert.strictEqual(r.byKey.get('method|bot.equip').status, 'todo')
    })

    it('requires an existing asserting test for done/adapted and a valid differences link for adapted/n.a.', () => {
      const root = tmpRepo({
        'docs/parity/U6.md': HEADER +
          '| `bot.chat` | method | U6 | done |  |\n' +
          '| `bot.whisper` | method | U6 | done | `test/unit/nope.test.js` › "x" |\n' +
          '| `bot.teams` | property | U6 | n.a. | none |\n' +
          '| `bot.teamMap` | property | U6 | n.a. | [no teams](../differences/U6.md#no-such-entry) |\n' +
          '| `teamCreated` | event | U6 | n.a. | [no teams](../differences/U6.md#no-teams) |\n' +
          '| `bot.tablist` | property | U6 | adapted | `test/unit/tab.test.js` › "t"; [d](../differences/U6.md#no-teams) |\n' +
          '| `actionBar` | event | U6 | done | `test/unit/chat.test.js` (to write) |\n',
        'docs/differences/U6.md': '# Differences — U6\n\n### No teams {#no-teams}\n- **Affects:** `bot.teams`\n',
        'packages/mineflayer-bedrock/test/unit/tab.test.js': ''
      })
      const r = assemble({ repoRoot: root })
      assert.deepStrictEqual(codes(r), ['bad-diff-link', 'bad-test', 'no-diff-link', 'no-test', 'no-test'])
    })

    it('reports reference items missing from every fragment, unknown rows, and todo rows in final mode', () => {
      const root = tmpRepo({ 'docs/parity/U0-seed.md': HEADER + '| `bot.chat` | method | U4 | todo |  |\n| `bot.typo` | method | U4 | todo |  |\n| `bot.connect` | method | U4 | todo |  |\n' })
      const reference = {
        mineflayer: '4.39.0',
        items: [{ kind: 'method', name: 'bot.chat', display: '`bot.chat`' }, { kind: 'event', name: 'chat', display: '`chat`' }],
        excluded: [{ kind: 'method', name: 'bot.connect', reason: 'd.ts only' }]
      }
      const r = assemble({ repoRoot: root, reference, final: true })
      assert.deepStrictEqual(codes(r), ['missing', 'todo', 'todo', 'todo'])
      assert.deepStrictEqual(codes(r, 'warning'), ['unknown'])
      assert.strictEqual(r.byKey.get('method|bot.connect').excluded, 'd.ts only')
    })

    it('treats `parity:seed` fragments as checklists (any owner) below unit fragments', () => {
      const root = tmpRepo({
        'docs/parity/U0-seed.md': HEADER + '| `bot.chat` | method | U4 | todo |  |\n',
        'docs/parity/U3-internal-tests.md': '<!-- parity:seed -->\n' + HEADER + '| `internalTest › bed` | test | U9 → U14 | todo |  |\n| `bot.chat` | method | U4 | todo |  |\n',
        'docs/parity/U9.md': HEADER + '| `internalTest › bed` | test | U9 → U14 | todo | half done |\n'
      })
      const r = assemble({ repoRoot: root })
      assert.deepStrictEqual(codes(r), ['duplicate']) // bot.chat in two checklists
      assert.strictEqual(r.byKey.get('test|internalTest › bed').source, 'U9.md')
    })
  })

  describe('render', () => {
    it('writes the matrix with coverage summaries and the differences document', () => {
      const root = tmpRepo({
        'docs/parity/U0-seed.md': HEADER + '| `bot.teams` | property | U6 | todo |  |\n| `chat` | event | U6 | todo |  |\n',
        'docs/parity/U6.md': HEADER + '| `bot.teams` | property | U6 | n.a. | [no teams](../differences/U6.md#no-teams) |\n',
        'docs/differences/U6.md': '# Differences — U6\n\n### No teams {#no-teams}\n- **Affects:** `bot.teams`\n'
      })
      const r = assemble({ repoRoot: root })
      const outDir = path.join(root, 'docs')
      const md = renderParity(r, { repoRoot: root, outDir })
      assert.match(md, /## Coverage per unit/)
      assert.match(md, /\| U6 \| 2 \| 0 \| 0 \| 1 \| 1 \| 50% \|/)
      assert.match(md, /\| `bot\.teams` \| property \| U6 \| n\.a\. \| \[no teams\]\(differences\/U6\.md#no-teams\) \| from U6\.md \|/)
      const diff = renderDifferences(r, { repoRoot: root, outDir })
      assert.match(diff, /## U6/)
      assert.match(diff, /#### No teams \{#no-teams\}/)
    })
  })

  describe('CLI', () => {
    it('rejects unknown options and checks the repository fragments', async () => {
      const log = console.log
      const err = console.error
      console.log = () => {}
      console.error = () => {}
      try {
        assert.strictEqual(await main(['--bogus']), 2)
        assert.strictEqual(await main(['--', '--check', '--quiet']), 0)
      } finally {
        console.log = log
        console.error = err
      }
    })
  })
})
