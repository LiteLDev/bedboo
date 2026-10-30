// owner: BEDD-2 (route registry shared by every bedd module: router, router_actions, inventory)
'use strict'
/**
 * The one route registry of `transport: 'bedd'`. Every serverbound packet bedboo would send reaches
 * `client.bedd.route(name, params)`; the router (./router.js) translates the core packets itself and hands the rest to
 * the handlers other modules register here:
 *
 *   const routes = ensureRoutes(client.bedd)               // created by whoever attaches first, idempotent
 *   const off = routes.register(name, handler)             // → unregister function; the same fn registers once
 *   handler(params, ctx)                                   // ctx.name is always set (the router adds call, present, …)
 *
 * - Handlers of a name run in registration order. A handler that returns exactly `false` declines the packet; when
 *   every handler declines, the router falls back to its built-in translation (or the unsupported error).
 * - player_auth_input: the router runs its own movement/look translation first, then dispatches the parts under the
 *   pseudo-names 'block_action' (params = the block_action array) and 'item_stack_request' (params =
 *   `{ requests: [request] }`, ctx.embedded = true), then the 'player_auth_input' handlers. Inside the tick a handler
 *   never throws to the bot (it only warns).
 * - item_stack_request sent on its own is dispatched under its own name (BEDD-7's handler).
 *
 * Without the router (a custom `bedd.modules` list, unit tests) `ensureDispatch(bedd)` installs a minimal
 * `bedd.route` that does the same dispatch and hands unhandled names to the previous route (BEDD-1's default drops
 * and counts them).
 */

const REGISTRY_MARK = Symbol.for('bedboo.bedd.routes')
const DISPATCH = Symbol.for('bedboo.bedd.routes.dispatch')

/** The handler registry (see the header). */
function createRouteRegistry () {
  const handlers = new Map()
  return {
    [REGISTRY_MARK]: true,
    handlers,
    register (name, handler) {
      if (typeof name !== 'string' || typeof handler !== 'function') throw new TypeError('routes.register(name, handler)')
      let list = handlers.get(name)
      if (!list) handlers.set(name, (list = []))
      if (!list.includes(handler)) list.push(handler)
      return () => {
        const i = list.indexOf(handler)
        if (i >= 0) list.splice(i, 1)
      }
    },
    /** a copy: a handler may unregister during dispatch */
    get (name) {
      return [...(handlers.get(name) ?? [])]
    },
    has (name) {
      return (handlers.get(name)?.length ?? 0) > 0
    }
  }
}

function isRegistry (routes) {
  return !!routes?.[REGISTRY_MARK]
}

/** `bedd.routes`, created if missing (idempotent). */
function ensureRoutes (bedd) {
  if (!isRegistry(bedd.routes)) {
    if (bedd.routes) throw new TypeError('client.bedd.routes is not a bedd route registry (create it with lib/bedd/routes.js)')
    bedd.routes = createRouteRegistry()
  }
  return bedd.routes
}

/** Handlers registered for `name` (an empty list without a registry). */
function handlersFor (routes, name) {
  return isRegistry(routes) ? routes.get(name) : []
}

/**
 * Run `list` for one packet. `handled` is false only when every handler declined (returned exactly `false`).
 * @returns {{ handled: boolean, result: any }}
 */
function runHandlers (list, params, ctx, onAsync) {
  let handled = false
  let result
  for (const handler of list) {
    const r = handler(params, ctx)
    if (r && typeof r.then === 'function') onAsync?.(r)
    if (r !== false) {
      handled = true
      result = r
    }
  }
  return { handled, result }
}

/** The parts of a player_auth_input other modules translate: [pseudo-name, params][] */
function inputParts (params) {
  const parts = []
  if (Array.isArray(params?.block_action) && params.block_action.length) parts.push(['block_action', params.block_action])
  if (params?.item_stack_request) parts.push(['item_stack_request', { requests: [params.item_stack_request] }])
  return parts
}

/**
 * Without the router: make `bedd.route` dispatch through the registry (registered names first, the parts of
 * player_auth_input, then the previous route). A route that already dispatches (the router's, or this one) is kept.
 */
function ensureDispatch (bedd, { warn } = {}) {
  const routes = ensureRoutes(bedd)
  if (bedd.route?.[DISPATCH]) return routes
  const previous = typeof bedd.route === 'function' ? bedd.route : null
  const route = function (name, params = {}) {
    if (name === 'player_auth_input') {
      for (const [part, partParams] of inputParts(params)) {
        try {
          runHandlers(handlersFor(routes, part), partParams, { name: part, packet: params, embedded: true })
        } catch (err) {
          warn?.(err)
        }
      }
    }
    const { handled, result } = runHandlers(handlersFor(routes, name), params, { name })
    if (handled) return result
    return previous ? previous.call(this, name, params) : undefined
  }
  route[DISPATCH] = true
  bedd.route = route
  return routes
}

/** Mark a route function as dispatching through the registry (the router's). */
function markDispatch (fn) {
  fn[DISPATCH] = true
  return fn
}

module.exports = {
  createRouteRegistry,
  ensureRoutes,
  ensureDispatch,
  handlersFor,
  runHandlers,
  inputParts,
  isRegistry,
  markDispatch,
  REGISTRY_MARK,
  DISPATCH
}
