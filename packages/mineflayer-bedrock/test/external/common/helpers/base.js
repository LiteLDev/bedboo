// owner: U1 (BDS harness & e2e infra)
'use strict'
/**
 * Base helpers + the shared helper context (packet tracker, console, raw command/chat channels).
 *
 * Upstream: mineflayer 4.39.0 test/externalTests/plugins/testCommon.js (MIT, Copyright (c) 2013
 * Andrew Kelley) — same helper names, signatures and semantics; the transport is the BDS console
 * (@bedboo/bds) and raw Bedrock packets (`bot._client`) instead of the Java server wrapper and
 * mineflayer plugins.
 *
 * Installs: groundY, port/host/server, wait, dumpMarker, sayEverywhere, awaitCommandsProcessed,
 * command, commandWithOutput, botCommand, becomeCreative, becomeSurvival, setGameMode, teleport, fly,
 * selfKill, awaitRespawn, tellAndListen, runExample, abortRunningExample, resetState.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { EYE_HEIGHT } = require('../../../../lib/bedrock/constants')
const { isStub } = require('../../../../lib/bedrock/errors')

const TIMEOUT = 5000
/** Feet y of the default flat world (bedrock -64, dirt -63/-62, grass_block -61). */
const GROUND_Y = -60
/** Bedrock `execute in` dimension names */
const EXECUTE_DIMENSION = { overworld: 'overworld', the_nether: 'nether', nether: 'nether', the_end: 'the_end' }

/** @returns {boolean} whether `fn` is a real implementation (not missing, not a NotImplemented stub) */
function implemented (fn) {
  return typeof fn === 'function' && !isStub(fn)
}

const stripFormatting = (s) => String(s ?? '').replace(/§./g, '')

/** Quote a player name for a command selector position. */
function target (name) {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `"${String(name).replace(/"/g, '\\"')}"`
}

// add_player.unique_id is an li64, which protodef reads as [high, low] (U7 fix)
const big = (v) => (v === undefined || v === null ? null : Array.isArray(v) ? BigInt.asIntN(64, (BigInt(v[0]) << 32n) | BigInt(v[1] >>> 0)) : BigInt(v))

/**
 * Packet tracker: everything the helpers need about the local player, from raw packets only.
 * Prefers mineflayer state (bot.entity, bot.game, bot.inventory) when those plugins are real.
 */
function createTracker (bot) {
  const client = bot._client
  const events = new EventEmitter()
  events.setMaxListeners(0)
  const state = {
    events,
    startGame: bot._bedrock?.startGame ?? null,
    runtimeId: null,
    uniqueId: null,
    position: null, // feet Vec3
    gameMode: null,
    dimension: 'overworld',
    alive: true,
    spawned: false,
    itemNames: new Map(), // network id → name (no namespace)
    itemIds: new Map(), // name → network id
    inventory: { inventory: [], armor: [], offhand: [], ui: [] },
    inventoryKnown: false,
    entities: new Map(), // Number(runtime id) → { runtimeId, uniqueId, type, name, position }
    worldDirty: true
  }

  function setFromStartGame (p) {
    state.startGame = p
    state.runtimeId = big(p.runtime_entity_id)
    state.uniqueId = big(p.entity_id)
    state.position = new Vec3(p.player_position.x, p.player_position.y - EYE_HEIGHT, p.player_position.z)
    state.gameMode = p.player_gamemode === 'fallback' ? p.world_gamemode : p.player_gamemode
    if (p.dimension !== undefined) state.dimension = typeof p.dimension === 'string' ? p.dimension : ['overworld', 'the_nether', 'the_end'][p.dimension]
    for (const it of p.itemstates ?? []) addItem(it)
  }
  function addItem (it) {
    const name = String(it.name).replace(/^minecraft:/, '')
    state.itemNames.set(it.runtime_id, name)
    state.itemIds.set(name, it.runtime_id)
  }
  if (state.startGame) setFromStartGame(state.startGame)

  const isSelfRuntime = (id) => state.runtimeId !== null && big(id) === state.runtimeId
  const toItem = (wire) => {
    if (!wire || !wire.network_id) return null
    // item_registry (seen when injected at creation), else the bot's registry (helpers injected late)
    const name = state.itemNames.get(wire.network_id) ?? bot.registry?.items?.[wire.network_id]?.name ?? `#${wire.network_id}`
    return { name, networkId: wire.network_id, count: wire.count, metadata: wire.metadata }
  }

  client.on('start_game', setFromStartGame)
  client.on('item_registry', (p) => { for (const it of p.itemstates ?? []) addItem(it) })
  client.on('move_player', (p) => {
    if (!isSelfRuntime(p.runtime_id)) return
    state.position = new Vec3(p.position.x, p.position.y - EYE_HEIGHT, p.position.z)
    events.emit('move', state.position, p)
  })
  client.on('correct_player_move_prediction', (p) => {
    if (p.prediction_type !== undefined && p.prediction_type !== 'player' && p.prediction_type !== 0) return
    state.position = new Vec3(p.position.x, p.position.y - EYE_HEIGHT, p.position.z)
  })
  client.on('respawn', (p) => {
    if (p.state === 1) state.position = new Vec3(p.position.x, p.position.y - EYE_HEIGHT, p.position.z)
  })
  const onGameMode = (p) => {
    if (p.player_unique_id !== undefined && state.uniqueId !== null && big(p.player_unique_id) !== state.uniqueId) return
    state.gameMode = p.gamemode
    events.emit('gameMode', p.gamemode)
  }
  client.on('update_player_game_type', onGameMode)
  client.on('set_player_game_type', onGameMode)
  client.on('change_dimension', (p) => {
    state.dimension = typeof p.dimension === 'string' ? p.dimension : ['overworld', 'the_nether', 'the_end'][p.dimension]
  })
  client.on('set_health', (p) => {
    if (p.health > 0 && !state.alive) {
      state.alive = true
      events.emit('alive')
    }
  })
  client.on('entity_event', (p) => {
    if (!isSelfRuntime(p.runtime_entity_id)) return
    if (p.event_id === 'death_animation' && state.alive) {
      state.alive = false
      events.emit('death')
    } else if (p.event_id === 'respawn' && !state.alive) {
      state.alive = true
      events.emit('alive')
    }
  })
  client.on('inventory_content', (p) => {
    const win = typeof p.window_id === 'string' ? p.window_id : String(p.window_id)
    if (!(win in state.inventory)) return
    state.inventory[win] = p.input.map(toItem)
    if (win === 'inventory') state.inventoryKnown = true
    events.emit('inventory', win)
  })
  client.on('inventory_slot', (p) => {
    const win = typeof p.window_id === 'string' ? p.window_id : String(p.window_id)
    if (!(win in state.inventory)) return
    state.inventory[win][p.slot] = toItem(p.item)
    events.emit('inventory', win)
  })
  const addEntity = (p, type) => {
    const runtimeId = big(p.runtime_id ?? p.runtime_entity_id)
    const uniqueId = big(p.unique_id ?? p.entity_id_self)
    const fullType = type ?? p.entity_type
    const e = {
      id: Number(runtimeId),
      runtimeId,
      uniqueId,
      type: fullType,
      name: String(fullType).replace(/^minecraft:/, ''),
      position: new Vec3(p.position.x, p.position.y, p.position.z)
    }
    state.entities.set(e.id, e)
    events.emit('entitySpawn', e)
  }
  client.on('add_entity', (p) => addEntity(p))
  client.on('add_item_entity', (p) => addEntity(p, 'minecraft:item'))
  client.on('add_player', (p) => addEntity({ ...p, unique_id: p.unique_id ?? p.unique_entity_id }, 'minecraft:player'))
  client.on('remove_entity', (p) => {
    const uniqueId = big(p.entity_id_self)
    for (const [id, e] of state.entities) {
      if (e.uniqueId === uniqueId) {
        state.entities.delete(id)
        events.emit('entityGone', e)
      }
    }
    events.emit('removeEntity', uniqueId)
  })
  client.on('update_block', () => { state.worldDirty = true })
  client.on('update_subchunk_blocks', () => { state.worldDirty = true })
  return state
}

/**
 * Raw-client behaviour for bots whose plugins do not handle it yet (RawBot, or mineflayer-bedrock
 * before U4/U9): join handshake (respawn state 1 → client state 2, serverbound_loading_screen 1/2
 * after play_status player_spawn — without them BDS does not simulate the player) and the respawn
 * handshake after death (client respawn state 2 → server state 1 → player_action respawn).
 */
function installRawClientBehaviour (bot, ctx, opts) {
  const client = bot._client
  const state = ctx.state
  // Decided when the packets arrive, not at inject time: inject() runs synchronously in onCreate, before
  // `inject_allowed` injects the plugins (bot.respawn does not exist yet at that point).
  const handlesJoin = () => implemented(bot._bedrock?.lifecycle?.markSpawned)
  const handlesRespawn = () => implemented(bot.respawn)
  ctx.raw = {
    get join () { return !handlesJoin() },
    get respawn () { return !handlesRespawn() && opts.autoRespawn !== false }
  }

  // BDS 1.26.51.1 death: entity_event death_animation, then respawn state 0 (searching) at the
  // death position. Client "Respawn" button: respawn state 2 (client_ready) → server respawn
  // state 0 + state 1 (ready, eye-level spawn position) → client player_action respawn → server
  // entity_event respawn + set_health 20. A state 2 sent before the server's state 0 is ignored.
  // The join also starts with respawn state 0 ×2 + state 1: only a state 0 after a death counts.
  let deathScreen = false
  let respawning = false
  let state0WhileAlive = false
  const resetRespawn = () => { deathScreen = false; respawning = false; state0WhileAlive = false }

  // join handshake (raw bots / a bot whose lifecycle does not handle the join)
  client.on('start_game', () => {
    state.spawned = false
    resetRespawn()
  })
  client.on('respawn', (p) => {
    if (!ctx.raw.join) return
    if (p.state === 1 && state.runtimeId !== null && !state.spawned) {
      client.queue('respawn', { position: p.position, state: 2, runtime_entity_id: state.runtimeId })
    }
  })
  client.on('spawn', () => {
    if (!ctx.raw.join) return
    client.queue('serverbound_loading_screen', { type: 1 })
    client.queue('serverbound_loading_screen', { type: 2 })
    state.spawned = true
    resetRespawn()
    state.events.emit('spawn')
    if (bot._rawBot) bot.emit('spawn')
  })
  // a bot that spawns by itself (mineflayer-bedrock's lifecycle): track it
  if (!bot._rawBot && typeof bot.on === 'function') {
    bot.on('spawn', () => {
      if (ctx.raw.join) return
      state.spawned = true
      resetRespawn()
    })
  }

  // respawn handshake after a death (until bot.respawn is implemented)
  const pressRespawn = () => {
    if (!ctx.raw.respawn || respawning || !deathScreen || state.alive) return
    respawning = true
    deathScreen = false
    client.queue('respawn', { position: { x: 0, y: 0, z: 0 }, state: 2, runtime_entity_id: state.runtimeId })
  }
  client.on('respawn', (p) => {
    if (!ctx.raw.respawn || !state.spawned) return // the join handshake is not a respawn
    if (p.state === 0 && !respawning) {
      if (state.alive) {
        state0WhileAlive = true // arrived before the death event
        return
      }
      deathScreen = true
      pressRespawn()
    } else if (p.state === 1 && respawning) {
      respawning = false
      client.queue('player_action', {
        runtime_entity_id: state.runtimeId,
        action: 'respawn',
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: -1
      })
    }
  })
  state.events.on('death', () => {
    if (state0WhileAlive) {
      state0WhileAlive = false
      deathScreen = true
    }
    pressRespawn()
  })
  state.events.on('alive', resetRespawn)
}

/**
 * Shared context for helper files.
 * @returns {object} ctx
 */
function createContext (bot, server, opts = {}) {
  const state = createTracker(bot)
  const ctx = {
    bot,
    server,
    state,
    Vec3,
    TIMEOUT,
    GROUND_Y,
    implemented,
    stripFormatting,
    target,
    /** the bot's username (bot.username is only set once U4's game plugin runs) */
    username () {
      return bot.username ?? bot._client?.username ?? bot._client?.options?.username ?? opts.username
    },
    /** selector-safe username */
    who () {
      return target(ctx.username())
    },
    /** feet position: bot.entity.position when the entity plugin is real, else tracked from packets */
    position () {
      return bot.entity?.position ?? state.position
    },
    /** `execute in <dim> run …` prefix for the bot's current dimension */
    inDimension () {
      const dim = EXECUTE_DIMENSION[bot.game?.dimension ?? state.dimension] ?? 'overworld'
      return `execute in ${dim} run `
    },
    /** console command (fire and forget once written) */
    console: (cmd) => server.command(cmd),
    /** console command → every message it printed (bounded by a console marker) */
    consoleOutput: (cmd, o) => server.commandOutput(cmd, o),
    /**
     * Console command that must succeed: resolves with its first output message matching `ok`,
     * throws with the whole output otherwise (fails fast on any BDS error message).
     */
    async consoleExpect (cmd, ok, what = cmd) {
      const lines = await server.commandOutput(cmd)
      const hit = lines.find((l) => ok.test(l))
      if (hit === undefined) throw new Error(`${what}: ${lines.join(' | ') || '(no output)'}`)
      return hit
    },
    /**
     * Wait for a raw packet. Arm it BEFORE triggering the packet.
     * @returns {{ promise: Promise<object>, cancel: () => void }}
     */
    packet (name, predicate = () => true, timeout = TIMEOUT) {
      const names = Array.isArray(name) ? name : [name]
      let cancel
      const promise = new Promise((resolve, reject) => {
        const listeners = names.map((n) => {
          const fn = (params) => {
            let ok
            try { ok = predicate(params, n) } catch (err) { done(); return reject(err) }
            if (ok) { done(); resolve(params) }
          }
          bot._client.on(n, fn)
          return [n, fn]
        })
        const timer = setTimeout(() => { done(); reject(new Error(`timed out after ${timeout} ms waiting for ${names.join('|')}`)) }, timeout)
        function done () {
          clearTimeout(timer)
          for (const [n, fn] of listeners) bot._client.removeListener(n, fn)
        }
        cancel = () => { done(); resolve(null) }
      })
      return { promise, cancel }
    },
    /** Wait for a tracker event (`move`, `death`, `alive`, `inventory`, `entitySpawn`, `entityGone`, `spawn`, …). */
    event (name, predicate = () => true, timeout = TIMEOUT) {
      return new Promise((resolve, reject) => {
        const fn = (...args) => {
          if (!predicate(...args)) return
          clearTimeout(timer)
          state.events.removeListener(name, fn)
          resolve(args)
        }
        const timer = setTimeout(() => {
          state.events.removeListener(name, fn)
          reject(new Error(`timed out after ${timeout} ms waiting for ${name}`))
        }, timeout)
        state.events.on(name, fn)
      })
    },
    /**
     * Run a command as the bot (raw command_request → command_output, correlated by origin uuid).
     * @returns {Promise<object>} the command_output params
     */
    async botCommand (cmd, timeout = 10000) {
      const uuid = crypto.randomUUID()
      const out = ctx.packet('command_output', (p) => p.origin?.uuid === uuid, timeout)
      bot._client.queue('command_request', {
        command: cmd.startsWith('/') ? cmd : `/${cmd}`,
        origin: { type: 'player', uuid, request_id: '', player_entity_id: 0n },
        internal: false,
        version: 'latest'
      })
      return out.promise
    },
    /** Send a chat message as the bot (bot.chat when implemented, else a raw `text` packet). */
    chat (message) {
      if (implemented(bot.chat)) return bot.chat(message)
      bot._client.queue('text', {
        needs_translation: false,
        category: 'authored',
        type: 'chat',
        source_name: ctx.username(),
        message,
        xuid: '',
        platform_chat_id: '',
        has_filtered_message: false
      })
    },
    /** Resolves when the bot spawned (raw join handshake done, or mineflayer `spawn`). */
    waitForSpawn () {
      const spawned = ctx.raw.join ? state.spawned : bot._bedrock?.lifecycle?.state === 'spawned'
      if (spawned) return Promise.resolve()
      const emitter = ctx.raw.join ? state.events : bot
      return new Promise((resolve, reject) => {
        const onSpawn = () => { bot.removeListener('end', onEnd); resolve() }
        const onEnd = (reason) => { emitter.removeListener('spawn', onSpawn); reject(new Error(`bot ended before spawning: ${reason}`)) }
        emitter.once('spawn', onSpawn)
        bot.once('end', onEnd)
      })
    }
  }
  installRawClientBehaviour(bot, ctx, opts)
  return ctx
}

function install (bot, ctx) {
  const { state, server, Vec3 } = ctx
  const t = bot.test

  t.groundY = GROUND_Y
  t.port = server.port
  t.host = server.host
  t.server = server
  t.ctx = ctx
  t.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  t.dumpMarker = (msg) => {
    if (process.env.BEDBOO_TRACE) console.log(`[trace ${new Date().toISOString()}] ${msg}`)
  }

  /** like upstream bot.chat(message) + local log: '/…' as the bot's own command, else a chat message */
  t.sayEverywhere = (message) => {
    t.dumpMarker(message)
    console.log(message)
    // upstream: bot.chat(message) — a '/command' runs as the bot (command_request), anything else is chat
    const sent = String(message).startsWith('/')
      ? ctx.botCommand(String(message))
      : Promise.resolve().then(() => ctx.chat(String(message)))
    return sent.then(() => {}, (err) => console.error(`sayEverywhere: ${err.message}`))
  }
  /** resolve once every console command written before has been executed */
  t.awaitCommandsProcessed = () => server.awaitCommandsProcessed()
  t.command = (cmd) => server.command(cmd)
  t.commandWithOutput = (cmd, matcher, opts) => server.commandWithOutput(cmd, matcher, opts)
  t.botCommand = (cmd, timeout) => ctx.botCommand(cmd, timeout)

  async function setGameMode (mode) {
    const current = bot.game?.gameMode ?? state.gameMode
    if (current === mode && state.gameMode === mode) return
    const changed = ctx.event('gameMode', (m) => m === mode, TIMEOUT)
    changed.catch(() => {})
    await ctx.consoleExpect(`gamemode ${mode} ${ctx.who()}`, /game mode to/i)
    if (state.gameMode === mode) return // tracker already up to date
    if (state.gameMode === null) {
      // unknown mode (helpers injected late): the server sends nothing if it was already `mode`
      await Promise.race([changed, t.wait(1000)]).catch(() => {})
      state.gameMode = mode
      return
    }
    await changed
  }
  t.setGameMode = setGameMode
  t.becomeCreative = () => setGameMode('creative')
  t.becomeSurvival = () => setGameMode('survival')

  /** Teleport to `position` (overworld) and resolve once the server moved the bot within 0.9 blocks. */
  t.teleport = async (position) => {
    const moved = ctx.event('move', (pos) => pos.distanceTo(position) < 0.9, TIMEOUT)
    moved.catch(() => {})
    await ctx.consoleExpect(`execute in overworld run tp ${ctx.who()} ${position.x} ${position.y} ${position.z}`, /^Teleported/, 'teleport')
    await moved
  }

  /** Move by `delta` (console tp; creative flight is U5's). */
  t.fly = async (delta) => {
    const from = ctx.position()
    if (!from) throw new Error('fly: bot position unknown')
    const dest = from.plus(delta)
    const moved = ctx.event('move', (pos) => pos.distanceTo(dest) < 0.9, TIMEOUT)
    moved.catch(() => {})
    await ctx.consoleExpect(`${ctx.inDimension()}tp ${ctx.who()} ${dest.x} ${dest.y} ${dest.z}`, /^Teleported/, 'fly')
    await moved
  }

  /**
   * Kill the bot (console `kill`). Bedrock refuses to kill creative players ("Players cannot be
   * killed while they are in Creative mode"), so a creative/spectator bot is switched to survival
   * first. Resolves once the death was observed; in raw mode the respawn handshake follows
   * automatically (see awaitRespawn).
   */
  t.selfKill = async () => {
    const mode = bot.game?.gameMode ?? state.gameMode
    if (mode !== 'survival' && mode !== 'adventure') await setGameMode('survival')
    const dead = ctx.event('death', () => true, TIMEOUT)
    dead.catch(() => {})
    await ctx.consoleExpect(`kill ${ctx.who()}`, /^Killed/, 'selfKill')
    await dead
  }
  /** Resolve once the bot is alive again (after selfKill / any death). */
  t.awaitRespawn = (timeout = 10000) => (state.alive ? Promise.resolve() : ctx.event('alive', () => true, timeout).then(() => {}))

  /**
   * Chat `what` and resolve with [username, message] of the first chat from `to` for which
   * `listen(message)` is truthy (upstream: bot 'chat' event; here raw `text` packets).
   */
  t.tellAndListen = (to, what, listen) => {
    const heard = new Promise((resolve, reject) => {
      const onText = (p) => {
        if (p.type !== 'chat') return
        const from = stripFormatting(p.source_name)
        if (from !== to) return
        let ok
        try { ok = listen(p.message) } catch (err) { cleanup(); return reject(err) }
        if (ok) { cleanup(); resolve([from, p.message]) }
      }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`tellAndListen: no matching chat from ${to} within ${TIMEOUT} ms`)) }, TIMEOUT)
      function cleanup () {
        clearTimeout(timer)
        bot._client.removeListener('text', onText)
      }
      bot._client.on('text', onText)
    })
    ctx.chat(what)
    return heard
  }

  // runExample — upstream spawns `node <file> 127.0.0.1 <port>` and coordinates over chat
  let runningExample = null
  t.abortRunningExample = () => {
    runningExample?.abort(new Error('a previous attempt of this example is still running'))
    runningExample = null
  }
  t.runExample = async (file, run) => {
    const abort = new AbortController()
    runningExample = abort
    const signal = abort.signal
    // upstream paths are relative to the package root ('examples/bee.js'); fall back to the repo root
    const candidates = path.isAbsolute(file) ? [file] : [path.join(__dirname, '../../../..', file), path.join(__dirname, '../../../../../..', file)]
    const exampleFile = candidates.find((f) => fs.existsSync(f)) ?? candidates[0]
    let childBotName

    const onAbort = (fn) => signal.addEventListener('abort', fn, { once: true })
    const joined = new Promise((resolve, reject) => {
      const onList = (p) => {
        // bedrock-protocol: `records` is either an array of records (each with `type`) or { type, records }
        const records = Array.isArray(p.records) ? p.records : (p.records?.records ?? []).map((r) => ({ type: p.records.type, ...r }))
        for (const r of records) {
          if (r.type === 'add' && r.username && r.username !== ctx.username()) { cleanup(); return resolve(r.username) }
        }
      }
      const cleanup = () => bot._client.removeListener('player_list', onList)
      bot._client.on('player_list', onList)
      onAbort(() => { cleanup(); reject(signal.reason) })
    })
    const detectChildJoin = async () => {
      childBotName = await joined
      const dest = new Vec3(50, GROUND_Y, 0)
      // the player list entry arrives before the child spawned: retry until it is targetable
      for (;;) {
        if (signal.aborted) throw signal.reason
        const out = await server.commandOutput(`tp ${target(childBotName)} ${dest.x} ${dest.y} ${dest.z}`)
        if (out.some((l) => /^Teleported/.test(l))) break
        await t.wait(200)
      }
      // wait until the server reports the child at the destination
      for (;;) {
        if (signal.aborted) throw signal.reason
        const pos = await queryTargetPosition(server, childBotName)
        if (pos && pos.distanceTo(dest) <= 5) break
        await t.wait(100)
      }
      ctx.chat('loaded')
    }
    const runExampleOnReady = async () => {
      await new Promise((resolve, reject) => {
        const onText = (p) => {
          if (p.type === 'chat' && p.message === 'Ready!') { cleanup(); resolve() }
        }
        const cleanup = () => bot._client.removeListener('text', onText)
        bot._client.on('text', onText)
        onAbort(() => { cleanup(); reject(signal.reason) })
      })
      return run(childBotName)
    }

    const child = spawn(process.execPath, [exampleFile, '127.0.0.1', `${server.port}`])
    child.stdout.on('data', (data) => { console.log(`${data}`) })
    child.stderr.on('data', (data) => { console.error(`${data}`) })
    const childDied = new Promise((resolve, reject) => {
      child.once('close', (code, sig) => reject(new Error(`${file} exited before the test finished (code ${code}, signal ${sig})`)))
      onAbort(() => resolve())
    })

    const closeExample = async (err) => {
      abort.abort(err ?? new Error(`${file} finished`))
      if (runningExample === abort) runningExample = null
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5000)
          child.once('close', () => { clearTimeout(timer); resolve() })
        })
      }
      if (err) throw err
    }
    try {
      await Promise.race([Promise.all([detectChildJoin(), runExampleOnReady()]), childDied])
    } catch (err) {
      return closeExample(err)
    }
    return closeExample()
  }

  /**
   * Upstream semantics: creative mode, at (0, groundY, 0), superflat around the origin restored if any
   * block changed since the last reset, empty inventory. Always leaves the bot in creative mode.
   */
  t.resetState = async () => {
    await t.becomeCreative()
    if (implemented(bot.creative?.startFlying)) bot.creative.startFlying()
    const origin = new Vec3(0, GROUND_Y, 0)
    const pos = ctx.position()
    if (!pos || pos.distanceTo(origin) >= 0.9) {
      await t.teleport(origin)
      if (implemented(bot.waitForChunksToLoad)) await bot.waitForChunksToLoad()
    }
    if (state.worldDirty) {
      await t.resetBlocksToSuperflat()
      state.worldDirty = false
    }
    const invReal = implemented(bot.setQuickBarSlot) && bot.inventory
    const nonEmpty = invReal
      ? bot.inventory.slots.some((slot) => slot != null) || bot.inventory.selectedItem
      : !state.inventoryKnown || Object.values(state.inventory).some((win) => win.some(Boolean))
    if (nonEmpty) await t.clearInventory()
  }
}

/**
 * Server-side feet position of a player from `querytarget` (prints "Target data: [" followed by a
 * JSON block with the eye-level position), or null if it is not targetable.
 */
async function queryTargetPosition (server, name) {
  const lines = await server.commandOutput(`querytarget ${target(name)}`)
  const start = lines.findIndex((l) => /^Target data: \[/.test(l))
  if (start < 0) return null
  try {
    const data = JSON.parse('[' + lines.slice(start + 1).join('\n'))
    const p = data[0]?.position
    return p ? new Vec3(p.x, p.y - EYE_HEIGHT, p.z) : null
  } catch {
    return null
  }
}

module.exports = install
module.exports.createContext = createContext
module.exports.createTracker = createTracker
module.exports.queryTargetPosition = queryTargetPosition
module.exports.implemented = implemented
module.exports.GROUND_Y = GROUND_Y
module.exports.target = target
