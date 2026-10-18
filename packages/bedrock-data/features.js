// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * `supportFeature` table for bedrock_1.26.51: an explicit Bedrock value for
 *   - every minecraft-data Bedrock feature (bedrock/common/features.json), equal to what minecraft-data
 *     computes for 1.26.51 (a unit test checks it), and
 *   - every Java feature name used by mineflayer 4.39.0 lib/, its external tests, the ecosystem plugins
 *     (pathfinder, pvp, collectblock, tool, armor-manager, auto-eat) and the prismarine-* modules that call
 *     `registry.supportFeature` (a unit test greps them and fails on any name missing here).
 *
 * How values were chosen (details per name in docs/differences/U2.md#feature-table):
 *   1. GAME / DATA FACTS (names, world shape, commands, entity identifiers, item/block scheme): the Bedrock
 *      truth, so reused code and ported tests take the Bedrock-correct branch (e.g. itemsAreNotBlocks,
 *      blockSchemeIsFlat, tallWorld, hasExecuteCommand, enderCrystalNameEndsInErNoCaps, fireworkNamePlural).
 *      Command facts were checked on BDS 1.26.51.1 (`/effect <target> <effect>` takes no namespace and has no
 *      `give`, `/replaceitem … slot.hotbar 1`, no `/item`, no `/data`, `/gamerule` without namespace,
 *      `noteblock`).
 *   2. JAVA PACKET LAYOUTS (which Java packet/field to read or write): false. On Bedrock those plugins are
 *      reimplemented on Bedrock packets, and false keeps a vendored Java code path from being taken by
 *      accident (e.g. stateIdUsed, blockPlaceHas*, dimensionIsA*, titleUses*, updatedParticlesPacket).
 *   Values that are not booleans keep the type minecraft-data uses for them (e.g. fishingBiteDelayMaxTicks).
 */

/** minecraft-data `bedrock/common/features.json`, values for 1.26.51 */
const BEDROCK = {
  blockHashes: true,
  compressorInPacketHeader: true,
  defaultTransportIsNethernet: true,
  explicitMaxDurability: true,
  itemRegistryPacket: true,
  itemSerializeUsesAuxValue: false,
  nbtNameForEnchant: 'ench',
  newLoginIdentityFields: true,
  newRecipeSchema: true,
  smallWorld: false,
  spawnEggsHaveSpawnedEntityInName: true,
  spawnEggsUseInternalIdInNbt: true,
  tallWorld: true,
  typeOfValueForEnchantLevel: 'short',
  usesBlockStates: true,
  usesPalettedChunks: true,
  whereDurabilityIsSerialized: 'Damage'
}

/** Java feature names → Bedrock value */
const JAVA = {
  // --- world, blocks, items (facts) -------------------------------------------------------------------
  tallWorld: true, // overworld -64..320 (flat world ground at y=-60)
  itemsAreNotBlocks: true, // separate item and block registries (grass_block, not grass)
  itemsAreAlsoBlocks: false,
  blockSchemeIsFlat: true, // flattened names: birch_log, birch_planks
  oneBlockForSeveralVariations: false,
  blockStateId: true, // Block.stateId is a state id (index into registry.blockStates)
  blockMetadata: false,
  doesntHaveChestType: true, // Bedrock chests have no `type` state; pairing lives in the block entity
  doesntHaveOffHandSlot: false, // Bedrock has an off-hand slot
  shieldSlot: true, // 46-slot Java-layout player window (slot 45 = off-hand)
  netherUpdateInventoryWindows: true, // modern (1.16+) prismarine-windows window set
  noteBlockNameIsNoteBlock: false, // Bedrock block/item is `noteblock`
  hasElytraFlying: true,
  creativeSleepNearMobs: true, // creative players may sleep with monsters nearby
  furnaceNbtUsesSnakeCase: false, // furnace block entity NBT: CookTime, BurnTime (PascalCase)
  multiSidedSigns: true, // signs have a front and a back text (FrontText / BackText)
  // --- items (facts; prismarine-item reads these through registry.supportFeature) ---------------------
  itemsWithComponents: false, // Bedrock items carry NBT (`ench`, `Damage`), not Java data components
  enchantmentsComponentIsFlat: false,
  booksUseStoredEnchantments: false, // Bedrock enchanted books keep their enchantments in `ench`
  itemLoreIsAString: false, // display.Lore is a list of strings
  itemSerializationAllowsPresent: false,
  itemSerializationUsesBlockId: false,
  itemSerializationWillOnlyUsePresent: false,
  spawnEggsUseEntityTagInNbt: false, // spawn eggs are named after their entity (bat_spawn_egg)
  metadataIxOfItem: false, // no Java metadata index; dropped items come from add_item_entity (U7)
  // --- entity identifiers (facts) -----------------------------------------------------------------------
  entityNameUpperCaseNoUnderscore: false, // boat, armor_stand, zombie
  entityNameLowerCaseNoUnderscore: false,
  enderCrystalNameEndsInErNoCaps: true, // minecraft:ender_crystal
  enderCrystalNameNoCapsWithUnderscore: false,
  fireworkNamePlural: true, // entity minecraft:fireworks_rocket (the item is firework_rocket)
  fireworkNameSingular: false,
  fishingBobberCorrectlyNamed: false, // entity minecraft:fishing_hook
  fishingBiteDelayMaxTicks: 600, // same 100..600 tick wait window as Java (not measured on BDS; U14)
  mcDataHasEntityMetadata: false, // minecraft-data has no Bedrock metadata keys (bedrock-protocol names them)
  // --- commands (facts, checked on BDS 1.26.51.1) -----------------------------------------------------------
  hasExecuteCommand: true, // `execute in overworld run teleport …` works
  hasItemCommand: false, // no /item; /replaceitem is used
  replaceItemSlotIsPrefixed: true, // /replaceitem … slot.container <n> / slot.hotbar <n> (slot index is its own argument)
  hasDataCommand: false, // no /data or /blockdata
  gameRuleUsesResourceLocation: false, // /gamerule doDaylightCycle (no namespace)
  effectAreNotPrefixed: true, // /effect <target> hunger … (no namespace; Bedrock has no `effect give`)
  effectAreMinecraftPrefixed: false,
  playsoundUsesResourceLocation: false, // /playsound note.harp
  setBlockUsesMetadataNumber: false, // /setblock … bed ["direction"=0] (no data values)
  indexesVillagerRecipes: false,
  // --- chat / UI -------------------------------------------------------------------------------------------
  lessCharsInChat: false, // 256-character chat chunks (below the Bedrock client limit)
  clientsideChatFormatting: false, // BDS sends formatted text / translation keys
  chatPacketsUseNbtComponents: false,
  chatCommandsQueuedToMainThread: false,
  tabCompleteHasAToolTip: true, // bot.tabComplete keeps the mineflayer ≥1.13 shape [{ match, tooltip }]
  tabCompleteHasNoToolTip: false,
  teamUsesChatComponents: false, // no teams on Bedrock
  teamUsesScoreboard: false,
  selectingTradeMovesItems: false, // Bedrock has no select_trade: the client moves the trade inputs itself
  // --- Java packet layouts: never taken on Bedrock (plugins are reimplemented on Bedrock packets) -----------
  actionIdUsed: false,
  armAnimationBeforeUse: false,
  attackUsesOwnPacket: false,
  blockPlaceHasHandAndFloatCursor: false,
  blockPlaceHasHandAndIntCursor: false,
  blockPlaceHasHeldItem: false,
  blockPlaceHasInsideBlock: false,
  chainedChatWithHashing: false, // (this and the next names: mineflayer internalTest.js, a fake Java server)
  consolidatedEntitySpawnPacket: false,
  positionPacketHasBitflags: false,
  signedChat: false, // Bedrock chat is not signed
  unifiedPlayerAndEntitySpawnPacket: false,
  useChatSessions: false,
  usesLoginPacket: false,
  clientUpdateBookIdWhenSign: false,
  customChannelIdentifier: false,
  customChannelMCPrefixed: false,
  dimensionDataInCodec: false,
  dimensionDataIsAvailable: false,
  dimensionIsAString: false,
  dimensionIsAWorld: false,
  dimensionIsAnInt: false,
  doublePosition: false,
  editBookIsPluginChannel: false,
  editBookPacketUsesNbt: false,
  entityActionUsesStringMapper: false,
  entityMetadataHasLong: false,
  fireworkMetadataOptVarInt8: false,
  fireworkMetadataOptVarInt9: false,
  fireworkMetadataVarInt7: false,
  fixedPointDelta: false,
  fixedPointDelta128: false,
  fixedPointPosition: false,
  hasConfigurationState: false,
  hasEditBookPacket: false, // Bedrock has book_edit, but not Java's edit_book item packet
  incrementedChatType: false,
  newLightingDataFormat: false, // Bedrock sends no light data
  newPlayerInputPacket: false,
  noAckOnCreateSetSlotPacket: false,
  playerInfoActionIsBitfield: false,
  positionUpdateSentEveryTick: true, // player_auth_input is sent every tick (CONTRIBUTING: input queue)
  quickMoveClickSendsEmptyItem: false,
  resourcePackUsesHash: false,
  resourcePackUsesUUID: false,
  respawnIsPayload: false,
  segmentedRegistryCodecData: false,
  sendStringifiedSignText: false,
  sendsPlayerLoadedPacket: false,
  setSlotAsTransaction: false,
  spawnPositionIsGlobal: false,
  spawnRespawnWorldDataField: false,
  stateIdUsed: false,
  teleportUsesOwnPacket: false,
  titleUsesLegacyPackets: false,
  titleUsesNewPackets: false,
  transactionPacketExists: false,
  updatedParticlesPacket: false,
  useItemWithBlockPlace: false,
  useItemWithOwnPacket: false,
  useMCItemName: false,
  useMCTrList: false,
  useMCTrSel: false,
  usesAdvCdm: false,
  usesAdvCmd: false,
  usesMultiblock3DChunkCoords: false,
  usesMultiblockSingleLong: false,
  usetraderlist: false
}

for (const name of Object.keys(JAVA)) {
  if (name in BEDROCK && BEDROCK[name] !== JAVA[name]) throw new Error(`feature ${name}: Java table disagrees with minecraft-data`)
}

/** Java feature name → Bedrock value (frozen) */
const FEATURES = Object.freeze({ ...BEDROCK, ...JAVA })

module.exports = { FEATURES, BEDROCK_FEATURES: Object.freeze({ ...BEDROCK }) }
