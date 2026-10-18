// owner: U6 (chat, commands & HUD)
// Upstream: mineflayer 4.39.0 lib/plugins/team.js (Team class: mineflayer/lib/team)
// Surface: bot.teams {name: Team}, bot.teamMap {member: Team}
// Events: 'teamCreated' / 'teamRemoved' / 'teamUpdated' / 'teamMemberAdded' / 'teamMemberRemoved' (team)
// Bedrock: there are NO teams in Bedrock Edition (no /team command, no team packet in protocol 2193). Both
//   properties stay empty objects forever and no team event is ever emitted (inherent difference,
//   docs/differences/U6.md#no-teams). ScoreBoard items' displayName still works (it falls back to the name when
//   the member has no team, like upstream).
'use strict'

module.exports = inject

function inject (bot) {
  bot.teams = {}
  bot.teamMap = {}
}
