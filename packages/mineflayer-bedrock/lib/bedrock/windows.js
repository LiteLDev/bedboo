// owner: U8 (inventory, windows, creative & item use)
'use strict'

/**
 * Window registry, exposed as `bot._bedrock.windows`.
 *
 * Maps a Bedrock container type (container_open `window_type`, e.g. 'container', 'furnace',
 * 'blast_furnace', 'smoker', 'anvil', 'enchantment', 'trading', 'brewing_stand', 'hopper',
 * 'dispenser', 'dropper', 'shulker_box', 'beacon', 'horse', 'workbench', 'inventory', …) to the
 * prismarine-windows (Java) window type and a slot map.
 *
 * U8 registers ALL container types; station units (U12 craft, U13 furnace/enchanting/anvil/villager)
 * only read entries. A slot map entry is `javaSlot → { container_id, slot }` for the container part;
 * player-inventory slots of a window are appended by `slots.resolve`.
 *
 * @typedef {{ javaType: string, slotMap: Array<{ container_id: string, slot: number }>, title?: string }} WindowSpec
 * @typedef {object} WindowRegistry
 * @property {(containerType: string, spec: WindowSpec) => void} register
 * @property {(containerType: string) => WindowSpec | undefined} get
 * @property {(containerType: string) => boolean} has
 * @property {() => string[]} types
 */

/** @returns {WindowRegistry} */
function createWindowRegistry () {
  const specs = new Map()
  return {
    register (containerType, spec) {
      if (!spec || typeof spec.javaType !== 'string') throw new TypeError(`window spec for ${containerType} needs a javaType`)
      specs.set(containerType, { slotMap: [], ...spec })
    },
    get (containerType) { return specs.get(containerType) },
    has (containerType) { return specs.has(containerType) },
    types () { return [...specs.keys()] }
  }
}

module.exports = { createWindowRegistry }
