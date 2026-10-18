#!/usr/bin/env node
'use strict'
/**
 * Records a raw packet capture from a running BDS into a gzip'd JSONL fixture.
 *
 * It is also the U0 transport spike: a raw bedrock-protocol client joins, answers the initial
 * respawn, spawns, acknowledges the loading screen, keeps sending a stationary `player_auth_input`
 * every 50 ms, requests sub-chunks, runs console commands in the server container (through
 * @bedboo/bds's docker helper) plus one client `command_request` and chat, provokes one movement
 * correction, then disconnects. Exit code 1 unless join, start_game, spawn, level_chunk and
 * subchunk were all observed.
 *
 * Usage (server must already be running, see docs/testing.md for the docker recipe):
 *   node scripts/capture-fixtures.js [--host 127.0.0.1] [--port 40100] [--container bds-u0]
 *     [--username U0Bot] [--seconds 25] [--backend raknet-native|jsp-raknet] [--transport raknet]
 *     [--ping yes]   (default: skipPing)   [--container ""]   (no console commands)
 *     [--out packages/mineflayer-bedrock/test/fixtures/1.26.51/join_flat.jsonl.gz]
 *
 * Output format: line 1 is `{"meta":{...}}`; every other line is
 *   {"i": <seq>, "t": <ms since connect>, "dir": "in"|"out", "name": "<packet>", "buf": "<base64>"}
 * where `buf` is the raw, decompressed, decrypted packet buffer (varint header id + body) exactly
 * as bedrock-protocol's deserializer consumes it. Duplicate (same name + bytes) packets are dropped.
 * Load with `packages/mineflayer-bedrock/test/fixtures/index.js`.
 */
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')
const crypto = require('crypto')
const { createRequire } = require('module')

const root = path.join(__dirname, '..')
const pkgRequire = createRequire(path.join(root, 'packages/mineflayer-bedrock/package.json'))
const bedrock = pkgRequire('bedrock-protocol')

function arg (name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : (process.env['CAPTURE_' + name.toUpperCase()] ?? def)
}

const host = arg('host', '127.0.0.1')
const port = Number(arg('port', 40100))
const container = arg('container', 'bds-u0')
const username = arg('username', 'U0Bot')
const seconds = Number(arg('seconds', 25))
const backend = arg('backend', 'raknet-native')
const transport = arg('transport', 'raknet')
const out = path.resolve(arg('out', path.join(root, 'packages/mineflayer-bedrock/test/fixtures/1.26.51/join_flat.jsonl.gz')))

// Per packet-name caps keep the fixture small; everything not listed is capped at DEFAULT_CAP.
const DEFAULT_CAP = 40
const CAPS = { level_chunk: 60, subchunk: 120, player_auth_input: 40, move_entity_delta: 20, set_entity_motion: 20, network_stack_latency: 5 }

const records = []
const seen = new Set()
const counts = {}
const stats = {}
const t0 = Date.now()
let seq = 0

// Never stored: our own login (≈0.5 MB of generated skin/identity JWTs).
const SKIP = new Set(['out:login'])

function record (dir, name, buf) {
  stats[dir + ':' + name] = (stats[dir + ':' + name] || 0) + 1
  if (SKIP.has(dir + ':' + name)) return
  const key = dir + name + crypto.createHash('sha1').update(buf).digest('hex')
  if (seen.has(key)) return
  seen.add(key)
  const ck = dir + ':' + name
  counts[ck] = (counts[ck] || 0) + 1
  if (counts[ck] > (CAPS[name] ?? DEFAULT_CAP)) return
  records.push({ i: seq++, t: Date.now() - t0, dir, name, buf: Buffer.from(buf).toString('base64') })
}

// Console commands go through @bedboo/bds's docker helper: the image's own `send-command` cannot
// find the server process on this host (see packages/bds/lib/docker.js and docs/testing.md).
const docker = require('@bedboo/bds/lib/docker')
function consoleCommand (cmd) {
  if (!container) return
  docker.sendCommand(container, cmd).then(
    () => console.log('[capture] console:', cmd),
    (e) => console.warn('[capture] console command failed:', cmd, e.message)
  )
}

const client = bedrock.createClient({
  host,
  port,
  username,
  offline: true,
  version: '1.26.51',
  transport,
  raknetBackend: backend,
  skipPing: arg('ping', 'skip') === 'skip',
  conLog: (...a) => console.log('[bedrock-protocol]', ...a)
})

// Inbound: capture the exact buffer handed to the deserializer.
const origRead = client.readPacket.bind(client)
client.readPacket = (buf) => {
  let name = '?'
  try { name = client.deserializer.parsePacketBuffer(buf).data.name } catch (e) { name = 'unparsed' }
  record('in', name, buf)
  return origRead(buf)
}
// Outbound: re-serialize what we send (same bytes the framer receives).
for (const fn of ['write', 'queue']) {
  const orig = client[fn].bind(client)
  client[fn] = (name, params) => {
    try { record('out', name, client.serializer.createPacketBuffer({ name, params })) } catch (e) {}
    return orig(name, params)
  }
}

let startGame = null
let tick = 0n
let inputTimer = null
const position = { x: 0, y: 0, z: 0 }
const requested = new Set()
const milestones = {}

function milestone (name, extra) {
  if (milestones[name]) return
  milestones[name] = Date.now() - t0
  console.log(`[capture] ${name} @${milestones[name]}ms`, extra ?? '')
}

client.on('join', () => milestone('join'))
client.on('start_game', (p) => {
  startGame = p
  tick = BigInt(p.current_tick ?? 0)
  Object.assign(position, p.player_position)
  milestone('start_game', { runtime_entity_id: p.runtime_entity_id, pos: p.player_position, tick: p.current_tick, rewind: p.rewind_history_size })
})
client.on('item_registry', (p) => milestone('item_registry', { items: p.itemstates?.length }))
client.on('respawn', (p) => {
  console.log('[capture] respawn', p)
  if (p.state === 1 && startGame) {
    // Server says "ready to spawn" (after the initial spawn search from y=32769): adopt the
    // position (eye level) and acknowledge as the vanilla client does (client_ready = 2).
    Object.assign(position, p.position)
    client.queue('respawn', { position: p.position, state: 2, runtime_entity_id: startGame.runtime_entity_id })
  }
})
client.on('move_player', (p) => {
  if (startGame && BigInt(p.runtime_id) === BigInt(startGame.runtime_entity_id)) {
    Object.assign(position, p.position)
    if (p.tick) tick = BigInt(p.tick)
  }
})
client.on('correct_player_move_prediction', (p) => {
  Object.assign(position, p.position)
  tick = BigInt(p.tick)
  milestone('correct_player_move_prediction')
})
client.on('level_chunk', (p) => {
  milestone('level_chunk', { x: p.x, z: p.z, sub_chunk_count: p.sub_chunk_count, highest: p.highest_subchunk_count })
  const key = p.x + ',' + p.z
  if (requested.has(key)) return
  // Sub-chunk request mode. With minecraft-data 3.117.0's 1.26.51 schema BDS sends
  // sub_chunk_count = 0 and `highest_subchunk_count` present (count of sub-chunks from the
  // bottom that hold data); older servers signal it with sub_chunk_count 0xfffffffe/0xffffffff.
  if (p.highest_subchunk_count != null || p.sub_chunk_count >= 0xfffffffe) {
    requested.add(key)
    // Request the full overworld column (-4..19): non-empty ones return `success`, the rest
    // `success_all_air`, so the fixture covers both result kinds.
    const requests = []
    for (let y = -4; y < 20; y++) requests.push({ x: 0, y, z: 0 })
    client.queue('subchunk_request', { dimension: p.dimension ?? 0, origin: { x: p.x, y: 0, z: p.z }, requests })
  }
})
client.on('subchunk', (p) => milestone('subchunk', { origin: p.origin, entries: p.entries?.length, results: [...new Set(p.entries?.map(e => e.result))] }))
client.on('update_block', () => milestone('update_block'))
client.on('inventory_content', () => milestone('inventory_content'))
client.on('inventory_slot', () => milestone('inventory_slot'))
client.on('set_time', () => milestone('set_time'))
client.on('sync_world_clocks', () => milestone('sync_world_clocks'))
client.on('command_output', (p) => milestone('command_output', JSON.stringify(p.output?.map(o => o.message_id))))
client.on('text', (p) => console.log('[capture] text', p.type, p.message, p.parameters ?? ''))
client.on('disconnect', (p) => console.log('[capture] disconnect', p))
client.on('kick', (p) => console.log('[capture] kick', p))
client.on('error', (e) => console.error('[capture] error', e))
client.on('close', () => milestone('close'))

client.on('spawn', () => {
  milestone('spawn')
  // BDS 1.26.51.1 does not simulate the player (ignores player_auth_input: no movement, no
  // corrections) until the client reports its loading screen as finished.
  client.queue('serverbound_loading_screen', { type: 1 }) // start
  client.queue('serverbound_loading_screen', { type: 2 }) // end
  // Stationary player_auth_input every 50 ms (server-authoritative movement needs it every tick).
  inputTimer = setInterval(() => {
    tick++
    client.queue('player_auth_input', {
      pitch: 0,
      yaw: 0,
      position: { ...position },
      move_vector: { x: 0, z: 0 },
      head_yaw: 0,
      input_data: [],
      input_mode: 'mouse',
      play_mode: 'normal',
      interaction_model: 'crosshair',
      interact_rotation: { x: 0, z: 0 },
      tick,
      delta: { x: 0, y: 0, z: 0 },
      analogue_move_vector: { x: 0, z: 0 },
      camera_orientation: { x: 0, y: 0, z: 1 },
      raw_move_vector: { x: 0, z: 0 }
    })
  }, 50)

  const px = Math.floor(position.x)
  const py = Math.floor(position.y - 1.62)
  const pz = Math.floor(position.z)
  const steps = [
    [1000, () => consoleCommand(`give ${username} diamond_pickaxe`)],
    [1500, () => consoleCommand(`give ${username} oak_log 16`)],
    [2000, () => consoleCommand(`setblock ${px + 2} ${py} ${pz} stone`)],
    [2500, () => consoleCommand(`setblock ${px + 2} ${py} ${pz + 1} chest`)],
    [3000, () => consoleCommand('say hello from console')],
    [3500, () => consoleCommand(`xp 30 ${username}`)],
    [4000, () => consoleCommand(`effect ${username} speed 30 1`)],
    [4500, () => consoleCommand('weather rain')],
    [5000, () => {
      client.queue('command_request', {
        command: '/time set 1000',
        origin: { type: 'player', uuid: client.profile?.uuid ?? '00000000-0000-0000-0000-000000000000', request_id: '', player_entity_id: 0n },
        internal: false,
        version: 'latest'
      })
      console.log('[capture] client command_request /time set 1000')
    }],
    [5500, () => client.queue('text', {
      needs_translation: false,
      category: 'authored',
      type: 'chat',
      source_name: username,
      message: 'hello from U0Bot',
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false
    })],
    [6000, () => consoleCommand(`replaceitem entity ${username} slot.hotbar 3 iron_sword`)],
    [6500, () => consoleCommand(`tp ${username} ${px + 0.5} ${py + 3} ${pz + 0.5}`)],
    [7000, () => consoleCommand('weather clear')],
    [7500, () => consoleCommand(`clear ${username} oak_log`)],
    [8000, () => consoleCommand(`title ${username} title Hello`)],
    [8500, () => consoleCommand(`gamemode creative ${username}`)],
    [9500, () => consoleCommand(`gamemode survival ${username}`)],
    [10000, () => consoleCommand(`summon pig ${px + 3} ${py} ${pz + 3}`)],
    [10500, () => consoleCommand(`setblock ${px + 2} ${py} ${pz} air`)],
    [11000, () => consoleCommand('time set 6000')],
    [11500, () => consoleCommand(`replaceitem entity ${username} slot.hotbar 0 iron_sword`)],
    [12000, () => consoleCommand(`enchant ${username} sharpness 2`)],
    [12500, () => consoleCommand(`give ${username} oak_planks 3`)],
    [13000, () => consoleCommand(`give ${username} oak_planks 5`)],
    [13500, () => consoleCommand(`replaceitem entity ${username} slot.armor.head 0 iron_helmet`)],
    [14000, () => consoleCommand(`replaceitem entity ${username} slot.weapon.offhand 0 shield`)],
    // Claim an impossible 4-block move in one tick so the server answers with
    // correct_player_move_prediction (rewind correction); the handler above adopts its position.
    [15000, () => { position.x += 4; console.log('[capture] sent impossible move to provoke a correction') }]
  ]
  for (const [ms, fn] of steps) setTimeout(fn, ms)
})

setTimeout(finish, seconds * 1000)
process.on('SIGINT', finish)

let finished = false
function finish () {
  if (finished) return
  finished = true
  clearInterval(inputTimer)
  try { client.disconnect('capture finished') } catch (e) {}
  const meta = {
    bds: '1.26.51.1',
    version: '1.26.51',
    protocol: client.options?.protocolVersion,
    transport,
    raknetBackend: backend,
    username,
    capturedAt: new Date().toISOString(),
    milestones,
    stats
  }
  const lines = [JSON.stringify({ meta }), ...records.map(r => JSON.stringify(r))].join('\n') + '\n'
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, zlib.gzipSync(lines, { level: 9 }))
  console.log(`[capture] wrote ${records.length} packets (${fs.statSync(out).size} bytes gz) to ${path.relative(root, out)}`)
  const required = ['join', 'start_game', 'spawn', 'level_chunk', 'subchunk']
  const missing = required.filter(m => !milestones[m])
  if (missing.length) {
    console.error('[capture] SPIKE FAILED, missing milestones:', missing.join(', '))
    process.exitCode = 1
  } else {
    console.log('[capture] spike OK: joined, spawned, received level_chunk and subchunk')
  }
  setTimeout(() => process.exit(), 500)
}
