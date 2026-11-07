'use strict'
/**
 * The Bedrock version the test run targets, from the BEDBOO_VERSION environment variable.
 *
 *   BEDBOO_VERSION=1.26.60 pnpm test        // a protocol family (minecraft-data / bedrock-protocol key)
 *   BEDBOO_VERSION=1.26.62.1 pnpm test      // a BDS build: resolved to its family (1.26.60)
 *
 *   const { TEST_VERSION, TEST_PROTOCOL, TEST_BDS_BUILD } = require('../version')
 *
 * - TEST_VERSION: the family ('1.26.51' when BEDBOO_VERSION is unset): fakes, serializers, registries and the
 *   fixture directory (test/fixtures/<family>/) all use it;
 * - TEST_PROTOCOL: the network protocol number of that family;
 * - TEST_BDS_BUILD: the 4-part BDS build when BEDBOO_VERSION names one, else undefined (pass
 *   `TEST_BDS_BUILD || TEST_VERSION` to anything that starts a server).
 *
 * The library's own table (lib/bedrock/versions.js, `resolveVersion`) wins when it exists; FAMILIES below is the
 * fallback and must stay consistent with it.
 */

const DEFAULT_VERSION = '1.26.51'

/** Stable BDS builds per protocol family. */
const FAMILIES = [
  { version: '1.26.40', protocol: 2168, bds: ['1.26.42.1', '1.26.43.1', '1.26.44.3'] },
  { version: '1.26.45', protocol: 2169, bds: ['1.26.45.1'] },
  { version: '1.26.51', protocol: 2193, bds: ['1.26.50.5', '1.26.51.1', '1.26.52.3'] },
  { version: '1.26.60', protocol: 2225, bds: ['1.26.60.6', '1.26.61.1', '1.26.62.1', '1.26.63.1'] }
]

function libraryVersions () {
  try {
    return require('../lib/bedrock/versions')
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err
    return null
  }
}

/**
 * @param {string} [input] a family ('1.26.60'), a BDS build ('1.26.62.1') or 'bedrock_<family>'
 * @returns {{ version: string, protocol: number|undefined, build: string|undefined }}
 */
function resolveTestVersion (input) {
  const raw = String(input ?? '').trim().replace(/^bedrock_/, '')
  if (!raw) return { version: DEFAULT_VERSION, protocol: protocolOf(DEFAULT_VERSION), build: undefined }
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(raw)) throw new Error(`BEDBOO_VERSION=${input}: expected a family (1.26.51) or a BDS build (1.26.51.1)`)
  const build = raw.split('.').length === 4 ? raw : undefined
  const lib = libraryVersions()
  let version
  if (typeof lib?.resolveVersion === 'function') {
    version = lib.resolveVersion(raw)
  } else if (build) {
    version = FAMILIES.find(f => f.bds.includes(build))?.version
    if (!version) throw new Error(`BEDBOO_VERSION=${input}: unknown BDS build (known: ${FAMILIES.flatMap(f => f.bds).join(', ')})`)
  } else {
    version = raw
    if (!FAMILIES.some(f => f.version === version)) throw new Error(`BEDBOO_VERSION=${input}: unknown Bedrock family (known: ${FAMILIES.map(f => f.version).join(', ')})`)
  }
  return { version, protocol: protocolOf(version), build }
}

function protocolOf (version) {
  const fromLib = libraryVersions()?.FAMILIES?.find(f => f.version === version)?.protocol
  return fromLib ?? FAMILIES.find(f => f.version === version)?.protocol
}

const resolved = resolveTestVersion(process.env.BEDBOO_VERSION)

module.exports = {
  DEFAULT_VERSION,
  FAMILIES,
  resolveTestVersion,
  TEST_VERSION: resolved.version,
  TEST_PROTOCOL: resolved.protocol,
  TEST_BDS_BUILD: resolved.build
}
