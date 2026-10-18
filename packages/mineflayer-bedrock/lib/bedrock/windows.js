// owner: U8 (inventory, windows, creative & item use)
'use strict'

/**
 * Window registry, exposed as `bot._bedrock.windows`: Bedrock container type → Java (prismarine-windows)
 * window type + slot map. U8 registers EVERY container type at creation; station units (U12 craft, U13
 * furnace/enchanting/anvil/villager, U14) only read entries (or `register()` a refined spec for their type).
 *
 * Registry key ("container type"): the Bedrock `container_open.window_type` name, except for
 * `window_type: 'container'`, which BDS uses for every chest-like block and entity; those are told apart by
 * the block at `coordinates` / the entity (see {@link windowKey}): `chest`, `trapped_chest`, `ender_chest`,
 * `copper_chest`, `barrel`, `shulker_box`, `minecart_chest`, `chest_boat`, generic `container`.
 *
 * A spec describes the CONTAINER part of the Java window (Java slots 0 … inventoryStart-1); the player part
 * (27 main + 9 hotbar, Java order) is appended like on Java and addressed by lib/bedrock/slots.js.
 *
 *   javaType            prismarine-windows / Java window type (`minecraft:generic_9x3`, `minecraft:furnace`, …);
 *                       a function of the container size for variable-size containers (chests: 27 / 54)
 *   title               default window title (Bedrock sends none)
 *   size                number of Java container slots; `null` = the length of the window's first inventory_content
 *   slotMap             Java container slot i → SlotRef (array, or a function of the size)
 *   craftingResultSlot  Java slot of a result slot (prismarine-windows `craft`), -1 if none
 *   content             true when the window's own `inventory_content` (window_id = the open window) carries
 *                       its slots (windowOpen waits for it, like upstream waits for window_items); false for
 *                       windows whose slots live only in the `ui` container (crafting table, lectern)
 *   quickMoveTargets    optional `(item) → javaSlot[]`: where a shift click from the player part puts `item`
 *                       (Java's per-menu quickMoveStack rules; [] = none, then main ↔ hotbar like Java). Without it
 *                       the item goes into the first container slots that take it. The furnace / brewing rules use
 *                       item-name lists (no smelting/brewing recipe data here); U13 may register refined specs.
 *   slotLimits          optional `{ javaSlot: maxStack }` (Java slots that hold one item: brewing bottles,
 *                       enchanting item, beacon payment)
 *
 * SlotRef `{ container_id, slot, content, ui }`:
 *   container_id/slot   the item_stack_request StackRequestSlotInfo address of that Java slot (container ids are
 *                       bedrock-protocol ContainerSlotType names — verified on BDS 1.26.51.1 for chest/trapped
 *                       chest/ender chest (`container`), barrel (`barrel`, `container` is rejected), shulker box
 *                       (`shulker`), dispenser/dropper/hopper/crafter (`container`; `crafter` is rejected),
 *                       furnace/blast furnace/smoker, brewing stand ingredient + fuel, cursor, hotbar/inventory,
 *                       armor, offhand (slot 1!), creative_output 50, and the ui station slots of the crafting
 *                       table, anvil, enchanting table, grindstone, stonecutter, loom, cartography and smithing
 *                       tables and beacon (vanilla UIInventorySlotOffset table); trading, horse: not yet)
 *   content             index of the slot in the open window's inventory_content / inventory_slot (null: never sent)
 *   ui                  true when the slot is a `ui` container slot (window 124): its ui index is `slot`
 *
 * Contract: `createWindowRegistry()` → `{ register(containerType, spec), get(type), has(type), types() }`;
 * `windowKey(containerOpen, { blockName, entityName })`, `CONTAINER_SPECS`, `PLAYER_INVENTORY`,
 * `containerSize(spec, contentLength)`, `slotMapOf(spec, size)`, `javaTypeOf(spec, size)`.
 *
 * @typedef {{ container_id: string, slot: number, content?: number|null, ui?: boolean }} SlotRef
 * @typedef {{ javaType: string|((size: number) => string), title?: string, size?: number|null,
 *   slotMap: Array<SlotRef|null>|((size: number) => Array<SlotRef|null>), craftingResultSlot?: number,
 *   content?: boolean }} WindowSpec
 * @typedef {object} WindowRegistry
 * @property {(containerType: string, spec: WindowSpec) => void} register
 * @property {(containerType: string) => WindowSpec | undefined} get
 * @property {(containerType: string) => boolean} has
 * @property {() => string[]} types
 */

const range = (n) => Array.from({ length: n }, (_, i) => i)
/** a block/entity container slot: stack-request slot = content index */
const own = (containerId) => (size) => range(size).map(i => ({ container_id: containerId, slot: i, content: i }))
const ui = (containerId, slot, content = null) => ({ container_id: containerId, slot, content, ui: true })
const CREATED_OUTPUT = (content = null) => ({ container_id: 'creative_output', slot: 50, content })
const chestType = (size) => size <= 9 ? 'minecraft:generic_9x1' : `minecraft:generic_9x${Math.min(6, Math.ceil(size / 9))}`

/** The player inventory window (bot.inventory): Java slots 0-8 (crafting result, 2×2 grid, armor head..feet). */
const PLAYER_INVENTORY = Object.freeze({
  javaType: 'minecraft:inventory',
  title: 'Inventory',
  size: 9,
  craftingResultSlot: 0,
  content: false,
  slotMap: Object.freeze([
    CREATED_OUTPUT(),
    ui('crafting_input', 28), ui('crafting_input', 29), ui('crafting_input', 30), ui('crafting_input', 31),
    { container_id: 'armor', slot: 0, content: null }, { container_id: 'armor', slot: 1, content: null },
    { container_id: 'armor', slot: 2, content: null }, { container_id: 'armor', slot: 3, content: null }
  ])
})

// Java quickMoveStack item rules (Bedrock item names)
const FURNACE_FUEL = /^(coal|charcoal|coal_block|lava_bucket|blaze_rod|dried_kelp_block|stick|bamboo|bamboo_block|scaffolding|bowl|.+_planks|wooden_.+|.+_wooden_slab|.+_wool|.+_carpet|.+_sapling|bow|crossbow|fishing_rod|ladder|crafting_table|bookshelf|chest|trapped_chest|barrel|.+_boat|.+_raft)$/
const BREWING_BOTTLES = /^(potion|splash_potion|lingering_potion|glass_bottle)$/
const BREWING_INGREDIENTS = /^(nether_wart|redstone|glowstone_dust|gunpowder|dragon_breath|fermented_spider_eye|spider_eye|sugar|magma_cream|ghast_tear|glistering_melon_slice|golden_carrot|rabbit_foot|pufferfish|turtle_helmet|phantom_membrane|breeze_rod|slime_block|stone|cobweb|blaze_powder)$/
const BEACON_PAYMENT = /^(iron_ingot|gold_ingot|emerald|diamond|netherite_ingot)$/
const nameOf = (item) => String(item?.name ?? '')
const furnaceTargets = (item) => FURNACE_FUEL.test(nameOf(item)) ? [1] : [0]

const chestSpec = (title, containerId = 'container') => ({ javaType: chestType, title, size: null, slotMap: own(containerId), craftingResultSlot: -1, content: true })
const fixedSpec = (javaType, title, size, containerId = 'container') => ({ javaType, title, size, slotMap: own(containerId), craftingResultSlot: -1, content: true })
const furnaceSpec = (javaType, title, ingredient) => ({
  javaType,
  title,
  size: 3,
  craftingResultSlot: 2,
  content: true,
  quickMoveTargets: furnaceTargets,
  slotMap: [
    { container_id: ingredient, slot: 0, content: 0 },
    { container_id: 'furnace_fuel', slot: 1, content: 1 },
    { container_id: 'furnace_output', slot: 2, content: 2 }
  ]
})

/** Every Bedrock container type (see the module comment for the keys of `window_type: 'container'`). */
const CONTAINER_SPECS = {
  inventory: PLAYER_INVENTORY,
  // window_type 'container' (told apart by the block / entity)
  container: chestSpec('Container'),
  chest: chestSpec('Chest'),
  trapped_chest: chestSpec('Chest'),
  copper_chest: chestSpec('Copper Chest'),
  ender_chest: { ...chestSpec('Ender Chest'), javaType: 'minecraft:generic_9x3', size: 27 },
  barrel: { ...chestSpec('Barrel', 'barrel'), javaType: 'minecraft:generic_9x3', size: 27 },
  shulker_box: fixedSpec('minecraft:shulker_box', 'Shulker Box', 27, 'shulker'),
  minecart_chest: { ...chestSpec('Minecart with Chest'), javaType: 'minecraft:generic_9x3', size: 27 },
  chest_boat: { ...chestSpec('Boat with Chest'), javaType: 'minecraft:generic_9x3', size: 27 },
  // own window types
  dispenser: fixedSpec('minecraft:generic_3x3', 'Dispenser', 9),
  dropper: fixedSpec('minecraft:generic_3x3', 'Dropper', 9),
  hopper: fixedSpec('minecraft:hopper', 'Hopper', 5),
  minecart_hopper: fixedSpec('minecraft:hopper', 'Minecart with Hopper', 5),
  crafter: {
    // stack requests address the grid as `container` (the `crafter` slot type is rejected by BDS 1.26.51.1)
    javaType: 'minecraft:crafter_3x3',
    title: 'Crafter',
    size: 10, // 9 grid slots + the result preview (Java slot 9, not addressable on Bedrock)
    craftingResultSlot: -1, // like prismarine-windows: the preview is not a crafting result slot
    content: true,
    slotMap: [...own('container')(9), null]
  },
  furnace: furnaceSpec('minecraft:furnace', 'Furnace', 'furnace_ingredient'),
  blast_furnace: furnaceSpec('minecraft:blast_furnace', 'Blast Furnace', 'blast_furnace_ingredient'),
  smoker: furnaceSpec('minecraft:smoker', 'Smoker', 'smoker_ingredient'),
  brewing_stand: {
    // Java: 0-2 bottles, 3 ingredient, 4 fuel. Bedrock window: 0 ingredient, 1-3 bottles, 4 fuel.
    javaType: 'minecraft:brewing_stand',
    title: 'Brewing Stand',
    size: 5,
    craftingResultSlot: -1,
    content: true,
    quickMoveTargets: (item) => {
      const name = nameOf(item)
      if (name === 'blaze_powder') return [4, 3]
      if (BREWING_BOTTLES.test(name)) return [0, 1, 2]
      return BREWING_INGREDIENTS.test(name) ? [3] : []
    },
    slotLimits: { 0: 1, 1: 1, 2: 1 },
    slotMap: [
      { container_id: 'brewing_result', slot: 1, content: 1 },
      { container_id: 'brewing_result', slot: 2, content: 2 },
      { container_id: 'brewing_result', slot: 3, content: 3 },
      { container_id: 'brewing_input', slot: 0, content: 0 },
      { container_id: 'brewing_fuel', slot: 4, content: 4 }
    ]
  },
  workbench: {
    // Java: 0 result, 1-9 grid. Bedrock: grid = ui 32-40 (crafting_input), result = created output 50.
    javaType: 'minecraft:crafting',
    title: 'Crafting',
    size: 10,
    craftingResultSlot: 0,
    content: false,
    slotMap: [CREATED_OUTPUT(), ...range(9).map(i => ui('crafting_input', 32 + i))]
  },
  enchantment: {
    javaType: 'minecraft:enchantment',
    title: 'Enchant',
    size: 2,
    craftingResultSlot: -1,
    content: true,
    quickMoveTargets: (item) => nameOf(item) === 'lapis_lazuli' ? [1] : [0],
    slotLimits: { 0: 1 },
    slotMap: [ui('enchanting_input', 14, 0), ui('enchanting_lapis', 15, 1)]
  },
  anvil: {
    javaType: 'minecraft:anvil',
    title: 'Repair & Name',
    size: 3,
    craftingResultSlot: 2,
    content: true,
    slotMap: [ui('anvil_input', 1, 0), ui('anvil_material', 2, 1), CREATED_OUTPUT(2)]
  },
  grindstone: {
    javaType: 'minecraft:grindstone',
    title: 'Repair & Disenchant',
    size: 3,
    craftingResultSlot: 2,
    content: true,
    slotMap: [ui('grindstone_input', 16, 0), ui('grindstone_additional', 17, 1), CREATED_OUTPUT(2)]
  },
  stonecutter: {
    javaType: 'minecraft:stonecutter',
    title: 'Stonecutter',
    size: 2,
    craftingResultSlot: 1,
    content: true,
    slotMap: [ui('stonecutter_input', 3, 0), CREATED_OUTPUT(1)]
  },
  loom: {
    javaType: 'minecraft:loom',
    title: 'Loom',
    size: 4,
    craftingResultSlot: 3,
    content: true,
    quickMoveTargets: (item) => {
      const name = nameOf(item)
      if (name === 'banner') return [0]
      if (/_dye$/.test(name)) return [1]
      return /_banner_pattern$/.test(name) ? [2] : []
    },
    slotMap: [ui('loom_input', 9, 0), ui('loom_dye', 10, 1), ui('loom_material', 11, 2), CREATED_OUTPUT(3)]
  },
  cartography: {
    javaType: 'minecraft:cartography',
    title: 'Cartography Table',
    size: 3,
    craftingResultSlot: 2,
    content: true,
    quickMoveTargets: (item) => {
      const name = nameOf(item)
      if (name === 'filled_map') return [0]
      return /^(paper|empty_map|map|glass_pane)$/.test(name) ? [1] : []
    },
    slotMap: [ui('cartography_input', 12, 0), ui('cartography_additional', 13, 1), CREATED_OUTPUT(2)]
  },
  smithing_table: {
    // Java 1.20+: 0 template, 1 base, 2 addition, 3 result. Bedrock window content: 0 input, 1 material, 2 template.
    javaType: 'minecraft:smithing',
    title: 'Upgrade Gear',
    size: 4,
    craftingResultSlot: 3,
    content: true,
    quickMoveTargets: (item) => {
      const name = nameOf(item)
      if (/_smithing_template$/.test(name)) return [0]
      return /^(netherite_ingot|iron_ingot|gold_ingot|copper_ingot|emerald|redstone|lapis_lazuli|amethyst_shard|quartz|diamond|resin_brick)$/.test(name) ? [2] : [1]
    },
    slotMap: [ui('smithing_table_template', 53, 2), ui('smithing_table_input', 51, 0), ui('smithing_table_material', 52, 1), CREATED_OUTPUT()]
  },
  beacon: {
    javaType: 'minecraft:beacon',
    title: 'Beacon',
    size: 1,
    craftingResultSlot: -1,
    content: true,
    quickMoveTargets: (item) => BEACON_PAYMENT.test(nameOf(item)) ? [0] : [],
    slotLimits: { 0: 1 },
    slotMap: [ui('beacon_payment', 27, 0)]
  },
  trading: {
    javaType: 'minecraft:merchant',
    title: 'Villager',
    size: 3,
    craftingResultSlot: 2,
    content: false,
    slotMap: [ui('trade2_ingredient1', 4), ui('trade2_ingredient2', 5), CREATED_OUTPUT()]
  },
  horse: {
    // mineflayer: open_horse_window → createWindow(id, 'HorseWindow', 'Horse', slots). 0 saddle, 1 armor, 2.. chest
    javaType: 'HorseWindow',
    title: 'Horse',
    size: null,
    craftingResultSlot: -1,
    content: true,
    slotMap: (size) => range(size).map(i => i < 2 ? { container_id: 'horse_equip', slot: i, content: i } : { container_id: 'container', slot: i, content: i })
  },
  lectern: {
    javaType: 'minecraft:lectern',
    title: 'Lectern',
    size: 1,
    craftingResultSlot: -1,
    content: false,
    slotMap: [null] // the book is edited with lectern_update, not item stack requests
  }
}

/** `container_open.window_type` values that are the chest-like generic container (told apart by block / entity). */
const CHEST_BLOCKS = {
  chest: 'chest',
  trapped_chest: 'trapped_chest',
  ender_chest: 'ender_chest',
  barrel: 'barrel'
}

/**
 * Registry key for a `container_open` packet.
 * @param {{ window_type: string|number }} packet container_open params
 * @param {{ blockName?: string|null, entityName?: string|null }} [at] the block at `coordinates`
 *   (`runtime_entity_id === -1`) or the entity's name (Bedrock names, no namespace)
 * @returns {string}
 */
function windowKey (packet, { blockName = null, entityName = null } = {}) {
  const type = String(packet.window_type)
  if (type !== 'container') return type
  if (entityName) {
    const name = entityName.replace(/^minecraft:/, '')
    if (name === 'chest_minecart' || name === 'minecart_chest') return 'minecart_chest'
    if (name === 'chest_boat' || /_chest_boat$/.test(name)) return 'chest_boat'
    if (name === 'hopper_minecart') return 'minecart_hopper'
    return 'container'
  }
  if (!blockName) return 'container'
  const name = blockName.replace(/^minecraft:/, '')
  if (CHEST_BLOCKS[name]) return CHEST_BLOCKS[name]
  if (/shulker_box$/.test(name)) return 'shulker_box'
  if (/copper_chest$/.test(name)) return 'copper_chest'
  return 'container'
}

/** Number of Java container slots of a spec, given the length of the window's first inventory_content. */
function containerSize (spec, contentLength = null) {
  if (typeof spec.size === 'number') return spec.size
  if (typeof contentLength === 'number' && contentLength > 0) return contentLength
  return 27
}

/** @returns {Array<SlotRef|null>} */
function slotMapOf (spec, size) {
  return typeof spec.slotMap === 'function' ? spec.slotMap(size) : spec.slotMap
}

/** @returns {string} */
function javaTypeOf (spec, size) {
  return typeof spec.javaType === 'function' ? spec.javaType(size) : spec.javaType
}

/** @returns {WindowRegistry} pre-filled with {@link CONTAINER_SPECS} */
function createWindowRegistry () {
  const specs = new Map()
  const registry = {
    register (containerType, spec) {
      if (!spec || (typeof spec.javaType !== 'string' && typeof spec.javaType !== 'function')) {
        throw new TypeError(`window spec for ${containerType} needs a javaType`)
      }
      specs.set(containerType, { title: containerType, size: null, craftingResultSlot: -1, content: true, slotMap: [], ...spec })
    },
    get (containerType) { return specs.get(containerType) },
    has (containerType) { return specs.has(containerType) },
    types () { return [...specs.keys()] }
  }
  for (const [type, spec] of Object.entries(CONTAINER_SPECS)) registry.register(type, spec)
  return registry
}

module.exports = {
  createWindowRegistry,
  windowKey,
  containerSize,
  slotMapOf,
  javaTypeOf,
  CONTAINER_SPECS,
  PLAYER_INVENTORY
}
