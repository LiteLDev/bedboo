// owner: U1 (BDS harness & e2e infra)
'use strict'
/**
 * @bedboo/bds — Docker-based Bedrock Dedicated Server harness (API).
 *
 * U0 ships the API shape + the environment fallback only; U1 implements the Docker harness
 * (golden BDS cache, per-instance dirs, slot registry, persistent console, snapshots, …).
 *
 * ENV FALLBACK (works today): if `BDS_HOST` or `BDS_PORT` is set, `startServer()` does not start
 * anything and returns a handle to that already-running server. `BDS_CONTAINER` (optional) names
 * its Docker container so `command()` and `waitForLog()` work against the manual recipe container
 * (docs/testing.md).
 *
 * @typedef {object} ServerHandle
 * @property {string} host
 * @property {number} port
 * @property {boolean} external true when using the BDS_HOST/BDS_PORT fallback
 * @property {string} [container] Docker container name
 * @property {(cmd: string) => Promise<Date>} command run a console command (no leading '/'); resolves
 *   with the time it was sent — pass it as `waitForLog(re, { since })` to match the command's output
 * @property {(re: RegExp|string, opts?: { timeout?: number, since?: Date }) => Promise<string>} waitForLog
 *   resolve with the first matching server log line printed at/after `since` (default: now)
 * @property {() => Promise<void>} stop stop + remove the container (no-op for external servers)
 *
 * @typedef {object} StartServerOptions
 * @property {string} [name] instance name (container `bedboo-<name>`)
 * @property {'flat'|'default'|string} [world] world preset or snapshot name
 * @property {object} [properties] extra server.properties (cannot override the enforced ones)
 * @property {object} [gamerules] gamerules to apply after start (deterministic test profile by default)
 */

const { NotImplementedError } = require('./lib/errors')
const docker = require('./lib/docker')

const DEFAULT_PORT = 19132

/** @returns {ServerHandle | null} handle for BDS_HOST/BDS_PORT, or null when unset */
function externalServer (env = process.env) {
  if (!env.BDS_HOST && !env.BDS_PORT) return null
  const host = env.BDS_HOST || '127.0.0.1'
  const port = Number(env.BDS_PORT || DEFAULT_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid BDS_PORT: ${env.BDS_PORT}`)
  const container = env.BDS_CONTAINER || undefined
  return {
    host,
    port,
    external: true,
    container,
    async command (cmd) {
      if (!container) throw new NotImplementedError('U1', 'ServerHandle.command without BDS_CONTAINER')
      return docker.sendCommand(container, cmd)
    },
    async waitForLog (re, opts = {}) {
      if (!container) throw new NotImplementedError('U1', 'ServerHandle.waitForLog without BDS_CONTAINER')
      return docker.waitForLog(container, re, opts)
    },
    async stop () {}
  }
}

/**
 * Start (or attach to) a BDS instance.
 * @param {StartServerOptions} [opts]
 * @returns {Promise<ServerHandle>}
 */
async function startServer (opts = {}) {
  const external = externalServer()
  if (external) return external
  throw new NotImplementedError('U1', 'startServer (Docker harness); set BDS_HOST/BDS_PORT to use a running server')
}

/**
 * Start a server (or use `opts.server`) and connect a mineflayer-bedrock bot to it.
 * Resolves after the bot's `spawn`. `createBot` defaults to the caller's mineflayer-bedrock.
 *
 * @param {{ server?: ServerHandle, username?: string, createBot?: Function } & object} [opts]
 * @returns {Promise<{ bot: object, server: ServerHandle }>}
 */
async function createTestBot (opts = {}) {
  throw new NotImplementedError('U1', 'createTestBot')
}

module.exports = { startServer, createTestBot, externalServer, DEFAULT_PORT }
