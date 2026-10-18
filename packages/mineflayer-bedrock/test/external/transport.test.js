// owner: U0 (transport spike) → U1 (ported onto the harness)
'use strict'
/**
 * smoke: raw transport against a real BDS (no mineflayer plugins involved).
 *
 * The server comes from the harness (`startServer()`: isolated container in a slot) or from
 * BDS_HOST/BDS_PORT. Proves lib/client.js defaults (offline RakNet via the patched raknet-native,
 * version 1.26.51, skipPing) can join, spawn and receive chunks.
 */
const assert = require('assert')
require('@bedboo/bedrock-data').install()
const { createClient } = require('../../lib/client')
const { useServer } = require('./common')

function waitFor (emitter, event, timeout, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, listener)
      reject(new Error(`timed out after ${timeout} ms waiting for ${event}`))
    }, timeout)
    function listener (params) {
      if (!predicate(params)) return
      clearTimeout(timer)
      emitter.removeListener(event, listener)
      resolve(params)
    }
    emitter.on(event, listener)
  })
}

describe('smoke: raw bedrock-protocol transport (U0 spike)', function () {
  this.timeout(60000)
  const env = useServer()
  let client

  afterEach(() => {
    if (client) {
      client.disconnect('smoke test done') // no-op until the transport is connected …
      client.close() // … so also close (idempotent)
    }
    client = null
  })

  it('joins, spawns, receives level_chunk and subchunk', async () => {
    client = createClient({
      host: env.server.host,
      port: env.server.port,
      username: 'SmokeT' + Math.floor(Math.random() * 1e4),
      conLog: null
    })
    let startGame = null
    client.on('start_game', (p) => { startGame = p })
    client.on('respawn', (p) => {
      if (p.state === 1 && startGame) client.queue('respawn', { position: p.position, state: 2, runtime_entity_id: startGame.runtime_entity_id })
    })
    // chunks usually arrive before play_status player_spawn: remember the first one
    let firstChunk = null
    client.on('level_chunk', (p) => { firstChunk ??= p })
    await waitFor(client, 'spawn', 30000)
    client.queue('serverbound_loading_screen', { type: 1 })
    client.queue('serverbound_loading_screen', { type: 2 })
    assert.ok(startGame, 'start_game before spawn')
    const lc = firstChunk ?? await waitFor(client, 'level_chunk', 15000)
    assert.ok(lc.highest_subchunk_count != null, 'sub-chunk request mode')
    const sub = waitFor(client, 'subchunk', 15000)
    client.queue('subchunk_request', {
      dimension: lc.dimension,
      origin: { x: lc.x, y: 0, z: lc.z },
      requests: [{ x: 0, y: -4, z: 0 }, { x: 0, y: 0, z: 0 }]
    })
    const { entries } = await sub
    assert.deepStrictEqual(entries.map(e => e.result).sort(), ['success', 'success_all_air'])
  })
})
