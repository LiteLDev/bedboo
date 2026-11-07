'use strict'

/**
 * Supported Bedrock versions: the single source of truth for every version bedboo knows about.
 *
 * A *family* is a minecraft-data / bedrock-protocol Bedrock version key ('1.26.51'): every BDS build of a family
 * speaks the same network protocol (BDS 1.26.50.5, 1.26.51.1 and 1.26.52.3 all answer protocol 2193), so the
 * family is what bedrock-protocol, minecraft-data (`bedrock_<family>`), `bot.version` and `@bedboo/bedrock-data`
 * are keyed by. A *build* is a BDS release ('1.26.52.3'); `createBot({ version })` accepts either.
 *
 * Every stable BDS released 2026-08-07 → 2026-11-07. A family listed here is only *tested* (accepted by
 * createBot) once @bedboo/bedrock-data ships data for it: see lib/version.js.
 */

/** @type {ReadonlyArray<{ version: string, protocol: number, bds: ReadonlyArray<string> }>} oldest first */
const FAMILIES = Object.freeze([
  { version: '1.26.40', protocol: 2168, bds: ['1.26.42.1', '1.26.43.1', '1.26.44.3'] },
  { version: '1.26.45', protocol: 2169, bds: ['1.26.45.1'] },
  { version: '1.26.51', protocol: 2193, bds: ['1.26.50.5', '1.26.51.1', '1.26.52.3'] },
  { version: '1.26.60', protocol: 2225, bds: ['1.26.60.6', '1.26.61.1', '1.26.62.1', '1.26.63.1'] }
].map(f => Object.freeze({ ...f, bds: Object.freeze([...f.bds]) })))

const byFamily = new Map(FAMILIES.map(f => [f.version, f]))
const byBuild = new Map(FAMILIES.flatMap(f => f.bds.map(build => [build, f])))

/** @returns {string} the list of known families and their builds, for error messages */
function describeFamilies (families = FAMILIES) {
  return families.map(f => `${f.version} (BDS ${f.bds.join(', ')})`).join('; ')
}

/**
 * @param {string} version a family ('1.26.60'), a BDS build ('1.26.62.1'), either with a 'bedrock_' prefix
 * @returns {{ version: string, protocol: number, bds: ReadonlyArray<string> } | null} its family, or null when unknown
 */
function findFamily (version) {
  if (typeof version !== 'string') return null
  const v = version.trim().replace(/^bedrock_/, '')
  return byFamily.get(v) ?? byBuild.get(v) ?? null
}

/**
 * @param {string} version a family ('1.26.60'), a BDS build ('1.26.62.1'), either with a 'bedrock_' prefix
 * @returns {string} the family ('1.26.60')
 * @throws {Error} code 'ERR_BEDBOO_VERSION' for anything else, listing the known versions
 */
function resolveVersion (version) {
  const family = findFamily(version)
  if (family) return family.version
  throw Object.assign(new Error(`Unknown Bedrock version '${version}'. Known versions: ${describeFamilies()}.`), { code: 'ERR_BEDBOO_VERSION' })
}

/**
 * @param {string} version a family or build (see {@link resolveVersion})
 * @returns {number} the network protocol of its family
 */
function protocolFor (version) {
  return byFamily.get(resolveVersion(version)).protocol
}

module.exports = { FAMILIES, findFamily, resolveVersion, protocolFor, describeFamilies }
