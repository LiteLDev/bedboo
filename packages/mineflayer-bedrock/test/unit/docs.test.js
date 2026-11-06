'use strict'
// The user docs stay in sync: every `bot.bedrock.*` extra typed in types/bedrock.d.ts is documented in the API
// reference (English and Chinese), and every relative link (and #anchor) of the docs resolves.
const { describe, it } = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../../../..')
const API_DOCS = ['docs/reference/api.md', 'docs/zh/reference/api.md']
// README, CONTRIBUTING and every page of the docs site (not its installed kit, dependencies or build output)
const USER_DOCS = ['README.md', 'CONTRIBUTING.md', ...markdownFiles('docs')]

function markdownFiles (dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return ['node_modules', 'kit', 'dist', '.kit'].includes(e.name) ? [] : markdownFiles(path.join(dir, e.name))
    return e.name.endsWith('.md') ? [path.join(dir, e.name)] : []
  })
}

/** members of `interface BedrockExtras` (one `name: type` / `name?: type` per line) */
function bedrockExtras () {
  const text = fs.readFileSync(path.join(ROOT, 'packages/mineflayer-bedrock/types/bedrock.d.ts'), 'utf8')
  const body = /interface BedrockExtras\s*\{([\s\S]*?)\n\}/.exec(text)?.[1]
  assert.ok(body !== undefined, 'interface BedrockExtras in types/bedrock.d.ts')
  return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(]/gm)].map((m) => m[1])
}

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

/** relative markdown links outside code: [text](target); site routes (/guide/…) are left to the docs build's linkcheck */
function links (text) {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '``')
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !/^([a-z]+:|\/)/i.test(t))
}

describe('user docs', () => {
  it('the API reference documents every bot.bedrock extra of types/bedrock.d.ts', () => {
    const extras = bedrockExtras()
    assert.ok(extras.length > 0)
    for (const doc of API_DOCS) {
      const api = fs.readFileSync(path.join(ROOT, doc), 'utf8')
      for (const name of extras) assert.ok(api.includes(`bot.bedrock.${name}`), `${doc} lacks bot.bedrock.${name}`)
    }
  })

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
    const example = fs.readFileSync(path.join(ROOT, 'packages/mineflayer-bedrock/examples/readme_quickstart.js'), 'utf8')
    const snippet = /## Usage\n[\s\S]*?```js\n([\s\S]*?)```/.exec(readme)?.[1]
    assert.ok(snippet, 'README usage (quick start) code block')
    const normalize = (code) => code.split('\n').map((l) => l.replace(/\s*\/\/.*$/, '').trim()).filter(Boolean)
    // the example adds argv handling and the test handshake; every other line of the snippet is in it verbatim
    const exampleLines = new Set(normalize(example))
    const missing = normalize(snippet).filter((l) => !exampleLines.has(l) && !/^(host|port|username|auth):/.test(l))
    assert.deepStrictEqual(missing, [])
  })
})
