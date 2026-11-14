'use strict'
const { Vec3 } = require('vec3')
const { isBedd } = require('../bedrock/transactions')
const { ensureDispatch } = require('./routes')

/**
 * Screen-level actions with `transport: 'bedd'`: what the real client only does when its user clicks or types in a
 * screen. They go through BeDD v2's `ui` op (the game's JSON UI as a tree of nodes with refs: read a snapshot, then
 * `click` / `setText` a node by its ref), or, when the user allowed the packet in BeDD's `sendAllow`, as the packet
 * itself (the router's generic `send` path):
 *
 * | API                          | packet bedboo would send          | `ui` (default)                                  | `send` (id in sendAllow) |
 * |------------------------------|-----------------------------------|-------------------------------------------------|--------------------------|
 * | bot.respawn() / `respawn`    | respawn, player_action respawn    | the death screen's Respawn button               | — (client-owned)         |
 * | bot.wake()                   | player_action stop_sleeping       | the bed screen's wake-up button                 | 36                       |
 * | bot.updateSign(block, text)  | block_entity_data                 | the sign editor's text box (opened with a use click when it is not showing), then Done / ESC | 56 |
 * | bot.writeBook / signBook     | book_edit                         | the book screen is closed with ESC on release   | 97 (needed)              |
 * | (credits after the End exit) | show_credits end (client-owned)   | ESC while `credits_screen` shows (the client then sends its own) | — |
 *
 * A node is found by role and by its name or shown text (`RESPAWN`, `WAKE`, `SIGN_TEXT`, `DONE` below; Bedrock's
 * own screens: `respawn_button` on the death screen, `wake_up_button` "Leave Bed" on the bed screen, the text box of
 * the sign screen). Each action reads the tree again until the node shows up (or `timeoutMs`), and reads again on
 * `stale_snapshot` / `stale_ref` / `occluded`.
 *
 * `client.bedd.screens` = { read(args), find(snapshot, matcher), act(matcher, action, extra, opts), click(matcher,
 * opts), setText(matcher, text, opts), respawn(), wake(), editSign(position, text, opts), idle() } — also usable by
 * scripts for other screens (`bot.bedrock.bedd.screens`).
 */

const ACT_TIMEOUT_MS = 10000
const POLL_MS = 200
/** how long a sign editor the server just opened may take to show before bedboo opens it itself */
const SIGN_SHOW_MS = 1500
const SIGN_OPEN_TIMEOUT_MS = 5000
const RETRY_CODES = new Set(['stale_snapshot', 'stale_ref', 'occluded', 'not_ready'])
/** the credits: ESC every CREDITS_ESC_MS while credits_screen shows, for at most CREDITS_TIMEOUT_MS */
const CREDITS_ESC_MS = 300
const CREDITS_TIMEOUT_MS = 10000

function label (node) {
  return `${node?.name ?? ''} ${node?.text ?? ''}`
}

/** a node the user could act on: not hidden, not disabled */
function usable (node) {
  return node?.state?.visible !== false && node?.state?.enabled !== false
}

/** matchers: (node, { screen }) → boolean */
const RESPAWN = (node) => node.role === 'button' && /respawn/i.test(label(node))
const WAKE = (node) => node.role === 'button' && /wake|leave[\s_-]*bed|stop[\s_-]*sleep/i.test(label(node))
const SIGN_TEXT = (node, { screen }) => node.role === 'textbox' && /sign/i.test(`${screen} ${label(node)}`)
const DONE = (node, { screen }) => node.role === 'button' && /sign/i.test(screen) && /done|close|finish/i.test(label(node))

/**
 * The screen (root name) of every node of a `ui` snapshot.
 * @returns {Map<string, string>} ref → screen name
 */
function screensOf (snapshot) {
  const nodes = snapshot?.nodes ?? {}
  const out = new Map()
  const roots = Array.isArray(snapshot?.roots) ? snapshot.roots : Object.keys(nodes).filter(ref => nodes[ref]?.role === 'screen')
  for (const root of roots) {
    const screen = nodes[root]?.name ?? snapshot?.active ?? ''
    const stack = [root]
    while (stack.length) {
      const ref = stack.pop()
      if (out.has(ref)) continue
      out.set(ref, screen)
      for (const child of nodes[ref]?.children ?? []) stack.push(child)
    }
  }
  for (const ref of Object.keys(nodes)) if (!out.has(ref)) out.set(ref, snapshot?.active ?? '')
  return out
}

/**
 * The first usable node of `snapshot` `matcher` accepts (the top screen's first: it is the one in front).
 * @returns {{ ref: string, node: object, screen: string } | null}
 */
function findNode (snapshot, matcher) {
  const nodes = snapshot?.nodes ?? {}
  const screens = screensOf(snapshot)
  const order = [...screens.entries()].sort(([, a], [, b]) => (b === snapshot?.active) - (a === snapshot?.active))
  for (const [ref, screen] of order) {
    const node = nodes[ref]
    if (!node || !usable(node)) continue
    if (matcher(node, { ref, screen, snapshot })) return { ref, node, screen }
  }
  return null
}

/** the sign text of one side of a block_entity_data compound (`FrontText` / `BackText` → `Text`) */
function signSideText (nbt, side) {
  const v = nbt?.value?.[side]?.value?.Text?.value
  return typeof v === 'string' ? v : null
}

function attach (bot, client) {
  const bedd = client?.bedd
  if (!bedd) return null
  if (bedd.screens) return bedd.screens

  const present = (op) => (bedd.caps ?? {})[op] === 'present'
  const timers = client.options?.bedd?.screens?.timers ?? { setTimeout }
  const pollMs = client.options?.bedd?.screens?.pollMs ?? POLL_MS
  let chain = Promise.resolve()
  let openSign = null // the last open_sign: { position, isFront }

  function warn (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    if (client.listenerCount?.('warning')) client.emit('warning', error)
  }

  function sleep (ms) {
    return new Promise((resolve) => timers.setTimeout(resolve, ms))
  }

  async function call (op, args) {
    const reply = await bedd.rpc.call(op, args)
    if (reply && reply.ok === false) throw Object.assign(new Error(`bedd ${op}: ${reply.error ?? 'failed'}`), { code: reply.code })
    return reply
  }

  /** screen steps run one after another (a sign edit never interleaves with a respawn click) */
  function enqueue (steps) {
    const step = chain.then(steps)
    chain = step.catch(() => {})
    return step
  }

  function read (args = {}) {
    return call('ui', args)
  }

  /**
   * Find the node `matcher` accepts and do `action` on it (reading again until it shows up or `timeoutMs`).
   * @returns {Promise<{ ref, node, screen, reply }>}
   */
  async function act (matcher, action, extra = {}, { timeoutMs = ACT_TIMEOUT_MS, what = 'node' } = {}) {
    if (!present('ui')) throw Object.assign(new Error(`bedd: no 'ui' op to ${action} the ${what}`), { code: 'ERR_BEDD_UNSUPPORTED', bedd: true, missing: ['ui'] })
    const deadline = Date.now() + timeoutMs
    let lastError = null
    for (;;) {
      let snapshot = null
      try {
        snapshot = await read()
      } catch (err) {
        if (!RETRY_CODES.has(err.code)) throw err
        lastError = err
      }
      const found = snapshot && findNode(snapshot, matcher)
      if (found) {
        try {
          const reply = await call('ui', { snapshot: snapshot.snapshot, ref: found.ref, action, ...extra })
          return { ...found, reply }
        } catch (err) {
          if (!RETRY_CODES.has(err.code)) throw err
          lastError = err
        }
      }
      if (Date.now() >= deadline) {
        const err = new Error(`bedd: no ${what} to ${action} on the client's screens within ${timeoutMs} ms${lastError ? ` (${lastError.message})` : ''}`)
        err.code = 'timeout'
        throw err
      }
      await sleep(pollMs)
    }
  }

  /** whether a node `matcher` accepts is showing now (one read) */
  async function showing (matcher) {
    try {
      return findNode(await read(), matcher)
    } catch (err) {
      if (RETRY_CODES.has(err.code)) return null
      throw err
    }
  }

  async function waitFor (matcher, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = await showing(matcher)
      if (found || Date.now() >= deadline) return found
      await sleep(pollMs)
    }
  }

  async function key (name) {
    if (present('key')) await call('key', { key: name })
  }

  // --- respawn ----------------------------------------------------------------------------------------------------

  /** click the death screen's Respawn button (the real client then sends its own respawn packets) */
  function respawn () {
    return enqueue(() => act(RESPAWN, 'click', {}, { what: 'Respawn button' }))
  }

  /** bot.respawn(): upstream's state machine (its packets are client-owned and dropped), then the button */
  function wrapRespawn () {
    const previous = bot.respawn
    if (typeof previous !== 'function' || previous.beddScreens) return
    const wrapped = function (...args) {
      const result = previous.apply(this, args)
      if (isBedd(bot) && present('ui') && bot.isAlive === false) respawn().catch(warn)
      return result
    }
    Object.defineProperty(wrapped, 'length', { value: previous.length })
    wrapped.beddScreens = true
    wrapped.beddSurface = previous.beddSurface // the surface guard already wraps `previous`
    wrapped.original = previous
    bot.respawn = wrapped
  }

  // --- wake -------------------------------------------------------------------------------------------------------

  function wake () {
    return enqueue(() => act(WAKE, 'click', {}, { what: 'wake-up button' }))
  }

  // --- signs ------------------------------------------------------------------------------------------------------

  /**
   * Type `text` into the sign editor of the sign at `position` (opening it with a use click when it is not showing),
   * then close it: the client sends the block_entity_data itself.
   */
  function editSign (position, text, { back = false } = {}) {
    return enqueue(async () => {
      let box = await waitFor(SIGN_TEXT, openSign && samePos(openSign.position, position) ? SIGN_SHOW_MS : 0)
      if (!box) {
        const block = bot.blockAt?.(new Vec3(position.x, position.y, position.z))
        if (!block) throw new Error(`bedd: no sign at ${position.x} ${position.y} ${position.z} to edit`)
        await bot.activateBlock(block)
        box = await waitFor(SIGN_TEXT, SIGN_OPEN_TIMEOUT_MS)
        if (!box) throw Object.assign(new Error('bedd: the sign editor did not open (a waxed sign, or one of another player?)'), { code: 'timeout' })
      }
      if (openSign && openSign.isFront === back) {
        warn(new Error(`bedd: the client edits the ${openSign.isFront ? 'front' : 'back'} of the sign (the side it faces), not the ${back ? 'back' : 'front'}`))
      }
      await act(SIGN_TEXT, 'setText', { text }, { what: 'sign text box' })
      const done = await showing(DONE)
      if (done) await act(DONE, 'click', {}, { what: 'Done button', timeoutMs: 0 }).catch(() => key('ESC'))
      else await key('ESC')
    })
  }

  function samePos (a, b) {
    return !!a && !!b && Number(a.x) === Number(b.x) && Number(a.y) === Number(b.y) && Number(a.z) === Number(b.z)
  }

  // the server starts the credits (show_credits status 0 for the local player); its answer is client-owned
  client.on?.('show_credits', (packet) => {
    if (packet?.status === 0 && isBedd(bot)) enqueue(skipCredits).catch(warn)
  })

  client.on?.('open_sign', (packet) => {
    openSign = { position: packet.position, isFront: packet.is_front !== false }
  })

  /** block_entity_data of bot.updateSign: which side changed, and its text */
  function signEdit (params) {
    const position = params?.position
    const nbt = params?.nbt
    if (!position || !nbt) return null
    const front = signSideText(nbt, 'FrontText')
    const back = signSideText(nbt, 'BackText')
    if (front === null && back === null) return null
    const current = bot.blockAt?.(new Vec3(position.x, position.y, position.z))?.entity
    const changedBack = back !== null && back !== signSideText(current, 'BackText') && front === signSideText(current, 'FrontText')
    return { position, text: (changedBack ? back : front) ?? '', back: changedBack }
  }

  // --- books ------------------------------------------------------------------------------------------------------

  /** the book screen the use click opened is closed when bedboo releases the book (upstream: item_release) */
  async function closeBookScreen () {
    if (!present('world')) return
    const world = await call('world').catch(() => null)
    if (world?.showingMenu && /book/i.test(String(world.topScreen ?? ''))) await key('ESC')
  }

  // --- credits ----------------------------------------------------------------------------------------------------

  /**
   * Headless bedboo answers show_credits at once: skip the client's credits screen (`credits_screen`) the same way.
   * ESC shows its Skip button, ESC again exits; topScreen is read again before every press (one ESC too many would
   * open the pause screen). The client then sends show_credits status 1 itself.
   */
  async function skipCredits () {
    if (!present('world') || !present('key')) return
    const deadline = Date.now() + CREDITS_TIMEOUT_MS
    let pressed = 0
    while (Date.now() < deadline && pressed < 10) {
      const world = await call('world').catch(() => null)
      if (world && String(world.topScreen ?? '') === 'credits_screen') {
        await key('ESC')
        pressed++
        await sleep(CREDITS_ESC_MS)
      } else if (pressed > 0) {
        return
      } else {
        await sleep(CREDITS_ESC_MS) // the screen shows a little after show_credits
      }
    }
  }

  // --- routes -----------------------------------------------------------------------------------------------------

  const sendable = (name, params) => !!bedd.router?.sendable?.(name, params)
  const routes = ensureDispatch(bedd, { warn })
  // false: declined (the router then sends it as is when sendAllow has its id, else reports it unsupported)
  routes.register('player_action', (params) => {
    if (!isBedd(bot) || params?.action !== 'stop_sleeping') return false
    if (sendable('player_action', params) || !present('ui')) return false
    return wake()
  })
  routes.register('block_entity_data', (params) => {
    if (!isBedd(bot) || sendable('block_entity_data', params) || !present('ui')) return false
    const edit = signEdit(params)
    if (!edit) return false
    return editSign(edit.position, edit.text, { back: edit.back })
  })
  routes.register('inventory_transaction', (params) => {
    if (isBedd(bot) && params?.transaction?.transaction_type === 'item_release') enqueue(closeBookScreen).catch(warn)
    return false // router_actions translates the release itself
  })

  wrapRespawn()
  bot.once?.('inject_allowed', wrapRespawn)

  bedd.screens = {
    read,
    find: findNode,
    act,
    click: (matcher, opts) => enqueue(() => act(matcher, 'click', {}, opts)),
    setText: (matcher, text, opts) => enqueue(() => act(matcher, 'setText', { text }, opts)),
    respawn,
    wake,
    editSign,
    /** settles once every screen step queued so far is done */
    idle: () => chain
  }
  bot.bedrock = bot.bedrock ?? {}
  bot.bedrock.bedd = bot.bedrock.bedd ?? {}
  bot.bedrock.bedd.screens = bedd.screens
  return bedd.screens
}

module.exports = { attach, findNode, screensOf, signSideText, RESPAWN, WAKE, SIGN_TEXT, DONE, ACT_TIMEOUT_MS }
