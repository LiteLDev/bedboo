// owner: U12 (crafting)
'use strict'

/**
 * Bedrock item tags used by `crafting_data` recipe ingredients (`descriptor_type: 'item_tag'`), as BDS 1.26.51.1
 * resolves them. The protocol never sends tag members (`item_registry` only carries the tags of data-driven items),
 * so lib/bedrock/recipes.js expands tag ingredients with this table.
 *
 * Source: pmmp/BedrockData `item_tags.json` @ bdb44a48fb6beffb6e9f6864f06d2232eb62b6a3 (BDS 1.26.30, CC0-1.0,
 * https://github.com/pmmp/BedrockData), restricted to the 11 tags that the 1.26.51 crafting recipes reference, then
 * verified member by member on BDS 1.26.51.1: every item whose name fits the tag was crafted at a crafting table in a
 * recipe using that tag (accepted = member; status 35 "mismatched recipe for grid items" = not a member). Found that
 * way: the poplar wood family (`planks`, `logs`, `wooden_slabs`) and `mushrooms_for_stew` (absent from the 1.26.30
 * data). (`logs_that_burn` is only used by a furnace recipe, which is not crafting: left out.)
 * test/external/craftingTags.test.js re-checks every member of every crafting tag against the server.
 * Names are given without the `minecraft:` namespace.
 */
module.exports = Object.freeze({
  'minecraft:coals': ['charcoal', 'coal'],
  'minecraft:egg': ['blue_egg', 'brown_egg', 'egg'],
  'minecraft:logs': ['acacia_log', 'acacia_wood', 'birch_log', 'birch_wood', 'cherry_log', 'cherry_wood', 'crimson_hyphae', 'crimson_stem', 'dark_oak_log', 'dark_oak_wood', 'jungle_log', 'jungle_wood', 'mangrove_log', 'mangrove_wood', 'oak_log', 'oak_wood', 'pale_oak_log', 'pale_oak_wood', 'poplar_log', 'poplar_wood', 'spruce_log', 'spruce_wood', 'stripped_acacia_log', 'stripped_acacia_wood', 'stripped_birch_log', 'stripped_birch_wood', 'stripped_cherry_log', 'stripped_cherry_wood', 'stripped_crimson_hyphae', 'stripped_crimson_stem', 'stripped_dark_oak_log', 'stripped_dark_oak_wood', 'stripped_jungle_log', 'stripped_jungle_wood', 'stripped_mangrove_log', 'stripped_mangrove_wood', 'stripped_oak_log', 'stripped_oak_wood', 'stripped_pale_oak_log', 'stripped_pale_oak_wood', 'stripped_poplar_log', 'stripped_poplar_wood', 'stripped_spruce_log', 'stripped_spruce_wood', 'stripped_warped_hyphae', 'stripped_warped_stem', 'warped_hyphae', 'warped_stem'],
  'minecraft:metal_nuggets': ['copper_nugget', 'gold_nugget', 'iron_nugget'],
  'minecraft:mushrooms_for_stew': ['brown_mushroom', 'red_mushroom', 'shelf_mushroom'],
  'minecraft:planks': ['acacia_planks', 'bamboo_planks', 'birch_planks', 'cherry_planks', 'crimson_planks', 'dark_oak_planks', 'jungle_planks', 'mangrove_planks', 'oak_planks', 'pale_oak_planks', 'poplar_planks', 'spruce_planks', 'warped_planks'],
  'minecraft:soul_fire_base_blocks': ['soul_sand', 'soul_soil'],
  'minecraft:stone_crafting_materials': ['blackstone', 'cobbled_deepslate', 'cobblestone'],
  'minecraft:stone_tool_materials': ['blackstone', 'cobbled_deepslate', 'cobblestone'],
  'minecraft:wooden_slabs': ['acacia_slab', 'bamboo_slab', 'birch_slab', 'cherry_slab', 'crimson_slab', 'dark_oak_slab', 'jungle_slab', 'mangrove_slab', 'oak_slab', 'pale_oak_slab', 'poplar_slab', 'spruce_slab', 'warped_slab'],
  'minecraft:wool': ['black_wool', 'blue_wool', 'brown_wool', 'cyan_wool', 'gray_wool', 'green_wool', 'light_blue_wool', 'light_gray_wool', 'lime_wool', 'magenta_wool', 'orange_wool', 'pink_wool', 'purple_wool', 'red_wool', 'white_wool', 'yellow_wool']
})
