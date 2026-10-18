// owner: U7 (entities & players)
'use strict'
const { stubSync } = require('./errors')

/**
 * Paintings. Bedrock spawns paintings with `add_painting` (motive title, direction 0-3, position of
 * the painting's center block); mineflayer exposes them as `Painting(id, position, name, direction)`
 * (re-exported from mineflayer/lib/painting) tracked by the world (blocks.js keeps
 * paintingsByPos/paintingsById upstream).
 *
 * Contract:
 * - `fromAddPainting(packet) → Painting` (Bedrock motive → Java-style lowercase name; direction → Vec3 face)
 * - `MOTIVES` Bedrock motive title → mineflayer painting name
 */

const MOTIVES = {}

module.exports = {
  MOTIVES,
  fromAddPainting: stubSync('U7', 'paintings.fromAddPainting', 1)
}
