// owner: U4 (wave 2) → U9 (wave 3)
// Upstream: mineflayer 4.39.0 lib/plugins/game.js (MIT, Copyright (c) 2013 Andrew Kelley)
// Surface: bot.game { levelType, hardcore, gameMode, dimension, minY, height, difficulty,
//   maxPlayers, enableRespawnScreen?, serverViewDistance?, serverBrand }; Bedrock extra bot.bedrock.gameRules
// Events: 'login' (start_game), 'game' (start_game, gamemode changes, dimension changes, respawns).
// Bedrock:
// - start_game: level type, hardcore, game mode, dimension (+ minY/height from the fixed per-dimension table),
//   difficulty, game rules → 'login' then 'game'.
// - set_player_game_type / update_player_game_type (own unique id) → gameMode + 'game'.
// - set_difficulty → difficulty (upstream: no 'game' for a difficulty change either).
// - chunk_radius_update → serverViewDistance.
// - game rules: start_game.gamerules + game_rules_changed → bot.bedrock.gameRules (Bedrock names as sent, e.g.
//   `doDayLightCycle`; Java has no client-side game rule state, docs/differences/U9.md#game-rules).
// - dimension change (the lifecycle's 'dimensionChange', i.e. change_dimension): dimension/minY/height + 'game'
//   (upstream: 'game' on a respawn packet); a death respawn in the same dimension also emits 'game' (upstream: every
//   respawn packet), through the lifecycle's 'respawn' notification from health.js.
// - show_credits {status: 0} (leaving the End through the exit portal) → reply show_credits {status: 1 (end)}
//   at once, like upstream skipping the credits (Java game_state_change win_game → client_command): without it
//   BDS keeps the player in limbo and never sends the change_dimension to the overworld.
// Keep-alive: bedrock-protocol answers network_stack_latency itself (Java's ping/pong in upstream game.js).
'use strict'
const { DIFFICULTY_NAMES, DIMENSION_HEIGHTS, dimensionName, gameModeName } = require('../bedrock/constants')

module.exports = inject

/** start_game.generator → mineflayer levelType (Java names where one exists) */
const LEVEL_TYPES = { 0: 'legacy', 1: 'default', 2: 'flat', 3: 'nether', 4: 'the_end', 5: 'void' }

/** show_credits status values */
const CREDITS_START = 0
const CREDITS_END = 1

function inject (bot, options) {
  bot.game = {}
  if (bot.bedrock) bot.bedrock.gameRules = {}

  const ids = () => bot._bedrock?.ids

  function setDimension (dimension) {
    bot.game.dimension = dimensionName(dimension)
    const { minY, height } = DIMENSION_HEIGHTS[bot.game.dimension]
    bot.game.minY = minY
    bot.game.height = height
  }

  function applyGameRules (rules) {
    if (!bot.bedrock) return
    for (const rule of rules ?? []) {
      if (rule?.name !== undefined) bot.bedrock.gameRules[rule.name] = rule.value
    }
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
    if (bot.bedrock) bot.bedrock.gameRules = {}
    applyGameRules(packet.gamerules)
    const immediateRespawn = packet.gamerules?.find(rule => rule.name.toLowerCase() === 'doimmediaterespawn')
    if (!immediateRespawn?.value) bot.game.enableRespawnScreen = true
    // No brand plugin channel on Bedrock: the server identifier when the server sets one, else BDS = the
    // vanilla server (docs/differences/U4.md#server-brand)
    bot.game.serverBrand = packet.server_identifier || 'vanilla'
    bot.emit('login')
    bot.emit('game')
  })

  bot._client.on('game_rules_changed', (packet) => {
    applyGameRules(packet.rules)
  })

  // the server's answer to request_chunk_radius (bedrock-protocol at join, setSettings later)
  bot._client.on('chunk_radius_update', (packet) => {
    bot.game.serverViewDistance = packet.chunk_radius
  })

  function onGameMode (packet) {
    // set_player_game_type has no id (always the local player)
    if (packet.player_unique_id !== undefined && !ids()?.isSelfUnique(packet.player_unique_id)) return
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

  bot._client.on('show_credits', (packet) => {
    if (packet.status !== CREDITS_START) return
    if (packet.runtime_entity_id !== undefined && ids()?.isSelf && !ids().isSelf(packet.runtime_entity_id)) return
    bot._client.queue('show_credits', { runtime_entity_id: ids()?.selfRuntimeId() ?? packet.runtime_entity_id ?? 0n, status: CREDITS_END })
  })

  // The lifecycle's change_dimension step, before the new position is applied: the world reset is blocks.js', the
  // acks the lifecycle's; upstream emits 'game' on a respawn packet that changes the dimension.
  const events = bot._bedrock?.lifecycle?.events
  events?.on('dimensionChange', ({ dimension }) => {
    setDimension(dimension)
    bot.emit('game')
  })
  // a death respawn in the same dimension (health.js, right before the bot's 'respawn' event)
  events?.on('respawn', ({ dimensionChange } = {}) => {
    if (!dimensionChange) bot.emit('game')
  })
}
