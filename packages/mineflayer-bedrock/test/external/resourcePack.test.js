// owner: U4 (core runtime)
'use strict'
/**
 * Resource packs against a real BDS 1.26.51.1 (Bedrock extra, U4): the server offers a world resource pack
 * (written into the world, server restarted); the bot holds its answer while a 'resourcePack' listener exists.
 * accept → joins; deny of an optional pack → joins without it; deny of a required pack (texturepack-required)
 * → BDS disconnects (kicked 'missing_client', loggedIn false); no listener → accepted automatically.
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { useServer } = require('./common')
const mineflayerBedrock = require('../..')

const PACK_UUID = '6c1fd8c5-2d4c-4b7e-9b43-0e0f2a4d5b61'
let counter = 0
const uniqueName = (prefix) => `${prefix}${process.pid % 1000}${counter++}`

function installPack (server) {
  const world = path.join(server.dataDir, 'worlds', server.levelName)
  const pack = path.join(world, 'resource_packs', 'bedboo_u4')
  fs.mkdirSync(pack, { recursive: true })
  fs.writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify({
    format_version: 2,
    header: { name: 'bedboo U4 test pack', description: 'resourcePack e2e', uuid: PACK_UUID, version: [1, 0, 0], min_engine_version: [1, 21, 0] },
    modules: [{ type: 'resources', uuid: 'a0a1c3d2-5e6f-4a7b-8c9d-0e1f2a3b4c5d', version: [1, 0, 0] }]
  }, null, 2))
  fs.writeFileSync(path.join(world, 'world_resource_packs.json'), JSON.stringify([{ pack_id: PACK_UUID, version: [1, 0, 0] }]))
}

function setRequired (server, required) {
  const file = path.join(server.dataDir, 'server.properties')
  const text = fs.readFileSync(file, 'utf8').replace(/^texturepack-required=.*$/m, `texturepack-required=${required}`)
  fs.writeFileSync(file, text)
}

/** join with an optional resourcePack listener; resolves with what happened */
function join (server, onPack) {
  const bot = mineflayerBedrock.createBot({ host: server.host, port: server.port, username: uniqueName('pack'), viewDistance: 'tiny', logErrors: false })
  const result = { packs: [], sent: [] }
  const write = bot._client.write.bind(bot._client)
  bot._client.write = (name, params) => {
    if (name === 'resource_pack_client_response') result.sent.push(params.response_status)
    return write(name, params)
  }
  if (onPack) {
    bot.on('resourcePack', (url, hash, uuid) => {
      result.packs.push([url, hash, uuid])
      setTimeout(() => onPack(bot), 300) // answered later: the server must wait
    })
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('neither spawn nor end')), 30000)
    bot.once('spawn', () => { clearTimeout(timer); result.spawned = true; bot.quit(); resolve(result) })
    bot.once('kicked', (reason, loggedIn) => { result.kicked = [reason, loggedIn] })
    bot.once('end', (reason) => { clearTimeout(timer); result.end = reason; resolve(result) })
  })
}

describe('core: resource packs (U4)', function () {
  this.timeout(180000)
  const env = useServer({ gamemode: 'creative' })

  before(async function () {
    if (env.server.external) this.skip() // needs the instance directory
    installPack(env.server)
    await env.server.restart()
  })

  it('no listener: accepted automatically', async () => {
    const r = await join(env.server, null)
    assert.strictEqual(r.spawned, true)
    assert.deepStrictEqual(r.sent, ['completed'])
  })

  it('acceptResourcePack: the answer waits for the call, then the bot joins', async () => {
    const r = await join(env.server, (bot) => bot.acceptResourcePack())
    assert.strictEqual(r.packs.length, 1)
    const [url, hash, uuid] = r.packs[0]
    assert.strictEqual(url, '')
    assert.match(uuid, /^[0-9a-f-]{36}$/)
    assert.strictEqual(hash, `${uuid}_1.0.0`)
    assert.deepStrictEqual(r.sent, ['completed'])
    assert.strictEqual(r.spawned, true)
  })

  it('denyResourcePack of an optional pack: joins without it', async () => {
    const r = await join(env.server, (bot) => bot.denyResourcePack())
    assert.deepStrictEqual(r.sent, ['have_all_packs', 'completed'])
    assert.strictEqual(r.spawned, true)
  })

  it('denyResourcePack of a required pack: the server disconnects the bot (kicked, not logged in)', async () => {
    setRequired(env.server, true)
    await env.server.restart()
    try {
      const r = await join(env.server, (bot) => bot.denyResourcePack())
      assert.deepStrictEqual(r.sent, ['refused'])
      assert.ok(!r.spawned)
      assert.deepStrictEqual(r.kicked, ['missing_client', false])
      const ok = await join(env.server, (bot) => bot.acceptResourcePack())
      assert.strictEqual(ok.spawned, true, 'accepting a required pack joins')
    } finally {
      setRequired(env.server, false)
    }
  })
})
