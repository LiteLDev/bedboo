# Names, ids and data

What `bot.registry` contains on Bedrock: block, item and entity names and ids, block state ids, datasets, the feature
table and what is missing from the Bedrock data. Checked against BDS 1.26.51.1 (protocol 2193), CloudburstMC/Data at
`659ce1e2eee3a67045693f4fd5515c6ccf571953` (BDS dumps) and a live server; how the data is built is described in
`packages/bedrock-data/NOTICE.md`.

## Bedrock block and item names and ids in `bot.registry`  {#registry}

- **Affects:** `bot.registry` / `require('minecraft-data')('bedrock_1.26.51')`, every API taking block or item names or
  ids (`bot.blockAt().name`, `bot.findBlocks({ matching })`, `bot.inventory.items()[i].name`, recipes, …).
- **Java:** Java names and ids (`grass_block`, `oak_door`, `zombified_piglin`, …).
- **Bedrock:** Bedrock identifiers: 1,477 blocks / 22,091 block states / 2,076 items (minecraft-data PR #1335 for
  1.26.51, every state matched to a BDS runtime id, every item matched name + id to BDS `item_registry`). Many names
  equal Java's; others differ (`wooden_door` block and item for Java's `oak_door`, `noteblock`, `unpowered_repeater`,
  `zombie_pigman` entity, `fishing_hook`, `fireworks_rocket`, …). Item ids are the server's network ids (block items
  can be negative). Bedrock-only items and blocks exist (e.g. `element_*`, `hard_*_stained_glass`, `unknown`).
- **bedboo:** `bot.registry` uses the Bedrock names and ids; items are re-keyed by the server's `item_registry`
  (identity for vanilla BDS). Code that hard-codes Java names has to use the Bedrock ones. Some blocks with a
  `lit` / `powered` state on Java are two blocks on Bedrock: see [block variants](world.md#block-variants).

## Block state ids vs network runtime ids  {#state-ids}

- **Affects:** `Block.stateId`, `registry.blocksByStateId`, `bot.world.setBlockStateId`, everything decoding
  `update_block` / sub-chunks or sending a `block_runtime_id`.
- **Java:** the network carries global palette ids, the same numbers as `block.stateId`.
- **Bedrock:** with `block_network_ids_are_hashes` (always on BDS 1.26.51) the network carries a 32-bit FNV-1a hash of
  the block state NBT (a signed int32 on the wire, e.g. stone = -2144268767).
- **bedboo:** `block.stateId` stays the **sequential index into `registry.blockStates`**, so every block's states are
  the contiguous `minStateId..maxStateId` range exactly like Java (mineflayer's `bed.js`, prismarine-block
  metadata / shapes and mineflayer-pathfinder's `Block.fromStateId(x.minStateId)` keep working unchanged). Network
  runtime ids are translated: `registry.blocksByRuntimeId[runtimeId] → { stateId, ...block }` and
  `registry.runtimeIdByStateId[stateId]` (both built by `registry.handleStartGame(start_game)`), and `block.hash` is
  the runtime id of a Block. prismarine-chunk does the translation itself when decoding / encoding sub-chunks. This
  deliberately differs from prismarine-registry PR #57 (which makes `stateId` the hash and leaves `minStateId`
  undefined, breaking pathfinder). `minecraft:unknown` is the one state whose runtime id is not its hash: BDS reserves
  `0xFFFFFFFE` (-2) for it. Every `blockStates[i]` carries its runtime id as `hash` (precomputed and verified by the
  generator), so `handleStartGame` does not hash 22k states.

## Unknown block runtime ids decode to `minecraft:unknown`  {#unknown-runtime-ids}

- **Affects:** chunk decoding (`bot.blockAt`, `bot.world`) when a server sends block states the data does not know
  (custom / add-on blocks from `start_game.block_properties`).
- **Java:** n/a (registry codecs are sent by the server).
- **Bedrock:** custom blocks are hashed like vanilla ones; their states are not in the 1.26.51 data.
- **bedboo:** the sub-chunk decoder never throws: an unknown runtime id becomes a palette entry for
  `minecraft:unknown` (BDS's own placeholder: a solid full cube with hardness 0, so physics treats it as solid and
  pathfinding as diggable) that keeps `entry.runtimeId`, and re-encoding writes the original id back. Vanilla BDS never
  produced one in a live check (default overworld, nether, end). Custom blocks are not added to the registry yet.
  Decoding network chunks before `registry.handleStartGame(start_game)` throws (no runtime-id map) instead of silently
  producing placeholders.

## Collision boxes and friction from BDS  {#collision}

- **Affects:** `block.shapes` (physics, pathfinder, `bot.canSeeBlock`), `registry.blocksByName[x].friction`.
- **Java:** Java collision boxes; slipperiness is hard-coded in prismarine-physics.
- **Bedrock:** the BDS dump differs from minecraft-data PR #1335 for 708 states: doors are 0.1875 (3/16) thick (PR:
  0.1825) and an `end_portal_frame` with an eye has the extra eye box. Friction per block: ice / packed / frosted
  0.98, blue_ice 0.989, slime 0.8, **honey_block 0.8**, everything else 0.6 (air and `unknown` 0.899999).
- **bedboo:** collision comes from PR #1335 except for an explicit allowlist taken from Cloudburst `collisionShape`
  (`/_door$/`, `end_portal_frame`); the generator fails on any other disagreement. Every block has a Bedrock `friction`
  field (new in the schema; the [physics engine](movement.md#engine) reads it). For the shapes of door halves see
  [door halves](world.md#door-halves).

## Datasets  {#datasets}

- **Affects:** `bot.registry.effects*`, `foods*`, `attributes*`, `enchantments*`, `entities*`, `biomes*`,
  `particles*`, `sounds*` and everything using them (`bot.entity.effects`, auto-eat, prismarine-physics
  `PlayerState`, `digTime`, `item.enchants`, `bot.entities[x].name`, particle / sound events).
- **Java / Bedrock / bedboo:**
  - **effects:** Bedrock ids (`mob_effect.effect_id`: Speed 1 … SlowFalling 27, BadOmen 28, HeroOfTheVillage 29
    (`village_hero`), Darkness 30, TrialOmen 31, WindCharged 32, Weaving 33, Oozing 34, Infested 35, RaidOmen 36,
    BreathOfTheNautilus 37) with minecraft-data's Java-style `name` / `displayName` / `type`, so
    `effectsByName.JumpBoost` etc. work; `bedrockName` is the command name. Bedrock-only: FatalPoison (25).
    Java-only (absent): Glowing, Luck, BadLuck, DolphinsGrace. Ids verified with `/effect` on BDS.
  - **enchantments:** Bedrock ids (minecraft-data bedrock 0..37 + wind_burst 38, density 39, breach 40, lunge 41,
    verified with `/enchant`); names are the Java ones (`efficiency`, `binding_curse`, …). Java's `sweeping_edge`
    does not exist on Bedrock.
  - **attributes:** `resource` is the Java key (`bot.entity.attributes` is keyed by it, prismarine-physics reads
    `attributesByName.movementSpeed.resource`), `bedrockName` the `update_attributes` name: maxHealth ←
    `minecraft:health` (its `max` is the max health, `current` the health), movementSpeed ← `minecraft:movement`
    (player default 0.1), followRange, knockbackResistance, attackDamage, maxAbsorption ← `minecraft:absorption`,
    luck, jumpStrength ← `minecraft:horse.jump_strength`, spawnReinforcements ←
    `minecraft:zombie.spawn_reinforcements`. Bedrock-only entries (`resource` = the Bedrock name):
    underwaterMovement, lavaMovement, frictionModifier, bounciness, airDragModifier, playerHunger, playerSaturation,
    playerExhaustion, playerLevel, playerExperience. Java-only attributes (armor, stepHeight, gravity, …) are kept
    without `bedrockName`; BDS never sends them. How the local player's attributes are reported:
    [self metadata](entities.md#self-metadata).
  - **foods:** minecraft-data's `foods` schema (Java field names) from the BDS `minecraft:food` item components:
    `foodPoints` = nutrition, `saturation` = nutrition × modifier × 2, `saturationRatio` = modifier × 2,
    `effectiveQuality` = foodPoints + saturation; 40 foods with Bedrock item ids.
  - **entities:** the 137 BDS identifiers (Cloudburst `entity_identifiers.dat`); `id` = `internalId` = Bedrock's
    numeric entity type (player 257). Sizes are the bounding boxes BDS reports for summoned entities (several differ
    from Java: zombie / skeleton 0.6×1.9, chicken 0.6×0.8, …); slime / magma cube are given at size 1 and shulker as
    1×1 (BDS reports the default actor box for it); Education Edition entities (agent, balloon, ice_bomb,
    tripod_camera) have no size (0×0). minecraft-data's bedrock-only `moving_block`, `item_frame`,
    `glow_item_frame`, `chalkboard` are dropped (blocks / block entities on BDS, not entity identifiers).
    minecraft-data bedrock 1.21.80 files Java-only variants under the identifier they map to (zombie: Zombie + Giant,
    llama: Llama + Trader Llama, arrow: Arrow + Spectral Arrow, evocation_illager: Evoker + Illusioner, plus
    placeholder rows for armor_stand and minecart); the generator takes the Bedrock entity's own row
    (`tables.ENTITY_DUPLICATES`; an unlisted duplicate fails the generation), so `entitiesByName.zombie` is Zombie,
    not Giant. Some identifiers keep minecraft-data's placeholder display name (= the identifier: `npc`, `tnt`,
    `boat`, `egg`, `*_minecart`, …).
  - **biomes:** keyed by the vanilla numeric ids that chunk biome palettes carry (ocean 0, plains 1, river 7, hell 8,
    the_end 9, … soulsand_valley 178 … mangrove_swamp 191, cherry_grove 192, pale_garden 193, sulfur_caves 194,
    dappled_forest 195): 89 biomes, the list BDS 1.26.51 sends in `biome_definition_list`. minecraft-data's bedrock
    1.21.60 list (what `bedrock_1.26.51` inherited) is numbered alphabetically (0 bamboo_jungle,
    1 bamboo_jungle_hills, plains 64), so every biome resolved to the wrong one (the flat world's plains became
    bamboo_jungle_hills). BDS sends `biome_id` 65535 ("vanilla id") for every vanilla biome and lists them in id
    order, so the client must know the numbering: ids from pmmp/BedrockData's `biome_id_map.json` (CC0) plus
    dappled_forest 195 (new in 1.26.50), checked against minecraft-data bedrock 1.20.0, against the order of BDS's
    `biome_definition_list` and live (each biome located with `/locate biome` has that id in the chunk). Schema as
    minecraft-data (`id`, `name`, `category`, `temperature`, `has_precipitation`, `dimension`
    overworld / nether / the_end, `displayName`, `color` = the BDS map water colour like minecraft-data bedrock
    1.21.60, plus `rainfall` and `depth`); climate values are BDS's (CloudburstMC `stripped_biome_definitions.json`,
    equal to the packet); category and display name come from minecraft-data bedrock 1.20.0 (Java-style categories),
    newer biomes from a table. Custom (data-driven) biomes are not in the registry. `bot.blockAt(p).biome` is built by
    prismarine-block 1.23.0 with `prismarine-biome(registry.version)`, which fills in only `id` (its `name` is `''`,
    the same on Java); `bot.registry.biomes[block.biome.id]` is the biome.
  - **particles:** Bedrock particle types (`level_event` `0x4000 | id`, e.g. bubble 1, heart 19).
  - **sounds:** level sound event identifiers as sent in `level_sound_event.sound_id` (strings since 1.26.40, e.g.
    `armor.equip_iron`); `id` is the legacy numeric LevelSoundEvent id (13 newer events got ids ≥ 615).
  - **unchanged from minecraft-data:** language (1.21.70), recipes (1.19.10, superseded by `crafting_data`: see
    [recipes](crafting.md#recipes)), windows, instruments, blocksB2J / J2B, protocol.

## Items on the wire (ItemV4)  {#items}

- **Affects:** `Item.fromNotch` / `Item.toNotch` (prismarine-item), used by inventory, creative, transactions.
- **Java:** `{ itemCount, itemId, components }`; an empty slot is `present: false` / count 0.
- **Bedrock:** ItemV4 `{ network_id, count, metadata, has_stack_id, stack_id, block_runtime_id, extra }`; since
  1.26.40 an empty slot still carries every field; block items carry the runtime id of the block state they place
  (BDS compares held items exactly).
- **bedboo:** `Item.toNotch(null)` is BDS's empty item; items keep the server's `stack_id`, `blockRuntimeId` and
  `can_place_on` / `can_destroy` lists (`item.canPlaceOn` / `item.canDestroy`), so `toNotch(fromNotch(x))` is
  byte-identical; new block items use `registry.items[id].blockStateId` (from BDS creative data, a new field) →
  runtime id. Before `registry.handleStartGame` new block items get 0.

## Item tags are not on the wire  {#item-tags}

- **Affects:** recipes with tag ingredients (planks, logs, wooden slabs, stone materials, coals, eggs, wool, nuggets,
  …).
- **Java:** minecraft-data's recipes are already expanded; the tags exist in the data.
- **Bedrock:** `crafting_data` names tags (`minecraft:planks`); BDS never sends their members (`item_registry` only
  lists the tags of data-driven items, none of the vanilla ones above). 11 tags are used by 1.26.51's crafting
  recipes.
- **bedboo:** `lib/bedrock/item_tags.js` holds pmmp/BedrockData `item_tags.json` (BDS 1.26.30, CC0) for those 11 tags,
  verified member by member on BDS 1.26.51.1 by crafting every candidate item into a recipe using the tag (accepted =
  member, status 35 = not). New in 1.26.51: the poplar wood family (planks, logs, wooden slabs) and
  `minecraft:mushrooms_for_stew` (brown, red and shelf mushroom). A recipe with an unknown tag or item would be
  skipped (`bot._bedrock.recipes.skipped`; empty on 1.26.51). See [recipes](crafting.md#recipes).

## No loot tables in the Bedrock data  {#loot}

- **Affects:** `registry.blockLoot`, `registry.entityLoot` (empty for `bedrock_1.26.51`).
- **Java:** minecraft-data has block and entity loot tables (drop chances and counts).
- **Bedrock:** only `blocks[].drops` (a list of item ids, no counts or chances) exists.
- **bedboo:** both tables are empty; code that needs yields has to bring its own. The bedboo agent
  (`packages/agent/src/data/index.js`) keeps the ones it needs: redstone ore ×4.5, lapis ×6.5, copper ×3.5,
  gravel → flint 10 %, leaves → saplings / sticks / apples, and the drops of the passive mobs it hunts.

## Feature table (`bot.supportFeature`)  {#feature-table}

- **Affects:** `bot.supportFeature(name)`, the `supportFeature` export, every reused plugin branching on a Java
  feature name.
- **Java:** values from minecraft-data's Java feature list for the bot's version.
- **Bedrock:** minecraft-data's Bedrock list knows none of the Java names.
- **bedboo:** an explicit value for every Java name used by mineflayer 4.39.0 `lib/` and `examples/` and its test
  suites, by pathfinder / pvp / collectblock / tool / armor-manager / auto-eat and by the prismarine-* modules, plus all
  17 minecraft-data Bedrock features with minecraft-data's own 1.26.51 values (`packages/bedrock-data/features.js`).
  Unknown names return `false` with a one-time process warning (`BEDBOO_UNKNOWN_FEATURE`); with
  `BEDBOO_STRICT_FEATURES=1` they throw. Rules:
  1. **Game / data facts → the Bedrock truth:** `tallWorld`, `itemsAreNotBlocks` (and not `itemsAreAlsoBlocks`),
     `blockSchemeIsFlat`, `blockStateId`, `doesntHaveChestType` (Bedrock chests have no `type` state),
     `doesntHaveOffHandSlot: false`, `shieldSlot` (46-slot player window), `hasElytraFlying`, `mobSpawner` (the block
     is `mob_spawner`; mineflayer's examples ask), `village&pillageInventoryWindows: false` (see below),
     `noteBlockNameIsNoteBlock: false` (`noteblock`), `multiSidedSigns`, `furnaceNbtUsesSnakeCase: false`,
     `creativeSleepNearMobs`, entity names (`enderCrystalNameEndsInErNoCaps`, `fireworkNamePlural`,
     `fishingBobberCorrectlyNamed: false`), item NBT facts for prismarine-item (`itemsWithComponents: false`,
     `booksUseStoredEnchantments: false`, `itemLoreIsAString: false`, …).
  2. **Commands (checked on BDS 1.26.51.1):** `hasExecuteCommand` (`execute in overworld run teleport …` works),
     `hasItemCommand: false` (no `/item`), `replaceItemSlotIsPrefixed` (`/replaceitem … slot.container <n>`; the slot
     index is a separate argument, so code using `slot.container.<n>` must be adapted), `hasDataCommand: false`,
     `gameRuleUsesResourceLocation: false`, `effectAreNotPrefixed` (Bedrock is `/effect <target> hunger 1 255`:
     neither `effect give` nor a `minecraft:` prefix is accepted), `playsoundUsesResourceLocation: false`,
     `setBlockUsesMetadataNumber: false`.
  3. **Java packet layouts → false** (`stateIdUsed`, `blockPlaceHas*`, `dimensionIsA*`, `dimensionDataInCodec`,
     `titleUses*`, `updatedParticlesPacket`, `useItemWith*`, `teleportUsesOwnPacket`, `hasEditBookPacket`, …): the
     plugins are reimplemented on Bedrock packets, and `false` keeps a vendored Java branch from being taken.
     Exception: `positionUpdateSentEveryTick: true` (`player_auth_input` goes out every tick).
  4. **API shape:** `tabCompleteHasAToolTip: true` (mineflayer ≥ 1.13 `[{ match, tooltip }]`),
     `lessCharsInChat: false` (256-character chunks), `selectingTradeMovesItems: false` (no `select_trade` on
     Bedrock), `fishingBiteDelayMaxTicks: 600` (Java's window; measured to hold on BDS, see
     [fishing](survival.md#fishing)).
  5. **prismarine-windows:** `village&pillageInventoryWindows: false` selects its legacy window table (player
     inventory of 46 slots via `shieldSlot`). `true` would take the 1.14+ branch, whose
     `registry.version['>=']('1.20.3')` throws a RangeError for a Bedrock version. Bedrock containers are not Java
     protocol windows: bedboo registers every Bedrock container type (`bot._bedrock.windows`) and builds the 46-slot
     Java-layout player inventory itself ([window types](inventory.md#window-types)).
     `netherUpdateInventoryWindows` is only read inside that 1.14+ branch (no effect on Bedrock).

## Java version comparisons on the Bedrock registry  {#version-comparisons}

- **Affects:** `bot.registry.isNewerOrEqualTo` / `isOlderThan` / `version['>=']` etc. with Java versions (mineflayer's
  `examples/inventory.js`, @nxg-org/mineflayer-util-plugin).
- **Java:** comparisons between Java versions.
- **Bedrock:** minecraft-data only knows Bedrock versions for a Bedrock version object and threw a RangeError for
  `'1.9'` / `'1.16'`: the util plugin (and so mineflayer-auto-eat) could not even load.
- **bedboo:** `@bedboo/bedrock-data` `install()` relaxes the comparators of the cached `bedrock_1.26.51` version
  object: a version minecraft-data does not know is compared numerically (major.minor.patch) with 1.26.51, so it is
  newer than every Java 1.x and older than Java 26.x; Bedrock versions compare exactly as before; non-numeric unknown
  versions still throw. Code that relied on the throw (prismarine-windows' 1.14+ branch) is unaffected: the
  [feature](#feature-table) that guards it stays false.
