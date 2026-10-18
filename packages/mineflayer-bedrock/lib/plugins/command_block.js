// owner: U9 (player state, world extras & dimensions)
// Adapted from mineflayer 4.39.0 lib/plugins/command_block.js (MIT, Copyright (c) 2013 Andrew Kelley): same checks,
//   option defaults and option names.
// Surface: bot.setCommandBlock(pos, command, options = {}) options { mode (0 sequence/chain, 1 auto/repeat,
//   2 redstone/impulse — default 2), trackOutput, conditional, alwaysActive }
// Bedrock: command_block_update { is_block: true, position, mode: 'chain' | 'repeat' | 'impulse',
//   needs_redstone: !alwaysActive, conditional, command, last_output, name, filtered_name, should_track_output,
//   tick_delay: 0, execute_on_first_tick: false }. BDS applies it to the block entity (the new `Command` comes back
//   as block_entity_data → 'blockEntityData') and prints no "Command set" message
//   (docs/differences/U9.md#command-block).
'use strict'
const assert = require('assert')

module.exports = inject

/** mineflayer (Java) command block modes → Bedrock */
const MODES = { 0: 'chain', 1: 'repeat', 2: 'impulse' }

function inject (bot) {
  function setCommandBlock (pos, command, options = {}) {
    // upstream: bot.player.gamemode === 1 (the self player_list entry); the same state here is bot.game.gameMode
    assert.strictEqual(bot.game?.gameMode, 'creative', new Error('The bot has to be in creative mode to open the command block window'))
    assert.notStrictEqual(pos, null)
    assert.notStrictEqual(command, null)
    assert.strictEqual(bot.blockAt(pos).name.includes('command_block'), true, new Error("The block isn't a command block"))

    // upstream tolerates a non-object (its test passes `false`): no options then
    if (options === null || typeof options !== 'object') options = {}

    // Default values when a command block is placed in vanilla minecraft
    options.trackOutput = options.trackOutput ?? false
    options.conditional = options.conditional ?? false
    options.alwaysActive = options.alwaysActive ?? false
    options.mode = options.mode ?? 2 // Possible values: 0: SEQUENCE, 1: AUTO and 2: REDSTONE

    bot._client.queue('command_block_update', {
      is_block: true,
      position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
      mode: MODES[options.mode] ?? 'impulse',
      needs_redstone: !options.alwaysActive,
      conditional: !!options.conditional,
      command,
      last_output: '',
      name: '',
      filtered_name: '',
      should_track_output: !!options.trackOutput,
      tick_delay: 0,
      execute_on_first_tick: false
    })
  }

  bot.setCommandBlock = setCommandBlock
}
