'use strict'
/**
 * Packet fixtures recorded from a real BDS (see README.md in this directory).
 *
 *   const fixtures = require('../fixtures')
 *   fixtures.list()                                  // ['join_flat']
 *   const cap = fixtures.load('join_flat')           // { meta, records, parse, packets, first }
 *   cap.first('start_game')                          // parsed params of the first inbound start_game
 *   cap.packets('subchunk')                          // [{ i, t, dir, name, buffer, params }, …]
 *   cap.packets('player_auth_input', { dir: 'out' }) // packets the recording client sent
 *   cap.records                                      // raw records (buffer only, unparsed)
 *
 * The default version is the family the test run targets (BEDBOO_VERSION, see ../version.js), so the same tests
 * replay test/fixtures/<family>/. A capture that does not exist for that family throws a FixtureMissingError
 * (code BEDBOO_FIXTURE_MISSING); ../skip-missing-fixtures.js turns it into a skipped test.
 *
 * Every record holds the raw decompressed packet buffer exactly as bedrock-protocol's deserializer
 * consumes it, so parsing goes through the same code path (and catches protocol-schema
 * regressions). Item-bearing packets need the `ShieldItemID` protodef variable, which is set from
 * the capture's `item_registry` before anything else is parsed (as bedrock-protocol's client does).
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// Same rule as the library: data overlay before any bedrock_<version> data is loaded.
require('@bedboo/bedrock-data').install()

const { TEST_VERSION, DEFAULT_VERSION: BASELINE_VERSION } = require('../version')

const DEFAULT_VERSION = TEST_VERSION
const cache = new Map()

class FixtureMissingError extends Error {
  constructor (name, version, file) {
    super(`no ${name} capture for Bedrock ${version} (${path.relative(path.join(__dirname, '..', '..'), file)}); capture one against a BDS of that family`)
    this.name = 'FixtureMissingError'
    this.code = 'BEDBOO_FIXTURE_MISSING'
    this.fixture = name
    this.version = version
  }
}

function fileOf (name, version) {
  return path.join(__dirname, version, name + '.jsonl.gz')
}

/** @returns {boolean} whether the capture `name` exists for `version` */
function has (name = 'join_flat', { version = DEFAULT_VERSION } = {}) {
  return fs.existsSync(fileOf(name, version))
}

/**
 * For test files that read a capture at module level: `describe(title, { skip: fixtures.skipReason() }, …)`.
 * @returns {string|false} why tests needing capture `name` must skip for `version`, or false when it exists. Never
 *   skips the baseline family (1.26.51): its captures must exist, so load() fails loudly there.
 */
function skipReason (name = 'join_flat', { version = DEFAULT_VERSION } = {}) {
  if (version === BASELINE_VERSION || has(name, { version })) return false
  return new FixtureMissingError(name, version, fileOf(name, version)).message
}

/** @returns {string[]} capture names available for `version` */
function list (version = DEFAULT_VERSION) {
  const dir = path.join(__dirname, version)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl.gz')).map(f => f.replace(/\.jsonl\.gz$/, '')).sort()
}

function readCapture (file) {
  const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean)
  const first = JSON.parse(lines[0])
  if (!first.meta) throw new Error(`${file}: first line must be {"meta": …}`)
  const records = lines.slice(1).map(line => {
    const r = JSON.parse(line)
    return { i: r.i, t: r.t, dir: r.dir, name: r.name, buffer: Buffer.from(r.buf, 'base64') }
  })
  return { meta: first.meta, records }
}

/**
 * @param {string} [name] capture name (file name without .jsonl.gz), default 'join_flat'
 * @param {{ version?: string }} [opts]
 */
function load (name = 'join_flat', { version = DEFAULT_VERSION } = {}) {
  const key = version + '/' + name
  if (cache.has(key)) return cache.get(key)
  const file = fileOf(name, version)
  if (!fs.existsSync(file)) throw new FixtureMissingError(name, version, file)
  const { meta, records } = readCapture(file)

  let deserializer = null
  function getDeserializer () {
    if (deserializer) return deserializer
    const { createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
    deserializer = createDeserializer(meta.version || version)
    const registry = records.find(r => r.dir === 'in' && r.name === 'item_registry')
    if (registry) {
      const params = deserializer.parsePacketBuffer(registry.buffer).data.params
      const shield = params.itemstates?.find(s => s.name === 'minecraft:shield')
      if (shield) deserializer.proto.setVariable('ShieldItemID', shield.runtime_id)
    }
    return deserializer
  }

  /** Parse one record → packet params (throws on a schema mismatch). */
  function parse (record) {
    const des = getDeserializer().parsePacketBuffer(record.buffer)
    if (des.data.name !== record.name) throw new Error(`record ${record.i}: expected ${record.name}, parsed ${des.data.name}`)
    return des.data.params
  }

  /** All records named `packetName` (default inbound), each with parsed `params`. */
  function packets (packetName, { dir = 'in' } = {}) {
    return records
      .filter(r => r.name === packetName && (dir === 'any' || r.dir === dir))
      .map(r => ({ ...r, params: parse(r) }))
  }

  /** Parsed params of the first `packetName` record (default inbound), or undefined. */
  function first (packetName, { dir = 'in' } = {}) {
    const r = records.find(r => r.name === packetName && (dir === 'any' || r.dir === dir))
    return r ? parse(r) : undefined
  }

  const capture = { name, version, meta, records, parse, packets, first }
  cache.set(key, capture)
  return capture
}

module.exports = { list, load, has, skipReason, DEFAULT_VERSION, FixtureMissingError }
