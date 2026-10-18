// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer master lib/plugins/abilities.js (not in 4.39.0; pinned copy in
//   docs/upstream/abilities.master.js, master SHA 7b4bb8d2b56be9cdb832474af873acd37e609746)
// Surface: bot.abilities { invulnerable, flying, mayFly, instantBuild, flyingSpeed, walkingSpeed }
//   (also mirrors bot.entity.flying / bot.entity.flyingSpeed for physics)
// Events: 'abilities' (abilities)
// Bedrock: update_abilities (ability layers: invulnerable, flying, may_fly, instabuild, fly_speed,
//   walk_speed), update_adventure_settings.
'use strict'

module.exports = inject

function inject (bot) {
  // Abilities' defaults, until the server says otherwise (same as upstream).
  bot.abilities = {
    invulnerable: false,
    flying: false,
    mayFly: false,
    instantBuild: false,
    flyingSpeed: 0.05,
    walkingSpeed: 0.1
  }
}
