// owner: BEDD-6 (real-client e2e + docs)
'use strict'
// Shared state of the opt-in real-client e2e (test/bedd/*.e2e.js, `corepack pnpm test:e2e:bedd`, docs/bedd.md).
//
// The suites drive a real Minecraft Bedrock client hosted by Be.D.D. through `createBot({ transport: 'bedd' })`.
// They need Windows (BeDD's pipes are Windows named pipes) and BEDBOO_BEDD_PIPE, the client's control pipe. Without
// either, or in a build without the 'bedd' transport, every suite is skipped (pending), never failed.
//
// One bot is shared by every file of the run (attached on first use, detached by hooks.js after the run): attaching
// replays BeDD's join journal, so attaching once keeps the run short.
//
// World modes:
// - remote: the client is in a BDS world. With BDS_CONTAINER set, setup commands and BDS-side assertions go through
//   the BDS console (@bedboo/bds, or `BEDBOO_BEDD_DOCKER`, e.g. `wsl -d Debian -e docker` where docker only runs in
//   WSL — see console.js).
// - local: singleplayer or a LAN world the client hosts (HELLO link type 'local'), or any world without a console.
//   Setup commands run as the player (`send` cap) and the effects are checked on the tapped state only.
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createConsole } = require('./console')

const PIPE = process.env.BEDBOO_BEDD_PIPE
const SPAWN_TIMEOUT = Number(process.env.BEDBOO_BEDD_SPAWN_TIMEOUT || 60000)
const DEBUG = process.env.BEDBOO_BEDD_DEBUG === '1'

/** Why the whole real-client e2e must be skipped here, or null when it can run. */
function skipReason () {
  if (process.platform !== 'win32') return `not Windows (${process.platform}): BeDD's pipes are Windows named pipes`
  if (!PIPE) return 'BEDBOO_BEDD_PIPE is not set (e.g. \\\\.\\pipe\\BeDD-1.26.51.01-hi20)'
  let transports
  try {
    transports = require('../../lib/client').TRANSPORTS
  } catch (err) {
    return `lib/client.js does not load: ${err.message}`
  }
  if (!Array.isArray(transports) || !transports.includes('bedd')) return "this build has no 'bedd' transport (lib/bedd is not merged)"
  return null
}

/** mocha `before` for every suite: skip the suite when the run is not possible */
function gate (suite) {
  const reason = skipReason()
  if (reason) {
    if (!gate.logged) console.log(`      [bedd e2e] skipped: ${reason}`)
    gate.logged = true
    suite.skip()
  }
}

let shared = null // Promise<Session>

/**
 * The shared session: `{ bot, caps, mode, console, name }`. Attaches on first call.
 * @returns {Promise<Session>}
 */
function session () {
  if (!shared) shared = createSession()
  return shared
}

async function createSession () {
  const mineflayer = require('../..')
  const bedd = { pipe: PIPE }
  if (process.env.BEDBOO_BEDD_TAP_PIPE) bedd.tapPipe = process.env.BEDBOO_BEDD_TAP_PIPE
  const bot = mineflayer.createBot({ transport: 'bedd', bedd, username: 'bedd-e2e' })
  bot.on('error', (err) => { if (DEBUG) console.error('[bedd e2e] bot error', err) })
  bot.on('kicked', (reason) => console.error('[bedd e2e] kicked/link down:', reason))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`no 'spawn' within ${SPAWN_TIMEOUT} ms: is the BeDD client in a world, with tap:true?`)), SPAWN_TIMEOUT)
    const onErr = (err) => done(err instanceof Error ? err : new Error(String(err)))
    const onEnd = (reason) => done(new Error(`bot ended before spawn: ${reason}`))
    function done (err) {
      clearTimeout(timer)
      bot.off('spawn', onSpawn)
      bot.off('error', onErr)
      bot.off('end', onEnd)
      err ? reject(err) : resolve()
    }
    function onSpawn () { done() }
    bot.once('spawn', onSpawn)
    bot.once('error', onErr)
    bot.once('end', onEnd)
  })
  assert.strictEqual(bot._bedrock?.mode, 'bedd', "bot._bedrock.mode is 'bedd'")

  const link = bot._client.bedd?.link ?? {}
  const forced = process.env.BEDBOO_BEDD_WORLD // 'remote' | 'local'
  const mode = forced === 'local' || forced === 'remote' ? forced : link.type === 'local' ? 'local' : 'remote'
  let console_ = null
  if (mode === 'remote' && process.env.BDS_CONTAINER) console_ = await createConsole(process.env.BDS_CONTAINER)
  const s = { bot, mode, console: console_, name: bot.username }
  if (DEBUG) console.log('[bedd e2e] session', { mode, link, name: s.name, caps: caps(s) })
  return s
}

/** End the shared session (hooks.js, after the whole run). The real client stays in its world. */
async function endSession () {
  if (!shared) return
  const s = await shared.catch(() => null)
  shared = null
  if (!s) return
  try { s.bot.end('e2e done') } catch {}
  await s.console?.close?.()
}

/** `bot.bedrock.bedd.caps` (BB5), else the transport's `client.bedd.caps` (BB1): { [op]: 'present'|'disabled'|'absent' } */
function caps (s) {
  return s.bot.bedrock?.bedd?.caps ?? s.bot._client.bedd?.caps ?? {}
}

/**
 * Skip the current test unless the API can work: `bot.bedrock.bedd.supports(api)` when the capability surface (BB5) is
 * there, else every op of `ops` must be 'present'.
 * @param {Mocha.Context} test
 * @param {Session} s
 * @param {string|null} api mineflayer API name passed to supports()
 * @param {string[]} [ops] BeDD control ops it needs
 */
function need (test, s, api, ops = []) {
  const c = caps(s)
  const supports = s.bot.bedrock?.bedd?.supports
  if (api && typeof supports === 'function') {
    if (!supports.call(s.bot.bedrock.bedd, api)) test.skip()
  }
  const missing = ops.filter((op) => c[op] !== 'present')
  if (missing.length) {
    if (DEBUG) console.log(`[bedd e2e] ${api}: caps ${missing.map((op) => `${op}=${c[op] ?? 'absent'}`).join(', ')}`)
    test.skip()
  }
}

/** Whether setup commands can run: on the BDS console (remote) or as the player through `send`. */
function canRunCommands (s) {
  return Boolean(s.console) || (caps(s).send === 'present' && typeof s.bot._bedrock?.commands?.request === 'function')
}

/** Skip the current test unless setup commands can run ({@link canRunCommands}). */
function needCommands (test, s) {
  if (!canRunCommands(s)) test.skip()
}

/**
 * Run a setup command: on the BDS console when there is one (no leading '/', the player addressed by name), else as
 * the player (command_request through `send`). Resolves with the output lines.
 * @param {Session} s
 * @param {string} cmd with `@s` standing for the player
 */
async function run (s, cmd) {
  if (s.console) return s.console.commandOutput(cmd.replace(/@s\b/g, target(s.name)))
  const out = await s.bot._bedrock.commands.request('/' + cmd, { timeout: 10000 })
  return (out.output ?? []).map((o) => [o.message_id, ...(o.parameters ?? [])].join(' '))
}

/** console target for a player name (quoted when it has spaces: Xbox gamertags may) */
function target (name) {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `"${String(name).replace(/"/g, '\\"')}"`
}

/** Poll `fn` until it returns a truthy value (resolved with it) or `timeout` ms pass (rejects naming `what`). */
async function until (fn, { timeout = 10000, interval = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what}`)
    await sleep(interval)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolve with the next echoed serverbound packet `name` matching `pred` (the client's own packets, BB1 'serverbound'). */
function nextServerbound (s, name, pred = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.bot._client.off('serverbound', on); reject(new Error(`no echoed ${name} within ${timeout} ms`)) }, timeout)
    function on (pkt) {
      if (pkt?.name !== name || !pred(pkt.params)) return
      clearTimeout(timer)
      s.bot._client.off('serverbound', on)
      resolve(pkt.params)
    }
    s.bot._client.on('serverbound', on)
  })
}

/**
 * Server-side feet position of the player (remote with a console), from `querytarget` ("Target data: [" + JSON with the
 * eye-level position); null without a console.
 */
async function serverPosition (s) {
  if (!s.console) return null
  const lines = await s.console.commandOutput(`querytarget ${target(s.name)}`)
  const start = lines.findIndex((l) => /^Target data: \[/.test(l))
  if (start < 0) return null
  const data = JSON.parse('[' + lines.slice(start + 1).join('\n'))
  const p = data[0]?.position
  return p ? { pos: new Vec3(p.x, p.y - 1.62, p.z), yRot: data[0].yRot } : null
}

/** Block name at `pos` on BDS (`testforblock`), only for the given candidate; true/false, or null without a console. */
async function serverBlockIs (s, pos, name) {
  if (!s.console) return null
  const lines = await s.console.commandOutput(`testforblock ${pos.x} ${pos.y} ${pos.z} ${name}`)
  return lines.some((l) => /Successfully found the block/i.test(l))
}

/** How many `item`s the player holds on BDS (`clear <p> <item> 0 0` counts without removing); null without a console. */
async function serverItemCount (s, item) {
  if (!s.console) return null
  const lines = await s.console.commandOutput(`clear ${target(s.name)} ${item} 0 0`)
  for (const l of lines) {
    const m = /has (\d+) items? that match/i.exec(l)
    if (m) return Number(m[1])
  }
  return 0 // "Could not clear the inventory of <p>, no items to remove"
}

/** Count of `itemName` in the bot's inventory window (tapped inventory_content / inventory_slot) */
function botItemCount (bot, itemName) {
  return bot.inventory.items().filter((i) => i.name === itemName).reduce((n, i) => n + i.count, 0)
}

let arena = null
/**
 * A cleared 13×13×4 air box around the player's feet on a stone floor (once per run; needs a command channel). The
 * suites place their blocks inside it. Resolves with the floored feet position the arena is centred on.
 */
async function prepareArena (s) {
  if (arena) return arena
  const base = s.bot.entity.position.floored()
  const { x, y, z } = base
  await run(s, 'gamemode survival @s')
  await run(s, `fill ${x - 6} ${y} ${z - 6} ${x + 6} ${y + 3} ${z + 6} air`)
  await run(s, `fill ${x - 6} ${y - 1} ${z - 6} ${x + 6} ${y - 1} ${z + 6} stone`)
  await run(s, `tp @s ${x + 0.5} ${y} ${z + 0.5}`)
  await until(() => s.bot.blockAt(base.offset(0, -1, 0))?.name === 'stone', { what: 'the arena floor on the tap', timeout: 10000 })
  arena = base
  return arena
}

/** Put `count` × `item` into hotbar slot `slot` (0..8) and wait until the tapped inventory shows it. */
async function giveHotbar (s, slot, item, count) {
  await run(s, `replaceitem entity @s slot.hotbar ${slot} ${item} ${count}`)
  const invSlot = s.bot.inventory.hotbarStart + slot
  await until(() => s.bot.inventory.slots[invSlot]?.name === item, { what: `${item} in hotbar slot ${slot}` })
}

module.exports = {
  skipReason,
  gate,
  session,
  endSession,
  caps,
  need,
  canRunCommands,
  needCommands,
  run,
  target,
  until,
  sleep,
  nextServerbound,
  serverPosition,
  serverBlockIs,
  serverItemCount,
  botItemCount,
  prepareArena,
  giveHotbar
}
