'use strict'
// owner: U17 — offline players keep their saved data: a SelfSignedId derived from the username (lib/client.js)
const assert = require('assert')

describe('offline SelfSignedId (U17): stable per username so BDS restores the player', () => {
  function capture (fn) {
    const bedrock = require('bedrock-protocol')
    const original = bedrock.createClient
    const calls = []
    bedrock.createClient = (opts) => { calls.push(opts); return opts }
    try {
      fn(require('../../lib/client').createClient)
    } finally {
      bedrock.createClient = original
    }
    return calls
  }

  it("is Java's offline-mode UUID of the username (version 3, IETF variant)", () => {
    const { offlineSelfSignedId } = require('../../lib/client')
    // Java: UUID.nameUUIDFromBytes("OfflinePlayer:Notch".getBytes(UTF_8))
    assert.strictEqual(offlineSelfSignedId('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f')
    assert.match(offlineSelfSignedId('Agent'), /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.notStrictEqual(offlineSelfSignedId('Agent'), offlineSelfSignedId('Agent2'))
  })

  it('offline clients send it; skinData can override it; Xbox Live clients are left alone', () => {
    const { offlineSelfSignedId } = require('../../lib/client')
    const [a, again, custom, extra, online] = capture((createClient) => {
      createClient({ username: 'Agent' })
      createClient({ username: 'Agent' })
      createClient({ username: 'Agent', skinData: { SelfSignedId: 'mine' } })
      createClient({ username: 'Agent', skinData: { SkinId: 'x' } })
      createClient({ username: 'Agent', auth: 'microsoft' })
    })
    assert.strictEqual(a.skinData.SelfSignedId, offlineSelfSignedId('Agent'))
    assert.strictEqual(again.skinData.SelfSignedId, a.skinData.SelfSignedId, 'the same on every connection')
    assert.strictEqual(custom.skinData.SelfSignedId, 'mine')
    assert.deepStrictEqual(extra.skinData, { SelfSignedId: offlineSelfSignedId('Agent'), SkinId: 'x' })
    assert.strictEqual(online.skinData, undefined)
  })
})
