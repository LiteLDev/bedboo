'use strict'
// owner: U4 (core runtime) — resource_pack.js + the bedrock-protocol patch that holds the resource pack answer
// (patches/bedrock-protocol@3.60.1.patch). The live accept/deny round trip against BDS is
// test/external/resourcePack.test.js.
const assert = require('assert')
const { createFakeBot } = require('./helpers/fake')

const PACK = { uuid: '0f5e9b7c-1111-4a2b-9c3d-2e2f3a4b5c6d', version: '1.0.0', size: 1234n, content_key: '', sub_pack_name: '', content_identity: '', has_scripts: false, addon_pack: false, rtx_enabled: false, cdn_url: '' }
const info = (packs) => ({ must_accept: false, has_addons: false, has_scripts: false, disable_vibrant_visuals: false, world_template: { uuid: '00000000-0000-0000-0000-000000000000', version: '0.0.0' }, texture_packs: packs })

/** a real (patched) bedrock-protocol client that never connects; write/queue are recorded */
function protocolClient () {
  require('../../lib/registry').installDataOverlay()
  const { createClient } = require('../../lib/client')
  const client = createClient({ host: '127.0.0.1', port: 1, username: 'packs', connectTimeout: 60000 })
  client.sent = []
  client.write = (name, params) => client.sent.push(['write', name, params])
  client.queue = (name, params) => client.sent.push(['queue', name, params])
  return client
}

describe('resource packs (U4)', function () {
  this.timeout(30000)

  it('bedrock-protocol patch: no hook → accepted at once (unchanged behaviour)', () => {
    const client = protocolClient()
    try {
      client.emit('resource_packs_info', info([PACK]))
      assert.deepStrictEqual(client.sent.map(([, n, p]) => [n, p.response_status ?? p.enabled]), [['resource_pack_client_response', 'completed'], ['client_cache_status', false]])
      client.emit('resource_pack_stack', {})
      assert.strictEqual(client.sent.filter(([, n]) => n === 'resource_pack_client_response').length, 2)
      assert.strictEqual(client.respondToResourcePacks(false), false, 'already answered')
    } finally {
      client.close()
    }
  })

  it('bedrock-protocol patch: holdResourcePacks → nothing sent until respondToResourcePacks(accept)', () => {
    const client = protocolClient()
    try {
      let seen = null
      client.holdResourcePacks = (packet) => { seen = packet; return true }
      client.emit('resource_packs_info', info([PACK]))
      assert.strictEqual(seen.texture_packs[0].uuid, PACK.uuid)
      assert.deepStrictEqual(client.sent, [])
      assert.strictEqual(client.respondToResourcePacks(false), true)
      assert.deepStrictEqual(client.sent, [['write', 'resource_pack_client_response', { response_status: 'refused', response_status_name: 'cancel', resourcepackids: [] }]])
      assert.strictEqual(client.respondToResourcePacks(true), false)
      assert.throws(() => client.respondToResourcePacks('maybe'), /unknown resource pack response/)
      const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
      assert.ok(createSerializer('1.26.51').createPacketBuffer({ name: 'resource_pack_client_response', params: client.sent[0][2] }).length > 0)
    } finally {
      client.close()
    }
  })

  it("bedrock-protocol patch: 'have_all_packs' (join without the packs) then 'completed' on the stack", () => {
    const client = protocolClient()
    try {
      client.holdResourcePacks = () => true
      client.emit('resource_packs_info', info([PACK]))
      assert.strictEqual(client.respondToResourcePacks('have_all_packs'), true)
      client.emit('resource_pack_stack', {})
      assert.deepStrictEqual(client.sent.filter(([, n]) => n === 'resource_pack_client_response').map(([, , p]) => [p.response_status, p.response_status_name]),
        [['have_all_packs', 'downloadingfinished'], ['completed', 'resourcepackstackfinished']])
    } finally {
      client.close()
    }
  })

  it('plugin: resourcePack(url, hash, uuid) per pack; held only while someone listens; accept/deny answer once', async () => {
    const { bot, client } = await createFakeBot()
    assert.strictEqual(client.holdResourcePacks(info([PACK])), false, 'no listener: auto-accept')
    const events = []
    bot.on('resourcePack', (...args) => events.push(args))
    assert.strictEqual(client.holdResourcePacks(info([])), false, 'no packs: nothing to hold')
    assert.strictEqual(client.holdResourcePacks(info([PACK])), true)
    client.receive('resource_packs_info', info([PACK, { ...PACK, uuid: 'aaaaaaaa-1111-4a2b-9c3d-2e2f3a4b5c6d', cdn_url: 'https://cdn.example/pack.zip' }]))
    assert.deepStrictEqual(events, [
      ['', `${PACK.uuid}_1.0.0`, PACK.uuid],
      ['https://cdn.example/pack.zip', 'aaaaaaaa-1111-4a2b-9c3d-2e2f3a4b5c6d_1.0.0', 'aaaaaaaa-1111-4a2b-9c3d-2e2f3a4b5c6d']
    ])
    // a client without the patch (this fake): the plugin answers itself; an optional pack is declined
    bot.denyResourcePack()
    bot.acceptResourcePack()
    client.receive('resource_pack_stack', {})
    assert.deepStrictEqual(client.sent('resource_pack_client_response').map(p => p.response_status), ['have_all_packs', 'completed'])

    const { bot: bot2, client: client2 } = await createFakeBot()
    const answers = []
    client2.respondToResourcePacks = (response) => { answers.push(response); return true }
    bot2.acceptResourcePack()
    assert.deepStrictEqual(answers, [], 'nothing offered yet: no answer')
    client2.receive('resource_packs_info', info([PACK]))
    bot2.acceptResourcePack()
    bot2.denyResourcePack()
    assert.deepStrictEqual(answers, ['completed'], 'the patched client answers, once')

    const { bot: bot3, client: client3 } = await createFakeBot()
    const answers3 = []
    client3.respondToResourcePacks = (response) => { answers3.push(response); return true }
    client3.receive('resource_packs_info', { ...info([PACK]), must_accept: true })
    bot3.denyResourcePack()
    assert.deepStrictEqual(answers3, ['refused'], 'a required pack is refused')
  })
})
