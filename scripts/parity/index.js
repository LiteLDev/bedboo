#!/usr/bin/env node
// owner: U3 (parity tooling)
'use strict'
/**
 * `corepack pnpm parity [options]` — assemble docs/parity/*.md into docs/parity.md and
 * docs/differences/*.md into docs/differences.md, and report problems.
 *
 *   --check         validate only (write nothing); exit 1 if there is any error
 *   --final         also require every row to be done/adapted/n.a. (final acceptance); exit 1 on errors
 *   --no-reference  skip the cross-check against the conformance reference surface (faster; no
 *                   "missing upstream item" detection)
 *   --json          print the assembled result as JSON instead of the text report
 *   --quiet         print errors only
 *
 * The reference surface (every upstream mineflayer 4.39.0 member/event/window member/test) is built by
 * packages/mineflayer-bedrock/test/unit/conformance/reference.js — the same one the conformance test
 * uses — so an upstream item that no fragment lists is reported as `missing`.
 */
const fs = require('fs')
const path = require('path')
const { assemble } = require('./lib/assemble')
const { renderParity, renderDifferences, unitOrder } = require('./lib/render')

const REPO_ROOT = path.join(__dirname, '../..')

async function loadReference () {
  const conformance = path.join(REPO_ROOT, 'packages/mineflayer-bedrock/test/unit/conformance/reference.js')
  const { buildReference, referenceItems } = require(conformance)
  const ref = await buildReference()
  return { mineflayer: ref.meta.mineflayer, items: referenceItems(ref), excluded: ref.excluded }
}

function formatProblem (p) {
  const where = p.file ? ` (${p.file}${p.line ? ':' + p.line : ''})` : ''
  return `  ${p.level === 'error' ? 'ERROR' : 'warn '} ${p.code}: ${p.message}${where}`
}

async function main (argv) {
  const args = new Set(argv.filter(a => a !== '--')) // `pnpm parity -- --check` passes the separator through
  const unknown = [...args].filter(a => !['--check', '--final', '--no-reference', '--json', '--quiet'].includes(a))
  if (unknown.length) {
    console.error(`parity: unknown option(s) ${unknown.join(' ')}`)
    return 2
  }
  const reference = args.has('--no-reference') ? null : await loadReference()
  const result = assemble({ repoRoot: REPO_ROOT, reference, final: args.has('--final') })
  const errors = result.problems.filter(p => p.level === 'error')
  const warnings = result.problems.filter(p => p.level === 'warning')

  if (!args.has('--check')) {
    const outDir = path.join(REPO_ROOT, 'docs')
    fs.writeFileSync(path.join(outDir, 'parity.md'), renderParity(result, { repoRoot: REPO_ROOT, outDir, reference }))
    fs.writeFileSync(path.join(outDir, 'differences.md'), renderDifferences(result, { repoRoot: REPO_ROOT, outDir }))
  }

  if (args.has('--json')) {
    console.log(JSON.stringify({ summary: result.summary, problems: result.problems, rows: result.rows }, null, 2))
  } else {
    if (!args.has('--quiet')) {
      const t = result.summary.total
      console.log(`parity: ${result.fragments.length} fragment(s), ${t.total} rows — ${t.done} done, ${t.adapted} adapted, ${t['n.a.']} n.a., ${t.todo} todo`)
      const units = Object.entries(result.summary.byUnit).sort(([a], [b]) => unitOrder(a) - unitOrder(b))
      console.log('  per unit: ' + units.map(([u, b]) => `${u} ${b.total - b.todo}/${b.total}`).join(', '))
      console.log('  per kind: ' + Object.entries(result.summary.byCategory).map(([k, b]) => `${k} ${b.total - b.todo}/${b.total}`).join(', '))
      if (reference) console.log(`  reference: mineflayer ${reference.mineflayer}, ${reference.items.length} items`)
      if (!args.has('--check')) console.log('  wrote docs/parity.md, docs/differences.md')
      for (const p of warnings) console.log(formatProblem(p))
    }
    for (const p of errors) console.log(formatProblem(p))
    if (errors.length || !args.has('--quiet')) console.log(`parity: ${errors.length} error(s), ${warnings.length} warning(s)`)
  }
  return (args.has('--check') || args.has('--final')) && errors.length ? 1 : 0
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => {
    console.error(err)
    process.exit(2)
  })
}

module.exports = { main }
