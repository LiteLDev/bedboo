// owner: U6 (chat, commands & HUD)
// Upstream: mineflayer 4.39.0 lib/plugins/scoreboard.js (ScoreBoard class: mineflayer/lib/scoreboard)
// Surface: bot.scoreboards {name: ScoreBoard}, bot.scoreboard {list|sidebar|belowName: ScoreBoard}
// Events: 'scoreboardCreated' / 'scoreboardDeleted' / 'scoreboardTitleChanged' (scoreboard),
//   'scoreUpdated' / 'scoreRemoved' (scoreboard, item), 'scoreboardPosition' (position, scoreboard)
// Bedrock: set_display_objective {display_slot: list|sidebar|belowname, objective_name, display_name,
//   criteria_name, sort_order}, remove_objective, set_score {action: change|remove, entries}.
'use strict'

module.exports = inject

function inject (bot) {
  bot.scoreboards = {}
  // Same shape as upstream ScoreBoard.positions: numeric display slots + named getters.
  bot.scoreboard = {
    get list () { return this[0] },
    get sidebar () { return this[1] },
    get belowName () { return this[2] }
  }
}
