'use strict'
// owner: U16b — the user docs stay in sync: every `bot.bedrock.*` extra typed in types/bedrock.d.ts is documented in
// docs/api.md, and every relative link (and #anchor) of the user docs resolves.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { anchors } = require('../../../../scripts/parity/lib/markdown')

const ROOT = path.join(__dirname, '../../../..')
const USER_DOCS = ['README.md', 'docs/README.md', 'docs/api.md', 'docs/getting-started.md', 'docs/differences/U16-transport.md']

/** members of `interface BedrockExtras` (one `name: type` / `name?: type` per line) */
function bedrockExtras () {
  const text = fs.readFileSync(path.join(ROOT, 'packages/mineflayer-bedrock/types/bedrock.d.ts'), 'utf8')
  const body = /interface BedrockExtras\s*\{([\s\S]*?)\n\}/.exec(text)?.[1]
  assert.ok(body !== undefined, 'interface BedrockExtras in types/bedrock.d.ts')
  return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(]/gm)].map((m) => m[1])
}

/** relative markdown links outside code: [text](target) */
function links (text) {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '``')
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !/^[a-z]+:/i.test(t))
}

describe('user docs (U16b)', function () {
  it('docs/api.md documents every bot.bedrock extra of types/bedrock.d.ts', () => {
    const api = fs.readFileSync(path.join(ROOT, 'docs/api.md'), 'utf8')
    const extras = bedrockExtras()
    assert.ok(extras.length > 0)
    for (const name of extras) assert.ok(api.includes(`bot.bedrock.${name}`), `docs/api.md lacks bot.bedrock.${name}`)
  })

  it('every relative link of the user docs resolves (files and #anchors)', () => {
    const problems = []
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
        if (anchor && resolved.endsWith('.md') && !anchors(fs.readFileSync(resolved, 'utf8')).has(anchor)) {
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
