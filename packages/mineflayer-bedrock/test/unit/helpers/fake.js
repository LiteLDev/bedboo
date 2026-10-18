// owner: U4 (core runtime) — shared by the U4 unit tests (and free to reuse by later units)
'use strict'
/**
 * A mineflayer-bedrock bot on a fake bedrock-protocol client (no network), with a controllable tick clock,
 * plus a replay of the recorded BDS join (test/fixtures join_flat).
 *
 *   const { createFakeBot, replayJoin } = require('./helpers/fake')
 *   const { bot, client, clock } = await createFakeBot()
 *   await replayJoin(bot, client)                    // start_game … play_status player_spawn
 *   clock.advance(50); bot._bedrock.input.pump()      // one tick → one player_auth_input
 *   client.sent('player_auth_input')                  // params of every queued/written packet with that name
 */
const { EventEmitter } = require('events')
const fixtures = require('../../fixtures')
const mineflayerBedrock = require('../../..')
const { createInputQueue } = require('../../../lib/bedrock/input_queue')

function fakeClient ({ username = 'U0Bot' } = {}) {
  const client = new EventEmitter()
  client.setMaxListeners(0)
  client.version = '1.26.51'
  client.username = username
  client.profile = { name: username, uuid: '103594cd-1da0-2ec6-fb7c-32af2c646f85', xuid: 0 }
  client.options = { version: '1.26.51', username, offline: true }
  client.written = []
  client.queue = (name, params) => client.written.push(['queue', name, params])
  client.write = (name, params) => client.written.push(['write', name, params])
  client.disconnect = (reason) => {
    client.written.push(['write', 'disconnect', { message: reason }])
    client.close()
  }
  client.close = () => {
    if (client.closed) return
    client.closed = true
    client.emit('close')
  }
  client.sent = (name) => client.written.filter(([, n]) => n === name).map(([, , p]) => p)
  client.clearSent = () => { client.written.length = 0 }
  /** emit a packet the way bedrock-protocol's Client#readPacket does */
  client.receive = (name, params) => {
    client.emit('packet', { data: { name, params } })
    if (name === 'start_game') client.startGameData = params
    if (name === 'server_to_client_handshake') client.emit('join')
    if (name === 'play_status' && params.status === 'player_spawn') {
      client.write('set_local_player_as_initialized', { runtime_entity_id: client.startGameData?.runtime_entity_id ?? 0n })
      client.emit('spawn')
    }
    client.emit(name, params)
  }
  return client
}

function fakeClock (start = 1000) {
  const clock = {
    now: start,
    advance (ms) { clock.now += ms; return clock.now }
  }
  return clock
}

/**
 * @param {object} [options] createBot options
 * @param {{ manualClock?: boolean }} [opts] manualClock (default true): the input queue runs on `clock`
 *   and never starts a real timer; drive it with `bot._bedrock.input.pump()`
 */
async function createFakeBot (options = {}, { manualClock = true } = {}) {
  const client = fakeClient({ username: options.username })
  const bot = mineflayerBedrock.createBot({ client, username: client.username, logErrors: false, hideErrors: true, ...options })
  const clock = fakeClock()
  if (manualClock) {
    const timers = { setInterval: () => ({ unref () {} }), clearInterval () {} }
    bot._bedrock.input = createInputQueue(bot, { now: () => clock.now, timers, maxCatchupTicks: options.maxCatchupTicks })
  }
  const errors = []
  bot.on('error', (err) => errors.push(err))
  await new Promise((resolve) => bot.once('inject_allowed', () => setImmediate(resolve)))
  return { bot, client, clock, errors }
}

/** Every inbound record of the join_flat capture up to and including play_status player_spawn. */
function joinRecords () {
  const cap = fixtures.load('join_flat')
  const end = cap.records.findIndex(r => r.dir === 'in' && r.name === 'play_status' && cap.parse(r).status === 'player_spawn')
  return cap.records.slice(0, end + 1).filter(r => r.dir === 'in').map(r => ({ name: r.name, params: cap.parse(r) }))
}

/** Replay the join (yields to the event loop every 50 packets, like the conformance replay). */
async function replayJoin (bot, client, { until } = {}) {
  let n = 0
  for (const { name, params } of joinRecords()) {
    if (until && until(name, params)) break
    client.receive(name, params)
    if (++n % 50 === 0) await new Promise(resolve => setImmediate(resolve))
  }
  await new Promise(resolve => setImmediate(resolve))
}

/** Inbound records of join_flat after the spawn (the console commands of the capture). */
function afterSpawnRecords () {
  const cap = fixtures.load('join_flat')
  const end = cap.records.findIndex(r => r.dir === 'in' && r.name === 'play_status' && cap.parse(r).status === 'player_spawn')
  return cap.records.slice(end + 1).filter(r => r.dir === 'in').map(r => ({ name: r.name, params: cap.parse(r) }))
}

module.exports = { fakeClient, fakeClock, createFakeBot, replayJoin, joinRecords, afterSpawnRecords }
