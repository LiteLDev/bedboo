#!/usr/bin/env node
'use strict'

/**
 * Downloads every pinned source (sources.js) of the selected data versions into the source cache
 * (`$BEDBOO_DATA_SRC`, default `~/.cache/bedboo/bedrock-data-src`) and verifies its sha256 against
 * `sources.lock.json` (`{ <version>: { <source id>: sha256 } }`). `--update-lock` rewrites the lock entries of the
 * selected versions (only when pinning or re-pinning a version's sources).
 *
 *   node packages/bedrock-data/scripts/fetch-sources.js [--version <v> | --all] [--update-lock]   # default 1.26.51
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { sourcesFor, sourcePath, versionsFromArgv } = require('./sources')
const { compareDotted } = require('../install')

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

const digest = b => crypto.createHash('sha256').update(b).digest('hex')

async function fetchVersion (version, lock, updateLock) {
  const locked = lock[version] ?? {}
  const fresh = {} // --update-lock: exactly the version's current sources (a dropped source leaves the lock)
  for (const s of Object.values(sourcesFor(version))) {
    const file = sourcePath(s.id, version)
    let buf = fs.existsSync(file) ? fs.readFileSync(file) : null
    const expected = locked[s.id]
    if (!buf || (expected && digest(buf) !== expected)) {
      buf = await download(s.url)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, buf)
      console.log(`fetched ${version} ${s.id} (${buf.length} bytes)`)
    }
    const actual = digest(buf)
    if (expected && expected !== actual && !updateLock) {
      throw new Error(`${version} ${s.id}: sha256 ${actual} does not match the lock ${expected}`)
    }
    if (!expected && !updateLock) {
      throw new Error(`${version} ${s.id} is not pinned in ${path.basename(LOCK)}: re-run with --version ${version} --update-lock after checking it`)
    }
    fresh[s.id] = actual
  }
  lock[version] = fresh
}

async function main () {
  const updateLock = process.argv.includes('--update-lock')
  const versions = versionsFromArgv()
  const lock = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : {}
  for (const version of versions) await fetchVersion(version, lock, updateLock)
  if (updateLock) {
    const sorted = {}
    for (const v of Object.keys(lock).sort(compareDotted)) sorted[v] = lock[v]
    fs.writeFileSync(LOCK, JSON.stringify(sorted, null, 2) + '\n')
    console.log('wrote', path.relative(process.cwd(), LOCK))
  }
  console.log(`sources ok (${versions.join(', ')})`)
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1) })
}

module.exports = { main }
