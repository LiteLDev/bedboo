// owner: U5 (physics & movement)
'use strict'
/**
 * Acceptance (Bedrock extra): 60 s of walk / sprint / sprint-jump / sneak / jump-walk laps over flat ground, stairs
 * and slabs with the server-authoritative movement of BDS 1.26.51.1:
 * - default settings (player-position-acceptance-threshold 0.5): 0 corrections;
 * - player-position-acceptance-threshold 0.1: at most 1 correction per 100 ticks.
 * The bot ends where the server says it is (querytarget).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')
const { commands, correctionRecorder, serverPosition, idle, place, sleep } = require('./physics_util')

const EAST = -Math.PI / 2
const WEST = Math.PI / 2
const MODES = [
  ['forward'],
  ['forward', 'sprint'],
  ['forward', 'sprint', 'jump'],
  ['forward', 'sneak'],
  ['forward', 'jump']
]

/** lane z = 0.5 from x = 0 to 16: stairs up (x 2..4), platform (x 5..7, top −57), slab steps down (x 8..12) */
function courseCommands () {
  const cmds = [
    'fill -3 -60 -3 19 -50 3 air',
    'fill -3 -61 -3 19 -61 3 grass_block'
  ]
  for (let i = 0; i < 3; i++) {
    if (i > 0) cmds.push(`fill ${2 + i} -60 -1 ${2 + i} ${-61 + i} 2 stone`)
    cmds.push(`fill ${2 + i} ${-60 + i} -1 ${2 + i} ${-60 + i} 2 oak_stairs ["weirdo_direction"=0,"upside_down_bit"=false]`)
  }
  cmds.push('fill 5 -60 -1 7 -58 2 stone')
  // slab steps: top heights −57.5, −58, −58.5, −59, −59.5
  const steps = [2.5, 2, 1.5, 1, 0.5]
  steps.forEach((h, i) => {
    const x = 8 + i
    const full = Math.floor(h)
    if (full > 0) cmds.push(`fill ${x} -60 -1 ${x} ${-60 + full - 1} 2 stone`)
    if (h > full) cmds.push(`fill ${x} ${-60 + full} -1 ${x} ${-60 + full} 2 smooth_stone_slab ["minecraft:vertical_half"="bottom"]`)
  })
  return cmds
}

async function runLaps (bot, ms) {
  let dir = EAST
  let lap = 0
  let ticks = 0
  await bot.look(dir, 0, true)
  const onTick = () => {
    ticks++
    const x = bot.entity.position.x
    if (dir === EAST && x >= 15) {
      dir = WEST
      bot.look(dir, 0, true)
    } else if (dir === WEST && x <= 0.8) {
      dir = EAST
      lap++
      bot.look(dir, 0, true)
    }
    const mode = MODES[lap % MODES.length]
    for (const c of ['forward', 'sprint', 'jump', 'sneak']) bot.setControlState(c, mode.includes(c))
  }
  bot.on('physicsTick', onTick)
  await sleep(ms)
  bot.removeListener('physicsTick', onTick)
  await idle(bot, 20)
  return { laps: lap, ticks }
}

function suite (name, properties, check) {
  describe(name, function () {
    this.timeout(180000)
    const env = useBot({ server: { gamemode: 'survival', properties } })

    it('60 s of walk / sprint / sprint-jump / sneak / jump-walk laps over flat ground, stairs and slabs', async () => {
      const { bot, server } = env
      await commands(server, courseCommands())
      await place(bot, new Vec3(0.5, -60, 0.5), 1000)
      const rec = correctionRecorder(bot)
      const { laps, ticks } = await runLaps(bot, 60000)
      rec.stop()
      console.log(`      ${laps} laps, ${ticks} ticks, ${rec.count} corrections (${rec.mispredictions().length} mispredictions)`)
      assert.ok(laps >= 5, `${laps} laps`)
      const pos = await serverPosition(bot, server)
      assert.ok(pos && pos.distanceTo(bot.entity.position) < 0.1, `client ${bot.entity.position} server ${pos}`)
      check(rec, ticks)
    })
  })
}

suite('physics acceptance: default settings (U5)', {}, (rec) => {
  assert.strictEqual(rec.count, 0, `corrections: ${JSON.stringify(rec.list.map((c) => [String(c.tick), c.error]))}`)
})

suite('physics acceptance: player-position-acceptance-threshold=0.1 (U5)', { 'player-position-acceptance-threshold': 0.1 }, (rec, ticks) => {
  assert.ok(rec.count <= Math.ceil(ticks / 100), `${rec.count} corrections in ${ticks} ticks`)
})
