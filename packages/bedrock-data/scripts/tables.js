// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * Hand-maintained tables used by generate.js. Each one is verified: effect and enchantment ids against a
 * live BDS 1.26.51.1 (probe-bds.js → probe/1.26.51.json; generate.js fails on a mismatch), attribute names
 * against the update_attributes packets BDS sends (U0 fixture), entity names against Cloudburst
 * entity_identifiers.dat.
 */

/**
 * Bedrock mob effects: [Bedrock id, minecraft-data (Java-style) name, displayName, type, Bedrock command name].
 * Ids from gophertunnel mob_effect.go (1..27) and the live probe (28..37). The `name`s are the ones
 * minecraft-data uses for Java so prismarine-physics / prismarine-block / plugins find them
 * (`effectsByName.JumpBoost`, `Haste`, `MiningFatigue`, `ConduitPower`, `Levitation`, `SlowFalling`, …).
 * Java-only effects (Glowing, Luck, BadLuck, DolphinsGrace) do not exist on Bedrock; Bedrock-only:
 * FatalPoison (25).
 */
const EFFECTS = [
  [1, 'Speed', 'Speed', 'good', 'speed'],
  [2, 'Slowness', 'Slowness', 'bad', 'slowness'],
  [3, 'Haste', 'Haste', 'good', 'haste'],
  [4, 'MiningFatigue', 'Mining Fatigue', 'bad', 'mining_fatigue'],
  [5, 'Strength', 'Strength', 'good', 'strength'],
  [6, 'InstantHealth', 'Instant Health', 'good', 'instant_health'],
  [7, 'InstantDamage', 'Instant Damage', 'bad', 'instant_damage'],
  [8, 'JumpBoost', 'Jump Boost', 'good', 'jump_boost'],
  [9, 'Nausea', 'Nausea', 'bad', 'nausea'],
  [10, 'Regeneration', 'Regeneration', 'good', 'regeneration'],
  [11, 'Resistance', 'Resistance', 'good', 'resistance'],
  [12, 'FireResistance', 'Fire Resistance', 'good', 'fire_resistance'],
  [13, 'WaterBreathing', 'Water Breathing', 'good', 'water_breathing'],
  [14, 'Invisibility', 'Invisibility', 'good', 'invisibility'],
  [15, 'Blindness', 'Blindness', 'bad', 'blindness'],
  [16, 'NightVision', 'Night Vision', 'good', 'night_vision'],
  [17, 'Hunger', 'Hunger', 'bad', 'hunger'],
  [18, 'Weakness', 'Weakness', 'bad', 'weakness'],
  [19, 'Poison', 'Poison', 'bad', 'poison'],
  [20, 'Wither', 'Wither', 'bad', 'wither'],
  [21, 'HealthBoost', 'Health Boost', 'good', 'health_boost'],
  [22, 'Absorption', 'Absorption', 'good', 'absorption'],
  [23, 'Saturation', 'Saturation', 'good', 'saturation'],
  [24, 'Levitation', 'Levitation', 'bad', 'levitation'],
  [25, 'FatalPoison', 'Fatal Poison', 'bad', 'fatal_poison'],
  [26, 'ConduitPower', 'Conduit Power', 'good', 'conduit_power'],
  [27, 'SlowFalling', 'Slow Falling', 'good', 'slow_falling'],
  [28, 'BadOmen', 'Bad Omen', 'bad', 'bad_omen'],
  [29, 'HeroOfTheVillage', 'Hero of the Village', 'good', 'village_hero'],
  [30, 'Darkness', 'Darkness', 'bad', 'darkness'],
  [31, 'TrialOmen', 'Trial Omen', 'bad', 'trial_omen'],
  [32, 'WindCharged', 'Wind Charged', 'bad', 'wind_charged'],
  [33, 'Weaving', 'Weaving', 'bad', 'weaving'],
  [34, 'Oozing', 'Oozing', 'bad', 'oozing'],
  [35, 'Infested', 'Infested', 'bad', 'infested'],
  [36, 'RaidOmen', 'Raid Omen', 'bad', 'raid_omen'],
  [37, 'BreathOfTheNautilus', 'Breath of the Nautilus', 'good', 'breath_of_the_nautilus']
]

/**
 * Enchantments added after minecraft-data's bedrock 1.19.1 list (ids 0..37): [Bedrock id, name]. Ids
 * verified with the live probe; the other fields come from minecraft-data pc 26.1. Java's sweeping_edge
 * does not exist on Bedrock.
 */
const ENCHANTMENTS_ADDED = [
  [38, 'wind_burst'],
  [39, 'density'],
  [40, 'breach'],
  [41, 'lunge']
]

/**
 * Java attributes (minecraft-data pc 26.1 `name`) that BDS also sends, with the Bedrock attribute name
 * (`update_attributes`) and the default BDS 1.26.51.1 reports for the player.
 * `resource` stays the Java key: bot.entity.attributes is keyed by it (CONTRIBUTING, entity_data.js) and
 * prismarine-physics reads `attributesByName.movementSpeed.resource`.
 */
const ATTRIBUTES_JAVA = [
  { name: 'maxHealth', bedrockName: 'minecraft:health', default: 20 },
  { name: 'movementSpeed', bedrockName: 'minecraft:movement', default: 0.1 },
  { name: 'followRange', bedrockName: 'minecraft:follow_range', default: 16 },
  { name: 'knockbackResistance', bedrockName: 'minecraft:knockback_resistance', default: 0 },
  { name: 'attackDamage', bedrockName: 'minecraft:attack_damage', default: 1 },
  { name: 'maxAbsorption', bedrockName: 'minecraft:absorption', default: 0 },
  { name: 'luck', bedrockName: 'minecraft:luck', default: 0 },
  { name: 'jumpStrength', bedrockName: 'minecraft:horse.jump_strength' },
  { name: 'spawnReinforcements', bedrockName: 'minecraft:zombie.spawn_reinforcements' }
]

/** Bedrock-only attributes (no Java equivalent): `resource` = the Bedrock name. Bounds/defaults as BDS sends them. */
const FLOAT_MAX = 3.4028234663852886e+38
const ATTRIBUTES_BEDROCK_ONLY = [
  { name: 'underwaterMovement', bedrockName: 'minecraft:underwater_movement', min: 0, max: FLOAT_MAX, default: 0.02 },
  { name: 'lavaMovement', bedrockName: 'minecraft:lava_movement', min: 0, max: FLOAT_MAX, default: 0.02 },
  { name: 'frictionModifier', bedrockName: 'minecraft:friction_modifier', min: 0, max: 256, default: 1 },
  { name: 'bounciness', bedrockName: 'minecraft:bounciness', min: 0, max: 1, default: 0 },
  { name: 'airDragModifier', bedrockName: 'minecraft:air_drag_modifier', min: 0, max: 256, default: 1 },
  { name: 'playerHunger', bedrockName: 'minecraft:player.hunger', min: 0, max: 20, default: 20 },
  { name: 'playerSaturation', bedrockName: 'minecraft:player.saturation', min: 0, max: 20, default: 5 },
  { name: 'playerExhaustion', bedrockName: 'minecraft:player.exhaustion', min: 0, max: 20, default: 0 },
  { name: 'playerLevel', bedrockName: 'minecraft:player.level', min: 0, max: 24791, default: 0 },
  { name: 'playerExperience', bedrockName: 'minecraft:player.experience', min: 0, max: 1, default: 0 }
]

/** Bedrock entity identifier → minecraft-data pc name, where they differ (used only for display names/category). */
const ENTITY_JAVA_NAMES = {
  chest_boat: 'oak_chest_boat',
  boat: 'oak_boat',
  breeze_wind_charge_projectile: 'breeze_wind_charge',
  wind_charge_projectile: 'wind_charge',
  zombie_pigman: 'zombified_piglin',
  evocation_illager: 'evoker',
  evocation_fang: 'evoker_fangs',
  tropicalfish: 'tropical_fish',
  xp_orb: 'experience_orb',
  xp_bottle: 'experience_bottle',
  ender_crystal: 'end_crystal',
  eye_of_ender_signal: 'eye_of_ender',
  fireworks_rocket: 'firework_rocket',
  thrown_trident: 'trident',
  villager_v2: 'villager',
  zombie_villager_v2: 'zombie_villager',
  splash_potion: 'splash_potion',
  lingering_potion: 'lingering_potion',
  snow_golem: 'snow_golem',
  leash_knot: 'leash_knot',
  wither_skull_dangerous: 'wither_skull',
  command_block_minecart: 'command_block_minecart',
  fishing_hook: 'fishing_bobber',
  lightning_bolt: 'lightning_bolt'
}

/** Bedrock-only entities with no minecraft-data entry: display name, type, category (size from the probe). */
const ENTITIES_MANUAL = {
  cushion: { displayName: 'Cushion', type: 'other', category: 'Immobile' },
  sulfur_cube: { displayName: 'Sulfur Cube', type: 'hostile', category: 'Hostile mobs' },
  elder_guardian_ghost: { displayName: 'Elder Guardian Ghost', type: 'other', category: 'UNKNOWN' }
}

/**
 * Entity sizes [width, height] that the probe cannot measure:
 * - slime / magma_cube: random size per spawn; this is size 1 (BDS scales it: a size-4 slime probed 2.08x2.08,
 *   a size-2 magma cube 1.04x1.02).
 * - shulker: BDS reports the default actor box (0.6x1.8) in its entity data; the shell is a full block.
 */
const ENTITY_SIZES = {
  slime: [0.52, 0.52],
  magma_cube: [0.52, 0.51],
  shulker: [1, 1]
}

module.exports = { EFFECTS, ENTITY_SIZES, ENCHANTMENTS_ADDED, ATTRIBUTES_JAVA, ATTRIBUTES_BEDROCK_ONLY, ENTITY_JAVA_NAMES, ENTITIES_MANUAL }
