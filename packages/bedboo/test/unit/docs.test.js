'use strict'
// The repository's user docs stay in sync: every relative link (and #anchor) of README and CONTRIBUTING resolves, and
// the README quick start is the runnable example. The documentation site (https://levimc.org/bedboo/, the API
// reference included) lives in LiteLDev/liteldev.github.io under docs/bedboo and is checked there.
const { describe, it } = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../../../..')
const USER_DOCS = ['README.md', 'CONTRIBUTING.md']

/** GitHub heading slug */
function slug (text) {
  return text.trim().toLowerCase().replace(/\{#[^}]*\}/g, '').replace(/`/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-')
}

/** anchors of a markdown document: `{#anchor}` markers, `<a id|name="…">` tags and heading slugs */
function anchors (text) {
  return new Set([
    ...[...text.matchAll(/\{#([A-Za-z0-9_.:-]+)\}/g)].map((m) => m[1]),
    ...[...text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) => slug(m[1]))
  ])
}

/** relative markdown links outside code: [text](target) */
function links (text) {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '``')
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !/^([a-z]+:|\/)/i.test(t))
}

describe('user docs', () => {
  it('every relative link of the user docs resolves (files and #anchors)', () => {
    const problems = []
    const anchorsOf = new Map() // resolved .md path → its anchors
    const hasAnchor = (file, anchor) => {
      if (!anchorsOf.has(file)) anchorsOf.set(file, anchors(fs.readFileSync(file, 'utf8')))
      return anchorsOf.get(file).has(anchor)
    }
    for (const doc of USER_DOCS) {
      const file = path.join(ROOT, doc)
      const text = fs.readFileSync(file, 'utf8')
      for (const link of links(text)) {
        const [target, anchor] = link.split('#')
        const resolved = target ? path.resolve(path.dirname(file), decodeURIComponent(target)) : file
        if (!fs.existsSync(resolved)) {
          problems.push(`${doc}: ${link} (no such file)`)
          continue
        }
        if (anchor && resolved.endsWith('.md') && !hasAnchor(resolved, anchor)) {
          problems.push(`${doc}: ${link} (no such anchor)`)
        }
      }
    }
    assert.deepStrictEqual(problems, [])
  })

  it('the README quick start is the runnable example (same createBot, echo and "come" logic)', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    const example = fs.readFileSync(path.join(ROOT, 'packages/bedboo/examples/readme_quickstart.js'), 'utf8')
    const snippet = /## Usage\n[\s\S]*?```js\n([\s\S]*?)```/.exec(readme)?.[1]
    assert.ok(snippet, 'README usage (quick start) code block')
    const normalize = (code) => code.split('\n').map((l) => l.replace(/\s*\/\/.*$/, '').trim()).filter(Boolean)
    // the example adds argv handling and the test handshake; every other line of the snippet is in it verbatim
    const exampleLines = new Set(normalize(example))
    const missing = normalize(snippet).filter((l) => !exampleLines.has(l) && !/^(host|port|username|auth):/.test(l))
    assert.deepStrictEqual(missing, [])
  })
})
