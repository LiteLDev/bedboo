// owner: BEDD-6 (real-client e2e + docs)
'use strict'
// mocha root hooks of .mocharc.bedd.json: detach the shared real-client session after the whole run (the BeDD client
// stays in its world).
const { endSession } = require('./common')

exports.mochaHooks = {
  async afterAll () {
    await endSession()
  }
}
