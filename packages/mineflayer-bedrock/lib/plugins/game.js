// owner: U4 (wave 2) → U9 (wave 3)
// Upstream: mineflayer 4.39.0 lib/plugins/game.js
// Surface: bot.game { levelType, hardcore, gameMode, dimension, minY, height, difficulty,
//   maxPlayers, enableRespawnScreen?, serverViewDistance?, serverBrand }
// Events: 'login' (start_game), 'game' (start_game, gamemode/difficulty/dimension changes).
// Bedrock: start_game, set_player_game_type / update_player_game_type, set_difficulty,
//   chunk_radius_update, change_dimension (minimal, via the lifecycle's 'dimensionChange': dimension fields +
//   'game'; U9 owns the flow),
//   game_rules_changed (U9). No brand channel (see serverBrand below).
// Keep-alive: bedrock-protocol answers network_stack_latency itself (Java's ping/pong in upstream game.js).
'use strict'
const { DIFFICULTY_NAMES, DIMENSION_HEIGHTS, dimensionName, gameModeName } = require('../bedrock/constants')

module.exports = inject

/** start_game.generator → mineflayer levelType (Java names where one exists) */
const LEVEL_TYPES = { 0: 'legacy', 1: 'default', 2: 'flat', 3: 'nether', 4: 'the_end', 5: 'void' }

function inject (bot, options) {
  bot.game = {}

  function setDimension (dimension) {
    bot.game.dimension = dimensionName(dimension)
    const { minY, height } = DIMENSION_HEIGHTS[bot.game.dimension]
    bot.game.minY = minY
    bot.game.height = height
  }

  bot._client.on('start_game', (packet) => {
    bot.game.levelType = LEVEL_TYPES[packet.generator] ?? 'default'
    bot.game.hardcore = !!packet.hardcore
    bot.game.gameMode = gameModeName(packet.player_gamemode, packet.world_gamemode)
    setDimension(packet.dimension)
    bot.game.difficulty = DIFFICULTY_NAMES[packet.difficulty]
    // Bedrock never tells the client the player limit (no field in start_game; BDS does not answer
    // unconnected pings with enable-lan-visibility=false): docs/differences/U4.md#max-players
    bot.game.maxPlayers = undefined
    const immediateRespawn = packet.gamerules?.find(rule => rule.name.toLowerCase() === 'doimmediaterespawn')
    if (!immediateRespawn?.value) bot.game.enableRespawnScreen = true
    // No brand plugin channel on Bedrock: the server identifier when the server sets one, else BDS = the
    // vanilla server (docs/differences/U4.md#server-brand)
    bot.game.serverBrand = packet.server_identifier || 'vanilla'
    bot.emit('login')
    bot.emit('game')
  })

  // the server's answer to request_chunk_radius (bedrock-protocol at join, setSettings later)
  bot._client.on('chunk_radius_update', (packet) => {
    bot.game.serverViewDistance = packet.chunk_radius
  })

  function onGameMode (packet) {
    // set_player_game_type has no id (always the local player)
    if (packet.player_unique_id !== undefined && !bot._bedrock?.ids?.isSelfUnique(packet.player_unique_id)) return
    bot.game.gameMode = gameModeName(packet.gamemode, bot._bedrock?.startGame?.world_gamemode)
    bot.emit('game')
  }
  // `/gamemode` sends update_player_game_type (with the player's unique id); set_player_game_type is the
  // older/self-only form
  bot._client.on('update_player_game_type', onGameMode)
  bot._client.on('set_player_game_type', onGameMode)

  bot._client.on('set_difficulty', (packet) => {
    bot.game.difficulty = DIFFICULTY_NAMES[packet.difficulty]
  })

  // Minimal dimension switch (U9 owns the full flow) on the lifecycle's change_dimension step, before the new
  // position is applied: the world reset is blocks.js', the acks the lifecycle's; upstream emits 'game' on a
  // respawn packet that changes the dimension.
  bot._bedrock?.lifecycle?.events?.on('dimensionChange', ({ dimension }) => {
    setDimension(dimension)
    bot.emit('game')
  })
}
