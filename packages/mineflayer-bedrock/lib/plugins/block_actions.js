// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/block_actions.js
// Surface: none (events only)
// Events: 'noteHeard' (block, instrument, pitch), 'pistonMove' (block, isPulling, direction),
//   'chestLidMove' (block, isOpen, block2), 'blockBreakProgressObserved' (block, destroyStage, entity),
//   'blockBreakProgressEnd' (block, entity)
// Bedrock: block_event (chest lid / note block), level_sound_event note, level_event
//   block_start_break / block_update_break / block_stop_break (break progress), piston arm
//   block entity data.
'use strict'

module.exports = inject

function inject (bot) {}
