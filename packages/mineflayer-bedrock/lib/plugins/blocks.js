// owner: U4 (wave 2, core world) → U9 (wave 3, extras: dimension reset, block entities API)
// Upstream: mineflayer 4.39.0 lib/plugins/blocks.js (MIT, Copyright (c) 2013 Andrew Kelley) — blockAt,
//   canSeeBlock, waitForChunksToLoad, the event proxy and the world switch are adapted from it; findBlocks is
//   vendored with a Bedrock palette shortcut. bot.updateSign lives in sign.js here.
// Surface: bot.world (prismarine-world WorldSync), bot.blockAt(point, extraInfos = true),
//   bot.findBlocks(options), bot.findBlock(options), bot.canSeeBlock(block),
//   bot.waitForChunksToLoad(), bot._updateBlockState(point, stateId), bot._getDimensionName()
// Events: 'blockUpdate' (old, new), 'blockUpdate:(x, y, z)', 'chunkColumnLoad' (point),
//   'chunkColumnUnload' (point), 'blockEntityData' (block) [U9]
// Bedrock:
// - registry runtime ids come from start_game (lib/registry.js attachRegistry, before this plugin's listeners).
// - level_chunk arrives in sub-chunk request mode (sub_chunk_count 0 + highest_subchunk_count): the payload
//   (biomes, border blocks, block entities) is decoded with networkDecodeNoCache(payload, 0), then ONE
//   subchunk_request per column asks for every sub-chunk of the dimension (overworld -4..19, nether 0..7, end
//   0..15; origin = the column, offsets dy). `subchunk` entries ('success' payloads incl. their block-entity
//   NBT, 'success_all_air') are decoded with networkDecodeSubChunkNoCache; once every requested sub-chunk of a
//   column was answered the column is set in bot.world → 'chunkColumnLoad'. Columns are created with the
//   dimension's minY/height (prismarine-chunk patch).
// - update_block: runtime id → registry.blocksByRuntimeId[id].stateId (unknown ids → minecraft:unknown);
//   layer 0 = the block, layer 1 = the liquid layer (waterlogging). update_subchunk_blocks: `blocks` = layer 0,
//   `extra` = layer 1. Both emit 'blockUpdate' / 'blockUpdate:(x, y, z)'.
//   Waterlogging (docs/differences/U4.md#waterlogging): bot.blockAt() returns the layer-0 block; when layer 1
//   holds water it carries `block.superimposed` (the layer-1 Block), `block.computedStates.waterlogged = true`
//   and `block.isWaterlogged = true` (prismarine-chunk's Bedrock representation, patched to skip air).
// - network_chunk_publisher_update: columns farther than the publisher radius (+2 chunks) are unloaded →
//   'chunkColumnUnload'. BDS never resends a column it considers sent, so the client must not drop one early
//   (U16b fix, observed on BDS 1.26.51.1): during the join, before its chunk_radius_update, it sends columns more
//   than 100 blocks away while its publisher updates still say 64 — nothing is unloaded until the granted radius
//   is known (or, if no chunk_radius_update ever comes, until the bot spawned), and the radius used is at least
//   the granted one (chunk_radius_update) plus two chunks of slack.
// - start_game / the lifecycle's 'dimensionChange' (change_dimension): bot._bedrock.world.reset(dimension) unloads
//   every column (upstream's switchWorld); U9 calls the same hook for its dimension flow.
// - block entities (U9, upstream tile_entity_data): block.entity / block.blockEntity from the sub-chunk payloads'
//   NBT and from block_entity_data { position, nbt } (stored on the column, then 'blockEntityData' with
//   bot.blockAt(position)); a block replaced by another block type loses its block entity (BDS sends the new one
//   right after the update_block). Signs: block.signText / getSignText() read FrontText/BackText (prismarine-block
//   patch); sign editing is sign.js.
'use strict'
const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { DIMENSION_HEIGHTS, dimensionName, dimensionId, subChunkRange } = require('../bedrock/constants')

const { OctahedronIterator } = require('prismarine-world').iterators

module.exports = inject

function inject (bot) {
  const Block = require('prismarine-block')(bot.registry)
  const Chunk = require('prismarine-chunk')(bot.registry)
  const World = require('prismarine-world')(bot.registry)
  const paintingsByPos = {}
  const paintingsById = {}
  /** 'x,z' → { column, remaining: Set<sub-chunk y>, dimension } columns waiting for their sub-chunks */
  const pendingColumns = new Map()
  let dimension = 'overworld'

  bot.world = new World(null).sync
  startListenerProxy()

  function addPainting (painting) {
    paintingsById[painting.id] = painting
    paintingsByPos[painting.position] = painting
  }

  function deletePainting (painting) {
    delete paintingsById[painting.id]
    delete paintingsByPos[painting.position]
  }

  function newColumn (x, z) {
    const { minY, height } = DIMENSION_HEIGHTS[dimension]
    return new Chunk({ x, z, minY, worldHeight: height })
  }

  function stateIdOf (runtimeId) {
    const block = bot.registry.blocksByRuntimeId?.[runtimeId]
    if (block) return block.stateId
    return (bot.registry.blocksByName.unknown ?? bot.registry.blocksByName.air).defaultState
  }

  // ---- chunks ----------------------------------------------------------------------------------------
  function requestSubChunks (column, dimId) {
    const { min, max } = subChunkRange(dimension)
    const requests = []
    for (let y = min; y <= max; y++) requests.push({ x: 0, y, z: 0 })
    pendingColumns.set(`${column.x},${column.z}`, { column, remaining: new Set(requests.map(r => r.y)), dimension: dimId })
    bot._client.queue('subchunk_request', { dimension: dimId, requests, origin: { x: column.x, y: 0, z: column.z } })
  }

  bot._client.on('level_chunk', (packet) => {
    const dimId = packet.dimension ?? dimensionId(dimension)
    if (dimensionName(dimId) !== dimension) return // a column of the dimension we just left
    try {
      const column = newColumn(packet.x, packet.z)
      const requestMode = packet.highest_subchunk_count !== undefined && packet.highest_subchunk_count !== null
      if (requestMode || packet.sub_chunk_count < 0) {
        // sub-chunk request mode: the payload holds the biomes (+ border blocks + block entities) only
        column.networkDecodeNoCache(packet.payload, packet.sub_chunk_count < 0 ? packet.sub_chunk_count : 0)
        requestSubChunks(column, dimId)
      } else {
        column.networkDecodeNoCache(packet.payload, packet.sub_chunk_count)
        pendingColumns.delete(`${packet.x},${packet.z}`)
        bot.world.setColumn(packet.x, packet.z, column)
      }
    } catch (err) {
      bot.emit('error', err)
    }
  })

  bot._client.on('subchunk', (packet) => {
    if (dimensionName(packet.dimension) !== dimension) return
    const completed = new Set()
    for (const entry of packet.entries ?? []) {
      const x = packet.origin.x + entry.dx
      const y = packet.origin.y + entry.dy
      const z = packet.origin.z + entry.dz
      const key = `${x},${z}`
      const pending = pendingColumns.get(key)
      const column = pending?.column ?? bot.world.getColumn(x, z)
      const refresh = liquidRefreshes.get(`${x},${y},${z}`)
      if (!column) continue
      if (refresh && !pending) {
        onLiquidRefreshAnswer(refresh, column, y, entry)
        continue
      }
      // a column still loading takes the answer as the whole sub-chunk (below)
      if (refresh) onLiquidRefreshAnswer(refresh, null, y, entry)
      if (entry.result === 'success' && entry.payload) {
        try {
          // async signature, synchronous body: the section is set when the call returns
          column.networkDecodeSubChunkNoCache(y, entry.payload).catch(err => bot.emit('error', err))
        } catch (err) {
          bot.emit('error', err)
        }
      } else if (entry.result === 'success_all_air' && !pending) {
        column.setSection(y, null)
      }
      if (pending) {
        pending.remaining.delete(y)
        if (pending.remaining.size === 0) completed.add(key)
      }
    }
    for (const key of completed) {
      const { column } = pendingColumns.get(key)
      pendingColumns.delete(key)
      bot.world.setColumn(column.x, column.z, column)
    }
  })

  // chunk_radius_update: the radius (chunks) the server granted to request_chunk_radius (null: not answered yet)
  let grantedRadius = null
  let spawned = false
  bot._client.on('chunk_radius_update', (packet) => {
    grantedRadius = Number(packet.chunk_radius) || 0
  })
  bot.once('spawn', () => { spawned = true })

  bot._client.on('network_chunk_publisher_update', (packet) => {
    // the join: BDS sends columns beyond the publisher radius until it answered request_chunk_radius (a server
    // that never answers: the publisher radius alone once the bot spawned)
    if (grantedRadius === null && !spawned) return
    const { x, z } = packet.coordinates
    // two chunks of slack: never drop a column the server still considers sent (it would not send it again)
    const limit = Math.max(packet.radius, (grantedRadius ?? 0) * 16) + 32
    const outside = (cx, cz) => Math.hypot(cx * 16 + 8 - x, cz * 16 + 8 - z) > limit
    for (const [key, { column }] of pendingColumns) {
      if (outside(column.x, column.z)) pendingColumns.delete(key)
    }
    for (const [cx, cz] of loadedColumnCoords()) {
      if (outside(cx, cz)) bot.world.unloadColumn(cx, cz)
    }
  })

  function loadedColumnCoords () {
    return Object.keys(bot.world.async.columns).map(key => key.split(',').map(n => parseInt(n, 10)))
  }

  // ---- blocks -----------------------------------------------------------------------------------------
  function blockAt (absolutePoint, extraInfos = true) {
    const block = bot.world.getBlock(absolutePoint)
    // null block means chunk not loaded
    if (!block) return null

    if (extraInfos) {
      block.painting = paintingsByPos[block.position]
    }

    return block
  }

  function updateBlockState (point, stateId) {
    const oldBlock = blockAt(point)
    bot.world.setBlockStateId(point, stateId)

    const newBlock = blockAt(point)
    // sometimes minecraft server sends us block updates before it sends
    // us the column that the block is in. ignore this.
    if (newBlock === null) {
      return
    }
    if (oldBlock.type !== newBlock.type) {
      const pos = point.floored()
      const painting = paintingsByPos[pos]
      if (painting) deletePainting(painting)
    }
  }

  /** layer 1 (liquid layer) of a block: set it on the column and emit the block update like setBlockStateId */
  function updateLiquidLayer (point, stateId) {
    const column = bot.world.getColumnAt(point)
    if (!column) return
    const local = new Vec3(Math.floor(point.x) & 15, Math.floor(point.y), Math.floor(point.z) & 15)
    const oldBlock = column.getBlock(local)
    local.l = 1
    column.setBlockStateId(local, stateId)
    delete local.l
    bot.world._emitBlockUpdate(oldBlock, column.getBlock(local), point)
  }

  // ---- the liquid layer of layer-0 updates -----------------------------------------------------------
  // BDS sends a layer-0 update only (update_block layer 0, update_subchunk_blocks `blocks` with an empty `extra`)
  // when a block replaces a water source or a waterlogged block; the Bedrock client applies the liquid-layer rule
  // itself: a block that can contain liquid keeps / takes the water in layer 1, any other block (and air or a
  // liquid in layer 0) leaves layer 1 empty. Clients have no can-contain-liquid table (carpets, ladders, chests …
  // can, full cubes cannot; Bedrock's set differs from Java's `waterlogged` blocks), so the layer is predicted
  // (air / liquid / full cube → dry, any other block → keeps or takes the water) and, when it was not certain,
  // confirmed by requesting that sub-chunk again (`refreshLiquidLayer`): the server's answer decides.
  const air = () => bot.registry.blocksByName.air.defaultState
  const stateIdType = (stateId) => bot.registry.blocksByStateId[stateId]?.id
  const isLiquidName = (name) => /^(?:flowing_)?(?:water|lava)$/.test(name ?? '')
  const isWaterName = (name) => name === 'water' || name === 'flowing_water'
  function layerStateId (column, local, l) {
    const pos = new Vec3(local.x, local.y, local.z)
    pos.l = l
    return column.getBlockStateId(pos) ?? air()
  }
  function setLayerStateId (column, local, l, stateId) {
    const pos = new Vec3(local.x, local.y, local.z)
    pos.l = l
    column.setBlockStateId(pos, stateId)
  }
  /** what a layer-0 change does to layer 1: { layer1: new layer-1 state (undefined: unchanged), confirm } */
  function liquidLayerRule (old0, old1, new0) {
    const before = bot.registry.blocksByStateId[old0]
    const after = bot.registry.blocksByStateId[new0]
    const old1Name = bot.registry.blocksByStateId[old1]?.name
    const waterSource = isWaterName(before?.name) && Number(Block.fromStateId(old0, 0).getProperties().liquid_depth ?? 0) === 0
    const hadLiquid = old1 !== air() && old1Name !== undefined && old1Name !== 'air'
    if (!after || after.name === 'air' || isLiquidName(after.name)) return { layer1: hadLiquid ? air() : undefined, confirm: false }
    if (!waterSource && !isWaterName(old1Name)) return { layer1: undefined, confirm: false }
    // the same block in another state (a trapdoor toggling, kelp growing, a repeated entry): the layer stays
    if (before?.id === after.id) return { layer1: undefined, confirm: false }
    // a full cube (stone, ice, sand falling into water …) is predicted dry — and asked for: a few full cubes hold
    // water on Bedrock (copper grates, mangrove roots, …)
    const shapes = Block.fromStateId(new0, 0).shapes ?? []
    if (shapes.length === 1 && shapes[0].join() === '0,0,0,1,1,1') return { layer1: hadLiquid ? air() : undefined, confirm: true }
    // any other block: predicted to keep / take the water, asked for
    const water = isWaterName(old1Name) ? old1 : bot.registry.blocksByName.water.defaultState
    return { layer1: water === old1 ? undefined : water, confirm: true }
  }

  /**
   * 'cx,sy,cz' → { key, cx, sy, cz, positions, again, outstanding, retries, timer }: sub-chunks re-requested to confirm
   * the liquid layer of `positions` (Maps 'x,y,z' → Vec3). `outstanding` answers are expected (the request, a retry,
   * the load answer of a sub-chunk still loading). Blocks changed while a request is out go to `again` (the answer may
   * predate them) and get a new request once an answer arrived; a request without an answer is sent again after
   * LIQUID_REFRESH_RETRY_MS, at most LIQUID_REFRESH_RETRIES times.
   */
  const liquidRefreshes = new Map()
  const LIQUID_REFRESH_RETRY_MS = 5000
  const LIQUID_REFRESH_RETRIES = 3
  /**
   * A block's liquid layer is asked for at most LIQUID_ASKS times per LIQUID_ASK_WINDOW_MS (a block that keeps
   * changing every round trip would otherwise be asked for forever, U16a); beyond that the prediction stands.
   * 'x,y,z' → { n, at }
   */
  const LIQUID_ASKS = 3
  const LIQUID_ASK_WINDOW_MS = 30000
  const liquidAsks = new Map()
  function mayAskLiquid (point) {
    const now = performance.now()
    if (liquidAsks.size > 256) for (const [k, rec] of liquidAsks) if (now - rec.at >= LIQUID_ASK_WINDOW_MS) liquidAsks.delete(k)
    const key = point.toString()
    let rec = liquidAsks.get(key)
    if (!rec || now - rec.at >= LIQUID_ASK_WINDOW_MS) liquidAsks.set(key, rec = { n: 0, at: now })
    if (rec.n >= LIQUID_ASKS) return false
    rec.n++
    return true
  }
  function sendLiquidRefresh (refresh) {
    refresh.outstanding++
    clearTimeout(refresh.timer)
    refresh.timer = setTimeout(() => {
      if (liquidRefreshes.get(refresh.key) !== refresh) return
      if (refresh.retries++ >= LIQUID_REFRESH_RETRIES) {
        liquidRefreshes.delete(refresh.key)
        return
      }
      for (const [k, p] of refresh.again) refresh.positions.set(k, p)
      refresh.again.clear()
      sendLiquidRefresh(refresh)
    }, LIQUID_REFRESH_RETRY_MS)
    refresh.timer.unref?.()
    bot._client.queue('subchunk_request', { dimension: dimensionId(dimension), requests: [{ x: 0, y: refresh.sy, z: 0 }], origin: { x: refresh.cx, y: 0, z: refresh.cz } })
  }
  /** ask for the sub-chunk of `points` (blocks of one sub-chunk) */
  function refreshLiquidLayer (...all) {
    const points = all.filter(mayAskLiquid)
    if (points.length === 0) return
    const [point] = points
    const cx = Math.floor(point.x / 16)
    const cz = Math.floor(point.z / 16)
    const sy = Math.floor(point.y / 16)
    const key = `${cx},${sy},${cz}`
    let refresh = liquidRefreshes.get(key)
    if (refresh) {
      for (const p of points) refresh.again.set(p.toString(), p)
      return
    }
    refresh = { key, cx, sy, cz, positions: new Map(points.map(p => [p.toString(), p])), again: new Map(), outstanding: 0, retries: 0, timer: null }
    liquidRefreshes.set(key, refresh)
    if (pendingColumns.get(`${cx},${cz}`)?.remaining.has(sy)) refresh.outstanding++ // its load answer comes too
    sendLiquidRefresh(refresh)
  }
  /** a block whose liquid layer is being asked for */
  function liquidRefreshPending (point) {
    const refresh = liquidRefreshes.get(`${Math.floor(point.x / 16)},${Math.floor(point.y / 16)},${Math.floor(point.z / 16)}`)
    const key = point.toString()
    return !!refresh && (refresh.positions.has(key) || refresh.again.has(key))
  }
  function dropLiquidRefresh (refresh) {
    clearTimeout(refresh.timer)
    if (liquidRefreshes.get(refresh.key) === refresh) liquidRefreshes.delete(refresh.key)
  }
  /** an answer for a re-requested sub-chunk (`column`: loaded; null: the column is still loading and decodes it) */
  function onLiquidRefreshAnswer (refresh, column, y, entry) {
    refresh.outstanding--
    if (column) applyLiquidRefresh(column, y, entry, refresh.positions)
    if (refresh.again.size) {
      refresh.positions = refresh.again
      refresh.again = new Map()
      refresh.retries = 0
      sendLiquidRefresh(refresh)
    } else if (refresh.outstanding <= 0) {
      dropLiquidRefresh(refresh)
    }
  }
  bot.world.on('chunkColumnUnload', (corner) => {
    const prefix = `${corner.x >> 4},`
    const suffix = `,${corner.z >> 4}`
    for (const [key, refresh] of liquidRefreshes) if (key.startsWith(prefix) && key.endsWith(suffix)) dropLiquidRefresh(refresh)
  })
  /** a re-requested sub-chunk: the server's layer 1 of the blocks that asked for it (one blockUpdate per change) */
  function applyLiquidRefresh (column, y, entry, positions) {
    const fresh = newColumn(column.x, column.z)
    if (entry.result === 'success' && entry.payload) {
      try {
        fresh.networkDecodeSubChunkNoCache(y, entry.payload).catch(err => bot.emit('error', err))
      } catch (err) {
        bot.emit('error', err)
        return
      }
    } else if (entry.result !== 'success_all_air') {
      return
    }
    for (const point of positions.values()) {
      const local = new Vec3(point.x & 15, point.y, point.z & 15)
      // layer 0 became another block since (its update is on the way): that update decides; a state change of the
      // same block (a trapdoor toggling) keeps the layer, so the answer still holds
      if (stateIdType(layerStateId(fresh, local, 0)) !== stateIdType(column.getBlockStateId(local) ?? air())) continue
      const server1 = layerStateId(fresh, local, 1)
      if (server1 === layerStateId(column, local, 1)) continue
      const oldBlock = column.getBlock(local)
      setLayerStateId(column, local, 1, server1)
      bot.world._emitBlockUpdate(oldBlock, column.getBlock(local), point)
    }
  }

  function applyBlockUpdate (position, runtimeId, layer) {
    const point = new Vec3(position.x, position.y, position.z)
    const stateId = stateIdOf(runtimeId)
    const local = new Vec3(point.x & 15, point.y, point.z & 15)
    if (!bot.world.getColumnAt(point)) {
      // column still waiting for its sub-chunks: keep the change, without events
      const pending = pendingColumns.get(`${Math.floor(point.x / 16)},${Math.floor(point.z / 16)}`)
      if (pending) {
        if (layer === 1) {
          setLayerStateId(pending.column, local, 1, stateId)
          return
        }
        const old0 = pending.column.getBlockStateId(local) ?? air()
        const rule = liquidLayerRule(old0, layerStateId(pending.column, local, 1), stateId)
        const { layer1 } = rule
        const confirm = rule.confirm || (stateIdType(old0) !== stateIdType(stateId) && liquidRefreshPending(point.floored()))
        const stale = staleBlockEntity(pending.column, local, stateId)
        pending.column.setBlockStateId(local, stateId)
        if (layer1 !== undefined) setLayerStateId(pending.column, local, 1, layer1)
        if (stale) pending.column.removeBlockEntity(local)
        // the answer decodes into the pending column (the server's whole sub-chunk), or is applied once it loaded
        if (confirm) refreshLiquidLayer(point.floored())
      }
      return
    }
    if (layer === 1) {
      updateLiquidLayer(point, stateId)
      return
    }
    const column = bot.world.getColumnAt(point)
    const stale = staleBlockEntity(column, local, stateId)
    const old0 = column.getBlockStateId(local) ?? air()
    const rule = liquidLayerRule(old0, layerStateId(column, local, 1), stateId)
    const { layer1 } = rule
    // a block whose check is out became another block: its answer may predate the change, ask again (a state change of
    // the same block keeps the layer: no new request, U16a)
    const confirm = rule.confirm || (stateIdType(old0) !== stateIdType(stateId) && liquidRefreshPending(point.floored()))
    if (layer1 === undefined) {
      updateBlockState(point, stateId) // 'blockUpdate' with the old block still carrying its block entity
    } else {
      // both layers change: one blockUpdate with the combined old and new block (like updateBlockState)
      const oldBlock = blockAt(point)
      column.setBlockStateId(local, stateId)
      setLayerStateId(column, local, 1, layer1)
      if (oldBlock.type !== stateIdType(stateId) && paintingsByPos[point.floored()]) deletePainting(paintingsByPos[point.floored()])
      bot.world._emitBlockUpdate(oldBlock, column.getBlock(local), point)
    }
    if (stale) column.removeBlockEntity(local)
    if (confirm) refreshLiquidLayer(point.floored())
  }

  // ---- block entities (U9) -----------------------------------------------------------------------------
  // block.entity (raw NBT) / block.blockEntity (simplified) come from the sub-chunk payloads (prismarine-chunk) and
  // block_entity_data packets; BDS sends the new block's block_entity_data right after its update_block, so the
  // block entity of a replaced block (another block type) is dropped with the update.
  function staleBlockEntity (column, local, newStateId) {
    if (!column?.getBlockEntity?.(local)) return false
    const oldStateId = column.getBlockStateId(local)
    const oldType = bot.registry.blocksByStateId[oldStateId]?.id
    const newType = bot.registry.blocksByStateId[newStateId]?.id
    return oldType !== newType
  }

  bot._client.on('block_entity_data', (packet) => {
    const point = new Vec3(packet.position.x, packet.position.y, packet.position.z)
    const local = new Vec3(point.x & 15, point.y, point.z & 15)
    const column = bot.world.getColumnAt(point)
    if (!column) {
      // column still waiting for its sub-chunks: keep the block entity, without event
      pendingColumns.get(`${Math.floor(point.x / 16)},${Math.floor(point.z / 16)}`)?.column.setBlockEntity(local, packet.nbt)
      return
    }
    // a late update of a block that was removed meanwhile (BDS re-sends a fresh block entity one tick later)
    if (column.getBlockStateId(local) === bot.registry.blocksByName.air?.defaultState) return
    column.setBlockEntity(local, packet.nbt)
    bot.emit('blockEntityData', bot.blockAt(point))
  })

  bot._client.on('update_block', (packet) => {
    applyBlockUpdate(packet.position, packet.block_runtime_id, packet.layer)
  })

  bot._client.on('update_subchunk_blocks', (packet) => {
    for (const update of packet.blocks ?? []) applyBlockUpdate(update.position, update.runtime_id, 0)
    for (const update of packet.extra ?? []) applyBlockUpdate(update.position, update.runtime_id, 1)
  })

  // ---- queries ----------------------------------------------------------------------------------------
  async function waitForChunksToLoad () {
    const dist = 2
    // This makes sure that the bot's real position has been already sent
    if (!bot.entity.height) await onceWithCleanup(bot, 'chunkColumnLoad', { timeout: 10000 })
    const pos = bot.entity.position
    const center = new Vec3(pos.x >> 4 << 4, 0, pos.z >> 4 << 4)
    // get corner coords of 5x5 chunks around us
    const chunkPosToCheck = new Set()
    for (let x = -dist; x <= dist; x++) {
      for (let y = -dist; y <= dist; y++) {
        // ignore any chunks which are already loaded
        const pos = center.plus(new Vec3(x, 0, y).scaled(16))
        if (!bot.world.getColumnAt(pos)) chunkPosToCheck.add(pos.toString())
      }
    }

    if (chunkPosToCheck.size) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          bot.world.off('chunkColumnLoad', waitForLoadEvents)
          reject(new Error(`Timeout waiting for ${chunkPosToCheck.size} chunks to load after 10000ms`))
        }, 10000)

        function waitForLoadEvents (columnCorner) {
          chunkPosToCheck.delete(columnCorner.toString())
          if (chunkPosToCheck.size === 0) { // no chunks left to find
            clearTimeout(timeout)
            bot.world.off('chunkColumnLoad', waitForLoadEvents) // remove this listener instance
            resolve()
          }
        }

        // begin listening for remaining chunks to load
        bot.world.on('chunkColumnLoad', waitForLoadEvents)
      })
    }
  }

  function getMatchingFunction (matching) {
    if (typeof (matching) !== 'function') {
      if (!Array.isArray(matching)) {
        matching = [matching]
      }
      return isMatchingType
    }
    return matching

    function isMatchingType (block) {
      return block === null ? false : matching.indexOf(block.type) >= 0
    }
  }

  // Bedrock sub-chunks keep one palette per storage layer (section.palette[layer] = [{ stateId, … }]); a block's
  // type is its layer-0 entry, so the palette shortcut checks layer 0 only (upstream: section.palette = state ids).
  function isBlockInSection (section, matcher) {
    if (!section) return false // section is empty, skip it (yay!)
    const palette = section.palette?.[0]
    if (!palette) return true
    for (const entry of palette) {
      if (matcher(Block.fromStateId(entry.stateId, 0))) return true
    }
    return false
  }

  function getFullMatchingFunction (matcher, useExtraInfo) {
    if (typeof (useExtraInfo) === 'boolean') {
      return fullSearchMatcher
    }

    return nonFullSearchMatcher

    function nonFullSearchMatcher (point) {
      const block = blockAt(point, true)
      return matcher(block) && useExtraInfo(block)
    }

    function fullSearchMatcher (point) {
      return matcher(bot.blockAt(point, useExtraInfo))
    }
  }

  /** fast path for `matching` = block id(s): compare the section's state ids without building Blocks */
  function typeIdsOf (matching) {
    if (typeof matching === 'function') return null
    const ids = Array.isArray(matching) ? matching : [matching]
    return new Set(ids)
  }

  bot.findBlocks = (options) => {
    const matcher = getMatchingFunction(options.matching)
    const point = (options.point || bot.entity.position).floored()
    const maxDistance = options.maxDistance || 16
    const count = options.count || 1
    const useExtraInfo = options.useExtraInfo || false
    const fullMatcher = getFullMatchingFunction(matcher, useExtraInfo)
    const typeIds = useExtraInfo === false ? typeIdsOf(options.matching) : null
    const stateMatches = new Map() // stateId → boolean (fast path)
    const start = new Vec3(Math.floor(point.x / 16), Math.floor(point.y / 16), Math.floor(point.z / 16))
    const it = new OctahedronIterator(start, Math.ceil((maxDistance + 8) / 16))
    // the octahedron iterator can sometime go through the same section again
    // we use a set to keep track of visited sections
    const visitedSections = new Set()
    const minY = bot.game?.minY ?? DIMENSION_HEIGHTS[dimension].minY
    const height = bot.game?.height ?? DIMENSION_HEIGHTS[dimension].height
    const minSection = minY >> 4
    const maxSection = ((minY + height) >> 4) - 1

    let blocks = []
    let startedLayer = 0
    let next = start
    while (next) {
      const column = bot.world.getColumn(next.x, next.z)
      if (next.y >= minSection && next.y <= maxSection && column && !visitedSections.has(next.toString())) {
        const section = column.getSectionAtIndex(next.y)
        if (useExtraInfo === true || isBlockInSection(section, matcher)) {
          const begin = new Vec3(next.x * 16, next.y * 16, next.z * 16)
          const cursor = begin.clone()
          const end = cursor.offset(16, 16, 16)
          for (cursor.x = begin.x; cursor.x < end.x; cursor.x++) {
            for (cursor.y = begin.y; cursor.y < end.y; cursor.y++) {
              for (cursor.z = begin.z; cursor.z < end.z; cursor.z++) {
                let matches
                if (typeIds) {
                  const stateId = section.getBlockStateId(0, cursor.x & 15, cursor.y & 15, cursor.z & 15)
                  matches = stateMatches.get(stateId)
                  if (matches === undefined) {
                    matches = typeIds.has(bot.registry.blocksByStateId[stateId]?.id)
                    stateMatches.set(stateId, matches)
                  }
                } else {
                  matches = fullMatcher(cursor)
                }
                if (matches && cursor.distanceTo(point) <= maxDistance) blocks.push(cursor.clone())
              }
            }
          }
        }
        visitedSections.add(next.toString())
      }
      // If we started a layer, we have to finish it otherwise we might miss closer blocks
      if (startedLayer !== it.apothem && blocks.length >= count) {
        break
      }
      startedLayer = it.apothem
      next = it.next()
    }
    blocks.sort((a, b) => {
      return a.distanceTo(point) - b.distanceTo(point)
    })
    // We found more blocks than needed, shorten the array to not confuse people
    if (blocks.length > count) {
      blocks = blocks.slice(0, count)
    }
    return blocks
  }

  function findBlock (options) {
    const blocks = bot.findBlocks(options)
    if (blocks.length === 0) return null
    return bot.blockAt(blocks[0])
  }

  // if passed in block is within line of sight to the bot, returns true
  // also works on anything with a position value
  function canSeeBlock (block) {
    const headPos = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
    const range = headPos.distanceTo(block.position)
    const dir = block.position.offset(0.5, 0.5, 0.5).minus(headPos)
    const match = (inputBlock, iter) => {
      const intersect = iter.intersect(inputBlock.shapes, inputBlock.position)
      if (intersect) { return true }
      return block.position.equals(inputBlock.position)
    }
    const blockAtCursor = bot.world.raycast(headPos, dir.normalize(), range, match)
    return blockAtCursor && blockAtCursor.position.equals(block.position)
  }

  // ---- dimensions -------------------------------------------------------------------------------------
  // only exposed for testing (upstream: the world name, e.g. 'minecraft:overworld')
  bot._getDimensionName = () => `minecraft:${dimension}`

  /** upstream switchWorld: drop every column (+ per-position blockUpdate listeners), switch dimension */
  function resetWorld (newDimension = dimension) {
    for (const [name, listener] of Object.entries(bot._events)) {
      if (name.startsWith('blockUpdate:') && typeof listener === 'function') {
        bot.emit(name, null, null)
        bot.off(name, listener)
      }
    }
    for (const [x, z] of loadedColumnCoords()) {
      bot.world.unloadColumn(x, z)
    }
    pendingColumns.clear()
    for (const refresh of [...liquidRefreshes.values()]) dropLiquidRefresh(refresh)
    dimension = dimensionName(newDimension)
  }

  bot._client.on('start_game', (packet) => {
    resetWorld(packet.dimension)
  })

  // the lifecycle's change_dimension step (before the new position is applied)
  bot._bedrock?.lifecycle?.events?.on('dimensionChange', ({ dimension }) => resetWorld(dimension))

  function startListenerProxy () {
    // standardized forwarding
    const forwardedEvents = ['blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload']
    for (const event of forwardedEvents) {
      bot.world.on(event, (...args) => bot.emit(event, ...args))
    }
    const blockUpdateRegex = /blockUpdate:\(-?\d+, -?\d+, -?\d+\)/
    bot.on('newListener', (event, listener) => {
      if (blockUpdateRegex.test(event)) {
        bot.world.on(event, listener)
      }
    })
    bot.on('removeListener', (event, listener) => {
      if (blockUpdateRegex.test(event)) {
        bot.world.off(event, listener)
      }
    })
  }

  /**
   * Internal world hooks (owner U4 → U9): `reset(dimension)` (the dimension switch), `dimension()` (mineflayer
   * name), `pendingColumns` (columns waiting for sub-chunks), `paintings` (U7 registers add_painting here so
   * blockAt(…, true).painting works), `stateIdOf(runtimeId)`, `applyBlockUpdate(position, runtimeId, layer)`.
   */
  if (bot._bedrock) {
    bot._bedrock.world = {
      reset: resetWorld,
      dimension: () => dimension,
      pendingColumns,
      paintings: { add: addPainting, remove: deletePainting, byPos: paintingsByPos, byId: paintingsById },
      stateIdOf,
      applyBlockUpdate
    }
  }

  /**
   * Bedrock extra (U16a, docs/differences/U16a.md#block-variants): the ids of the Bedrock blocks that Java models as
   * one block with a state — a burning furnace is `lit_furnace`, a powered repeater `powered_repeater` — so
   * `bot.findBlock({ matching: bot.bedrock.blockVariants('furnace') })` also finds a furnace while it burns.
   * Accepts a block name or id; any other block → [its id]; unknown → [].
   */
  function blockVariants (block) {
    const def = typeof block === 'number' ? bot.registry.blocks[block] : bot.registry.blocksByName[block]
    if (!def) return []
    const group = BLOCK_VARIANTS.find((names) => names.includes(def.name)) ?? [def.name]
    return group.map((name) => bot.registry.blocksByName[name]?.id).filter((id) => id !== undefined)
  }
  if (bot.bedrock) bot.bedrock.blockVariants = blockVariants

  bot.findBlock = findBlock
  bot.canSeeBlock = canSeeBlock
  bot.blockAt = blockAt
  bot._updateBlockState = updateBlockState
  bot.waitForChunksToLoad = waitForChunksToLoad
}

/** Bedrock blocks that are one Java block with a `lit` / `powered` / `inverted` state (the Java name first) */
const BLOCK_VARIANTS = [
  ['furnace', 'lit_furnace'],
  ['blast_furnace', 'lit_blast_furnace'],
  ['smoker', 'lit_smoker'],
  ['redstone_ore', 'lit_redstone_ore'],
  ['deepslate_redstone_ore', 'lit_deepslate_redstone_ore'],
  ['redstone_lamp', 'lit_redstone_lamp'],
  ['redstone_torch', 'unlit_redstone_torch'],
  ['unpowered_repeater', 'powered_repeater'],
  ['unpowered_comparator', 'powered_comparator'],
  ['daylight_detector', 'daylight_detector_inverted']
]
