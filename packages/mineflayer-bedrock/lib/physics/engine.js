// owner: U5 (physics & movement)
// Bedrock Edition player physics.
// Forked from prismarine-physics 1.11.1 index.js (MIT, Copyright (c) 2020 PrismarineJS,
// https://github.com/PrismarineJS/prismarine-physics) and made Bedrock-correct. The module shape is the
// upstream one — `Physics(registry, world)` returns an object with the upstream field names, `simulatePlayer`
// and `adjustPositionHeight`; `PlayerState(bot, control)` has the upstream fields — because
// mineflayer-pathfinder builds prismarine-physics `PlayerState`s itself and runs them through
// `bot.physics.simulatePlayer(state, world)`: the engine only reads the upstream PlayerState fields (Bedrock-only
// inputs are optional extras with defaults) and never relies on the class.
//
// Bedrock deltas vs. the Java engine — measured against BDS 1.26.51.1 with recorded player_auth_input traces and the
// server's correct_player_move_prediction states (docs/differences/U5.md#engine, test/fixtures/physics/):
// - float32 positions/velocities; the yaw is the float32 degrees of the wire x float32(pi/180), precise sin/cos;
// - update order: speed + friction from the PREVIOUS tick's onGround (block at floor(pos - 0.5), else the block
//   supporting the box, else friction 0.6, never air's 0.9) -> moveRelative (move vector, normalized, +-0.3 while
//   sneaking, x 0.98) -> jump (vy = max(vy, 0.42 + 0.1 x jump boost), sprint-jump +0.2 in the facing direction,
//   10-tick delay while held) -> climb -> cobweb -> sneak edge avoidance -> collide (Y, X, Z; auto-step 0.5625) ->
//   step-on slowdown / landing bounce -> gravity + drag -> friction;
// - the reported `delta` (player_auth_input) is the velocity at the end of the tick;
// - sneak edge avoidance shrinks the box by 0.025, probes 1.01 x step height down and clips the velocity itself;
//   the sneaking box is 1.49 high;
// - climbing: vy >= -0.2; jump climbs 0.2 (then gravity), a horizontal collision sets 0.2 as the end velocity; no
//   horizontal clamp, sneaking holds;
// - cobweb x0.25/x0.05/x0.25 before the move, velocity reset after it; powder snow / berry bushes likewise (Java
//   factors); soul sand: ground speed x 0.544; honey and slime: "step on" x (0.4 + |vy| x 0.2), honey jump x 0.6;
//   slime bounce from the air; bed bounce;
// - water gravity 0.005 (drag 0.8), lava 0.02 (drag 0.5), bubble columns per block (Java values);
// - slow falling only while falling (vy < 0);
// - creative flight: see moveFlying; elytra: the Java formula (matches BDS).
'use strict'
const { Vec3 } = require('vec3')
const AABB = require('./aabb')
const attribute = require('./attribute')
const { f32, sin, cos, clamp } = require('./math')
const { moveVector } = require('./input')
const { SNEAK_HEIGHT } = require('../bedrock/constants')

/**
 * Upstream prismarine-physics field names (31) with their Bedrock values. `bot.physics` exposes exactly these
 * (plus simulatePlayer / adjustPositionHeight), like mineflayer.
 */
function defaultPhysicsFields () {
  return {
    gravity: 0.08,
    airdrag: f32(1 - 0.02),
    yawSpeed: 3.0,
    pitchSpeed: 3.0,
    playerSpeed: 0.1,
    sprintSpeed: 0.3,
    sneakSpeed: 0.3,
    stepHeight: 0.5625, // Bedrock: 9/16 (Java 0.6)
    negligeableVelocity: 1e-6, // Bedrock: the velocity is zeroed only when |v|² < 1e-12 (Java: per axis < 0.003)
    soulsandSpeed: 0.544, // Bedrock: ground movement speed factor (Java: velocity × 0.4)
    honeyblockSpeed: 0.4, // Bedrock: base of the slime/honey "step on" slowdown (0.4 + |vy| × 0.2)
    honeyblockJumpSpeed: 0.6, // Bedrock: jump velocity factor on honey (measured; Java 0.5)
    ladderMaxSpeed: 0.2, // Bedrock: fall speed clamp on climbables (Java 0.15, also horizontal)
    ladderClimbSpeed: 0.2,
    playerHalfWidth: 0.3,
    playerHeight: 1.8,
    waterInertia: 0.8,
    lavaInertia: 0.5,
    liquidAcceleration: 0.02,
    airborneInertia: 0.91,
    airborneAcceleration: 0.02,
    defaultSlipperiness: 0.6,
    outOfLiquidImpulse: 0.3,
    autojumpCooldown: 10,
    bubbleColumnSurfaceDrag: { down: 0.03, maxDown: -0.9, up: 0.1, maxUp: 1.8 },
    bubbleColumnDrag: { down: 0.03, maxDown: -0.3, up: 0.06, maxUp: 0.7 },
    slowFalling: 0.125, // gravity multiplier (0.01 / 0.08)
    movementSpeedAttribute: 'minecraft:movement_speed',
    sprintingUUID: 'd208fc00-42aa-4aad-9276-d5446530de43', // Bedrock "Sprinting speed boost" modifier (update_attributes)
    waterGravity: 0.005, // gravity / 16
    lavaGravity: 0.02
  }
}

/** Bedrock-only constants of the engine (not on bot.physics, which keeps the upstream shape). */
const BEDROCK = Object.freeze({
  jumpVelocity: f32(0.42),
  jumpBoostPerLevel: f32(0.1),
  sprintJumpBoost: f32(0.2),
  airSprintAcceleration: f32(0.026),
  groundAccelerationFactor: f32(0.16277136),
  sprintMultiplier: f32(1.3),
  usingItemImpulse: f32(0.1225),
  sneakHeight: SNEAK_HEIGHT, // 1.49 (BDS)
  impulseScale: f32(0.98),
  sneakEdgeMargin: 0.025,
  sneakEdgeStep: 0.05,
  bedBounce: f32(0.66),
  slimeBounceMin: 1e-4,
  levitationPerLevel: f32(0.05),
  cobweb: { x: 0.25, y: 0.05, z: 0.25 },
  powderSnow: { x: 0.9, y: 1.5, z: 0.9 },
  sweetBerryBush: { x: 0.8, y: 0.75, z: 0.8 },
  flyAscendFactor: 3, // vertical fly acceleration: + 3 × flySpeed per tick of jump
  flyDescendFactor: 4.4, // − 4.4 × flySpeed per tick of sneak
  flyVerticalDrag: f32(0.6),
  flyStopDamping: f32(0.375), // extra damping of every axis on a tick without movement input
  defaultFlySpeed: 0.05,
  waterJump: f32(0.04),
  waterFlow: f32(0.014)
})

const DEG_TO_RAD = f32(Math.PI / 180)

/** mineflayer yaw (radians) → the Bedrock yaw the server uses: float32 degrees on the wire × float32(π/180) */
function wireYawRadians (yaw) {
  return f32(f32((Math.PI - yaw) * 180 / Math.PI) * DEG_TO_RAD)
}

function Physics (registry, world) {
  const blocksByName = registry.blocksByName
  const idOf = (name) => blocksByName[name]?.id ?? -1
  const idSet = (...names) => new Set(names.map(idOf).filter((id) => id >= 0))

  // per-block friction (U2 data: Bedrock `friction`, 0.6 default; ice 0.98, blue ice 0.989, slime 0.8, …)
  const blockFriction = []
  for (const block of registry.blocksArray ?? Object.values(registry.blocks ?? {})) {
    blockFriction[block.id] = typeof block.friction === 'number' ? block.friction : 0.6
  }

  const slimeId = idOf('slime')
  const soulsandId = idOf('soul_sand')
  const honeyblockId = idOf('honey_block')
  const webId = idOf('web')
  const powderSnowId = idOf('powder_snow')
  const sweetBerryId = idOf('sweet_berry_bush')
  const bedId = idOf('bed')
  const bubbleColumnId = idOf('bubble_column')
  const waterIds = idSet('water', 'flowing_water')
  const lavaIds = idSet('lava', 'flowing_lava')
  const climbableIds = idSet('ladder', 'vine', 'twisting_vines', 'weeping_vines', 'cave_vines',
    'cave_vines_body_with_berries', 'cave_vines_head_with_berries')
  // blocks that are always water-filled (rendered depth 0)
  const waterLike = idSet('seagrass', 'kelp', 'bubble_column')

  const physics = defaultPhysicsFields()

  // box height of the player being simulated (Bedrock: 1.49 while sneaking, measured on BDS)
  let boxHeight = physics.playerHeight

  function getPlayerBB (pos) {
    const w = physics.playerHalfWidth
    return new AABB(-w, 0, -w, w, boxHeight, w).offset(pos.x, pos.y, pos.z)
  }

  function setPositionToBB (bb, pos) {
    pos.x = f32(bb.minX + physics.playerHalfWidth)
    pos.y = f32(bb.minY)
    pos.z = f32(bb.minZ + physics.playerHalfWidth)
  }

  function getSurroundingBBs (world, queryBB) {
    const surroundingBBs = []
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(queryBB.minY) - 1; cursor.y <= Math.floor(queryBB.maxY); cursor.y++) {
      for (cursor.z = Math.floor(queryBB.minZ); cursor.z <= Math.floor(queryBB.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(queryBB.minX); cursor.x <= Math.floor(queryBB.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          const shapes = collisionShapes(block)
          if (shapes) {
            const blockPos = block.position ?? cursor
            for (const shape of shapes) {
              const blockBB = new AABB(shape[0], shape[1], shape[2], shape[3], shape[4], shape[5])
              blockBB.offset(blockPos.x, blockPos.y, blockPos.z)
              surroundingBBs.push(blockBB)
            }
          }
        }
      }
    }
    return surroundingBBs
  }

  function collisionShapes (block) {
    return block ? block.shapes : null
  }

  function noCollision (world, bb) {
    for (const blockBB of getSurroundingBBs(world, bb)) {
      if (blockBB.intersects(bb)) return false
    }
    return true
  }

  physics.adjustPositionHeight = (pos) => {
    boxHeight = physics.playerHeight
    const playerBB = getPlayerBB(pos)
    const queryBB = playerBB.clone().extend(0, -1, 0)
    const surroundingBBs = getSurroundingBBs(world, queryBB)

    let dy = -1
    for (const blockBB of surroundingBBs) {
      dy = blockBB.computeOffsetY(playerBB, dy)
    }
    pos.y += dy
  }

  /** blocks overlapping `bb` (cursor positions), calling fn(block, x, y, z) */
  function forEachBlockIn (world, bb, fn) {
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(bb.minY); cursor.y <= Math.floor(bb.maxY); cursor.y++) {
      for (cursor.z = Math.floor(bb.minZ); cursor.z <= Math.floor(bb.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(bb.minX); cursor.x <= Math.floor(bb.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block && fn(block, cursor) === true) return true
        }
      }
    }
    return false
  }

  /** Sneak edge avoidance (Bedrock: box shrunk by 0.025 on x/z, probing 1.01 × step height below). */
  function avoidEdge (world, pos, dx, dz) {
    const step = BEDROCK.sneakEdgeStep
    const probeY = -physics.stepHeight * 1.01
    const bb = getPlayerBB(pos).contract(BEDROCK.sneakEdgeMargin, 0, BEDROCK.sneakEdgeMargin)
    const unsupported = (x, z) => noCollision(world, bb.clone().offset(x, probeY, z))
    const reduce = (v) => (v < step && v >= -step) ? 0 : (v > 0 ? v - step : v + step)
    while (dx !== 0 && unsupported(dx, 0)) dx = reduce(dx)
    while (dz !== 0 && unsupported(0, dz)) dz = reduce(dz)
    while (dx !== 0 && dz !== 0 && unsupported(dx, dz)) {
      dx = reduce(dx)
      dz = reduce(dz)
    }
    return [dx, dz]
  }

  /**
   * Collide the player box with the world and move it (Y, then X, then Z), with Bedrock's auto-step.
   * Updates pos and the collision flags; returns the applied movement.
   */
  function moveEntity (entity, world, dx, dy, dz) {
    const pos = entity.pos
    const wasOnGround = entity.onGround

    if (entity.control.sneak && entity.onGround && dy <= 0 && !entity.flying) {
      const [ax, az] = avoidEdge(world, pos, dx, dz)
      // Bedrock clips the velocity itself (measured: the reported delta is 0 along a held edge)
      if (ax !== dx) entity.vel.x = dx = ax
      if (az !== dz) entity.vel.z = dz = az
    }

    const oldVelX = dx
    const oldVelY = dy
    const oldVelZ = dz

    let playerBB = getPlayerBB(pos)
    const queryBB = playerBB.clone().extend(dx, dy, dz)
    const surroundingBBs = getSurroundingBBs(world, queryBB)
    const oldBB = playerBB.clone()

    for (const blockBB of surroundingBBs) dy = blockBB.computeOffsetY(playerBB, dy)
    playerBB.offset(0, dy, 0)
    for (const blockBB of surroundingBBs) dx = blockBB.computeOffsetX(playerBB, dx)
    playerBB.offset(dx, 0, 0)
    for (const blockBB of surroundingBBs) dz = blockBB.computeOffsetZ(playerBB, dz)
    playerBB.offset(0, 0, dz)

    // Auto-step (Bedrock: 0.5625): up (collided), X, Z, then down by the same amount
    const groundedForStep = wasOnGround || (dy !== oldVelY && oldVelY < 0)
    if (physics.stepHeight > 0 && groundedForStep && (dx !== oldVelX || dz !== oldVelZ)) {
      const stepBBs = getSurroundingBBs(world, oldBB.clone().extend(oldVelX, physics.stepHeight, oldVelZ))
      const bb = oldBB.clone()
      let sdy = physics.stepHeight
      for (const blockBB of stepBBs) sdy = blockBB.computeOffsetY(bb, sdy)
      bb.offset(0, sdy, 0)
      let sdx = oldVelX
      for (const blockBB of stepBBs) sdx = blockBB.computeOffsetX(bb, sdx)
      bb.offset(sdx, 0, 0)
      let sdz = oldVelZ
      for (const blockBB of stepBBs) sdz = blockBB.computeOffsetZ(bb, sdz)
      bb.offset(0, 0, sdz)
      let down = -sdy
      for (const blockBB of stepBBs) down = blockBB.computeOffsetY(bb, down)
      bb.offset(0, down, 0)
      if (sdx * sdx + sdz * sdz > dx * dx + dz * dz) {
        dx = sdx
        dy = sdy + down
        dz = sdz
        playerBB = bb
      }
    }

    setPositionToBB(playerBB, pos)
    entity.isCollidedHorizontally = dx !== oldVelX || dz !== oldVelZ
    entity.isCollidedVertically = dy !== oldVelY
    entity.onGround = (entity.isCollidedVertically && oldVelY < 0) ||
      (wasOnGround && !entity.isCollidedVertically && Math.abs(oldVelY) <= 1e-5 && restsOnSomething(world, playerBB))
    return { dx, dy, dz, oldVelX, oldVelY, oldVelZ, wasOnGround }
  }

  /**
   * (U10 fix) A box without vertical velocity keeps onGround only while something is right below it: a teleport
   * reports the on_ground of the old position, and without gravity (upstream's creative.startFlying) nothing else
   * would ever clear it.
   */
  function restsOnSomething (world, bb) {
    const probe = -1e-3
    let dy = probe
    for (const blockBB of getSurroundingBBs(world, bb.clone().extend(0, probe, 0))) dy = blockBB.computeOffsetY(bb, dy)
    return dy !== probe
  }

  /**
   * Velocity after the collision. Walking on slime or honey (Bedrock "step on", measured on BDS for honey) slows
   * vx/vz × (0.4 + |vy| × 0.2), vy being the velocity of the move (−0.0784 when walking: × 0.41568; landing: × 0.4);
   * then blocked axes stop and landing (from the air) bounces on slime or a bed (−0.66 vy, at most 1) unless sneaking.
   */
  function postCollision (entity, world, move) {
    const vel = entity.vel
    const below = world.getBlock(entity.pos.offset(0, -0.2, 0).floored())
    if (entity.onGround && !entity.control.sneak && (below?.type === slimeId || below?.type === honeyblockId)) {
      const k = f32(physics.honeyblockSpeed + (Math.abs(vel.y) < 0.1 ? Math.abs(vel.y) * 0.2 : 0))
      vel.x = f32(vel.x * k)
      vel.z = f32(vel.z * k)
    }
    if (move.dx !== move.oldVelX) vel.x = 0
    if (move.dz !== move.oldVelZ) vel.z = 0
    if (move.dy !== move.oldVelY) {
      if (move.oldVelY < 0 && !entity.control.sneak && below?.type === slimeId && !move.wasOnGround) {
        // Bedrock slime bounce (fitted to BDS samples within 1e-3): the reflected velocity plus the gravity share of
        // the part of the tick spent before the contact
        vel.y = f32(-move.oldVelY + physics.gravity * (move.dy / move.oldVelY))
        if (vel.y < BEDROCK.slimeBounceMin) vel.y = 0
      } else if (move.oldVelY < 0 && !entity.control.sneak && below?.type === bedId && !move.wasOnGround) {
        vel.y = f32(Math.min(1, -BEDROCK.bedBounce * vel.y))
      } else {
        vel.y = 0
      }
    }
  }

  function getLookingVector (entity) {
    const yaw = entity.yaw
    const pitch = entity.pitch
    const sinYaw = Math.sin(yaw)
    const cosYaw = Math.cos(yaw)
    const sinPitch = Math.sin(pitch)
    const cosPitch = Math.cos(pitch)
    const lookX = -sinYaw * cosPitch
    const lookY = sinPitch
    const lookZ = -cosYaw * cosPitch
    const lookDir = new Vec3(lookX, lookY, lookZ)
    return { yaw, pitch, sinYaw, cosYaw, sinPitch, cosPitch, lookX, lookY, lookZ, lookDir }
  }

  /**
   * moveRelative: Bedrock impulse = move vector × 0.98 (strafe +left, forward), normalized when longer than 1,
   * rotated by the (Bedrock, degrees) yaw with the sin/cos table. Same result as Java's applyHeading.
   */
  function applyHeading (entity, strafe, forward, multiplier) {
    let speed = strafe * strafe + forward * forward
    if (speed < 1e-4) return
    speed = f32(multiplier / Math.max(Math.sqrt(speed), 1))
    const ms = f32(-strafe * speed) // Bedrock strafe is +left
    const mf = f32(forward * speed)
    const yaw = wireYawRadians(entity.yaw)
    const s = sin(yaw)
    const c = cos(yaw)
    const vel = entity.vel
    vel.x = f32(vel.x + f32(ms * c - mf * s))
    vel.z = f32(vel.z + f32(mf * c + ms * s))
  }

  /**
   * The block whose friction/speed applies: the one at floor(pos − 0.5) when it has a collision box, else (standing
   * on the edge of a block, the centre over air) the colliding block right under the player's box nearest to its
   * centre, else null (default friction 0.6). Measured on BDS: a player on the edge of a slab, or walking off a ledge
   * (still on the ground from the previous tick), moves with ground friction 0.6 — never air's 0.9.
   */
  function supportingBlock (world, pos) {
    const under = world.getBlock(pos.offset(0, -0.5, 0).floored())
    if (!under || collisionShapes(under)?.length > 0) return under
    const feet = getPlayerBB(pos)
    const probe = new AABB(feet.minX, feet.minY - 1e-3, feet.minZ, feet.maxX, feet.minY, feet.maxZ)
    let best = null
    let bestDist = Infinity
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(probe.minY); cursor.y <= Math.floor(probe.maxY); cursor.y++) {
      for (cursor.z = Math.floor(probe.minZ); cursor.z <= Math.floor(probe.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(probe.minX); cursor.x <= Math.floor(probe.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          const shapes = collisionShapes(block)
          if (!shapes) continue
          for (const shape of shapes) {
            const box = new AABB(shape[0], shape[1], shape[2], shape[3], shape[4], shape[5]).offset(cursor.x, cursor.y, cursor.z)
            if (!box.intersects(probe)) continue
            const dist = (cursor.x + 0.5 - pos.x) ** 2 + (cursor.z + 0.5 - pos.z) ** 2
            if (dist < bestDist) {
              best = block
              bestDist = dist
            }
          }
        }
      }
    }
    return best
  }

  function isClimbable (world, pos) {
    const block = world.getBlock(pos.floored())
    return !!block && climbableIds.has(block.type)
  }

  function movementSpeed (entity) {
    const raw = entity.attributes?.[physics.movementSpeedAttribute]
    let attr = raw && typeof raw.value === 'number'
      ? { value: raw.value, modifiers: (raw.modifiers ?? []).slice() }
      : attribute.createAttributeValue(physics.playerSpeed)
    // client-side sprinting (Bedrock: × 1.3), never the server's sprint modifier
    attr = attribute.deleteAttributeModifier(attr, physics.sprintingUUID)
    attr.modifiers = attr.modifiers.filter((m) => !/sprint/i.test(m.name ?? ''))
    if (entity.control.sprint) {
      attr = attribute.addAttributeModifier(attr, { uuid: physics.sprintingUUID, amount: physics.sprintSpeed, operation: 2 })
    }
    return f32(Math.max(0, attribute.getAttributeValue(attr)))
  }

  // ---- liquids ------------------------------------------------------------------------------------------

  function getRenderedDepth (block) {
    if (!block) return -1
    if (waterLike.has(block.type)) return 0
    if (block.isWaterlogged) return 0
    if (!waterIds.has(block.type)) return -1
    const meta = block.metadata
    return meta >= 8 ? 0 : meta
  }

  function getLiquidHeightPcent (block) {
    return (getRenderedDepth(block) + 1) / 9
  }

  function getFlow (world, block) {
    const curlevel = getRenderedDepth(block)
    const flow = new Vec3(0, 0, 0)
    for (const [dx, dz] of [[0, 1], [-1, 0], [0, -1], [1, 0]]) {
      const adjBlock = world.getBlock(block.position.offset(dx, 0, dz))
      const adjLevel = getRenderedDepth(adjBlock)
      if (adjLevel < 0) {
        if (adjBlock && adjBlock.boundingBox !== 'empty') {
          const adjLevel = getRenderedDepth(world.getBlock(block.position.offset(dx, -1, dz)))
          if (adjLevel >= 0) {
            const f = adjLevel - (curlevel - 8)
            flow.x += dx * f
            flow.z += dz * f
          }
        }
      } else {
        const f = adjLevel - curlevel
        flow.x += dx * f
        flow.z += dz * f
      }
    }
    if (waterIds.has(block.type) && block.metadata >= 8) {
      for (const [dx, dz] of [[0, 1], [-1, 0], [0, -1], [1, 0]]) {
        const adjBlock = world.getBlock(block.position.offset(dx, 0, dz))
        const adjUpBlock = world.getBlock(block.position.offset(dx, 1, dz))
        if ((adjBlock && adjBlock.boundingBox !== 'empty') || (adjUpBlock && adjUpBlock.boundingBox !== 'empty')) {
          flow.normalize().translate(0, -6, 0)
        }
      }
    }
    return flow.normalize()
  }

  function getWaterInBB (world, bb) {
    const waterBlocks = []
    forEachBlockIn(world, bb, (block, cursor) => {
      if (waterIds.has(block.type) || waterLike.has(block.type) || block.isWaterlogged) {
        const waterLevel = cursor.y + 1 - getLiquidHeightPcent(block)
        if (Math.ceil(bb.maxY) >= waterLevel) waterBlocks.push(block)
      }
    })
    return waterBlocks
  }

  function isInWaterApplyCurrent (world, bb, vel) {
    const acceleration = new Vec3(0, 0, 0)
    const waterBlocks = getWaterInBB(world, bb)
    for (const block of waterBlocks) {
      if (!block.position) continue
      acceleration.add(getFlow(world, block))
    }
    const len = acceleration.norm()
    if (len > 0) {
      vel.x = f32(vel.x + acceleration.x / len * BEDROCK.waterFlow)
      vel.y = f32(vel.y + acceleration.y / len * BEDROCK.waterFlow)
      vel.z = f32(vel.z + acceleration.z / len * BEDROCK.waterFlow)
    }
    return waterBlocks.length > 0
  }

  function isMaterialInBB (world, queryBB, types) {
    return forEachBlockIn(world, queryBB, (block) => types.has(block.type) ? true : undefined)
  }

  function doesNotCollide (world, pos) {
    const pBB = getPlayerBB(pos)
    return noCollision(world, pBB) && getWaterInBB(world, pBB).length === 0
  }

  // ---- block effects inside the player box ------------------------------------------------------------

  /** stuck multiplier (cobweb, powder snow, berry bush) of the blocks inside the box, or null */
  function stuckMultiplier (world, bb) {
    let result = null
    forEachBlockIn(world, bb, (block) => {
      if (block.type === webId) result = BEDROCK.cobweb
      else if (block.type === powderSnowId && result !== BEDROCK.cobweb) result = BEDROCK.powderSnow
      else if (block.type === sweetBerryId && !result) result = BEDROCK.sweetBerryBush
    })
    return result
  }

  function applyBubbleColumns (entity, world, bb) {
    const vel = entity.vel
    forEachBlockIn(world, bb, (block, cursor) => {
      if (block.type !== bubbleColumnId) return
      const props = block.getProperties ? block.getProperties() : (block._properties ?? {})
      const down = !!(props.drag_down ?? block.metadata)
      const aboveBlock = world.getBlock(cursor.offset(0, 1, 0))
      const bubbleDrag = (aboveBlock && aboveBlock.type === 0) || (aboveBlock && aboveBlock.name === 'air') ? physics.bubbleColumnSurfaceDrag : physics.bubbleColumnDrag
      if (down) vel.y = f32(Math.max(bubbleDrag.maxDown, vel.y - bubbleDrag.down))
      else vel.y = f32(Math.min(bubbleDrag.maxUp, vel.y + bubbleDrag.up))
    })
  }

  // ---- movement per medium ----------------------------------------------------------------------------

  // slow falling (Bedrock): gravity 0.01 only while already falling (vy < 0; measured: the first tick after a
  // teleport with vy = 0 still uses 0.08)
  function gravityOf (entity) {
    return (entity.slowFalling > 0 && entity.vel.y < 0) ? physics.gravity * physics.slowFalling : physics.gravity
  }

  function applyGravityAndFriction (entity, inertia) {
    const vel = entity.vel
    if (entity.levitation > 0) {
      vel.y = f32(f32(vel.y + (BEDROCK.levitationPerLevel * entity.levitation - vel.y) * 0.2) * physics.airdrag)
    } else {
      vel.y = f32(f32(vel.y - gravityOf(entity)) * physics.airdrag)
    }
    vel.x = f32(vel.x * inertia)
    vel.z = f32(vel.z * inertia)
  }

  function moveInLiquid (entity, world, strafe, forward) {
    const vel = entity.vel
    const pos = entity.pos
    const lastY = pos.y
    let acceleration = physics.liquidAcceleration
    const inertia = entity.isInWater ? physics.waterInertia : physics.lavaInertia
    let horizontalInertia = inertia

    if (entity.isInWater) {
      let strider = Math.min(entity.depthStrider ?? 0, 3)
      if (!entity.onGround) strider *= 0.5
      if (strider > 0) {
        horizontalInertia += (0.546 - horizontalInertia) * strider / 3
        acceleration += (0.7 - acceleration) * strider / 3
      }
      if (entity.dolphinsGrace > 0) horizontalInertia = 0.96
    }

    applyHeading(entity, strafe, forward, acceleration)
    const move = moveEntity(entity, world, vel.x, vel.y, vel.z)
    postCollisionLiquid(entity, move)
    vel.y = f32(vel.y * inertia)
    vel.y = f32(vel.y - (entity.isInWater ? physics.waterGravity : physics.lavaGravity) * (entity.slowFalling > 0 && vel.y <= 0 ? physics.slowFalling : 1))
    vel.x = f32(vel.x * horizontalInertia)
    vel.z = f32(vel.z * horizontalInertia)

    if (entity.isCollidedHorizontally && doesNotCollide(world, pos.offset(vel.x, vel.y + 0.6 - pos.y + lastY, vel.z))) {
      vel.y = physics.outOfLiquidImpulse // jump out of liquid
    }
  }

  function postCollisionLiquid (entity, move) {
    const vel = entity.vel
    if (move.dx !== move.oldVelX) vel.x = 0
    if (move.dz !== move.oldVelZ) vel.z = 0
    if (move.dy !== move.oldVelY) vel.y = 0
  }

  function moveElytra (entity, world) {
    const vel = entity.vel
    const { pitch, sinPitch, cosPitch, lookDir } = getLookingVector(entity)
    const horizontalSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z)
    const cosPitchSquared = cosPitch * cosPitch
    const gravityMultiplier = (vel.y <= 0 && entity.slowFalling > 0) ? physics.slowFalling : 1
    vel.y += physics.gravity * gravityMultiplier * (-1.0 + cosPitchSquared * 0.75)
    if (vel.y < 0.0 && cosPitch > 0.0) {
      const movingDownSpeedModifier = vel.y * (-0.1) * cosPitchSquared
      vel.x += lookDir.x * movingDownSpeedModifier / cosPitch
      vel.y += movingDownSpeedModifier
      vel.z += lookDir.z * movingDownSpeedModifier / cosPitch
    }
    if (pitch > 0.0 && cosPitch > 0.0) {
      const lookDownSpeedModifier = horizontalSpeed * sinPitch * 0.04
      vel.x += -lookDir.x * lookDownSpeedModifier / cosPitch
      vel.y += lookDownSpeedModifier * 3.2
      vel.z += -lookDir.z * lookDownSpeedModifier / cosPitch
    }
    if (cosPitch > 0.0) {
      vel.x += (lookDir.x / cosPitch * horizontalSpeed - vel.x) * 0.1
      vel.z += (lookDir.z / cosPitch * horizontalSpeed - vel.z) * 0.1
    }
    vel.x = f32(vel.x * 0.99)
    vel.y = f32(vel.y * 0.98)
    vel.z = f32(vel.z * 0.99)
    const move = moveEntity(entity, world, vel.x, vel.y, vel.z)
    postCollisionLiquid(entity, move)
    if (entity.onGround) entity.elytraFlying = false
  }

  /**
   * Creative / abilities flight (BDS 1.26.51, measured with per-tick server samples): jump adds 3 × fly speed (0.15) and
   * sneak removes 4.4 × fly speed (0.22) to the vertical velocity before the move, the horizontal acceleration is the
   * fly speed (no sprint bonus), no gravity; after the move vy × 0.6 and vx/vz × 0.91. Without horizontal input vx/vz
   * are damped × 0.375 more after the move, and without any input vy × 0.375 before it: flight stops within a few
   * ticks.
   */
  function moveFlying (entity, world, strafe, forward) {
    const vel = entity.vel
    const flySpeed = entity.flySpeed ?? BEDROCK.defaultFlySpeed
    const idle = strafe === 0 && forward === 0 && !entity.control.jump && !entity.control.sneak
    if (idle) vel.y = f32(vel.y * BEDROCK.flyStopDamping)
    if (entity.control.jump) vel.y = f32(vel.y + flySpeed * BEDROCK.flyAscendFactor)
    if (entity.control.sneak) vel.y = f32(vel.y - flySpeed * BEDROCK.flyDescendFactor)
    applyHeading(entity, strafe, forward, f32(flySpeed))
    const move = moveEntity(entity, world, vel.x, vel.y, vel.z)
    postCollisionLiquid(entity, move)
    const horizontalStop = strafe === 0 && forward === 0 ? BEDROCK.flyStopDamping : 1
    vel.y = f32(vel.y * BEDROCK.flyVerticalDrag)
    vel.x = f32(f32(vel.x * physics.airborneInertia) * horizontalStop)
    vel.z = f32(f32(vel.z * physics.airborneInertia) * horizontalStop)
  }

  function moveOnLand (entity, world, strafe, forward) {
    const vel = entity.vel
    const pos = entity.pos

    // speed + friction from the previous tick's ground state (block at floor(pos − 0.5))
    let acceleration
    let inertia
    if (entity.onGround) {
      const blockUnder = supportingBlock(world, pos)
      const friction = blockUnder ? (blockFriction[blockUnder.type] ?? physics.defaultSlipperiness) : physics.defaultSlipperiness
      inertia = f32(friction * physics.airborneInertia)
      let speed = movementSpeed(entity)
      if (blockUnder && blockUnder.type === soulsandId) speed = f32(speed * physics.soulsandSpeed)
      acceleration = f32(speed * f32(BEDROCK.groundAccelerationFactor / f32(inertia * inertia * inertia)))
    } else {
      inertia = physics.airborneInertia
      acceleration = entity.control.sprint ? BEDROCK.airSprintAcceleration : physics.airborneAcceleration
    }

    applyHeading(entity, strafe, forward, acceleration)
    jump(entity, world)

    // climbing (Bedrock, measured): falls at most 0.2/tick; holding jump climbs 0.2 this tick (gravity applies after:
    // delta 0.1176); a horizontal collision while on the climbable sets 0.2 as the end-of-tick velocity (delta 0.2,
    // next tick climbs 0.2); sneaking holds on
    const onClimbable = isClimbable(world, pos)
    if (onClimbable) {
      vel.y = f32(Math.max(vel.y, -physics.ladderMaxSpeed))
      if (entity.control.jump) vel.y = physics.ladderClimbSpeed
      if (entity.control.sneak && vel.y < 0) vel.y = 0
    }

    const stuck = stuckMultiplier(world, getPlayerBB(pos).contract(0.001, 0.001, 0.001))
    entity.isInWeb = stuck === BEDROCK.cobweb
    let dx = vel.x
    let dy = vel.y
    let dz = vel.z
    if (stuck) {
      dx = f32(dx * stuck.x)
      dy = f32(dy * stuck.y)
      dz = f32(dz * stuck.z)
    }

    const move = moveEntity(entity, world, dx, dy, dz)
    postCollision(entity, world, move)
    if (stuck) vel.set(0, 0, 0)

    applyGravityAndFriction(entity, inertia)
    if (onClimbable && entity.isCollidedHorizontally && isClimbable(world, pos)) vel.y = physics.ladderClimbSpeed
  }

  function jump (entity, world) {
    const vel = entity.vel
    if (!entity.wantsJump || !entity.onGround || entity.jumpTicks !== 0) return
    const blockBelow = world.getBlock(entity.pos.offset(0, -0.5, 0).floored())
    let jumpVelocity = f32(BEDROCK.jumpVelocity * ((blockBelow && blockBelow.type === honeyblockId) ? physics.honeyblockJumpSpeed : 1))
    if (entity.jumpBoost > 0) jumpVelocity = f32(jumpVelocity + BEDROCK.jumpBoostPerLevel * entity.jumpBoost)
    vel.y = f32(Math.max(jumpVelocity, vel.y))
    if (entity.control.sprint) {
      const yaw = wireYawRadians(entity.yaw)
      vel.x = f32(vel.x - sin(yaw) * BEDROCK.sprintJumpBoost)
      vel.z = f32(vel.z + cos(yaw) * BEDROCK.sprintJumpBoost)
    }
    entity.jumpTicks = physics.autojumpCooldown
    entity.jumped = true
  }

  function normalizeState (entity) {
    if (!entity.pos) entity.pos = new Vec3(0, 0, 0)
    if (!entity.vel) entity.vel = new Vec3(0, 0, 0)
    if (!entity.control) entity.control = {}
    for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) entity.control[key] = !!entity.control[key]
    if (typeof entity.yaw !== 'number') entity.yaw = 0
    if (typeof entity.pitch !== 'number') entity.pitch = 0
    if (typeof entity.jumpTicks !== 'number') entity.jumpTicks = 0
    entity.onGround = !!entity.onGround
    for (const key of ['jumpBoost', 'slowFalling', 'levitation', 'dolphinsGrace', 'depthStrider', 'fireworkRocketDuration']) {
      if (typeof entity[key] !== 'number') entity[key] = 0
    }
  }

  physics.simulatePlayer = (entity, world) => {
    normalizeState(entity)
    const vel = entity.vel
    const pos = entity.pos
    entity.jumped = false
    boxHeight = entity.control.sneak && !entity.flying && !entity.elytraFlying ? BEDROCK.sneakHeight : physics.playerHeight

    const waterBB = getPlayerBB(pos).contract(0.001, 0.401, 0.001)
    const lavaBB = getPlayerBB(pos).contract(0.1, 0.4, 0.1)
    entity.isInWater = isInWaterApplyCurrent(world, waterBB, vel)
    entity.isInLava = isMaterialInBB(world, lavaBB, lavaIds)

    // Bedrock: the velocity is only zeroed when it is negligible as a whole
    if (vel.x * vel.x + vel.y * vel.y + vel.z * vel.z < physics.negligeableVelocity * physics.negligeableVelocity) vel.set(0, 0, 0)

    // jump input + delay (10 ticks while held, reset on release)
    entity.wantsJump = false
    if (entity.control.jump || entity.jumpQueued) {
      if (entity.jumpTicks > 0) entity.jumpTicks--
      if (entity.isInWater || entity.isInLava) {
        if (!entity.flying) vel.y = f32(vel.y + BEDROCK.waterJump)
      } else {
        entity.wantsJump = true
      }
    } else {
      entity.jumpTicks = 0
    }
    entity.jumpQueued = false

    // impulse = move vector (the one sent in player_auth_input; derived from the controls for upstream
    // PlayerStates) clamped to ±0.3 while sneaking (±0.1225 while using an item), × 0.98
    const mv = entity.moveVector ?? moveVector(entity.control, { flying: entity.flying })
    let maxImpulse = 1
    if (entity.control.sneak && !entity.flying) maxImpulse *= physics.sneakSpeed
    if (entity.usingItem) maxImpulse *= BEDROCK.usingItemImpulse
    const strafe = f32(clamp(-maxImpulse, -mv.x, maxImpulse) * BEDROCK.impulseScale) // Java sign: +right
    const forward = f32(clamp(-maxImpulse, mv.z, maxImpulse) * BEDROCK.impulseScale)

    entity.elytraFlying = !!(entity.elytraFlying && entity.elytraEquipped && !entity.onGround && !entity.levitation && !entity.flying)

    if (entity.fireworkRocketDuration > 0) {
      if (!entity.elytraFlying) {
        entity.fireworkRocketDuration = 0
      } else {
        const { lookDir } = getLookingVector(entity)
        vel.x += lookDir.x * 0.1 + (lookDir.x * 1.5 - vel.x) * 0.5
        vel.y += lookDir.y * 0.1 + (lookDir.y * 1.5 - vel.y) * 0.5
        vel.z += lookDir.z * 0.1 + (lookDir.z * 1.5 - vel.z) * 0.5
        --entity.fireworkRocketDuration
      }
    }

    if (entity.flying) {
      entity.isInWeb = false
      moveFlying(entity, world, strafe, forward)
    } else if (entity.isInWater || entity.isInLava) {
      entity.isInWeb = false
      moveInLiquid(entity, world, strafe, forward)
      applyBubbleColumns(entity, world, getPlayerBB(pos).contract(0.001, 0.001, 0.001))
    } else if (entity.elytraFlying) {
      entity.isInWeb = false
      moveElytra(entity, world)
    } else {
      moveOnLand(entity, world, strafe, forward)
    }

    pos.set(f32(pos.x), f32(pos.y), f32(pos.z))
    vel.set(f32(vel.x), f32(vel.y), f32(vel.z))
    return entity
  }

  return physics
}

// ---- PlayerState --------------------------------------------------------------------------------------

function getEffectLevel (registry, effectName, effects) {
  const effectDescriptor = registry?.effectsByName?.[effectName]
  if (!effectDescriptor || !effects) return 0
  const effectInfo = effects[effectDescriptor.id]
  if (!effectInfo) return 0
  return effectInfo.amplifier + 1
}

function getEnchantmentLevel (registry, enchantmentName, enchantments) {
  const enchantmentDescriptor = registry?.enchantmentsByName?.[enchantmentName]
  if (!enchantmentDescriptor) return 0
  for (const enchInfo of enchantments) {
    if (typeof enchInfo.id === 'string') {
      if (enchInfo.id.includes(enchantmentName)) return enchInfo.lvl
    } else if (enchInfo.id === enchantmentDescriptor.id) {
      return enchInfo.lvl
    }
  }
  return 0
}

/**
 * Upstream prismarine-physics PlayerState shape, built from a mineflayer-bedrock bot (registry from `bot.registry`,
 * effects keyed by Bedrock id, Java-layout inventory slots 6 = chest / 8 = boots, missing slots tolerated) plus the
 * Bedrock-only optional inputs `flying` and `flySpeed`.
 */
class PlayerState {
  constructor (bot, control) {
    const registry = bot.registry
    const entity = bot.entity
    // Input / Outputs
    this.pos = entity.position.clone()
    this.vel = entity.velocity.clone()
    this.onGround = entity.onGround
    this.isInWater = entity.isInWater
    this.isInLava = entity.isInLava
    this.isInWeb = entity.isInWeb
    this.isCollidedHorizontally = entity.isCollidedHorizontally
    this.isCollidedVertically = entity.isCollidedVertically
    this.elytraFlying = entity.elytraFlying
    this.jumpTicks = bot.jumpTicks
    this.jumpQueued = bot.jumpQueued
    this.fireworkRocketDuration = bot.fireworkRocketDuration

    // Input only (not modified)
    this.attributes = entity.attributes
    this.yaw = entity.yaw
    this.pitch = entity.pitch
    this.control = control

    const effects = entity.effects
    this.jumpBoost = getEffectLevel(registry, 'JumpBoost', effects)
    this.speed = getEffectLevel(registry, 'Speed', effects)
    this.slowness = getEffectLevel(registry, 'Slowness', effects)
    this.dolphinsGrace = getEffectLevel(registry, 'DolphinsGrace', effects)
    this.slowFalling = getEffectLevel(registry, 'SlowFalling', effects)
    this.levitation = getEffectLevel(registry, 'Levitation', effects)

    const slots = bot.inventory?.slots ?? []
    const boots = slots[8]
    this.depthStrider = 0
    if (boots && boots.nbt) {
      try {
        const simplified = require('prismarine-nbt').simplify(boots.nbt)
        const enchantments = simplified.Enchantments ?? simplified.ench ?? []
        this.depthStrider = getEnchantmentLevel(registry, 'depth_strider', enchantments)
      } catch {}
    }
    const chest = slots[6]
    this.elytraEquipped = chest != null && chest.name === 'elytra'

    // Bedrock extras (optional for the engine)
    this.flying = !!bot._bedrock?.physics?.isFlying?.()
    this.flySpeed = bot.abilities?.flyingSpeed ?? bot.entity?.flyingSpeed ?? 0.05
  }

  apply (bot) {
    bot.entity.position = this.pos
    bot.entity.velocity = this.vel
    bot.entity.onGround = this.onGround
    bot.entity.isInWater = this.isInWater
    bot.entity.isInLava = this.isInLava
    bot.entity.isInWeb = this.isInWeb
    bot.entity.isCollidedHorizontally = this.isCollidedHorizontally
    bot.entity.isCollidedVertically = this.isCollidedVertically
    bot.entity.elytraFlying = this.elytraFlying
    bot.jumpTicks = this.jumpTicks
    bot.jumpQueued = this.jumpQueued
    bot.fireworkRocketDuration = this.fireworkRocketDuration
  }
}

module.exports = { Physics, PlayerState, defaultPhysicsFields, BEDROCK, getEffectLevel }
