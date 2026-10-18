// owner: U4 (core runtime)
'use strict'
const { VERSION } = require('./bedrock/constants')

// Latest Bedrock only (BDS 1.26.51.1; 1.26.52.x is wire-identical).
const testedVersions = [VERSION]

module.exports = {
  testedVersions,
  latestSupportedVersion: testedVersions[testedVersions.length - 1],
  oldestSupportedVersion: testedVersions[0]
}
