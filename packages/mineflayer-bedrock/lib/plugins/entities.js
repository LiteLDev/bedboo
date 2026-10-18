// owner: U4 (wave 2, local player only) → U7 (wave 3, all other entities & players)
// Adapted from mineflayer 4.39.0 lib/plugins/entities.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): the same members, events, arguments and event order; the packets
// are Bedrock's. Differences are documented in docs/differences/U7.md.
//
// Surface: bot.entity (local player Entity, created on start_game by U4), bot.username,
//   bot.entities {id: Entity}, bot.players {username: Player}, bot.player, bot.uuidToUsername,
//   bot.vehicle, bot.fireworkRocketDuration, bot.findPlayer(s)(filter), bot.nearestEntity(match),
//   bot._playerFromUUID(uuid), bot.swingArm(hand, showHand), bot.attack(entity, swing = true),
//   bot.mount(entity), bot.dismount(), bot.useOn(entity), bot.moveVehicle(left, forward) (U5: input.setVehicle)
// Events: entitySpawn/Gone/Moved/Update/Hurt/Dead/SwingArm/Equip/Sleep/Wake/Eat/Crouch/Uncrouch/
//   Attributes/Effect/EffectEnd/Attach/Detach/ElytraFlew/Taming/Tamed/ShakingOffWater/EatingGrass/
//   CriticalEffect/MagicCriticalEffect, playerJoined/Updated/Left, itemDrop, playerCollect,
//   mount, dismount, usedFirework (entityHandSwap: no Bedrock packet, docs/differences/U7.md#hand-swap)
//
// Bedrock packets (BDS 1.26.51.1, verified live — docs/differences/U7.md#positions):
// - Entity ids: mineflayer `entity.id` = Number(runtime id); `entity.runtimeId` / `entity.uniqueId` are BigInt.
//   add_* register runtime ↔ unique in `bot._bedrock.ids`; remove_entity and set_entity_link carry UNIQUE ids.
//   Packets for runtime ids that were never added are ignored (no ghost entities like upstream's fetchEntity).
// - Positions: add_player is FEET level; move_player (other players) is EYE level (feet + 1.62); add_entity /
//   add_item_entity / move_entity / move_entity_delta are feet level + a per-type offset (POSITION_OFFSETS: item
//   0.125, tnt / falling_block 0.49, boats 0.375, minecarts 0.35). move_entity_delta fields are absolute and
//   optional (absent = unchanged); its rotations are bytes (×360/256): rot_x pitch, rot_y yaw, rot_z head yaw.
// - add_player.unique_id is an li64 ([high, low] from protodef), every other unique id a zigzag64 BigInt.
// - entity_event: hurt_animation → entityHurt, death_animation → entityDead (preceded by entityHurt for the killing
//   blow, which BDS reports with death_animation only), tame_fail → entityTaming, tame_success → entityTamed,
//   shake_wet → entityShakingOffWater, eat_grass_animation → entityEatingGrass, eating_item → entityEat,
//   arm_swing (mob attacks) → entitySwingArm. animate: swing_arm → entitySwingArm, wake_up → entityWake,
//   critical_hit / magic_critical_hit → entityCriticalEffect / entityMagicCriticalEffect.
// - set_entity_link { ridden_entity_id, rider_entity_id, type: 0 remove | 1 rider | 2 passenger } → entityAttach /
//   entityDetach, bot.vehicle + mount / dismount for the local player. take_item_entity { runtime_entity_id: the
//   item, target: the collector } → playerCollect(collector, collected). add_painting → a `painting` entity + a
//   mineflayer Painting registered in `bot._bedrock.world.paintings` (lib/bedrock/paintings.js).
// - player_list (maybeIncompleteArray: the last record may be truncated) arrives BEFORE start_game for the players
//   already online; those records are kept and applied after start_game's reset (playerJoined for each, the bot
//   included, like upstream's player_info).
//
// U4 (wave 2) — the local player, kept as is:
// - start_game → bot.entity = prismarine-entity Entity(Number(runtime_entity_id)): type/name 'player',
//   username, uuid, uniqueId (BigInt start_game.entity_id), height 1.8, width 0.6, eyeHeight 1.62, FEET
//   position (wire eye level − 1.62), yaw/pitch (radians) from start_game.rotation; bot.entities[id] = bot.entity;
//   bot.username = the client's username (offline: options.username, online: the Xbox gamertag).
//   Like upstream, players/uuidToUsername/entities are reset on login.
// - own update_attributes / set_health / mob_effect / set_entity_data / set_entity_motion →
//   lib/bedrock/entity_data.js (attributes, effects, metadata flags, velocity, + the entity events).
// - 'spawn' → entitySpawn(bot.entity) (upstream does the same).
'use strict'
const { stubSync } = require('../bedrock/errors')
const conv = require('../bedrock/conversions')
const entityData = require('../bedrock/entity_data')
const { fromNetwork } = require('../bedrock/item')
const { fromAddPainting } = require('../bedrock/paintings')
const { buildUseOnEntity, buildMouseOver } = require('../bedrock/transactions')
const { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH, SNEAK_HEIGHT, SNEAK_EYE_HEIGHT, gameModeName } = require('../bedrock/constants')

module.exports = inject

/** wire y − feet y of non-player entities in add_entity / add_item_entity / move_entity(_delta) (BDS 1.26.51.1) */
const POSITION_OFFSETS = Object.freeze({
  item: 0.125,
  tnt: 0.49,
  falling_block: 0.49,
  boat: 0.375,
  chest_boat: 0.375,
  minecart: 0.35,
  chest_minecart: 0.35,
  hopper_minecart: 0.35,
  tnt_minecart: 0.35,
  command_block_minecart: 0.35
})

// mineflayer's animation / entity_status tables, keyed by the Bedrock packet values
const animateEvents = {
  swing_arm: 'entitySwingArm',
  wake_up: 'entityWake',
  critical_hit: 'entityCriticalEffect',
  magic_critical_hit: 'entityMagicCriticalEffect'
}

const entityEventEvents = {
  hurt_animation: 'entityHurt',
  death_animation: 'entityDead',
  tame_fail: 'entityTaming',
  tame_success: 'entityTamed',
  shake_wet: 'entityShakingOffWater',
  eat_grass_animation: 'entityEatingGrass',
  eating_item: 'entityEat',
  arm_swing: 'entitySwingArm'
}

/** mob_armor_equipment field → mineflayer equipment index (0 hand, 1 off-hand, 2 boots … 5 helmet, 6 body) */
const ARMOR_SLOTS = Object.freeze({ boots: 2, leggings: 3, chestplate: 4, helmet: 5, body: 6 })

/** Armor points and toughness per worn item (minecraft.wiki; Bedrock = Java for these items). */
const ARMOR_VALUES = (() => {
  const values = {}
  const sets = {
    leather: [1, 3, 2, 1, 0],
    copper: [2, 4, 3, 1, 0],
    chainmail: [2, 5, 4, 1, 0],
    iron: [2, 6, 5, 2, 0],
    golden: [2, 5, 3, 1, 0],
    diamond: [3, 8, 6, 3, 2],
    netherite: [3, 8, 6, 3, 3]
  }
  for (const [material, [helmet, chestplate, leggings, boots, toughness]] of Object.entries(sets)) {
    values[`${material}_helmet`] = [helmet, toughness]
    values[`${material}_chestplate`] = [chestplate, toughness]
    values[`${material}_leggings`] = [leggings, toughness]
    values[`${material}_boots`] = [boots, toughness]
  }
  Object.assign(values, {
    turtle_helmet: [2, 0],
    leather_horse_armor: [3, 0],
    copper_horse_armor: [4, 0],
    iron_horse_armor: [5, 0],
    golden_horse_armor: [7, 0],
    diamond_horse_armor: [11, 0],
    netherite_horse_armor: [19, 3],
    wolf_armor: [11, 0]
  })
  return Object.freeze(values)
})()

/** Sum of armor points / toughness of the worn items (equipment indexes 2..6). */
function armorTotals (equipment) {
  let armor = 0
  let toughness = 0
  for (let i = 2; i <= 6; i++) {
    const values = ARMOR_VALUES[equipment?.[i]?.name]
    if (!values) continue
    armor += values[0]
    toughness += values[1]
  }
  return { armor, toughness }
}

/**
 * Synthesized armor attributes (Bedrock sends none): `minecraft:armor` / `minecraft:armor_toughness` (U2 attribute
 * resource names) and the keys upstream's explosion plugin reads (`generic.armor`, `generic.armorToughness`), live
 * from the entity's equipment so `bot.getExplosionDamages(entity, …)` works unchanged.
 */
function installArmorAttributes (entity) {
  if (!entity.attributes) entity.attributes = {}
  const attrs = entity.attributes
  const define = (key, pick) => {
    Object.defineProperty(attrs, key, {
      configurable: true,
      enumerable: true,
      get () { return { value: armorTotals(entity.equipment)[pick], modifiers: [] } },
      set (value) { Object.defineProperty(attrs, key, { value, writable: true, configurable: true, enumerable: true }) }
    })
  }
  define('minecraft:armor', 'armor')
  define('minecraft:armor_toughness', 'toughness')
  define('generic.armor', 'armor')
  define('generic.armorToughness', 'toughness')
}

/** protodef li64 ([high, low]) or varint64 / zigzag64 → BigInt */
function toBigInt (v) {
  if (Array.isArray(v)) return BigInt.asIntN(64, (BigInt(v[0]) << 32n) | BigInt(v[1] >>> 0))
  return BigInt(v)
}

function inject (bot) {
  const Entity = require('prismarine-entity')(bot.registry)
  const ChatMessage = require('prismarine-chat')(bot.registry)

  bot.players = {}
  bot.uuidToUsername = {}
  bot.entities = {}
  bot.vehicle = null
  bot.fireworkRocketDuration = 0

  let pendingRecords = [] // player_list records received before start_game (applied after its reset)
  const playerUniques = new Map() // unique id (BigInt) → player uuid, from player_list records
  const hurtThisBatch = new Set() // entities with a hurt_animation in the packet batch being read (one server tick)
  let batchEnd = null
  const knownFireworks = new Set()
  let hovered = null // id of the entity the last interact mouse_over_entity named

  const ids = () => bot._bedrock?.ids
  const isSelf = (runtimeId) => !!ids()?.isSelf(runtimeId)
  const isSelfUnique = (uniqueId) => !!ids()?.isSelfUnique(uniqueId)

  function ownUsername () {
    return bot._client.username ?? bot._client.profile?.name ?? bot._client.options?.username
  }

  /** mineflayer gamemode number of a Bedrock game mode ('fallback' / undefined → the world's default) */
  function gameModeIndex (mode) {
    return ['survival', 'creative', 'adventure', 'spectator'].indexOf(gameModeName(mode, bot._bedrock?.startGame?.world_gamemode))
  }
  /** the local player's gamemode from start_game */
  function selfGameModeIndex () {
    return gameModeIndex(bot._bedrock?.startGame?.player_gamemode)
  }

  /** a known entity (the local player included) by runtime id */
  function entityByRuntime (runtimeId) {
    if (runtimeId === undefined || runtimeId === null) return undefined
    return bot.entities[Number(runtimeId)]
  }

  /** a known entity other than the local player by runtime id */
  function otherEntity (runtimeId) {
    if (isSelf(runtimeId)) return undefined
    return entityByRuntime(runtimeId)
  }

  /** a known entity (the local player included) by unique id */
  function entityByUnique (uniqueId) {
    if (uniqueId === undefined || uniqueId === null) return undefined
    if (isSelfUnique(uniqueId)) return bot.entity
    const id = ids()?.entityIdFromUnique(uniqueId)
    return id === undefined ? undefined : bot.entities[id]
  }

  function fetchEntity (runtimeId, uniqueId) {
    const id = Number(runtimeId)
    const entity = bot.entities[id] || (bot.entities[id] = new Entity(id))
    entity.isValid = true
    entity.runtimeId = BigInt(runtimeId)
    entity.uniqueId = toBigInt(uniqueId)
    ids()?.trackEntity(entity.runtimeId, entity.uniqueId)
    return entity
  }

  // upstream setEntityData, by Bedrock identifier
  function setEntityData (entity, identifier) {
    const name = String(identifier).replace(/^minecraft:/, '')
    const data = bot.registry.entitiesByName[name]
    if (data) {
      entity.type = data.type || 'object'
      entity.displayName = data.displayName
      entity.entityType = data.id
      entity.name = data.name
      entity.kind = data.category
      entity.height = data.height
      entity.width = data.width
    } else {
      // unknown entity (e.g. a behavior pack's custom entity)
      entity.type = 'other'
      entity.entityType = identifier
      entity.displayName = 'unknown'
      entity.name = 'unknown'
      entity.kind = 'unknown'
    }
  }

  /** wire y − feet y for move packets */
  function moveOffset (entity) {
    return entity.type === 'player' ? EYE_HEIGHT : (POSITION_OFFSETS[entity.name] ?? 0)
  }

  function setRotation (entity, yaw, pitch, headYaw) {
    if (yaw !== undefined) entity.yaw = conv.fromNotchianYaw(yaw)
    if (pitch !== undefined) entity.pitch = conv.fromNotchianPitch(pitch)
    if (headYaw !== undefined) entity.headYaw = conv.fromNotchianYaw(headYaw)
  }

  function setVelocity (entity, v) {
    if (v) entity.velocity.set(v.x, v.y, v.z)
  }

  /** add_entity attributes ({ name, min, value, max }) → entity.attributes like entity_data.applyAttributes (no event) */
  function applySpawnAttributes (entity, attributes) {
    if (!entity.attributes) entity.attributes = {}
    const keys = entityData.attributeKeys(bot.registry)
    for (const attr of attributes ?? []) {
      const key = keys.get(attr.name) ?? attr.name
      const value = attr.name === 'minecraft:health' ? attr.max : attr.value
      entity.attributes[key] = { value, modifiers: [], current: attr.value, min: attr.min, max: attr.max }
      if (attr.name === 'minecraft:health') entity.health = attr.value
    }
  }

  function mergeMetadata (entity, metadata) {
    if (!entity.metadata) entity.metadata = []
    for (const { key, value } of metadata ?? []) entity.metadata[key] = value
  }

  /**
   * Sleeping state in a metadata update, undefined when the update does not say: players from player_flags (bit 1;
   * BDS leaves flags_extended's sleeping bit clear for them), other entities from flags_extended.sleeping.
   */
  function sleepingFrom (entity, metadata) {
    for (const m of metadata ?? []) {
      if (entity.type === 'player' && m.key === 'player_flags') return (Number(m.value) & 2) !== 0
      if (entity.type !== 'player' && m.key === 'flags_extended' && m.value && typeof m.value === 'object') return !!m.value.sleeping
    }
    return undefined
  }

  /** spawn-time metadata: state only, no events (upstream parses spawn metadata silently too) */
  function applySpawnMetadata (entity, metadata) {
    mergeMetadata(entity, metadata)
    const flags = entity.metadata.flags
    if (flags && typeof flags === 'object') {
      entity.crouching = !!flags.sneaking
      entity.sprinting = !!flags.sprinting
      entity.swimming = !!flags.swimming
      entity.onFire = !!flags.onfire
      entity.elytraFlying = !!flags.gliding
    }
    const sleeping = sleepingFrom(entity, metadata)
    if (sleeping !== undefined) entity.sleeping = sleeping
    if (entity.crouching && entity.type === 'player') {
      entity.eyeHeight = SNEAK_EYE_HEIGHT
      entity.height = SNEAK_HEIGHT
    }
  }

  // upstream setElytraFlyingState
  function setElytraFlyingState (entity, elytraFlying) {
    let startedFlying = false
    if (elytraFlying) {
      startedFlying = !entity.elytraFlying
      entity.elytraFlying = true
    } else if (entity.elytraFlying) {
      entity.elytraFlying = false
    }
    if (startedFlying) bot.emit('entityElytraFlew', entity)
  }

  // set_entity_data of another entity: upstream's entity_metadata handler
  function applyMetadata (entity, metadata) {
    mergeMetadata(entity, metadata)
    bot.emit('entityUpdate', entity)

    const sleeping = sleepingFrom(entity, metadata)
    if (sleeping !== undefined) {
      if (sleeping && !entity.sleeping) bot.emit('entitySleep', entity)
      else if (!sleeping && entity.sleeping) bot.emit('entityWake', entity)
      entity.sleeping = sleeping
    }

    checkFirework(entity)

    const flags = metadata.find(m => m.key === 'flags')?.value
    if (flags && typeof flags === 'object') {
      setElytraFlyingState(entity, !!flags.gliding)
      if (flags.sneaking) {
        entity.crouching = true
        bot.emit('entityCrouch', entity)
      } else if (entity.crouching) { // prevent the initial metadata from firing off an uncrouch event
        entity.crouching = false
        bot.emit('entityUncrouch', entity)
      }
      entity.sprinting = !!flags.sprinting
      entity.swimming = !!flags.swimming
      entity.onFire = !!flags.onfire
    }
  }

  // ---- fireworks (upstream handleBotUsedFireworkRocket) ----

  function handleBotUsedFireworkRocket (fireworkEntityId, fireworkInfo) {
    if (knownFireworks.has(fireworkEntityId)) return
    knownFireworks.add(fireworkEntityId)
    let flightDur = fireworkInfo?.nbtData?.value?.Fireworks?.value?.Flight?.value ?? 1
    if (typeof flightDur !== 'number') { flightDur = 1 }
    const baseDuration = 10 * (flightDur + 1)
    const randomDuration = Math.floor(Math.random() * 6) + Math.floor(Math.random() * 7)
    bot.fireworkRocketDuration = baseDuration + randomDuration

    bot.emit('usedFirework', fireworkEntityId)
  }

  /**
   * A rocket boosting the local player: a fireworks_rocket whose owner / shooter is the bot while it glides
   * (Bedrock has no "attached to" metadata; the rocket's item NBT is the display item, metadata key 16).
   */
  function checkFirework (entity) {
    if (entity.name !== 'fireworks_rocket' || !bot.entity?.elytraFlying) return
    const md = entity.metadata ?? {}
    const self = ids()?.selfUniqueId()
    const selfRuntime = ids()?.selfRuntimeId()
    const owners = [md.owner_eid, md.firework_shooter_id, md.arrow_shooter_id]
    const mine = owners.some(v => v !== undefined && v !== null && (BigInt(v) === self || BigInt(v) === selfRuntime))
    if (mine) handleBotUsedFireworkRocket(entity.id, { nbtData: md.minecart_display_block })
  }

  // ---- vehicles (upstream attach_entity / set_passengers) ----

  function detach (passenger) {
    const vehicle = passenger.vehicle
    if (vehicle?.passengers) {
      const index = vehicle.passengers.indexOf(passenger)
      if (index !== -1) vehicle.passengers.splice(index, 1)
    }
    passenger.vehicle = null
    bot.emit('entityDetach', passenger, vehicle)
    if (passenger === bot.entity) {
      const original = bot.vehicle
      bot.vehicle = null
      bot.emit('dismount', original)
    }
  }

  function attach (passenger, vehicle) {
    if (passenger.vehicle === vehicle) return // repeated link
    if (passenger.vehicle) {
      const index = passenger.vehicle.passengers.indexOf(passenger)
      if (index !== -1) passenger.vehicle.passengers.splice(index, 1)
    }
    passenger.vehicle = vehicle
    vehicle.passengers.push(passenger)
    bot.emit('entityAttach', passenger, vehicle)
    if (passenger === bot.entity) {
      bot.vehicle = vehicle
      bot.emit('mount')
    }
  }

  function applyLink (link) {
    const passenger = entityByUnique(link.rider_entity_id)
    if (!passenger) return
    if (Number(link.type) === 0) {
      if (passenger.vehicle !== null && passenger.vehicle !== undefined) detach(passenger)
      return
    }
    const vehicle = entityByUnique(link.ridden_entity_id)
    if (vehicle) attach(passenger, vehicle)
  }

  // ---- spawning / despawning ----

  function spawned (entity, links) {
    bot.emit('entitySpawn', entity)
    for (const link of links ?? []) applyLink(link)
  }

  function removeEntity (entity) {
    bot.emit('entityGone', entity)
    entity.isValid = false
    if (entity.username && bot.players[entity.username]) {
      bot.players[entity.username].entity = null
    }
    delete bot.entities[entity.id]
    knownFireworks.delete(entity.id)
    if (hovered === entity.id) hovered = null
    const paintings = bot._bedrock?.world?.paintings
    const painting = paintings?.byId?.[entity.id]
    if (painting) paintings.remove(painting)
    // upstream's dismount-when-the-vehicle-is-gone (registered on bot._client there, so it never ran)
    if (bot.vehicle === entity) {
      bot.vehicle = null
      bot.emit('dismount', entity)
    }
    for (const passenger of entity.passengers ?? []) passenger.vehicle = null
    if (entity.vehicle?.passengers) {
      const index = entity.vehicle.passengers.indexOf(entity)
      if (index !== -1) entity.vehicle.passengers.splice(index, 1)
    }
  }

  function removeAllOthers () {
    for (const entity of Object.values(bot.entities)) {
      if (entity !== bot.entity) removeEntity(entity)
    }
    const selfRuntime = ids()?.selfRuntimeId()
    const selfUnique = ids()?.selfUniqueId()
    ids()?.runtimeToUnique.clear()
    ids()?.uniqueToRuntime.clear()
    if (selfRuntime !== null && selfRuntime !== undefined) ids()?.trackEntity(selfRuntime, selfUnique)
  }

  // ---- the local player (U4) ----

  bot._client.on('start_game', (packet) => {
    // reset on login, like upstream (silently); also the state that refers to the old entities
    const paintings = bot._bedrock?.world?.paintings
    for (const id of Object.keys(bot.entities)) {
      if (paintings?.byId?.[id]) paintings.remove(paintings.byId[id])
    }
    bot.players = {}
    bot.uuidToUsername = {}
    bot.entities = {}
    bot.player = undefined
    bot.vehicle = null
    hovered = null
    knownFireworks.clear()
    playerUniques.clear()
    ids()?.runtimeToUnique.clear()
    ids()?.uniqueToRuntime.clear()
    const entity = new Entity(Number(packet.runtime_entity_id))
    const username = ownUsername()
    bot.username = username
    entity.username = username
    entity.type = 'player'
    entity.name = 'player'
    entity.height = PLAYER_HEIGHT
    entity.width = PLAYER_WIDTH
    entity.eyeHeight = EYE_HEIGHT
    entity.uniqueId = BigInt(packet.entity_id)
    entity.runtimeId = BigInt(packet.runtime_entity_id)
    entity.position = conv.feetFromWire(packet.player_position)
    // start_game.rotation: x = pitch, z = yaw (degrees, notchian convention)
    entity.yaw = conv.fromNotchianYaw(packet.rotation?.z ?? 0)
    entity.pitch = conv.fromNotchianPitch(packet.rotation?.x ?? 0)
    entity.onGround = false
    entity.attributes = {}
    // live equipment view like upstream inventory.js (held, off-hand, armor) — Java slot layout of bot.inventory;
    // configurable so U8's inventory plugin can redefine it
    Object.defineProperty(entity, 'equipment', {
      configurable: true,
      enumerable: true,
      get () {
        const slots = bot.inventory?.slots
        if (!slots) return [undefined, undefined, undefined, undefined, undefined, undefined]
        return [bot.heldItem, slots[45], slots[8], slots[7], slots[6], slots[5]]
      }
    })
    installArmorAttributes(entity)
    bot.entity = entity
    bot.entities[entity.id] = entity
    ids()?.trackEntity(entity.runtimeId, entity.uniqueId)

    const records = pendingRecords
    pendingRecords = []
    handleRecords(records)
    if (!bot.player) addSelfPlayer() // no player_list record of our own (yet)
  })

  bot._client.on('update_attributes', (packet) => {
    if (isSelf(packet.runtime_entity_id)) return entityData.applyAttributes(bot, packet)
    const entity = otherEntity(packet.runtime_entity_id)
    if (!entity) return
    entityData.applyAttributes(bot, packet, entity)
    const health = packet.attributes?.find(a => a.name === 'minecraft:health')
    if (health) entity.health = health.current
  })
  bot._client.on('set_health', (packet) => {
    entityData.applyHealth(bot, packet) // set_health is only ever about the local player
  })
  bot._client.on('mob_effect', (packet) => {
    if (isSelf(packet.runtime_entity_id)) return entityData.applyEffect(bot, packet)
    const entity = otherEntity(packet.runtime_entity_id)
    if (entity) entityData.applyEffect(bot, packet, entity)
  })
  bot._client.on('set_entity_data', (packet) => {
    if (isSelf(packet.runtime_entity_id)) return entityData.applyMetadata(bot, packet)
    const entity = otherEntity(packet.runtime_entity_id)
    if (entity) applyMetadata(entity, packet.metadata ?? [])
  })
  bot._client.on('set_entity_motion', (packet) => {
    if (isSelf(packet.runtime_entity_id)) return entityData.applyMotion(bot, packet)
    const entity = otherEntity(packet.runtime_entity_id)
    if (entity) setVelocity(entity, packet.velocity)
  })

  bot.on('spawn', () => {
    bot.emit('entitySpawn', bot.entity)
  })

  // upstream: crouching changes the (player) hitbox — on Bedrock mobs such as foxes and cats use the same
  // sneaking flag, their registry hitbox stays
  bot.on('entityCrouch', (entity) => {
    if (entity.type !== 'player') return
    entity.eyeHeight = SNEAK_EYE_HEIGHT
    entity.height = SNEAK_HEIGHT
  })
  bot.on('entityUncrouch', (entity) => {
    if (entity.type !== 'player') return
    entity.eyeHeight = EYE_HEIGHT
    entity.height = PLAYER_HEIGHT
  })

  // ---- other entities ----

  bot._client.on('add_entity', (packet) => {
    if (isSelf(packet.runtime_id)) return
    const entity = fetchEntity(packet.runtime_id, packet.unique_id)
    setEntityData(entity, packet.entity_type)
    const p = packet.position
    entity.position.set(p.x, p.y - (POSITION_OFFSETS[entity.name] ?? 0), p.z)
    setRotation(entity, packet.yaw, packet.pitch, packet.head_yaw)
    setVelocity(entity, packet.velocity)
    applySpawnAttributes(entity, packet.attributes)
    applySpawnMetadata(entity, packet.metadata)
    if (entity.name === 'xp_orb' && entity.metadata.experience_value !== undefined) entity.count = entity.metadata.experience_value
    if (entity.attributes['minecraft:max_health']) installArmorAttributes(entity) // living entities
    spawned(entity, packet.links)
    checkFirework(entity)
  })

  bot._client.on('add_item_entity', (packet) => {
    if (isSelf(packet.runtime_entity_id)) return
    const entity = fetchEntity(packet.runtime_entity_id, packet.entity_id_self)
    setEntityData(entity, 'minecraft:item')
    const p = packet.position
    entity.position.set(p.x, p.y - POSITION_OFFSETS.item, p.z)
    setVelocity(entity, packet.velocity)
    applySpawnMetadata(entity, packet.metadata)
    entity.metadata.item = packet.item // the wire item, read by entity.getDroppedItem() (prismarine-entity patch)
    spawned(entity)
    bot.emit('itemDrop', entity)
  })

  bot._client.on('add_player', (packet) => {
    if (isSelf(packet.runtime_id)) return
    const entity = fetchEntity(packet.runtime_id, packet.unique_id)
    entity.type = 'player'
    entity.name = 'player'
    entity.username = bot.uuidToUsername[packet.uuid] ?? packet.username
    entity.uuid = packet.uuid
    const p = packet.position // feet level (move_player is eye level)
    entity.position.set(p.x, p.y, p.z)
    setRotation(entity, packet.yaw, packet.pitch, packet.head_yaw)
    setVelocity(entity, packet.velocity)
    entity.eyeHeight = EYE_HEIGHT
    entity.height = PLAYER_HEIGHT
    entity.width = PLAYER_WIDTH
    applySpawnMetadata(entity, packet.metadata)
    entity.setEquipment(0, fromNetwork(bot.registry, packet.held_item))
    installArmorAttributes(entity)
    const player = bot.players[entity.username]
    if (player !== undefined && !player.entity) player.entity = entity
    if (player && packet.gamemode !== undefined && packet.gamemode !== 'fallback') player.gamemode = gameModeIndex(packet.gamemode)
    spawned(entity, packet.links)
  })

  bot._client.on('add_painting', (packet) => {
    if (isSelf(packet.runtime_entity_id)) return
    const entity = fetchEntity(packet.runtime_entity_id, packet.entity_id_self)
    setEntityData(entity, 'minecraft:painting')
    const c = packet.coordinates
    entity.position.set(c.x, c.y, c.z)
    const painting = fromAddPainting(packet)
    bot._bedrock?.world?.paintings?.add(painting)
    spawned(entity)
  })

  bot._client.on('remove_entity', (packet) => {
    const uniqueId = BigInt(packet.entity_id_self)
    if (isSelfUnique(uniqueId)) return
    const id = ids()?.untrackEntity({ uniqueId })
    if (id === undefined) return
    const entity = bot.entities[id]
    if (entity && entity !== bot.entity) removeEntity(entity)
  })

  // the dimension's entities are gone after a dimension change (Java drops the whole client world)
  bot._bedrock?.lifecycle?.events?.on?.('dimensionChange', removeAllOthers)

  bot._client.on('move_entity', (packet) => {
    const entity = otherEntity(packet.runtime_entity_id)
    if (!entity) return
    const p = packet.position
    entity.position.set(p.x, p.y - moveOffset(entity), p.z)
    const r = packet.rotation
    if (r) setRotation(entity, r.yaw, r.pitch, r.head_yaw)
    entity.onGround = (Number(packet.flags) & 1) !== 0
    bot.emit('entityMoved', entity)
  })

  bot._client.on('move_entity_delta', (packet) => {
    const entity = otherEntity(packet.runtime_entity_id)
    if (!entity) return
    if (packet.x !== undefined) entity.position.x = packet.x
    if (packet.y !== undefined) entity.position.y = packet.y - moveOffset(entity)
    if (packet.z !== undefined) entity.position.z = packet.z
    if (packet.rot_x !== undefined) entity.pitch = conv.fromNotchianPitchByte(packet.rot_x)
    if (packet.rot_y !== undefined) entity.yaw = conv.fromNotchianYawByte(packet.rot_y)
    if (packet.rot_z !== undefined) entity.headYaw = conv.fromNotchianYawByte(packet.rot_z)
    if (packet.on_ground !== undefined) entity.onGround = !!packet.on_ground
    bot.emit('entityMoved', entity)
  })

  bot._client.on('move_player', (packet) => {
    const entity = otherEntity(packet.runtime_id)
    if (!entity) return
    const p = packet.position
    entity.position.set(p.x, p.y - moveOffset(entity), p.z)
    setRotation(entity, packet.yaw, packet.pitch, packet.head_yaw)
    entity.onGround = !!packet.on_ground
    bot.emit('entityMoved', entity)
  })

  bot._client.on('mob_equipment', (packet) => {
    const entity = otherEntity(packet.runtime_entity_id)
    if (!entity) return
    const window = packet.window_id
    let slot
    if (window === 'inventory' || window === 0) slot = 0
    else if (window === 'offhand' || window === 119) slot = 1
    else return
    entity.setEquipment(slot, fromNetwork(bot.registry, packet.item))
    bot.emit('entityEquip', entity)
  })

  bot._client.on('mob_armor_equipment', (packet) => {
    const entity = otherEntity(packet.runtime_entity_id)
    if (!entity) return
    for (const [field, slot] of Object.entries(ARMOR_SLOTS)) {
      if (packet[field] !== undefined) entity.setEquipment(slot, fromNetwork(bot.registry, packet[field]))
    }
    bot.emit('entityEquip', entity)
  })

  bot._client.on('animate', (packet) => {
    const entity = entityByRuntime(packet.runtime_entity_id)
    if (!entity) return
    const eventName = animateEvents[packet.action_id]
    if (!eventName) return
    if (entity === bot.entity && eventName === 'entitySwingArm') return // Java never echoes the bot's own swing
    if (eventName === 'entityWake') {
      if (entity.sleeping === false) return // already reported by the metadata
      entity.sleeping = false
    }
    bot.emit(eventName, entity)
  })

  bot._client.on('entity_event', (packet) => {
    const entity = entityByRuntime(packet.runtime_entity_id)
    if (!entity) return
    const eventName = entityEventEvents[packet.event_id]
    if (!eventName) return
    if (entity === bot.entity && eventName === 'entitySwingArm') return
    if (eventName === 'entityHurt') {
      // bedrock-protocol reads a batch's packets synchronously: the set lives until the batch is done
      hurtThisBatch.add(entity)
      batchEnd ??= setImmediate(() => { hurtThisBatch.clear(); batchEnd = null })
    }
    if (eventName === 'entityDead' && !hurtThisBatch.has(entity)) {
      // Java reports the killing blow (damage_event) before the death status; BDS sends death_animation only
      bot.emit('entityHurt', entity)
    }
    bot.emit(eventName, entity)
  })

  bot._client.on('set_entity_link', (packet) => {
    if (packet.link) applyLink(packet.link)
  })

  bot._client.on('take_item_entity', (packet) => {
    const collected = entityByRuntime(packet.runtime_entity_id)
    const collector = entityByRuntime(packet.target)
    if (!collected || !collector) return
    bot.emit('playerCollect', collector, collected)
  })

  // ---- players ----

  function isOwnRecord (record) {
    return record.username === ownUsername() || isSelfUnique(record.entity_unique_id)
  }

  function addSelfPlayer () {
    const uuid = bot._client.profile?.uuid
    if (!bot.entity || !bot.username) return
    const player = {
      username: bot.username,
      uuid,
      displayName: new ChatMessage({ text: '', extra: [{ text: bot.username }] }),
      gamemode: selfGameModeIndex(),
      ping: 0,
      skinData: undefined,
      entity: bot.entity
    }
    bot.players[player.username] = player
    if (uuid) bot.uuidToUsername[uuid] = player.username
    bot.player = player
    bot.entity.uuid = uuid
    bot.emit('playerJoined', player)
  }

  function addRecord (record) {
    if (!record.uuid) return // truncated last record (maybeIncompleteArray)
    const mine = isOwnRecord(record)
    let player = bot._playerFromUUID(record.uuid)
    if (!player && mine && bot.player) {
      // the bot's own record with another uuid than its login profile: keep the one player object
      player = bot.player
      if (player.uuid !== undefined) delete bot.uuidToUsername[player.uuid]
      player.uuid = record.uuid
      bot.uuidToUsername[player.uuid] = player.username
    }
    const newPlayer = !player
    if (newPlayer) {
      const username = mine ? bot.username : record.username
      if (!username) return
      player = { uuid: record.uuid, username }
    }
    player.displayName = new ChatMessage({ text: '', extra: [{ text: player.username }] })
    player.gamemode = player.gamemode ?? (mine ? selfGameModeIndex() : gameModeIndex())
    player.ping = player.ping ?? 0
    player.skinData = undefined // Bedrock skins are raw images (docs/differences/U7.md#skin-data)
    if (record.entity_unique_id !== undefined) playerUniques.set(BigInt(record.entity_unique_id), player.uuid)

    if (newPlayer) {
      bot.players[player.username] = player
      bot.uuidToUsername[player.uuid] = player.username
    }

    const playerEntity = mine ? bot.entity : Object.values(bot.entities).find(e => e.type === 'player' && e.username === player.username)
    player.entity = playerEntity
    if (playerEntity && playerEntity === bot.entity) {
      bot.player = player
      bot.entity.uuid = player.uuid
    }

    if (newPlayer) bot.emit('playerJoined', player)
    else bot.emit('playerUpdated', player)
  }

  function removeRecord (record) {
    const player = bot._playerFromUUID(record.uuid)
    if (!player || player.entity === bot.entity) return
    player.entity = null
    delete bot.players[player.username]
    delete bot.uuidToUsername[record.uuid]
    for (const [unique, uuid] of playerUniques) if (uuid === record.uuid) playerUniques.delete(unique)
    bot.emit('playerLeft', player)
  }

  function handleRecords (records) {
    for (const { record, type } of records) {
      if (type === 'add') addRecord(record)
      else if (type === 'remove') removeRecord(record)
    }
  }

  bot._client.on('player_list', (packet) => {
    const list = Array.isArray(packet.records) ? packet.records : (packet.records?.records ?? [])
    const records = list.map(record => ({ record, type: record.type ?? packet.records?.type }))
    if (!bot.entity) pendingRecords.push(...records)
    else handleRecords(records)
  })

  // gamemode changes of any player (/gamemode → update_player_game_type with the player's unique id)
  function onGameType (packet) {
    let player
    if (packet.player_unique_id === undefined || isSelfUnique(packet.player_unique_id)) player = bot.player
    else player = bot._playerFromUUID(playerUniques.get(BigInt(packet.player_unique_id)))
    if (!player) return
    player.gamemode = gameModeIndex(packet.gamemode)
    bot.emit('playerUpdated', player)
  }
  bot._client.on('update_player_game_type', onGameType)
  bot._client.on('set_player_game_type', onGameType)

  // ---- queries (upstream, verbatim) ----

  bot.findPlayer = bot.findPlayers = (filter) => {
    const filterFn = (entity) => {
      if (entity.type !== 'player') return false
      if (filter === null) return true
      if (typeof filter === 'object' && filter instanceof RegExp) {
        return entity.username.search(filter) !== -1
      } else if (typeof filter === 'function') {
        return filter(entity)
      } else if (typeof filter === 'string') {
        return entity.username.toLowerCase() === filter.toLowerCase()
      }
      return false
    }
    const resultSet = Object.values(bot.entities)
      .filter(filterFn)

    if (typeof filter === 'string') {
      switch (resultSet.length) {
        case 0:
          return null
        case 1:
          return resultSet[0]
        default:
          return resultSet
      }
    }
    return resultSet
  }

  bot._playerFromUUID = (uuid) => Object.values(bot.players).find(player => player.uuid === uuid)

  bot.nearestEntity = (match = (entity) => { return true }) => {
    let best = null
    let bestDistance = Number.MAX_VALUE

    for (const entity of Object.values(bot.entities)) {
      if (entity === bot.entity || !match(entity)) {
        continue
      }

      const dist = bot.entity.position.distanceSquared(entity.position)
      if (dist < bestDistance) {
        best = entity
        bestDistance = dist
      }
    }

    return best
  }

  // ---- actions ----

  bot.swingArm = swingArm
  bot.attack = attack
  bot.mount = mount
  bot.dismount = dismount
  bot.useOn = useOn
  bot.moveVehicle = stubSync('U5', 'bot.moveVehicle', 2) // vehicle input belongs to the physics plugin (input.setVehicle)

  function selfRuntimeId () {
    return ids()?.selfRuntimeId() ?? BigInt(bot.entity?.id ?? 0)
  }

  /** animate swing_arm; `source` is the vanilla client's swing source ('attack', 'interact') when it has one */
  function sendSwing (source) {
    const packet = { action_id: 'swing_arm', runtime_entity_id: selfRuntimeId(), data: 0, has_swing_source: !!source }
    if (source) packet.swing_source = source
    bot._client.queue('animate', packet)
  }

  /**
   * Bedrock has a single arm swing animation (no off-hand swing, no hidden hand): `arm` and `showHand` are
   * accepted for compatibility (docs/differences/U7.md#swing-arm).
   */
  function swingArm (arm = 'right', showHand = true) {
    sendSwing()
  }

  /** Center of the target's hitbox (absolute), where the bot looks and "clicks". */
  function aimPoint (target) {
    return target.position.offset(0, (target.height ?? 0) / 2, 0)
  }

  /** Face the target and hover it (interact mouse_over_entity) like the vanilla client before using it. */
  function aim (target) {
    if (bot.entity && typeof bot.lookAt === 'function' && !bot.lookAt.notImplemented) {
      bot.lookAt(aimPoint(target), true).catch(() => {})
    }
    if (hovered !== target.id) {
      hovered = target.id
      bot._client.queue('interact', buildMouseOver(bot, target, aimPoint(target)))
    }
  }

  /** item_use_on_entity transaction; the clicked position is relative to the target's feet */
  function useEntity (target, action) {
    aim(target)
    const clickPos = { x: 0, y: (target.height ?? 0) / 2, z: 0 }
    bot._client.queue('inventory_transaction', buildUseOnEntity(bot, target, { action, position: clickPos }))
  }

  function useOn (target) {
    useEntity(target, 'interact')
  }

  function attack (target, swing = true) {
    // the vanilla client swings, then sends the attack transaction
    if (swing) sendSwing('attack')
    useEntity(target, 'attack')
  }

  function mount (target) {
    useEntity(target, 'interact')
  }

  function dismount () {
    if (bot.vehicle) {
      const vehicle = bot.vehicle
      bot._client.queue('interact', {
        action_id: 'leave_vehicle',
        target_entity_id: vehicle.runtimeId ?? BigInt(vehicle.id),
        has_position: false
      })
    } else {
      bot.emit('error', new Error('dismount: not mounted'))
    }
  }
}

module.exports.POSITION_OFFSETS = POSITION_OFFSETS
module.exports.ARMOR_VALUES = ARMOR_VALUES
module.exports.armorTotals = armorTotals
