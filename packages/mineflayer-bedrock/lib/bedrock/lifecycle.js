// owner: U4 (core runtime)
'use strict'
const { stubSync } = require('./errors')

/**
 * Player lifecycle, exposed as `bot._bedrock.lifecycle`.
 *
 * This module is the ONLY emitter of mineflayer's `spawn` event (`markSpawned()`), which happens:
 *   1. after join: play_status `player_spawn` + local player initialised (set_local_player_as_initialized)
 *      and the initial `respawn` with state 1 (ready_to_spawn) has been answered with state 2;
 *   2. after a respawn reaches "ready" (3-step respawn: server respawn state 0 searching →
 *      client respawn state 2 client_ready → server respawn state 1 ready), see U9;
 *   3. after a dimension change completes (change_dimension → chunks → dimension_change_ack +
 *      play_status player_spawn), see U9.
 * health.js (U9) must never emit `spawn` itself.
 *
 * Observed on BDS 1.26.51.1 at join (U0 spike, test/fixtures/1.26.51/join_flat.jsonl.gz):
 * start_game.player_position.y = 32769.62 (spawn search height), then respawn state 0 twice and
 * respawn state 1 with the real eye-level position, before play_status player_spawn.
 *
 * States: 'connecting' → 'loading' (start_game received) → 'spawned' ⇄ 'dead' / 'respawning' /
 *         'changing_dimension' → 'ended'.
 *
 * @typedef {object} Lifecycle
 * @property {string} state current state
 * @property {(reason: 'join'|'respawn'|'dimension') => void} markSpawned set state 'spawned' and emit `spawn`
 * @property {(state: string) => void} setState
 * @property {(state: string, opts?: { timeout?: number }) => Promise<void>} waitFor resolves when `state` is reached
 */

/** @returns {Lifecycle} */
function createLifecycle (bot) {
  return {
    state: 'connecting',
    markSpawned: stubSync('U4', 'bot._bedrock.lifecycle.markSpawned', 1),
    setState: stubSync('U4', 'bot._bedrock.lifecycle.setState', 1),
    waitFor: stubSync('U4', 'bot._bedrock.lifecycle.waitFor', 1)
  }
}

module.exports = { createLifecycle }
