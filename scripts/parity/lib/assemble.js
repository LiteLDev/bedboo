// owner: U3 (parity tooling)
'use strict'
/**
 * Assemble docs/parity/*.md fragments into one matrix and validate it.
 *
 * Precedence: checklists (`U0-seed.md`, and fragments marked `<!-- parity:seed -->` such as
 * `U3-internal-tests.md`) < unit fragments (`U<n>.md`, `U<n>-<topic>.md`). A unit fragment row
 * overrides the seed row with the same (kind, canonical item) — see ./items.js. When two unit
 * fragments list the same item, that is only allowed for a multi-wave hand-off named in the owner
 * column (`U4 → U5`): the unit later in that chain wins. Anything else is a duplicate claim.
 *
 * Problems (`level: 'error'` fails `pnpm parity --check`):
 *   bad-fragment (a fragment file not named after its unit), no-owner, bad-kind, bad-status,
 *   foreign-row (a fragment lists an item its unit does not own), duplicate (same item twice in a
 *   file, in two files of one unit, or claimed by two units), no-test (done/adapted without an
 *   asserting test), bad-test (asserting test names a .test.js file that does not exist),
 *   no-diff-link / bad-diff-link (adapted/n.a. without a valid docs/differences/<unit>.md link),
 *   missing (an upstream item of the conformance reference surface is in no fragment),
 *   todo (only with `final: true`: every row must be done/adapted/n.a.).
 * Warnings: unknown (a row that is not in the reference surface, e.g. Bedrock-only or a typo).
 */
const fs = require('fs')
const path = require('path')
const { parseTables, anchors } = require('./markdown')
const { KINDS, STATUSES, PLACEHOLDER_RE, DIFF_LINK_RE, canonicalItem, itemKey, category, parseOwners, fragmentUnit } = require('./items')

const SEED = 'U0-seed.md'
/**
 * Checklist fragments (rows owned by any unit, overridden by unit fragments): the seed, or a file whose
 * first line is the marker `<!-- parity:seed -->`.
 */
const SEED_MARKER = /^\uFEFF?<!--\s*parity:\s*seed\s*-->/
const NON_FRAGMENTS = new Set(['README.md', '_template.md'])
const COLUMN_ALIASES = {
  item: 'item',
  kind: 'kind',
  owner: 'owner',
  status: 'status',
  'asserting test': 'test',
  test: 'test',
  notes: 'notes',
  note: 'notes'
}

function unitNumber (unit) {
  return unit ? Number(unit.slice(1)) : Infinity
}

/** Read one fragment file → rows (only tables having item/kind/owner/status columns). */
function readFragment (file) {
  const name = path.basename(file)
  const text = fs.readFileSync(file, 'utf8')
  const rows = []
  for (const table of parseTables(text)) {
    const cols = table.header.map(h => COLUMN_ALIASES[h] || null)
    if (!['item', 'kind', 'owner', 'status'].every(c => cols.includes(c))) continue
    for (const r of table.rows) {
      const row = { file: name, line: r.line, section: table.heading }
      cols.forEach((c, i) => { if (c) row[c] = (r.cells[i] ?? '').trim() })
      row.test = row.test ?? ''
      row.notes = row.notes ?? ''
      row.kind = row.kind.toLowerCase()
      row.status = row.status.toLowerCase()
      row.owners = parseOwners(row.owner)
      row.name = canonicalItem(row.item, row.kind).name
      row.key = itemKey(row.kind, row.item)
      row.category = category(row.kind, row.item)
      rows.push(row)
    }
  }
  const seed = name === SEED || SEED_MARKER.test(text)
  return { file, name, unit: name === SEED ? 'U0' : fragmentUnit(name), seed, rows }
}

function listFragments (parityDir) {
  if (!fs.existsSync(parityDir)) return []
  return fs.readdirSync(parityDir)
    .filter(f => f.endsWith('.md') && !NON_FRAGMENTS.has(f))
    .sort((a, b) => (a === SEED ? -1 : b === SEED ? 1 : unitNumber(fragmentUnit(a)) - unitNumber(fragmentUnit(b)) || a.localeCompare(b)))
    .map(f => path.join(parityDir, f))
}

/** Differences fragments: { unit, file, name, text, anchors } */
function readDifferences (differencesDir) {
  if (!fs.existsSync(differencesDir)) return []
  return fs.readdirSync(differencesDir)
    .filter(f => f.endsWith('.md') && !NON_FRAGMENTS.has(f))
    .sort((a, b) => unitNumber(fragmentUnit(a)) - unitNumber(fragmentUnit(b)) || a.localeCompare(b))
    .map(f => {
      const file = path.join(differencesDir, f)
      const text = fs.readFileSync(file, 'utf8')
      return { unit: fragmentUnit(f), file, name: f, text, anchors: anchors(text) }
    })
}

const TEST_PATH_RE = /([\w./@-]+\.test\.js)/g

/** Locations an asserting-test path may be relative to. */
function testExists (repoRoot, p) {
  const bases = [repoRoot, path.join(repoRoot, 'packages/mineflayer-bedrock')]
  const pkgs = path.join(repoRoot, 'packages')
  if (fs.existsSync(pkgs)) for (const d of fs.readdirSync(pkgs)) bases.push(path.join(pkgs, d))
  return bases.some(b => fs.existsSync(path.join(b, p)))
}

/**
 * @param {{ repoRoot: string, parityDir?: string, differencesDir?: string,
 *           reference?: { items: {kind,name,display,category}[], excluded: {kind,name,reason}[] } | null,
 *           final?: boolean }} opts
 */
function assemble (opts) {
  const repoRoot = opts.repoRoot
  const parityDir = opts.parityDir ?? path.join(repoRoot, 'docs/parity')
  const differencesDir = opts.differencesDir ?? path.join(repoRoot, 'docs/differences')
  const fragments = listFragments(parityDir).map(readFragment)
  const differences = readDifferences(differencesDir)
  const diffByName = new Map(differences.map(d => [d.name, d]))
  const problems = []
  const problem = (level, code, message, row) => problems.push({ level, code, message, file: row?.file ?? null, line: row?.line ?? null, key: row?.key ?? null })

  // ---- per-row format checks + collection -----------------------------------------------------
  const seedRows = new Map()
  const claims = new Map() // key → [{ unit, row }]
  const order = [] // first-appearance order of keys
  for (const frag of fragments) {
    if (!frag.seed && !frag.unit) {
      problem('error', 'bad-fragment', `${frag.name}: fragment file names start with the owning unit (U<n>.md, U<n>-<topic>.md); its rows are ignored`, { file: frag.name, line: null, key: null })
      continue
    }
    const seen = new Set()
    for (const row of frag.rows) {
      if (!KINDS.includes(row.kind)) problem('error', 'bad-kind', `${row.item}: kind '${row.kind}' is not one of ${KINDS.join('/')}`, row)
      if (!STATUSES.includes(row.status)) problem('error', 'bad-status', `${row.item}: status '${row.status}' is not one of ${STATUSES.join('/')}`, row)
      if (seen.has(row.key)) problem('error', 'duplicate', `${row.item} (${row.kind}) is listed twice in ${frag.name}`, row)
      seen.add(row.key)
      if (!frag.seed && frag.unit && !row.owners.includes(frag.unit)) {
        problem('error', 'foreign-row', `${frag.name} lists ${row.item} (${row.kind}) owned by ${row.owner || 'nobody'}; a fragment may only list items its unit owns`, row)
      }
      if (!seedRows.has(row.key) && !claims.has(row.key)) order.push(row.key)
      if (frag.seed) {
        const prev = seedRows.get(row.key)
        if (prev) problem('error', 'duplicate', `${row.item} (${row.kind}) is listed in both ${prev.file} and ${frag.name}`, row)
        else seedRows.set(row.key, row)
      } else {
        if (!claims.has(row.key)) claims.set(row.key, [])
        claims.get(row.key).push({ unit: frag.unit, row })
      }
    }
  }

  // ---- merge ------------------------------------------------------------------------------------
  const rows = new Map()
  for (const key of order) {
    const seed = seedRows.get(key)
    const list = claims.get(key) || []
    if (list.length === 0) { rows.set(key, { ...seed, source: seed.file }); continue }
    // The checklist's owner column is authoritative; without one, the first claimant's owner column.
    const chain = seed ? seed.owners : list[0].row.owners
    if (seed) {
      for (const c of list) {
        if (c.row.owners.includes(c.unit) && !chain.includes(c.unit)) {
          problem('error', 'foreign-row', `${c.row.file} lists ${c.row.item} (${c.row.kind}) but ${seed.file} assigns it to ${seed.owner || 'nobody'}`, c.row)
        }
      }
    }
    let winner = list[list.length - 1]
    const units = [...new Set(list.map(c => c.unit))]
    if (units.length < list.length) {
      const files = list.map(c => c.row.file)
      problem('error', 'duplicate', `${winner.row.item} (${winner.row.kind}) is listed in several fragments of the same unit (${files.join(', ')})`, winner.row)
    }
    if (units.length > 1) {
      if (units.every(u => chain.includes(u))) {
        // multi-wave hand-off (`U4 → U5`): the unit later in the chain wins
        winner = list.reduce((best, c) => chain.lastIndexOf(c.unit) >= chain.lastIndexOf(best.unit) ? c : best)
      } else {
        problem('error', 'duplicate', `${winner.row.item} (${winner.row.kind}) is claimed by ${units.join(' and ')} (${list.map(c => c.row.file).join(', ')}) but the owner column names ${chain.join(' → ') || 'nobody'}`, winner.row)
      }
    }
    rows.set(key, { ...winner.row, source: winner.row.file, overrides: seed ? seed.file : null })
  }

  // ---- merged-row checks --------------------------------------------------------------------------
  for (const row of rows.values()) {
    if (row.owners.length === 0) problem('error', 'no-owner', `${row.item} (${row.kind}) has no owner unit`, row)
    if (row.status === 'done' || row.status === 'adapted') {
      if (!row.test || PLACEHOLDER_RE.test(row.test)) {
        problem('error', 'no-test', `${row.item} (${row.kind}) is '${row.status}' without an asserting test`, row)
      } else {
        for (const m of row.test.matchAll(TEST_PATH_RE)) {
          if (!testExists(repoRoot, m[1])) problem('error', 'bad-test', `${row.item} (${row.kind}): asserting test file ${m[1]} does not exist`, row)
        }
      }
    }
    if (row.status === 'adapted' || row.status === 'n.a.') {
      const links = [...`${row.test} ${row.notes}`.matchAll(DIFF_LINK_RE)]
      if (links.length === 0) problem('error', 'no-diff-link', `${row.item} (${row.kind}) is '${row.status}' but links no docs/differences/U<n>.md entry`, row)
      for (const [, file, anchor] of links) {
        const diff = diffByName.get(file)
        if (!diff) problem('error', 'bad-diff-link', `${row.item} (${row.kind}): docs/differences/${file} does not exist`, row)
        else if (anchor && !diff.anchors.has(anchor)) problem('error', 'bad-diff-link', `${row.item} (${row.kind}): no entry #${anchor} in docs/differences/${file}`, row)
      }
    }
    if (opts.final && row.status === 'todo') problem('error', 'todo', `${row.item} (${row.kind}) is still todo`, row)
  }

  // ---- reference cross-check ----------------------------------------------------------------------
  if (opts.reference) {
    const refKeys = new Map(opts.reference.items.map(i => [`${i.kind}|${i.name}`, i]))
    const excluded = new Map(opts.reference.excluded.map(e => [e.name, e]))
    for (const [key, item] of refKeys) {
      if (!rows.has(key)) problem('error', 'missing', `${item.display} (${item.kind}) of the mineflayer ${opts.reference.mineflayer ?? ''} reference surface is in no parity fragment`.replace('  ', ' '), null)
    }
    for (const row of rows.values()) {
      if (refKeys.has(row.key)) continue
      if (row.name === 'bot.bedrock' || row.name.startsWith('bot.bedrock.')) continue
      const ex = excluded.get(row.name)
      if (ex) { row.excluded = ex.reason; continue }
      problem('warning', 'unknown', `${row.item} (${row.kind}) is not part of the reference surface (Bedrock-only extra, kind mismatch or typo?)`, row)
    }
  }

  return { fragments, differences, rows: [...rows.values()], byKey: rows, problems, summary: summarize([...rows.values()]) }
}

/** Status counts per final owner unit and per category. */
function summarize (rows) {
  const blank = () => ({ total: 0, todo: 0, done: 0, adapted: 0, 'n.a.': 0, other: 0 })
  const byUnit = {}
  const byCategory = {}
  const total = blank()
  for (const row of rows) {
    const unit = row.owners[row.owners.length - 1] || '(none)'
    for (const bucket of [byUnit[unit] = byUnit[unit] || blank(), byCategory[row.category] = byCategory[row.category] || blank(), total]) {
      bucket.total++
      if (bucket[row.status] !== undefined && row.status !== 'total' && row.status !== 'other') bucket[row.status]++
      else bucket.other++
    }
  }
  return { byUnit, byCategory, total }
}

module.exports = { assemble, readFragment, listFragments, readDifferences, summarize, SEED }
