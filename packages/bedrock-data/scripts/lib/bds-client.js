// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * Minimal raw bedrock-protocol client for the data scripts (probe-bds.js, live-check.js): joins, answers
 * the respawn handshake, acknowledges the loading screen, keeps a stationary player_auth_input running and
 * offers `command(cmd)` (command_request → command_output). bedrock-protocol is resolved from the
 * mineflayer-bedrock package (it is not a dependency of @bedboo/bedrock-data).
 */
const path = require('path')
const { createRequire } = require('module')

const repoRoot = path.join(__dirname, '..', '..', '..', '..')
const requireLib = createRequire(path.join(repoRoot, 'packages', 'mineflayer-bedrock', 'package.json'))

function connect ({ host = '127.0.0.1', port, username = 'U2Data', log = () => {} }) {
  require('../..').install()
  const bedrock = requireLib('bedrock-protocol')
  const client = bedrock.createClient({
    host, port, username, offline: true, version: '1.26.51', transport: 'raknet', raknetBackend: 'raknet-native', skipPing: true
  })
  const state = { startGame: null, tick: 0n, position: { x: 0, y: 0, z: 0 }, timer: null }
  client.on('start_game', p => {
    state.startGame = p
    state.tick = BigInt(p.current_tick)
    Object.assign(state.position, p.player_position)
  })
  client.on('respawn', p => {
    if (p.state === 1 && state.startGame) {
      Object.assign(state.position, p.position)
      client.queue('respawn', { position: p.position, state: 2, runtime_entity_id: state.startGame.runtime_entity_id })
    }
  })
  const isSelf = id => state.startGame && BigInt(id) === BigInt(state.startGame.runtime_entity_id)
  client.on('move_player', p => { if (isSelf(p.runtime_id)) Object.assign(state.position, p.position) })
  client.on('correct_player_move_prediction', p => { Object.assign(state.position, p.position); state.tick = BigInt(p.tick) })
  client.on('error', e => log('error', e))

  const spawned = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no spawn within 30 s')), 30000)
    client.once('spawn', () => {
      clearTimeout(t)
      client.queue('serverbound_loading_screen', { type: 1 })
      client.queue('serverbound_loading_screen', { type: 2 })
      state.timer = setInterval(() => {
        state.tick++
        client.queue('player_auth_input', {
          pitch: 0,
          yaw: 0,
          position: { ...state.position },
          move_vector: { x: 0, z: 0 },
          head_yaw: 0,
          input_data: [],
          input_mode: 'mouse',
          play_mode: 'normal',
          interaction_model: 'crosshair',
          interact_rotation: { x: 0, z: 0 },
          tick: state.tick,
          delta: { x: 0, y: 0, z: 0 },
          analogue_move_vector: { x: 0, z: 0 },
          camera_orientation: { x: 0, y: 0, z: 1 },
          raw_move_vector: { x: 0, z: 0 }
        })
      }, 50)
      resolve()
    })
  })

  /** Runs a command as the (operator) player; resolves with command_output params or null on timeout. */
  function command (cmd, timeout = 3000) {
    client.queue('command_request', {
      command: cmd,
      origin: { type: 'player', uuid: client.profile?.uuid ?? '00000000-0000-0000-0000-000000000000', request_id: '', player_entity_id: 0n },
      internal: false,
      version: 'latest'
    })
    return new Promise(resolve => {
      const t = setTimeout(() => { client.removeListener('command_output', on); resolve(null) }, timeout)
      function on (p) { clearTimeout(t); client.removeListener('command_output', on); resolve(p) }
      client.on('command_output', on)
    })
  }

  /** Resolves with the first `name` packet matching `filter` (or null after `timeout` ms). */
  function waitFor (name, filter = () => true, timeout = 3000) {
    return new Promise(resolve => {
      const t = setTimeout(() => { client.removeListener(name, on); resolve(null) }, timeout)
      function on (p) {
        if (!filter(p)) return
        clearTimeout(t)
        client.removeListener(name, on)
        resolve(p)
      }
      client.on(name, on)
    })
  }

  function close () {
    clearInterval(state.timer)
    client.close()
  }

  return { client, state, spawned, command, waitFor, close, requireLib }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

module.exports = { connect, sleep, requireLib }
