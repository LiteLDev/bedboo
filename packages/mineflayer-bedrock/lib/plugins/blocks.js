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
// - network_chunk_publisher_update: columns farther than the publisher radius (+1 chunk) are unloaded →
//   'chunkColumnUnload'.
// - start_game / the lifecycle's 'dimensionChange' (change_dimension): bot._bedrock.world.reset(dimension) unloads
//   every column (upstream's switchWorld); U9 calls the same hook for its dimension flow.
// - block entities (U9, upstream tile_entity_data): block.entity / block.blockEntity from the sub-chunk payloads'
//   NBT and from block_entity_data { position, nbt } (stored on the column, then 'blockEntityData' with
//   bot.blockAt(position)); a block replaced by another block type loses its block entity (BDS sends the new one
//   right after the update_block). Signs: block.signText / getSignText() read FrontText/BackText (prismarine-block
//   patch); sign editing is sign.js.
'use strict'
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
      if (!column) continue
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

  bot._client.on('network_chunk_publisher_update', (packet) => {
    const { x, z } = packet.coordinates
    const limit = packet.radius + 16 // one chunk of slack: never drop a column the server still considers sent
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

  function applyBlockUpdate (position, runtimeId, layer) {
    const point = new Vec3(position.x, position.y, position.z)
    const stateId = stateIdOf(runtimeId)
    if (!bot.world.getColumnAt(point)) {
      // column still waiting for its sub-chunks: keep the change, without events
      const pending = pendingColumns.get(`${Math.floor(point.x / 16)},${Math.floor(point.z / 16)}`)
      if (pending) {
        const local = new Vec3(point.x & 15, point.y, point.z & 15)
        if (layer === 1) local.l = 1
        const stale = layer !== 1 && staleBlockEntity(pending.column, local, stateId)
        pending.column.setBlockStateId(local, stateId)
        if (stale) pending.column.removeBlockEntity(local)
      }
      return
    }
    if (layer === 1) {
      updateLiquidLayer(point, stateId)
    } else {
      const column = bot.world.getColumnAt(point)
      const local = new Vec3(point.x & 15, point.y, point.z & 15)
      const stale = staleBlockEntity(column, local, stateId)
      updateBlockState(point, stateId) // 'blockUpdate' with the old block still carrying its block entity
      if (stale) column.removeBlockEntity(local)
    }
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

  bot.findBlock = findBlock
  bot.canSeeBlock = canSeeBlock
  bot.blockAt = blockAt
  bot._updateBlockState = updateBlockState
  bot.waitForChunksToLoad = waitForChunksToLoad
}
