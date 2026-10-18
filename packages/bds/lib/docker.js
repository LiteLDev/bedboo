// owner: U1 (BDS harness & e2e infra)
'use strict'
const { execFile, spawn } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

/**
 * Minimal Docker helpers for an already-running itzg/minecraft-bedrock-server container.
 * Everything is asynchronous so a bot sharing the event loop keeps its 50 ms input loop running.
 *
 * Console commands: the image's own `send-command` does not work on this host — it runs as root
 * without CAP_SYS_PTRACE and cannot readlink /proc/<pid>/exe of the server process (uid 1000), so it
 * fails with "failed to search for bedrock server process". We write to the server's stdin as the
 * server's own uid:gid instead (the owner of /data). Output only appears in `docker logs`.
 */

const CONSOLE_SH = 'for p in /proc/[0-9]*; do case "$(readlink "$p/exe" 2>/dev/null)" in ' +
  '/data/bedrock_server*) printf "%s\\n" "$*" > "$p/fd/0"; exit 0;; esac; done; ' +
  'echo "no bedrock_server process" >&2; exit 2'

const ownerCache = new Map()

/** @returns {Promise<string>} `uid:gid` owning /data (= the user the server runs as) */
function dataOwner (container) {
  if (!ownerCache.has(container)) {
    const p = execFileAsync('docker', ['exec', container, 'stat', '-c', '%u:%g', '/data']).then(({ stdout }) => stdout.trim())
    p.catch(() => ownerCache.delete(container))
    ownerCache.set(container, p)
  }
  return ownerCache.get(container)
}

/**
 * Send one console command (no leading '/'). Rejects if the server process is not found.
 * Resolves with the time just before the command was written — pass it as `since` to
 * {@link waitForLog} to catch the command's output.
 * @returns {Promise<Date>}
 */
async function sendCommand (container, cmd) {
  if (/[\r\n]/.test(cmd)) throw new Error('console commands must be a single line')
  const user = await dataOwner(container)
  const sentAt = new Date()
  await execFileAsync('docker', ['exec', '-u', user, container, 'bash', '-c', CONSOLE_SH, 'bds-console', cmd])
  return sentAt
}

/**
 * Resolve with the first log line matching `re` (string = substring) printed at/after `since`.
 * Capture `since` BEFORE triggering the output (e.g. the value returned by {@link sendCommand}).
 * @param {string} container
 * @param {RegExp|string} re
 * @param {{ timeout?: number, since?: Date }} [opts]
 */
function waitForLog (container, re, { timeout = 30000, since = new Date() } = {}) {
  const test = typeof re === 'string' ? (line) => line.includes(re) : (line) => re.test(line)
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['logs', '-f', '--since', since.toISOString(), container], { stdio: ['ignore', 'pipe', 'pipe'] })
    let done = false
    const finish = (err, line) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      err ? reject(err) : resolve(line)
    }
    // stdout and stderr are separate streams: keep one partial-line buffer per stream
    const buffers = { stdout: '', stderr: '' }
    const onData = (stream) => (chunk) => {
      const lines = (buffers[stream] + chunk.toString()).split('\n')
      buffers[stream] = lines.pop()
      for (const line of lines) if (test(line)) return finish(null, line)
    }
    child.stdout.on('data', onData('stdout'))
    child.stderr.on('data', onData('stderr'))
    child.on('error', (err) => finish(err))
    // 'close' fires after both streams ended: check the trailing partial lines too
    child.on('close', () => {
      for (const rest of Object.values(buffers)) if (rest && test(rest)) return finish(null, rest)
      finish(new Error(`docker logs exited before ${re} appeared`))
    })
    const timer = setTimeout(() => finish(new Error(`Timed out after ${timeout} ms waiting for ${re} in ${container} logs`)), timeout)
  })
}

module.exports = { sendCommand, waitForLog, CONSOLE_SH }
