'use strict'
// owner: U17 — bot.spawnPoint: BDS's spawn search height (y 32767) is resolved to the spawn column's ground
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const inject = require('../../lib/plugins/spawn_point')

function fakeBot ({ ground = 70, loaded = false, dimension = 'overworld' } = {}) {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.game = { dimension, minY: -64, height: 384 }
  bot.loaded = loaded
  bot.blockAt = (p) => {
    if (!bot.loaded) return null
    return { position: p, boundingBox: p.y < ground ? 'block' : 'empty', name: p.y < ground ? 'stone' : 'air' }
  }
  inject(bot)
  return bot
}

describe('spawn point height (U17)', () => {
  it('y 32767 stays until the spawn column is loaded, then becomes the ground height + 1', () => {
    const bot = fakeBot({ ground: 70 })
    bot._client.emit('start_game', { spawn_position: { x: -516, y: 32767, z: 77 } })
    assert.ok(bot.spawnPoint.equals(new Vec3(-516, 32767, 77)))
    bot.loaded = true
    bot.emit('chunkColumnLoad', new Vec3(-512, 0, 64)) // another column: nothing yet
    assert.strictEqual(bot.spawnPoint.y, 32767)
    bot.emit('chunkColumnLoad', new Vec3(-528, 0, 64)) // the spawn's column (x -528..-513, z 64..79)
    assert.ok(bot.spawnPoint.equals(new Vec3(-516, 70, 77)), `${bot.spawnPoint}`)
  })

  it('a real height (/setworldspawn) is kept; another dimension never resolves the overworld spawn', () => {
    const bot = fakeBot({ ground: 70, loaded: true })
    bot._client.emit('set_spawn_position', { spawn_type: 'world', player_position: { x: 3, y: 64, z: 4 } })
    assert.ok(bot.spawnPoint.equals(new Vec3(3, 64, 4)))
    const nether = fakeBot({ ground: 40, loaded: true, dimension: 'the_nether' })
    nether._client.emit('start_game', { spawn_position: { x: 0, y: 32767, z: 0 } })
    nether.emit('spawn')
    assert.strictEqual(nether.spawnPoint.y, 32767)
  })
})
