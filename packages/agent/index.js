// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * @bedboo/agent — scripted (no LLM) survival agent for mineflayer-bedrock. See README.md.
 *
 *   const { Agent } = require('@bedboo/agent')
 *   const agent = await Agent.create({ host, port, username: 'Agent' })
 *   await agent.run('obtain', { item: 'iron_pickaxe' })
 */
const runner = require('./src/runner')

module.exports = {
  ...runner,
  planner: require('./src/planner'),
  blueprint: require('./src/blueprint'),
  knowledge: require('./src/knowledge'),
  data: require('./src/data'),
  world: require('./src/world'),
  inventory: require('./src/inventory'),
  errors: require('./src/errors'),
  skill: require('./src/skill')
}
