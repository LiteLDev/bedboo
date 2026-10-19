#!/usr/bin/env node
// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Regenerates src/data/smelting.json — the furnace recipes the obtain planner may use.
 *
 * BDS's crafting_data carries no furnace recipes since 1.21.50, so they are vendored from CloudburstMC/Data
 * (Apache License 2.0, Copyright CloudburstMC) `recipes.json` at commit 73bda57f9afa (1.21.40, protocol 748, the
 * last dump that still contains `type: 3` furnace recipes), filtered and vetted:
 *   - `block: 'furnace'` only (blast furnace / smoker / campfire recipes are subsets of it), no `deprecated` copies;
 *   - no gear → nugget recipes (smelting a tool or armour piece is never a way the agent should obtain anything);
 *   - every input / output must exist in the bedrock_1.26.51 registry (renamed items are mapped below);
 *   - wood types newer than 1.21.40 (pale oak, poplar) get the same charcoal recipe as the others.
 *
 *   node packages/agent/scripts/gen-smelting.js [path/to/recipes.json]   # default: downloads the pinned file
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const COMMIT = '73bda57f9afa'
const URL = `https://raw.githubusercontent.com/CloudburstMC/Data/${COMMIT}/recipes.json`
const OUT = path.join(__dirname, '..', 'src', 'data', 'smelting.json')

/** 1.21.40 names that differ in 1.26.51 */
const RENAMES = {}
/** extra charcoal sources (wood families added after 1.21.40) */
const EXTRA_LOGS = ['pale_oak_log', 'pale_oak_wood', 'stripped_pale_oak_log', 'stripped_pale_oak_wood', 'poplar_log', 'poplar_wood', 'stripped_poplar_log', 'stripped_poplar_wood']
const GEAR = /_(sword|shovel|pickaxe|axe|hoe|helmet|chestplate|leggings|boots|horse_armor)$/

/**
 * Burn time in furnace ticks (200 ticks smelt one item) — Bedrock values (same as Java for these items).
 * Only items the agent plausibly carries; `tag:` entries match by name pattern.
 */
const FUELS = {
  lava_bucket: 20000,
  coal_block: 16000,
  dried_kelp_block: 4000,
  blaze_rod: 2400,
  coal: 1600,
  charcoal: 1600,
  'tag:logs': 300,
  'tag:planks': 300,
  crafting_table: 300,
  'tag:wooden_slab': 150,
  stick: 100,
  'tag:sapling': 100
}

function load (file) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'))
  return JSON.parse(execFileSync('curl', ['-sSfL', URL], { encoding: 'utf8', maxBuffer: 64 << 20 }))
}

function main () {
  require('@bedboo/bedrock-data').install()
  const registry = require('prismarine-registry')('bedrock_1.26.51')
  const data = load(process.argv[2])
  const strip = (id) => {
    const name = id.replace(/^minecraft:/, '')
    return RENAMES[name] ?? name
  }
  const seen = new Set()
  const recipes = []
  const dropped = []
  for (const r of data.recipes) {
    if (r.type !== 3 || r.block !== 'furnace') continue
    const input = strip(r.input.id)
    const output = strip(r.output.id)
    if (GEAR.test(input)) continue
    if (!registry.itemsByName[input] || !registry.itemsByName[output]) {
      dropped.push(`${input} -> ${output}`)
      continue
    }
    const key = `${input}>${output}`
    if (seen.has(key)) continue
    seen.add(key)
    recipes.push({ input, output, count: r.output.count ?? 1 })
  }
  for (const log of EXTRA_LOGS) {
    if (registry.itemsByName[log] && !seen.has(`${log}>charcoal`)) recipes.push({ input: log, output: 'charcoal', count: 1, added: true })
  }
  recipes.sort((a, b) => a.output.localeCompare(b.output) || a.input.localeCompare(b.input))
  const doc = {
    source: `CloudburstMC/Data@${COMMIT} recipes.json (Apache-2.0, Copyright CloudburstMC), furnace recipes; filtered by packages/agent/scripts/gen-smelting.js`,
    cookTicks: 200,
    recipes,
    fuels: FUELS
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n')
  console.log(`wrote ${recipes.length} recipes to ${OUT}${dropped.length ? `; dropped (not in 1.26.51): ${dropped.join(', ')}` : ''}`)
}

main()
