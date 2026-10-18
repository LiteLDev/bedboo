// owner: U1 (BDS harness & e2e infra)
'use strict'
/**
 * World helpers (upstream testCommon.js: setBlock, placeBlock, resetBlocksToSuperflat) over the BDS
 * console; completion is observed through raw `update_block` / `update_subchunk_blocks` packets.
 * U11 upgrades `placeBlock` to the real `bot.placeBlock` in helpers/place.js.
 */

/** Flat world layers from groundY-1 (grass) to groundY+4 (air), like upstream's resetBlocksToSuperflat. */
const SUPERFLAT_TOP = 'grass_block'

function install (bot, ctx) {
  const { server, state, Vec3, TIMEOUT } = ctx
  const t = bot.test

  const samePos = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z

  /** Arm a waiter for a block update at `pos` (update_block on any layer or update_subchunk_blocks). */
  function blockUpdateAt (pos, timeout = TIMEOUT) {
    return ctx.packet(['update_block', 'update_subchunk_blocks'], (p, name) => {
      if (name === 'update_block') return samePos(p.position, pos)
      return [...(p.blocks ?? []), ...(p.extra ?? [])].some((b) => samePos(b.position, pos))
    }, timeout)
  }

  /**
   * Run a setblock-like console command and wait for its block update.
   * Resolves `false` when the block already was `blockName` (BDS: "The block couldn't be placed").
   */
  async function setblockCommand (command, pos) {
    const update = blockUpdateAt(pos)
    update.promise.catch(() => {})
    const out = await server.commandOutput(command)
    if (out.some((l) => /^Block placed/.test(l))) {
      await update.promise
      return true
    }
    update.cancel()
    if (out.some((l) => /^The block couldn't be placed/.test(l))) return false // already that block
    throw new Error(`${command}: ${out.join(' | ') || '(no output)'}`)
  }

  /**
   * Upstream signature: `setBlock({ x, y, z, relative, blockName })`; `relative` offsets from the
   * bot's floored position. Resolves once the client received the block update.
   */
  t.setBlock = async ({ x = 0, y = 0, z = 0, relative, blockName }) => {
    let pos = new Vec3(x, y, z)
    if (relative) {
      const p = ctx.position()
      if (!p) throw new Error('setBlock: bot position unknown')
      pos = p.floored().offset(x, y, z)
    }
    if (ctx.implemented(bot.blockAt)) {
      const block = bot.blockAt(pos)
      if (block && block.name === blockName) return
    }
    await setblockCommand(`${ctx.inDimension()}setblock ${pos.x} ${pos.y} ${pos.z} ${blockName}`, pos)
  }

  /**
   * Upstream: select hotbar `slot - 36` and place the held block on top of the block below
   * `position`. Here: the item in Java slot `slot` (bot.inventory when U8's inventory is real, else the
   * raw inventory tracker) is set at `position` with `execute as <bot> at @s run setblock` (same
   * dimension as the bot; the item is not consumed).
   */
  t.placeBlock = async (slot, position) => {
    if (ctx.implemented(bot.setQuickBarSlot)) bot.setQuickBarSlot(slot - 36)
    let name
    if (ctx.implemented(bot.setQuickBarSlot) && bot.inventory?.slots?.[slot]) {
      name = bot.inventory.slots[slot].name
    } else {
      name = javaSlotItem(state, slot)?.name
    }
    if (!name) throw new Error(`placeBlock: no item in slot ${slot}`)
    const pos = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
    await setblockCommand(`execute as ${ctx.who()} at @s run setblock ${pos.x} ${pos.y} ${pos.z} ${name}`, pos)
  }

  /** Restore the superflat layers (grass at groundY-1, air up to groundY+4) in an 11×11 area around the bot. */
  t.resetBlocksToSuperflat = async () => {
    const p = (ctx.position() ?? new Vec3(0, t.groundY, 0)).floored()
    const prefix = ctx.inDimension()
    for (let y = t.groundY + 4; y >= t.groundY - 1; y--) {
      const block = y === t.groundY - 1 ? SUPERFLAT_TOP : 'air'
      await server.command(`${prefix}fill ${p.x - 5} ${y} ${p.z - 5} ${p.x + 5} ${y} ${p.z + 5} ${block}`)
    }
    // the fills run in order on the server thread: the marker confirms they executed (their block
    // updates are already queued for the client)
    await server.awaitCommandsProcessed()
  }
}

/**
 * Item at a Java player-inventory slot from the raw tracker (36–44 hotbar, 9–35 main, 5–8 armor, 45 offhand).
 * @returns {{ name: string, count: number }|null}
 */
function javaSlotItem (state, slot) {
  if (slot >= 36 && slot <= 44) return state.inventory.inventory[slot - 36] ?? null
  if (slot >= 9 && slot <= 35) return state.inventory.inventory[slot] ?? null
  if (slot >= 5 && slot <= 8) return state.inventory.armor[slot - 5] ?? null
  if (slot === 45) return state.inventory.offhand[0] ?? null
  return null
}

module.exports = install
module.exports.javaSlotItem = javaSlotItem
