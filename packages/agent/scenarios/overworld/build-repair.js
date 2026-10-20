// owner: FINAL-ROUND (the build skill's repair on BDS)
'use strict'
/**
 * B1 — the build repairs block by block (U17's `build` skill, house5x5 on a flat world, materials given). During the
 * build the "world" goes wrong in the three ways a real run met:
 * - a cow is summoned into a floor cell: BDS itself refuses a block whose cell a mob stands in;
 * - the first 5 placements at another floor cell are refused (the library's refusal error; default-f2's failure:
 *   BDS refused the same cobblestone 4 times from the same spot): the build's 4 attempts fail, a repair round places
 *   it;
 * - when the roof begins, a finished wall block is replaced with dirt (`/setblock`): the verification finds it, the
 *   repair digs it out and places cobblestone again.
 * The house must verify (125 cells) after the repair. Cheat-assisted (documented in the scenario only: the kit, the
 * cow, the forced refusals and the griefing block are the test's own disturbances).
 */
const { Vec3 } = require('vec3')

const KIT = [['cobblestone', 128], ['oak_planks', 64], ['wooden_door', 1], ['crafting_table', 1], ['chest', 1], ['dirt', 32], ['stone_pickaxe', 1], ['stone_shovel', 1]]

module.exports = {
  name: 'B1-build-repair',
  description: 'house5x5 with a cow in a floor cell, 5 refused placements and a griefed wall block: repaired block by block',
  server: { gamemode: 'survival' },
  kit: KIT,
  timeout: 10 * 60 * 1000,
  async prepare (ctx) {
    const { bot, cmd, data } = ctx
    const feet = bot.entity.position.floored()
    const origin = feet.offset(3, 0, 3)
    data.origin = { x: origin.x, y: origin.y, z: origin.z }
    const refusedCell = origin.offset(1, 0, 3) // a floor cell
    const cowCell = origin.offset(3, 0, 1) // another floor cell
    const wallCell = origin.offset(0, 2, 2) // the west wall, middle layer
    data.refusedCell = refusedCell
    data.wallCell = wallCell
    data.forced = 0
    data.griefed = false
    ctx.log(`summon: ${(await cmd(`summon cow ${cowCell.x + 0.5} ${cowCell.y} ${cowCell.z + 0.5}`)).join(' | ')}`)
    const placeBlock = bot.placeBlock
    bot.placeBlock = async function (ref, face) {
      const dest = ref.position.plus(face)
      if (dest.equals(refusedCell) && data.forced < 5) {
        data.forced++
        throw new Error(`Server refused to place ${bot.heldItem?.name} at ${dest}: the block is still air (forced by the test, ${data.forced}/5)`)
      }
      const out = await placeBlock.call(bot, ref, face)
      if (!data.griefed && dest.y === origin.y + 4) {
        data.griefed = true
        ctx.log(`grief: ${(await cmd(`setblock ${wallCell.x} ${wallCell.y} ${wallCell.z} dirt`)).join(' | ')}`)
      }
      return out
    }
  },
  steps: (ctx) => [{ skill: 'build', name: 'build house5x5', args: { blueprint: 'house5x5', origin: ctx.data.origin }, timeout: 8 * 60 * 1000 }],
  check (report, ctx) {
    const r = report.steps[0].result
    const { bot, data } = ctx
    if (!r?.verified) throw new Error(`not verified: ${JSON.stringify(r?.mismatches)}`)
    if (data.forced !== 5) throw new Error(`forced refusals: ${data.forced}/5`)
    if (!data.griefed) throw new Error('the wall block was not griefed')
    if (!(r.repairs?.length >= 1)) throw new Error(`no repair round ran: ${JSON.stringify(r.repairs)}`)
    for (const [name, cell] of [['refused cell', data.refusedCell], ['griefed wall cell', data.wallCell]]) {
      const b = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
      if (b?.name !== 'cobblestone') throw new Error(`${name} at ${cell}: ${b?.name}`)
    }
    ctx.log(`repaired: ${r.repairs.length} round(s) (${r.repairs.join(' → ')} mismatches left), ${r.placed} placed, ${(r.ms / 1000).toFixed(0)} s`)
  }
}
