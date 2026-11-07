'use strict'
const { VERSION } = require('./bedrock/constants')
const { FAMILIES, findFamily, describeFamilies } = require('./bedrock/versions')

/**
 * Tested versions: the families of lib/bedrock/versions.js that @bedboo/bedrock-data ships data for (a family
 * without block/item data cannot build a registry). Before bedrock-data exported `versions`, only VERSION had data.
 */
function dataVersions () {
  const { versions } = require('@bedboo/bedrock-data')
  return Array.isArray(versions) ? versions : [VERSION]
}

const shipped = new Set(dataVersions())
/** families, oldest first (same order as FAMILIES) */
const testedVersions = FAMILIES.filter(f => shipped.has(f.version)).map(f => f.version)

/**
 * @param {string} version a family or BDS build, optionally 'bedrock_'-prefixed
 * @returns {string|null} its family when it is tested, else null
 */
function testedFamily (version) {
  const family = findFamily(version)
  return family && testedVersions.includes(family.version) ? family.version : null
}

/**
 * createBot's version check: a family or build → its tested family.
 * @param {string} version
 * @returns {string} the family
 * @throws {Error} code 'ERR_BEDBOO_VERSION' naming the tested versions (and why this one is not among them)
 */
function resolveTestedVersion (version) {
  const tested = testedFamily(version)
  if (tested) return tested
  const supported = describeFamilies(FAMILIES.filter(f => testedVersions.includes(f.version)))
  const family = findFamily(version)
  const why = family
    ? `Bedrock ${family.version} (protocol ${family.protocol}) is known but not tested yet: @bedboo/bedrock-data has no data for it`
    : `Bedrock version '${version}' is not supported`
  throw Object.assign(new Error(`${why}. Supported versions: ${supported}.`), { code: 'ERR_BEDBOO_VERSION' })
}

module.exports = {
  testedVersions,
  latestSupportedVersion: testedVersions[testedVersions.length - 1],
  oldestSupportedVersion: testedVersions[0],
  testedFamily,
  resolveTestedVersion
}
