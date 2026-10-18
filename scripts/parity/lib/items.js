// owner: U3 (parity tooling)
'use strict'
/**
 * Parity item naming, shared by the parity assembler (scripts/parity) and the conformance test
 * (packages/mineflayer-bedrock/test/unit/conformance).
 *
 * A parity row is identified by (kind, canonical item). The canonical form is derived from the `item`
 * cell so that units may copy a seed row and keep or drop its notes:
 *   `bot.equip`                                   → method  bot.equip
 *   `bot.connect` (d.ts only; …)                  → method  bot.connect      (text after the code span is a note)
 *   `Furnace .putInput(itemType, metadata, count)` → method Furnace.putInput (call arguments are dropped)
 *   `Furnace "update" event`                      → event   Furnace:update
 *   `Chest/Container .close()`                    → method  Chest.close
 *   `villager.trade(tradeIndex, [times])`         → method  Villager.trade
 *   `blockUpdate:(x, y, z)`                       → event   blockUpdate:(x, y, z) (events keep parentheses)
 *   `internalTest › entities › metadata`          → test    internalTest › entities › metadata
 */

const KINDS = ['export', 'property', 'method', 'event', 'test']
const STATUSES = ['todo', 'done', 'adapted', 'n.a.']
/** An asserting-test cell that only announces a test (`… (to write)`, `TBD`, `todo`). */
const PLACEHOLDER_RE = /\bto write\b|\bTBD\b|\btodo\b/i
/** Links to a differences entry: docs/differences/<file>.md[#anchor] (match[1] file, match[2] anchor). */
const DIFF_LINK_RE = /differences\/(U\d+[\w-]*\.md)(?:#([\w.:-]+))?/g

/** Window class labels used in item names → canonical class name. */
const WINDOW_CLASSES = {
  'window (base)': 'Window',
  window: 'Window',
  'chest/container': 'Chest',
  chest: 'Chest',
  container: 'Chest',
  dispenser: 'Dispenser',
  furnace: 'Furnace',
  enchantmenttable: 'EnchantmentTable',
  anvil: 'Anvil',
  villager: 'Villager'
}
/** Canonical window class → label used when the tooling writes an item name (matches the seed). */
const WINDOW_LABELS = {
  Window: 'Window (base)',
  Chest: 'Chest/Container',
  Dispenser: 'Dispenser',
  Furnace: 'Furnace',
  EnchantmentTable: 'EnchantmentTable',
  Anvil: 'Anvil',
  Villager: 'Villager'
}

const WINDOW_RE = /^(Window \(base\)|Chest\/Container|Chest|Container|Dispenser|Furnace|EnchantmentTable|Anvil|Villager|Window)\s*(?:\.\s*|\s+)(.+)$/i

/** The code span of an item cell (`…`), or the whole cell when there is none. */
function itemText (cell) {
  const m = /`([^`]+)`/.exec(cell)
  return (m ? m[1] : cell).trim()
}

function stripCall (name) {
  return name.replace(/\s*\(.*\)\s*$/, '').trim()
}

/**
 * @param {string} cell item cell (markdown)
 * @param {string} kind row kind
 * @returns {{ name: string, window: string|null }} canonical name (+ canonical window class)
 */
function canonicalItem (cell, kind) {
  const text = itemText(cell)
  const wm = WINDOW_RE.exec(text)
  if (wm && kind !== 'test' && kind !== 'export') {
    const cls = WINDOW_CLASSES[wm[1].toLowerCase()]
    const rest = wm[2].trim()
    const ev = /^"([^"]+)"(?:\s+event)?$/.exec(rest)
    if (ev) return { name: `${cls}:${ev[1]}`, window: cls }
    return { name: `${cls}.${stripCall(rest.replace(/^\./, ''))}`, window: cls }
  }
  if (kind === 'method') return { name: stripCall(text), window: null }
  return { name: text, window: null }
}

/** Unique key of a row / reference item. */
function itemKey (kind, cell) {
  return `${kind}|${canonicalItem(cell, kind).name}`
}

/**
 * Category used for coverage summaries: the kind, except window-class members ('window') and
 * mineflayer internal tests ('internal-test').
 */
function category (kind, cell) {
  const { name, window } = canonicalItem(cell, kind)
  if (window) return 'window'
  if (kind === 'test' && name.startsWith('internalTest')) return 'internal-test'
  return kind
}

/** Display form (markdown cell) of a canonical reference item, in the seed's style. */
function displayItem (kind, name, { args = null } = {}) {
  const w = /^(Window|Chest|Dispenser|Furnace|EnchantmentTable|Anvil|Villager)([.:])(.+)$/.exec(name)
  if (w && kind !== 'test' && kind !== 'export') {
    const label = WINDOW_LABELS[w[1]]
    if (w[2] === ':') return `\`${label} "${w[3]}" event\``
    if (kind === 'method') return `\`${label} .${w[3]}(${args ?? ''})\``
    return `\`${label} .${w[3]}\``
  }
  return `\`${name}\``
}

/** Units named in an owner cell, in order: 'U4 → U5' → ['U4', 'U5']. */
function parseOwners (cell) {
  return (String(cell).match(/U\d+/g) || [])
}

/** The unit a fragment file belongs to ('U8.md' → 'U8', 'U3-internal-tests.md' → 'U3', seed → 'U0'). */
function fragmentUnit (fileName) {
  const m = /^(U\d+)/.exec(fileName)
  return m ? m[1] : null
}

module.exports = {
  KINDS,
  STATUSES,
  PLACEHOLDER_RE,
  DIFF_LINK_RE,
  WINDOW_LABELS,
  itemText,
  canonicalItem,
  itemKey,
  category,
  displayItem,
  parseOwners,
  fragmentUnit
}
