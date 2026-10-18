#!/usr/bin/env node
// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * Downloads every pinned source (sources.js) into the source cache
 * (`$BEDBOO_DATA_SRC`, default `~/.cache/bedboo/bedrock-data-src`) and verifies its sha256 against
 * `sources.lock.json`. `--update-lock` rewrites the lock (only when re-pinning a source).
 *
 *   node packages/bedrock-data/scripts/fetch-sources.js [--update-lock]
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { SOURCES, sourcePath } = require('./sources')

const LOCK = path.join(__dirname, 'sources.lock.json')

async function download (url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (attempt >= 3) throw err
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
    }
  }
}

async function main () {
  const updateLock = process.argv.includes('--update-lock')
  const lock = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : {}
  for (const s of Object.values(SOURCES)) {
    const file = sourcePath(s.id)
    let buf = fs.existsSync(file) ? fs.readFileSync(file) : null
    const expected = lock[s.id]
    const digest = b => crypto.createHash('sha256').update(b).digest('hex')
    if (!buf || (expected && digest(buf) !== expected)) {
      buf = await download(s.url)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, buf)
      console.log(`fetched ${s.id} (${buf.length} bytes)`)
    }
    const actual = digest(buf)
    if (expected && expected !== actual && !updateLock) {
      throw new Error(`${s.id}: sha256 ${actual} does not match the lock ${expected}`)
    }
    lock[s.id] = actual
  }
  if (updateLock || !fs.existsSync(LOCK)) {
    fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n')
    console.log('wrote', path.relative(process.cwd(), LOCK))
  }
  console.log('sources ok')
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1) })
}

module.exports = { main }
