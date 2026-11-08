'use strict'
// 1.26.60: animate, item_use_on_entity and item_release carry the hand (feature actionPacketsHaveHand)
const { describe, it } = require('node:test')
const assert = require('assert')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { versions } = require('@bedboo/bedrock-data')
const { buildUseOnEntity, buildRelease, buildUseItem, actionHand } = require('../../lib/bedrock/transactions')
const { createSupportFeature } = require('../../lib/bedrock/features')
const { createFakeBot } = require('./helpers/fake')

const SELF = 7n

/** a bare bot for the transaction builders of one family */
function builderBot (version) {
  return {
    supportFeature: createSupportFeature(null, { version }),
    quickBarSlot: 2,
    entity: { position: { x: 0.5, y: -60, z: 0.5 } },
    _bedrock: { ids: { selfRuntimeId: () => SELF } }
  }
}

/** whether bedrock-protocol's schema of `version` has a `hand` field in that packet / transaction */
function schemaHasHand (version, where) {
  const types = require('minecraft-data')('bedrock_' + version).protocol.types
  if (where === 'animate') return types.packet_animate[1].some(f => f.name === 'hand')
  const data = types.Transaction[1].find(f => f.name === 'transaction_data').type[1].fields[where]
  return data[1].some(f => f.name === 'hand')
}

function roundTrip (version, name, params) {
  const buffer = createSerializer(version).createPacketBuffer({ name, params })
  return createDeserializer(version).parsePacketBuffer(buffer).data.params
}

describe('actionPacketsHaveHand (1.26.60)', () => {
  it('agrees with every shipped family\'s schema (animate, item_use_on_entity, item_release)', () => {
    for (const version of versions) {
      const feature = createSupportFeature(null, { version })('actionPacketsHaveHand')
      for (const where of ['animate', 'item_use_on_entity', 'item_release']) {
        assert.strictEqual(schemaHasHand(version, where), feature, `${version} ${where}`)
      }
    }
    assert.strictEqual(createSupportFeature(null, { version: '1.26.63.1' })('actionPacketsHaveHand'), true)
    assert.strictEqual(createSupportFeature(null, { version: '1.26.51' })('actionPacketsHaveHand'), false)
  })

  it('the builders add the main hand only where the schema has it; every family\'s serializer writes them', () => {
    const target = { id: 42 }
    for (const version of versions) {
      const bot = builderBot(version)
      const hand = actionHand(bot)
      const onEntity = buildUseOnEntity(bot, target, { action: 'attack' })
      const release = buildRelease(bot)
      assert.strictEqual(onEntity.transaction.transaction_data.hand, hand.hand, version)
      assert.strictEqual(release.transaction.transaction_data.hand, hand.hand, version)
      const outEntity = roundTrip(version, 'inventory_transaction', onEntity).transaction
      assert.strictEqual(outEntity.transaction_data.action_type, 'attack', version)
      assert.strictEqual(outEntity.transaction_data.entity_runtime_id, 42n, version)
      assert.strictEqual(outEntity.transaction_data.hand, hand.hand, version)
      const outRelease = roundTrip(version, 'inventory_transaction', release).transaction
      assert.strictEqual(outRelease.transaction_data.hotbar_slot, 2, version)
      assert.strictEqual(outRelease.transaction_data.hand, hand.hand, version)
      // item_use (click_air) has its hand in every family
      assert.strictEqual(roundTrip(version, 'inventory_transaction', buildUseItem(bot)).transaction.transaction_data.action_type, 'click_air', version)
    }
    assert.deepStrictEqual(actionHand(builderBot('1.26.60')), { hand: 'main_hand' })
    assert.deepStrictEqual(actionHand(builderBot('1.26.60'), 'off_hand'), { hand: 'off_hand' })
    assert.deepStrictEqual(actionHand(builderBot('1.26.51')), {})
    assert.deepStrictEqual(actionHand(builderBot('1.26.51'), 'off_hand'), {})
    const offRelease = buildRelease(builderBot('1.26.60'), { hand: 'off_hand' })
    assert.strictEqual(roundTrip('1.26.60', 'inventory_transaction', offRelease).transaction.transaction_data.hand, 'off_hand')
    assert.strictEqual(buildRelease(builderBot('1.26.51'), { hand: 'off_hand' }).transaction.transaction_data.hand, undefined)
    assert.deepStrictEqual(actionHand({}), {}, 'a bot without supportFeature')
  })

  it('swingArm: animate with the hand on 1.26.60 (left = off hand), unchanged on 1.26.51', async () => {
    for (const [version, extra] of [['1.26.60', { hand: 'main_hand' }], ['1.26.51', {}]]) {
      const { bot, client } = await createFakeBot({ version })
      bot.swingArm()
      bot.swingArm('left')
      const sent = client.sent('animate')
      assert.strictEqual(sent.length, 2, version)
      assert.deepStrictEqual(sent[0], { action_id: 'swing_arm', runtime_entity_id: sent[0].runtime_entity_id, data: 0, has_swing_source: false, ...extra }, version)
      assert.strictEqual(sent[1].hand, extra.hand ? 'off_hand' : undefined, version + ': the left arm is the off hand')
      for (const packet of sent) assert.strictEqual(roundTrip(version, 'animate', packet).action_id, 'swing_arm', version)
      bot.end?.()
    }
  })

  it('deactivateItem releases the hand activateItem used (1.26.60)', async () => {
    for (const [version, hands] of [['1.26.60', ['off_hand', 'main_hand']], ['1.26.51', [undefined, undefined]]]) {
      const { bot, client } = await createFakeBot({ version })
      const releases = () => client.sent('inventory_transaction').filter(p => p.transaction.transaction_type === 'item_release')
      bot.activateItem(true)
      bot.deactivateItem()
      bot.activateItem()
      bot.deactivateItem()
      assert.deepStrictEqual(releases().map(p => p.transaction.transaction_data.hand), hands, version)
      for (const packet of releases()) roundTrip(version, 'inventory_transaction', packet)
      bot.end?.()
    }
  })
})
