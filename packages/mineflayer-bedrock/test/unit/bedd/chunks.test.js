'use strict'
// bedd mode (transport 'bedd'): the real client requests its own sub-chunks, so lib/plugins/blocks.js sets a column at
// its level_chunk and decodes every subchunk entry into the column it names, whatever the request origin, without
// queueing a subchunk_request of its own (it is client-owned and the router drops it).
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, joinRecords } = require('../helpers/fake')

async function feed (bot, client, records) {
  let n = 0
  for (const { name, params } of records) {
    client.receive(name, params)
    if (++n % 50 === 0) await new Promise(resolve => setImmediate(resolve))
  }
  await new Promise(resolve => setImmediate(resolve))
}

describe('bedd chunks: the client owns the sub-chunk requests (lib/plugins/blocks.js)', function () {
  this.timeout(30000)

  it('columns load from level_chunk + the client\'s subchunk answers; bedboo sends no subchunk_request', async () => {
    const { bot, client } = await createFakeBot()
    bot._bedrock.mode = 'bedd'
    const records = joinRecords()
    await feed(bot, client, records)
    assert.strictEqual(client.sent('subchunk_request').length, 0, 'no subchunk_request of its own')
    const feet = bot.entity.position.floored()
    assert.notStrictEqual(bot.blockAt(feet.offset(0, -1, 0))?.name ?? 'undefined', 'undefined')
    assert.notStrictEqual(bot.blockAt(feet.offset(0, -1, 0)).name, 'air')
    assert.strictEqual(bot._bedrock.world.pendingColumns.size, 0, 'nothing waits for a request bedboo never made')

    // one request answers many columns relative to one origin (the client's), in any order: a subchunk for columns
    // never announced by level_chunk still loads them
    const sub = records.find(r => r.name === 'subchunk' && r.params.entries.some(e => e.result === 'success' && e.payload?.length))
    const entry = sub.params.entries.find(e => e.result === 'success' && e.payload?.length)
    const far = { x: 4000, y: sub.params.origin.y, z: 4000 }
    client.receive('subchunk', { ...sub.params, origin: { x: far.x - 3, y: far.y, z: far.z + 2 }, entries: [{ ...entry, dx: 3, dz: -2 }] })
    const column = bot.world.getColumn(far.x, far.z)
    assert.ok(column, 'the column was created by its subchunk')
    const sy = far.y + entry.dy
    let solid = 0
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) if (bot.blockAt(new Vec3(far.x * 16 + x, sy * 16 + y, far.z * 16 + z))?.name !== 'air') solid++
    const origX = sub.params.origin.x + entry.dx
    const origZ = sub.params.origin.z + entry.dz
    let expected = 0
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) if (bot.blockAt(new Vec3(origX * 16 + x, sy * 16 + y, origZ * 16 + z))?.name !== 'air') expected++
    assert.strictEqual(solid, expected, 'the same section decoded at the named column')
    assert.ok(solid > 0)
  })

  it('raknet mode still requests every sub-chunk and waits for them', async () => {
    const { bot, client } = await createFakeBot()
    const records = joinRecords()
    const chunk = records.find(r => r.name === 'level_chunk')
    client.receive('level_chunk', chunk.params)
    assert.strictEqual(client.sent('subchunk_request').length, 1)
    assert.strictEqual(bot.world.getColumn(chunk.params.x, chunk.params.z), undefined, 'set once its sub-chunks arrived')
  })
})
