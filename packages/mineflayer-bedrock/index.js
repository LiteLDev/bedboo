// owner: U4 (core runtime)
'use strict'
if (typeof process !== 'undefined' && parseInt(process.versions.node.split('.')[0]) < 24) {
  console.error('Your node version is currently', process.versions.node)
  console.error('Please update it to a version >= 24.x.x from https://nodejs.org/')
  process.exit(1)
}

// MUST stay first: the bedrock-data overlay has to patch minecraft-data before bedrock-protocol
// or prismarine-* load any bedrock_1.26.51 data (see lib/registry.js).
require('./lib/registry').installDataOverlay()

module.exports = require('./lib/loader.js')
