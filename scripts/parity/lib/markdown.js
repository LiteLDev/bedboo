// owner: U3 (parity tooling)
'use strict'
/** Minimal GitHub-flavoured markdown table reader/writer for the parity fragments. */

/**
 * Split one table line into cells. `|` inside a code span or escaped as `\|` does not split.
 * @param {string} line
 * @returns {string[]}
 */
function splitRow (line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells = []
  let cur = ''
  let inCode = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue }
    if (ch === '`') inCode = !inCode
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

const SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

/** Normalise a header cell: 'kind (property/method/…)' → 'kind', 'Asserting test' → 'asserting test'. */
function headerName (cell) {
  return cell.replace(/\(.*\)/, '').trim().toLowerCase()
}

/**
 * Every table in a markdown document.
 * @param {string} text
 * @returns {{ header: string[], rows: { cells: string[], line: number }[], line: number, heading: string|null }[]}
 */
function parseTables (text) {
  const lines = text.split(/\r?\n/)
  const tables = []
  let heading = null
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { heading = h[2].trim(); continue }
    if (!line.trim().startsWith('|') || i + 1 >= lines.length || !SEPARATOR_RE.test(lines[i + 1])) continue
    const table = { header: splitRow(line).map(headerName), rows: [], line: i + 1, heading }
    i += 2
    for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
      table.rows.push({ cells: splitRow(lines[i]), line: i + 1 })
    }
    i--
    tables.push(table)
  }
  return tables
}

/** Escape a value for use inside a table cell. */
function cell (value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|')
}

/**
 * Render a table.
 * @param {string[]} header
 * @param {string[][]} rows
 */
function renderTable (header, rows) {
  const out = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`]
  for (const row of rows) out.push(`| ${row.map(cell).join(' | ')} |`)
  return out.join('\n')
}

/** GitHub heading slug (used to resolve `#anchor` links to differences entries). */
function slug (text) {
  return text.trim().toLowerCase()
    .replace(/\{#[^}]*\}/g, '')
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-')
}

/**
 * Anchors defined by a markdown document: explicit `{#anchor}` markers, `<a id|name="…">` tags and
 * heading slugs.
 * @param {string} text
 * @returns {Set<string>}
 */
function anchors (text) {
  const out = new Set()
  for (const m of text.matchAll(/\{#([A-Za-z0-9_.:-]+)\}/g)) out.add(m[1])
  for (const m of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1])
  for (const m of text.matchAll(/^#{1,6}\s+(.*)$/gm)) out.add(slug(m[1]))
  return out
}

module.exports = { splitRow, parseTables, renderTable, cell, slug, anchors, headerName }
