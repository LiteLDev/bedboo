'use strict'
const { describe, it } = require('node:test')
const assert = require('assert')
const fixtures = require('../fixtures')
const { TEST_VERSION, TEST_PROTOCOL } = require('../version')

describe(`packet fixtures (capture of Bedrock ${TEST_VERSION})`, () => {
  const cap = fixtures.load('join_flat')

  it('lists the join_flat capture with metadata', () => {
    assert.ok(fixtures.list().includes('join_flat'))
    assert.strictEqual(cap.meta.version, TEST_VERSION)
    assert.strictEqual(cap.meta.protocol, TEST_PROTOCOL)
    for (const m of ['join', 'start_game', 'spawn', 'level_chunk', 'subchunk']) assert.ok(cap.meta.milestones[m] > 0, m)
  })

  it(`every recorded packet re-parses with bedrock-protocol ${TEST_VERSION}`, () => {
    for (const record of cap.records) cap.parse(record)
  })

  it('covers the packets later units need', () => {
    const required = [
      'start_game', 'item_registry', 'creative_content', 'crafting_data', 'available_commands',
      'level_chunk', 'subchunk', 'update_block', 'network_chunk_publisher_update',
      'inventory_content', 'inventory_slot', 'update_attributes', 'set_entity_data', 'player_list',
      'update_abilities', 'text', 'command_output', 'move_player', 'correct_player_move_prediction',
      'respawn', 'sync_world_clocks'
    ]
    for (const name of required) assert.ok(cap.first(name), `missing inbound ${name}`)
    assert.ok(cap.packets('level_chunk').length >= 10)
    assert.ok(cap.packets('subchunk').length >= 10)
    assert.ok(cap.first('player_auth_input', { dir: 'out' }))
    assert.ok(cap.first('command_request', { dir: 'out' }))
  })

  it('start_game matches the BDS test profile', () => {
    const sg = cap.first('start_game')
    assert.strictEqual(sg.dimension, 'overworld')
    assert.strictEqual(sg.block_network_ids_are_hashes, true)
    assert.strictEqual(sg.server_authoritative_inventory, true)
    assert.strictEqual(sg.rewind_history_size, 40)
    assert.ok(BigInt(sg.current_tick) > 0n, 'current_tick (protodef SignedBigInt) anchors the tick clock')
  })

  it('level_chunk uses sub-chunk request mode and subchunk replies carry data', () => {
    const chunk = cap.first('level_chunk')
    assert.strictEqual(chunk.sub_chunk_count, 0)
    assert.ok(chunk.highest_subchunk_count >= 1)
    const results = new Set(cap.packets('subchunk').flatMap(p => p.params.entries.map(e => e.result)))
    assert.ok(results.has('success'))
    assert.ok(results.has('success_all_air'))
  })
})
