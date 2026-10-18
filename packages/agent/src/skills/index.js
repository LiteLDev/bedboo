// owner: U17 (agent core & overworld milestones); U18's skills are pre-registered here
'use strict'

/** Skill registry: name -> `async (bot, args) => result` (see ../skill.js). */
module.exports = {
  navigate: require('./navigate'),
  gather: require('./gather'),
  craft: require('./craft'),
  smelt: require('./smelt'),
  mine: require('./mine'),
  build: require('./build'),
  combat: require('./combat'),
  portal: require('./portal'),
  nether: require('./nether'),
  end: require('./end')
}
