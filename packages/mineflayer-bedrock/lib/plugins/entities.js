// owner: U4 (wave 2, local player only) → U7 (wave 3, all other entities & players)
// Upstream: mineflayer 4.39.0 lib/plugins/entities.js
// Surface: bot.entity (local player Entity, created on start_game by U4), bot.username,
//   bot.entities {id: Entity}, bot.players {username: Player}, bot.player, bot.uuidToUsername,
//   bot.vehicle, bot.fireworkRocketDuration, bot.findPlayer(s)(filter), bot.nearestEntity(match),
//   bot._playerFromUUID(uuid), bot.swingArm(hand, showHand), bot.attack(entity, swing = true),
//   bot.mount(entity), bot.dismount(), bot.useOn(entity), bot.moveVehicle(left, forward)
// Events: entitySpawn/Gone/Moved/Update/Hurt/Dead/SwingArm/Equip/Sleep/Wake/Eat/Crouch/Uncrouch/
//   Attributes/Effect/EffectEnd/Attach/Detach/ElytraFlew/Taming/Tamed/ShakingOffWater/EatingGrass/
//   HandSwap/CriticalEffect/MagicCriticalEffect, playerJoined/Updated/Left, itemDrop, playerCollect,
//   mount, dismount, usedFirework
// Bedrock: add_player/add_entity/add_item_entity/add_painting, remove_entity (unique id),
//   move_entity(_delta), set_entity_data, update_attributes, mob_effect, mob_equipment,
//   mob_armor_equipment, animate, entity_event, player_list, set_entity_link, take_item_entity.
//
// U4 (wave 2) — the local player only:
// - start_game → bot.entity = prismarine-entity Entity(Number(runtime_entity_id)): type/name 'player',
//   username, uuid, uniqueId (BigInt start_game.entity_id), height 1.8, width 0.6, eyeHeight 1.62, FEET
//   position (wire eye level − 1.62), yaw/pitch (radians) from start_game.rotation; bot.entities[id] = bot.entity;
//   bot.username = the client's username (offline: options.username, online: the Xbox gamertag).
//   Like upstream, players/uuidToUsername/entities are reset on login.
// - player_list (self record, matched by username / unique id) → bot.players[username] = bot.player
//   { username, uuid, displayName (ChatMessage), gamemode, ping: 0, entity: bot.entity, skinData: undefined }
//   and bot.uuidToUsername[uuid]. U7 adds every other player (and playerJoined/Left).
// - own update_attributes / set_health / mob_effect / set_entity_data / set_entity_motion →
//   lib/bedrock/entity_data.js (attributes, effects, metadata flags, velocity, + the entity events).
// - 'spawn' → entitySpawn(bot.entity) (upstream does the same).
// U7: handle all other runtime ids and skip `bot._bedrock.startGame.runtime_entity_id` in these packets.
'use strict'
const { stubSync } = require('../bedrock/errors')
const conv = require('../bedrock/conversions')
const entityData = require('../bedrock/entity_data')
const { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH, gameModeName } = require('../bedrock/constants')

module.exports = inject

function inject (bot) {
  const Entity = require('prismarine-entity')(bot.registry)
  const ChatMessage = require('prismarine-chat')(bot.registry)

  bot.players = {}
  bot.uuidToUsername = {}
  bot.entities = {}
  bot.vehicle = null
  bot.fireworkRocketDuration = 0

  let selfRecord = null // the player_list record of the local player (arrives before start_game)

  const isSelf = (runtimeId) => !!bot._bedrock?.ids?.isSelf(runtimeId)

  function ownUsername () {
    return bot._client.username ?? bot._client.profile?.name ?? bot._client.options?.username
  }

  function linkPlayer () {
    if (!bot.entity) return
    const username = bot.username
    const record = selfRecord
    const uuid = record?.uuid ?? bot._client.profile?.uuid
    const player = bot.players[username] ?? { username }
    player.username = username
    player.uuid = uuid
    player.displayName = new ChatMessage({ text: '', extra: [{ text: username }] })
    player.gamemode = player.gamemode ?? (bot._bedrock?.startGame ? gameModeIndex(bot._bedrock.startGame) : undefined)
    player.ping = player.ping ?? 0
    player.skinData = undefined // Bedrock skins are raw images in player_list (docs/differences/U4.md#self-player)
    player.entity = bot.entity
    bot.players[username] = player
    if (uuid) bot.uuidToUsername[uuid] = username
    bot.player = player
    bot.entity.uuid = uuid
  }

  function gameModeIndex (startGame) {
    return ['survival', 'creative', 'adventure', 'spectator'].indexOf(gameModeName(startGame.player_gamemode, startGame.world_gamemode))
  }

  bot._client.on('start_game', (packet) => {
    // reset on login, like upstream
    bot.players = {}
    bot.uuidToUsername = {}
    bot.entities = {}
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
    bot.entity = entity
    bot.entities[entity.id] = entity
    linkPlayer()
  })

  bot._client.on('player_list', (packet) => {
    const records = Array.isArray(packet.records) ? packet.records : (packet.records?.records ?? [])
    for (const record of records) {
      if (record.type !== 'add' && packet.records?.type !== 'add') continue
      const mine = record.username === ownUsername() || !!bot._bedrock?.ids?.isSelfUnique(record.entity_unique_id)
      if (!mine) continue
      selfRecord = record
      linkPlayer()
    }
  })

  bot._client.on('update_attributes', (packet) => {
    if (isSelf(packet.runtime_entity_id)) entityData.applyAttributes(bot, packet)
  })
  bot._client.on('set_health', (packet) => {
    entityData.applyHealth(bot, packet) // set_health is only ever about the local player
  })
  bot._client.on('mob_effect', (packet) => {
    if (isSelf(packet.runtime_entity_id)) entityData.applyEffect(bot, packet)
  })
  bot._client.on('set_entity_data', (packet) => {
    if (isSelf(packet.runtime_entity_id)) entityData.applyMetadata(bot, packet)
  })
  bot._client.on('set_entity_motion', (packet) => {
    if (isSelf(packet.runtime_entity_id)) entityData.applyMotion(bot, packet)
  })

  bot.on('spawn', () => {
    bot.emit('entitySpawn', bot.entity)
  })

  bot.findPlayers = stubSync('U7', 'bot.findPlayers', 1)
  bot.findPlayer = bot.findPlayers
  bot._playerFromUUID = stubSync('U7', 'bot._playerFromUUID', 1)
  bot.nearestEntity = stubSync('U7', 'bot.nearestEntity', 0)
  bot.swingArm = stubSync('U7', 'bot.swingArm', 0)
  bot.attack = stubSync('U7', 'bot.attack', 1)
  bot.mount = stubSync('U7', 'bot.mount', 1)
  bot.dismount = stubSync('U7', 'bot.dismount', 0)
  bot.useOn = stubSync('U7', 'bot.useOn', 1)
  bot.moveVehicle = stubSync('U7', 'bot.moveVehicle', 2)
}
