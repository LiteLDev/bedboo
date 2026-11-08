'use strict'
// 1.26.40 double optionals (lib/bedrock/presence.js): the outer presence bools bedboo adds before serialization
const { describe, it } = require('node:test')
const assert = require('assert')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { addPresenceFlags, installPresenceFlags, AUTH_INPUT_PRESENCE } = require('../../lib/bedrock/presence')
const { createSupportFeature } = require('../../lib/bedrock/features')

function idleInput (extra = {}) {
  return {
    pitch: 0,
    yaw: 0,
    position: { x: 0.5, y: -58.38, z: 0.5 },
    move_vector: { x: 0, z: 0 },
    head_yaw: 0,
    input_data: [],
    input_mode: 'mouse',
    play_mode: 'normal',
    interaction_model: 'crosshair',
    interact_rotation: { x: 0, z: 0 },
    tick: 42n,
    delta: { x: 0, y: 0, z: 0 },
    analogue_move_vector: { x: 0, z: 0 },
    camera_orientation: { x: 0, y: 0, z: 1 },
    raw_move_vector: { x: 0, z: 0 },
    ...extra
  }
}

const emptyItem = { network_id: 0 }
const action = { source_type: 'container', window_id: 0, slot: 3, old_item: emptyItem, new_item: emptyItem }

describe('1.26.40 double optionals (optionalsHavePresenceFlag)', () => {
  it('is a 1.26.40 feature only', () => {
    assert.strictEqual(createSupportFeature(null, { version: '1.26.40' })('optionalsHavePresenceFlag'), true)
    assert.strictEqual(createSupportFeature(null, { version: '1.26.44.3' })('optionalsHavePresenceFlag'), true)
    assert.strictEqual(createSupportFeature(null, { version: '1.26.45' })('optionalsHavePresenceFlag'), true)
    assert.strictEqual(createSupportFeature(null, { version: '1.26.45.1' })('optionalsHavePresenceFlag'), true)
    assert.strictEqual(createSupportFeature(null, { version: '1.26.51' })('optionalsHavePresenceFlag'), false)
  })

  it('player_auth_input: every outer presence bool, also in its transaction and actions; the input is not mutated', () => {
    const input = idleInput({ transaction: { legacy: { legacy_request_id: 0 }, actions: [action], data: {} } })
    const out = addPresenceFlags('player_auth_input', input)
    for (const field of AUTH_INPUT_PRESENCE) assert.strictEqual(out[field + '_presence'], true, field)
    assert.strictEqual(out.transaction.actions_presence, true)
    assert.deepStrictEqual(out.transaction.actions, [{ ...action, container_presence: true, flag_presence: true }])
    assert.strictEqual(input.transaction_presence, undefined)
    assert.strictEqual(input.transaction.actions[0].container_presence, undefined)
    assert.strictEqual(addPresenceFlags('player_auth_input', idleInput({ transaction_presence: false })).transaction_presence, false, 'an explicit value wins')
  })

  it('inventory_transaction actions; other packets unchanged', () => {
    const tx = { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'normal', actions: [action] } }
    assert.deepStrictEqual(addPresenceFlags('inventory_transaction', tx).transaction.actions, [{ ...action, container_presence: true, flag_presence: true }])
    const text = { type: 'chat', message: 'hi' }
    assert.strictEqual(addPresenceFlags('text', text), text)
    assert.strictEqual(addPresenceFlags('inventory_transaction', {}).transaction, undefined)
  })

  it('on the 1.26.40 wire: one extra byte per double optional, and the packet reads back', () => {
    const v40 = createSerializer('1.26.40')
    const v51 = createSerializer('1.26.51')
    const params = idleInput()
    const b51 = v51.createPacketBuffer({ name: 'player_auth_input', params })
    const b40 = v40.createPacketBuffer({ name: 'player_auth_input', params: addPresenceFlags('player_auth_input', params) })
    // + 1: input_data is an optional on 1.26.40 too (a plain array since 1.26.50)
    assert.strictEqual(b40.length, b51.length + AUTH_INPUT_PRESENCE.length + 1)
    const { data } = createDeserializer('1.26.40').parsePacketBuffer(b40)
    assert.strictEqual(data.name, 'player_auth_input')
    for (const field of AUTH_INPUT_PRESENCE) assert.strictEqual(data.params[field + '_presence'], true, field)
    assert.deepStrictEqual(data.params.raw_move_vector, params.raw_move_vector)
    assert.deepStrictEqual(data.params.camera_orientation, params.camera_orientation)
  })

  it('installPresenceFlags: the serializer bedrock-protocol creates in init() (delayedInit) of a 1.26.40 client only', () => {
    // bedrock-protocol's createClient builds the Client with delayedInit: `serializer` appears in init(), after discovery
    const delayedClient = (version) => ({ init () { this.serializer = createSerializer(version) } })
    const decode = (version, buffer) => createDeserializer(version).parsePacketBuffer(buffer).data.params
    const c40 = installPresenceFlags(delayedClient('1.26.40'), createSupportFeature(null, { version: '1.26.40' }))
    assert.strictEqual(c40.serializer, undefined)
    c40.init()
    const params = idleInput()
    const out = decode('1.26.40', c40.serializer.createPacketBuffer({ name: 'player_auth_input', params }))
    for (const field of AUTH_INPUT_PRESENCE) assert.strictEqual(out[field + '_presence'], true, field)
    c40.init() // a second init (new serializer) is wrapped too
    assert.strictEqual(decode('1.26.40', c40.serializer.createPacketBuffer({ name: 'player_auth_input', params })).transaction_presence, true)
    assert.strictEqual(installPresenceFlags(c40, () => true), c40, 'installing twice does not wrap twice')

    const c51 = installPresenceFlags(delayedClient('1.26.51'), createSupportFeature(null, { version: '1.26.51' }))
    c51.init()
    assert.strictEqual(decode('1.26.51', c51.serializer.createPacketBuffer({ name: 'player_auth_input', params })).transaction_presence, undefined)

    // a client that already has its serializer (no delayed init)
    const ready = { serializer: createSerializer('1.26.40') }
    installPresenceFlags(ready, () => true)
    assert.strictEqual(decode('1.26.40', ready.serializer.createPacketBuffer({ name: 'player_auth_input', params })).block_action_presence, true)
    const fake = { queue () {} }
    assert.strictEqual(installPresenceFlags(fake, () => true), fake, 'a client without a serializer (test fakes) is left alone')
  })

  it('createBot installs it on the client of a 1.26.40 bot (also a client given as options.client)', async () => {
    const bedboo = require('../..')
    const { EventEmitter } = require('events')
    const client = Object.assign(new EventEmitter(), { init () { this.serializer = createSerializer('1.26.40') } })
    const bot = bedboo.createBot({ client, version: '1.26.44.3', logErrors: false, hideErrors: true })
    assert.strictEqual(bot.supportFeature('optionalsHavePresenceFlag'), true)
    client.init()
    const out = createDeserializer('1.26.40').parsePacketBuffer(client.serializer.createPacketBuffer({ name: 'player_auth_input', params: idleInput() })).data.params
    assert.strictEqual(out.predicted_vehicle_presence, true)
    bot.end()
  })

  it('1.26.45 (protocol 2169) has the same double optionals: a 1.26.45.1 bot writes them on the 1.26.45 wire', async () => {
    const bedboo = require('../..')
    const { EventEmitter } = require('events')
    const client = Object.assign(new EventEmitter(), { init () { this.serializer = createSerializer('1.26.45') } })
    const bot = bedboo.createBot({ client, version: '1.26.45.1', logErrors: false, hideErrors: true })
    client.init()
    const params = idleInput()
    const b45 = client.serializer.createPacketBuffer({ name: 'player_auth_input', params })
    const b51 = createSerializer('1.26.51').createPacketBuffer({ name: 'player_auth_input', params })
    assert.strictEqual(b45.length, b51.length + AUTH_INPUT_PRESENCE.length + 1)
    // the five optional parts just before analogue_move_vector (8 bytes), camera_orientation (12), raw_move_vector (8):
    // (outer presence true, inner presence false) each
    assert.deepStrictEqual([...b45.subarray(b45.length - 28 - 10, b45.length - 28)], [1, 0, 1, 0, 1, 0, 1, 0, 1, 0])
    const out = createDeserializer('1.26.45').parsePacketBuffer(b45).data.params
    for (const field of AUTH_INPUT_PRESENCE) assert.strictEqual(out[field + '_presence'], true, field)
    assert.deepStrictEqual(out.raw_move_vector, params.raw_move_vector)
    bot.end()
  })
})
