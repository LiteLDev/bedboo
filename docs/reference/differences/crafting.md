# Crafting and stations

How recipes, `bot.craft` and the station APIs (`bot.openFurnace`, `bot.openEnchantmentTable`, `bot.openAnvil`,
`bot.openVillager`, `bot.trade`) work on Bedrock. The station APIs keep mineflayer's signatures, window members, events
and error messages; underneath, every crafting and station operation is a server-authoritative item stack request
(`lib/bedrock/stations.js`, see [clickWindow](inventory.md#click-window)). Observed on BDS 1.26.51.1 (protocol 2193,
bedrock-protocol 3.60.1).

## Recipes come from the server's crafting_data  {#recipes}

- **Affects:** `bot.recipesFor`, `bot.recipesAll`, `bot.registry.recipes`, `require('prismarine-recipe')(bot.registry)`
- **Java:** mineflayer reads minecraft-data's Java recipes (`registry.recipes[resultId]` =
  `{ result, inShape | ingredients, outShape? }`, tags already expanded to one recipe per item) through
  prismarine-recipe's `Recipe.find`.
- **Bedrock:** minecraft-data's Bedrock `recipes` have another shape (keyed by index, Bedrock names) and are not what
  the server uses. BDS sends its recipes at join in `crafting_data` (1.26.51: typed arrays `shaped_recipes`,
  `shapeless_recipes`, `shulker_box_recipes`, …): each with a `recipe_id`, a `network_id` (what crafting requests
  name), a `block` tag, a `priority`, ingredient descriptors (`name` + metadata, 32767 = any; `item_tag`) and one or
  more outputs (network-id items).
  - Every crafting-grid recipe — 2×2 included — has `block: 'crafting_table'`; whether it fits the 2×2 grid follows
    from its size.
  - `deprecated` recipes are hidden legacy duplicates (BDS still accepts them).
  - Furnace, smoker, blast furnace, campfire, stonecutter, cartography, smithing and potion recipes are not
    crafting-grid recipes; `multi_recipes` (map cloning, fireworks, banner / book copies, …) have no fixed inputs or
    outputs.
  - Tag ingredients name the tag only; see [item tags](data.md#item-tags).
- **bedboo:** `lib/bedrock/recipes.js` turns the `crafting_table` shaped / shapeless / shulker-box recipes into
  prismarine-recipe `Recipe`s with the same fields (`result {id, count, metadata}`, `inShape`, `outShape`,
  `ingredients`, `delta`, `requiresTable`) plus the Bedrock `networkId`.
  - Tag ingredients are expanded like minecraft-data's Java recipes: every cell of one tag gets the same member (13
    stick recipes, one per plank type); two tags in one recipe give the cartesian product (13 planks × 13 wooden slabs
    = 169 barrels); structurally identical expansions are kept once (lower Bedrock `priority` first: the generic
    `minecraft:stick` beats `stick_from_crimson_planks`; BDS accepts either id, and the other ids are kept for limited
    crafting). Like Java's expanded recipes, one recipe never mixes members of a tag (2 oak + 2 birch planks give no
    crafting table recipe, although BDS would accept that grid) — upstream's behaviour, kept. BDS 1.26.51's
    `crafting_data` yields 4874 recipes from 4128 Bedrock recipes, none skipped.
  - `bot.registry.recipes` is replaced per bot by the same recipes in minecraft-data's Java shape (filled in place on
    every `crafting_data`), so `require('prismarine-recipe')(bot.registry).Recipe.find(id)` works as on Java. Those
    Recipes lack `networkId` (prismarine-recipe drops unknown fields), so `bot.craft` matches them to the server recipe
    by result and ingredients (also for Recipes built by hand). A Recipe kept from an older `crafting_data` is matched
    again the same way.
  - `recipesFor` / `recipesAll` are upstream's code over these recipes, with one fix: the `metadata` argument filters
    on the result metadata (upstream's `Recipe.find` looks for a `meta` key and never filters). It matters on Bedrock,
    where e.g. the bed colour is the `bed` item's metadata (white 0, red 14).
  - With the gamerule `doLimitedCrafting` on, only the recipes the server unlocked (`unlocked_recipes`) are returned
    (a grid is available when any of its Bedrock recipes is unlocked, and crafted with that one).
  - Netherite gear is a smithing-table upgrade, not crafting (and has no mineflayer API).

## Crafting is one item stack request per batch  {#craft-request}

- **Affects:** `bot.craft`
- **Java:** mineflayer clicks the ingredients into the grid (`window_click` per click), takes the result from slot 0
  and puts it away, once per craft.
- **Bedrock:** there is no click packet; the server crafts from an `item_stack_request`, and only from the crafting
  grid: consuming straight from the hotbar is refused (`craft_recipe`: status 35 "mismatched recipe for grid items";
  `craft_recipe_auto`: status 27). The 2×2 grid is `crafting_input` ui 28-31 and needs the player's inventory screen
  (status 7 without it); the crafting table's grid is ui 32-40 (row-major; shapes may sit anywhere and mixed tag
  members are accepted). Verified request shape (one request, any number of crafts):
  1. `place` × n (inventory → grid cell),
  2. `craft_recipe { recipe_network_id, times_crafted }` (legacy id 12),
  3. `results_deprecated { result_items: [{ type: 'name', legacy_type: 1, name, metadata, count (per craft),
     block_runtime_id, extra }], times_crafted }` (19),
  4. `consume` (5) × each grid cell (count = times),
  5. per result, `place` (1) from `creative_output` 50 (stack id = the request id) into the inventory — or `take` to
     the cursor.

  The created output holds at most one stack per request (16 logs → 64 planks in one request; 20 logs → status 14),
  every result must be taken (status 17 otherwise), and a result may also be dropped from the created output
  (`drop`). Bulk crafting = `times_crafted` > 1.
- **bedboo:** `bot.craft(recipe, count, craftingTable)` keeps upstream's checks, errors and window handling
  (`Recipe requires craftingTable, but one was not supplied: …`, `crafting: non craftingTable used as craftingTable`,
  errors re-thrown as `new Error(err)` so a missing ingredient reads `Error: missing ingredient`, the table window is
  opened once and closed at the end or on error).
  - Each request crafts as many of the `count` crafts as the inventory, one stack per grid cell and one stack of each
    result allow (`count` = 25 sticks → 2 requests of 16 and 9); when the ingredients run out after some crafts it
    throws `missing ingredient` like upstream's next `craftOnce`.
  - Ingredients are taken in upstream's `findInventoryItem` order (main inventory, then hotbar; one kind of stack per
    cell); results go where upstream's `putSelectedItemRange` puts them (stacks with room, then the first empty slot,
    main inventory first).
  - The request goes through the inventory model (prediction, rollback on rejection); items found in the grid are
    returned first.
  - A container window open when crafting in the 2×2 grid, or another window open when crafting at a table, is closed
    first: the 2×2 grid only exists in the player's inventory screen (upstream would click into the open container
    instead) and BDS ignores a container activation while another window is open
    ([window switching](inventory.md#window-switch)). A table window already open on the same block is reused and, like
    the one upstream's `activateBlock` would have opened in its place, closed at the end.

## Several results: buckets and bottles go to the inventory  {#remainders}

- **Affects:** `bot.craft` / `recipe.delta` / `recipe.outShape` of the cake, honey block and honey bottle → sugar
- **Java:** the empty buckets / bottles stay in the crafting grid (minecraft-data's old `outShape`), and mineflayer puts
  them away after the craft.
- **Bedrock:** the recipe lists them as extra outputs (cake: `output: [cake, bucket × 3]`); the client selects each one
  with `create { result_slot_id: k }` (legacy id 6) and takes it from the created output like the main result (the
  vanilla client's request, confirmed on BDS: without `create` the take fails with status 49).
- **bedboo:** the extra outputs are added to `recipe.delta` (positive counts); `outShape` stays null since nothing
  remains in the grid. `bot.craft` emits `create` before taking each result when there are several.

## A result that does not fit is carried, then tossed  {#overflow}

- **Affects:** `bot.craft` with a full inventory
- **Java:** upstream's `putSelectedItemRange` tosses what it cannot put away (`tossLeftover`).
- **Bedrock:** the result must be taken in the craft request itself.
- **bedboo:** what does not fit is taken to the cursor in the same request, then `returnCursor` puts it back (Java's
  rule, as in [closing a window](inventory.md#close-window)) and drops the rest — the same outcome as upstream (an
  `itemDrop`). Only one stack can be carried, so a batch whose results overflow by more than that crafts fewer times
  (the rest in the next request); a single craft that cannot place its results even so fails with `destination full`
  (upstream's message for a full range).

## No furnace recipes from the server  {#furnace-recipes}

- **Affects:** any code that wants to know what smelts into what
- **Java:** minecraft-data / the client's recipe book include the furnace recipes.
- **Bedrock:** BDS 1.26.51's `crafting_data` carries no furnace recipes (see [recipes](#recipes)); minecraft-data's
  Bedrock recipes are not what the server uses.
- **bedboo:** the library has no smelting data. The agent package (`packages/agent`) vendors a vetted furnace table
  from CloudburstMC/Data (Apache-2.0) `recipes.json` @73bda57f9afa (1.21.40, the last dump with furnace recipes):
  `packages/agent/src/data/smelting.json`, regenerated by `packages/agent/scripts/gen-smelting.js` and checked against
  the 1.26.51 registry.

## Furnace properties come from container_set_data  {#furnace}

- **Affects:** `Furnace` `.fuel`, `.progress`, `.totalFuel`, `.fuelSeconds`, `.totalProgress`, `.progressSeconds`, the
  `Furnace` `update` event, `bot.openFurnace` (furnace, blast furnace, smoker)
- **Java:** `craft_progress_bar` (window property) carries property 0 (fuel left), 1 (burn time of the fuel),
  2 (cook progress) and 3 (total cook time).
- **Bedrock:** `container_set_data { window_id, property, value }`. Property 0 is the tick count (progress), 1 the lit
  time (fuel left) and 2 the lit duration (burn time). 3 (stored XP) and 4 (fuel aux) have no Java counterpart.
  There is **no total cook time**: it is the block's constant, 200 ticks for a furnace and 100 for a blast furnace or
  smoker (a blast furnace or smoker also burns one coal for 800 ticks, not 1600). BDS sends the block's state
  **before** its `container_open`, then every tick while the block burns. The smelted output arrives as
  `inventory_slot` of the window. Bedrock has neither `/data` nor `/blockdata`, so a cook cannot be shortened by
  command.
- **bedboo:** Bedrock properties are mapped onto the Java ones (0→2, 1→0, 2→1) and normalised exactly as upstream does
  it. `totalProgress` is set from the block type when the window opens. Values that arrived before the window opened
  are applied when it opens. `update` fires for every `container_set_data` of the window, like upstream fires it for
  every window property.

## A click into a just-placed furnace is now and then rejected  {#furnace-click}

- **Affects:** `Furnace.putInput` / `putFuel` / `takeOutput` right after the furnace was placed and opened
- **Java:** no such rejection.
- **Bedrock:** in about 1 of 10 smelts the first transfer into a furnace placed a moment before failed with
  `Server rejected transaction for clicking on slot 1, on window with id N.` (BDS answered the item stack request with
  an error); the same transfer a few hundred ms later succeeded. Not reproduced in isolation (furnaces that have stood
  for a while are not affected).
- **bedboo:** not fixed in the library. Retry a rejected furnace transfer (the agent retries twice after 600 ms,
  recomputing what is still missing, in `packages/agent/src/skills/smelt.js`).

## Enchanting: options, seed and the enchant request  {#enchanting}

- **Affects:** `EnchantmentTable` `.enchantments`, `.xpseed`, `.enchant(choice)`, the `EnchantmentTable` `ready` event
- **Java:** window properties 0–9 give the three level requirements, the enchantment seed and one *hinted*
  enchantment (id + level) per option. `enchant_item { windowId, enchantment }` enchants, and the server sends the new
  item.
- **Bedrock:** `player_enchant_options { options: [{ cost, slot_flags, equip_enchants, held_enchants, self_enchants,
  name, option_id }] }` is sent before the table's `container_open` (empty) and again after every change of the item
  slot. `cost` is the level requirement. The three lists are **all** the enchantments the option applies, not a single
  hint. The seed is never sent to the client. Enchanting is a single item stack request:
  `craft_recipe { recipe_network_id: zigzag32(option_id) }`, then `results_deprecated`, then `consume` of choice + 1
  lapis (nothing in creative), then `consume` of the item, then `place` of the produced item from `creative_output` 50
  back into the item slot. BDS applies its own result (a wrong `results_deprecated` is ignored) and charges choice + 1
  levels. **The response carries no item.**
- **bedboo:** `enchantments[i] = { level: cost, expected: { enchant, level } }`, where `expected` is the first of the
  option's enchantments (Bedrock ids, as in `bot.registry.enchantments`). `ready` fires on the same transitions as
  upstream, and `xpseed` stays −1. `enchant(choice)` predicts the enchanted item from the option: equip, held and self
  enchantments in that order, the same `ench` NBT as BDS (a book becomes an `enchanted_book`). This prediction was
  verified byte-equal against the server's copy for swords, pickaxes, chestplates and books with options 0–2. It
  resolves with the item in slot 0 once the server accepts the request. Missing lapis or levels reject with an
  explanatory error instead of waiting forever.

## Enchanting options without enchantments  {#enchanting-empty-options}

- **Affects:** `EnchantmentTable.enchant`, `enchantments[i].expected`
- **Java:** every offered option applies at least one enchantment.
- **Bedrock:** BDS can offer options whose enchantment lists are all empty (a fishing rod or a carrot on a stick at a
  table without bookshelves); it charges levels and lapis for them and leaves the item unchanged.
- **bedboo:** such an option has `expected: { enchant: -1, level: -1 }`; `enchant()` predicts the item unchanged (no
  empty `ench` list), so the bot's copy equals the server's.

## Anvil: the name travels in the request, the client predicts the result  {#anvil}

- **Affects:** `Anvil` `.combine(itemOne, itemTwo[, name])`, `Anvil` `.rename(item[, name])`, `bot.openAnvil`
- **Java:** the name is typed with `name_item` (or `MC|ItemName`), the server shows the result in slot 2, and
  `putAway(2)` takes it. The costs that upstream checks come from prismarine-item's `Item.anvil`.
- **Bedrock:** there is no name packet. The operation is a single item stack request:
  `optional { recipe_network_id: 0, filtered_string_index: 0 (rename) | -1 }`, then `consume` of the target and the
  sacrifice, then `place` of the produced item from `creative_output` 50. The new name goes in the request's
  `custom_names` (cause `anvil_text`). BDS shows nothing in slot 2 and never sends the result back.
  - Bedrock's rules differ from Java's: an enchantment costs multiplier × the **levels it adds** (Sharpness IV + IV → V
    costs 1, not 5), an incompatible enchantment is dropped at no cost, Impaling has multiplier 2/1, a rename alone
    keeps the prior work penalty (a fresh renamed item has `RepairCost` 0), and a rename can also be "Too Expensive"
    (Java caps it at 39).
  - Names are at most 30 characters, and a custom name is a plain string, not a JSON text component.
  - prismarine-item has no Bedrock anvil (`Item.anvil` is undefined).
- **bedboo:** `lib/bedrock/anvil.js` (adapted from prismarine-item's `anvil.js`) applies the Bedrock rules for the
  guards ("Not anvil-able…", "not enough xp", input order) and for the predicted result. That result has BDS's NBT
  layout: `RepairCost`, `display.Name`, `ench`, `Damage`. Both are verified against the server's copy for combine,
  combine + rename, rename, material repair, stack rename and enchantment upgrade.
  - The result goes into the inventory the way upstream's `putAway(2)` puts it: first a matching stack with room, else
    the first empty slot.
  - The experience check uses the cost of the direction actually used (upstream's `smallest` is 0 whenever one
    direction is impossible, so it never refuses; BDS would reject the request and leave the items in the anvil).
  - A sacrifice that changes nothing gives no result even with a name, as in vanilla, and the slots are cleared of
    leftovers (e.g. unused repair materials) before an operation.
  - `rename` in creative mode does not wait for an experience change (upstream waits for one in creative too, though
    none comes).
  - A name longer than 30 characters is refused with upstream's "Name is too long." (upstream: 35).

## Villager trading: update_trade opens the window, the offers are NBT  {#trading}

- **Affects:** `bot.openVillager`, `bot.trade`, `Villager` `.trades`, `.selectedTrade`,
  `villager.trade(tradeIndex, [times])`, `Villager` `.close()`, the `Villager` `ready` event
- **Java:** `open_window` (merchant) plus `trade_list` (only the unlocked offers, with `specialPrice`, `demand` and
  `priceMultiplier`). `select_trade` makes the server move the inputs, and `putAway(2)` takes the output. The opener
  accepts the `villager` entity only.
- **Bedrock:** interacting with a villager sends `update_trade { window_id, window_type: 'trading', trade_tier,
  villager_unique_id, offers: NBT { Recipes: [{ buyA, buyCountA, buyB, buyCountB, sell, uses, maxUses, tier, traderExp,
  demand, priceMultiplierA/B, netId }] } }` and **no** `container_open`: that packet opens the screen.
  - The offers list every tier (locked ones too). `buyA.Count` is the price the server charges, with discounts such as
    Hero of the Village folded in (verified), and `buyCountA` is the base price. A `Damage` of 32767 means any data
    value.
  - There is no `select_trade`. One use is a single item stack request: `craft_recipe { recipe_network_id: netId }`,
    then `consume` from `trade2_ingredient1` / `trade2_ingredient2` (ui slots 4 / 5, verified), then `place` of the
    output from `creative_output` 50. The server counts the use (`uses` in the next `update_trade`).
  - The villager is `villager_v2`; `wandering_trader` opens the same window.
- **bedboo:** the villager plugin hands `update_trade` to the inventory plugin as a `trading` container
  (`minecraft:merchant`, see [window types](inventory.md#window-types); a refresh while another window is open, or for
  a window being closed, opens nothing). `trades` lists the unlocked offers (tier ≤ `trade_tier`), like Java.
  - Prices: `inputItem1.count` is the base price and `realPrice` the server's. `specialPrice` is the difference minus
    Java's demand term, so upstream's formula yields `realPrice` again. `xp` is `traderExp`. An input whose `Damage` is
    32767 matches any data value when counting and depositing. The recipe network id is the non-enumerable
    `trade.bedrock.netId`.
  - `trade()` keeps upstream's guards and messages and runs one request per use (`putRequirements` deposits the inputs
    as upstream does). It first clears ingredient slots that hold something else, since Bedrock has no
    `select_trade`. The output is predicted from the offer's `sell` item (NBT included, e.g. enchanted books) and lands
    like `putAway(2)`. A used-up trade rejects with "trade blocked".
  - `openVillager` accepts `villager_v2`, `villager` and `wandering_trader`. Items left in the trade input slots by a
    dead trader come back with the next trade window ([container gone](inventory.md#container-gone)).
