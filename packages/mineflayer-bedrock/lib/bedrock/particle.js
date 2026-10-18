// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * `Particle` adapted to Bedrock (export `Particle` of mineflayer-bedrock, used by the particle plugin).
 *
 * Same loader shape and constructor as mineflayer 4.39.0 lib/particle.js — `require('mineflayer-bedrock').Particle
 * (registry)` → class `Particle(id, position, offset, count = 1, movementSpeed = 0, longDistanceRender = false)`,
 * which copies `registry.particles[id] || registry.particlesByName[id]` (`{ id, name }`) onto the instance — and
 * `instanceof` the upstream class. Differences (docs/differences/U6.md#particles):
 *   - `fromNetwork(packet)` reads Bedrock packets:
 *       `spawn_particle_effect { position, particle_name, … }` (what `/particle` and scripts send): `id` is the
 *       particle effect identifier ('minecraft:heart_particle'), resolved through the registry when it is a
 *       particle type name ('heart' → `{ id: 19, name: 'heart' }`);
 *       `level_event { event: 'add_particle_<name>' | 0x4000 | type, position, data }` (particles the server
 *       spawns itself): `id` = the Bedrock particle type id from `registry.particles` (or the particle name when
 *       the registry does not list it, e.g. 9815 add_particle_smash_attack_ground_dust);
 *   - Bedrock sends no offset / count / speed / long-distance flag: `offset` is (0, 0, 0), `count` 1,
 *     `movementSpeed` 0, `longDistanceRender` false;
 *   - a particle effect that is not in the registry keeps its identifier as `name` too.
 */
const { Vec3 } = require('vec3')

const PARTICLE_EVENT_FLAG = 0x4000

module.exports = loader

function loader (registry) {
  const UpstreamParticle = require('mineflayer/lib/particle')(registry)

  class Particle extends UpstreamParticle {
    constructor (id, position, offset, count = 1, movementSpeed = 0, longDistanceRender = false) {
      super(id, position, offset, count, movementSpeed, longDistanceRender)
      if (this.name === undefined && typeof id === 'string') this.name = id
    }

    /**
     * @param {object} packet bedrock-protocol `spawn_particle_effect` or `level_event` params
     * @returns {Particle|null} null for a level_event that is not a particle
     */
    static fromNetwork (packet) {
      const position = new Vec3(packet.position?.x ?? 0, packet.position?.y ?? 0, packet.position?.z ?? 0)
      if (packet.particle_name !== undefined) {
        return new Particle(packet.particle_name, position, new Vec3(0, 0, 0))
      }
      const id = particleType(registry, packet.event)
      if (id === null) return null
      return new Particle(id, position, new Vec3(0, 0, 0))
    }
  }

  return Particle
}

/**
 * Bedrock particle type of a level_event: `add_particle_<name>` → the registry id (or the name for the particle
 * events outside the 0x4000 range, e.g. 9815 add_particle_smash_attack_ground_dust), the raw number 0x4000 | type
 * when bedrock-protocol does not name it → type; null for any other level event.
 */
function particleType (registry, event) {
  if (typeof event === 'number') {
    return (event & PARTICLE_EVENT_FLAG) && (event & ~PARTICLE_EVENT_FLAG) > 0 ? event & ~PARTICLE_EVENT_FLAG : null
  }
  const m = /^add_particle_(.+)$/.exec(String(event))
  if (!m || m[1] === 'mask') return null
  return registry.particlesByName?.[m[1]]?.id ?? m[1]
}
