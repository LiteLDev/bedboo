// owner: U1 (BDS harness & e2e infra)
'use strict'
const { execFile, spawn } = require('child_process')
const { LABELS } = require('./config')

/**
 * Docker CLI helpers. Everything is asynchronous so a bot sharing the event loop keeps its 50 ms
 * input loop running.
 *
 * Console commands for containers this process did not start (env fallback, CLI): the image's own
 * `send-command` does not work on this host — it runs as root without CAP_SYS_PTRACE and cannot
 * readlink /proc/<pid>/exe of the server process (uid 1000), so it fails with "failed to search for
 * bedrock server process". {@link sendCommand} writes to the server's stdin as the server's own
 * uid:gid instead (the owner of /data); the output only appears in the container log. Containers
 * started by the harness use a persistent attached console instead (lib/console.js).
 */

/**
 * Run a command, resolve with `{ stdout, stderr }`; reject with an Error carrying `code`, `stdout`,
 * `stderr` on a non-zero exit.
 * @param {string} file
 * @param {string[]} args
 * @param {{ timeout?: number, input?: string, inherit?: boolean }} [opts]
 */
function run (file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (opts.inherit) {
      const child = spawn(file, args, { stdio: ['ignore', 'inherit', 'inherit'] })
      const timer = opts.timeout ? setTimeout(() => child.kill('SIGKILL'), opts.timeout) : null
      child.on('error', (err) => { clearTimeout(timer); reject(err) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve({ stdout: '', stderr: '' })
        else reject(Object.assign(new Error(`${file} ${args.join(' ')} exited with ${code}`), { code }))
      })
      return
    }
    const child = execFile(file, args, { timeout: opts.timeout ?? 120000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${file} ${args.join(' ')} failed: ${(stderr || err.message).trim()}`
        return reject(Object.assign(new Error(msg), { code: err.code, stdout, stderr }))
      }
      resolve({ stdout, stderr })
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
  })
}

const docker = (args, opts) => run('docker', args, opts)

async function commandExists (cmd) {
  try {
    await run('sh', ['-c', `command -v ${cmd}`], { timeout: 10000 })
    return true
  } catch {
    return false
  }
}

async function imageExists (image) {
  try {
    await docker(['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 30000 })
    return true
  } catch {
    return false
  }
}

/**
 * List harness containers (label `bedboo.managed=1`), running or not.
 * @param {string[]} [filters] extra `--filter` values
 * @returns {Promise<Array<{ id: string, name: string, state: string, labels: Record<string,string> }>>}
 */
async function listManaged (filters = []) {
  // one JSON object per line; labels extracted individually (values may contain commas)
  const labelJson = Object.values(LABELS).map((l) => `${JSON.stringify(l)}:{{json (.Label ${JSON.stringify(l)})}}`).join(',')
  const format = `{"id":{{json .ID}},"name":{{json .Names}},"state":{{json .State}},"labels":{${labelJson}}}`
  const args = ['ps', '-a', '--no-trunc', '--filter', `label=${LABELS.managed}=1`, '--format', format]
  for (const f of filters) args.push('--filter', f)
  const { stdout } = await docker(args, { timeout: 30000 })
  return stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** @returns {Promise<object|null>} `docker inspect` of a container, or null if it does not exist */
async function inspect (container) {
  try {
    const { stdout } = await docker(['container', 'inspect', container], { timeout: 30000 })
    return JSON.parse(stdout)[0] ?? null
  } catch (err) {
    if (/No such (container|object)/i.test(err.stderr || err.message)) return null
    throw err
  }
}

/**
 * Remove containers: `docker rm -f -v`. A container that is already gone, or that another process (a concurrent
 * reaper) is removing right now, is not an error; any other error line is.
 */
async function removeContainers (names) {
  if (!names.length) return
  try {
    await docker(['rm', '-f', '-v', ...names], { timeout: 120000 })
  } catch (err) {
    const lines = String(err.stderr || err.message).split('\n').map((l) => l.trim()).filter(Boolean)
    const benign = (line) => /No such container|removal of container .* is already in progress/i.test(line)
    if (!lines.length || !lines.every(benign)) throw err
  }
}

const CONSOLE_SH = 'for p in /proc/[0-9]*; do case "$(readlink "$p/exe" 2>/dev/null)" in ' +
  '/data/bedrock_server*) printf "%s\\n" "$*" > "$p/fd/0"; exit 0;; esac; done; ' +
  'echo "no bedrock_server process" >&2; exit 2'

const ownerCache = new Map()

/** @returns {Promise<string>} `uid:gid` owning /data (= the user the server runs as) */
function dataOwner (container) {
  if (!ownerCache.has(container)) {
    const p = docker(['exec', container, 'stat', '-c', '%u:%g', '/data'], { timeout: 30000 }).then(({ stdout }) => stdout.trim())
    p.catch(() => ownerCache.delete(container))
    ownerCache.set(container, p)
  }
  return ownerCache.get(container)
}

/**
 * Send one console command (no leading '/') by writing to the server process's stdin.
 * Rejects if the server process is not found. Resolves with the time just before the command was
 * written — pass it as `since` to {@link waitForLog} to catch the command's output.
 * @returns {Promise<Date>}
 */
async function sendCommand (container, cmd) {
  if (/[\r\n]/.test(cmd)) throw new Error('console commands must be a single line')
  const user = await dataOwner(container)
  const sentAt = new Date()
  await docker(['exec', '-u', user, container, 'bash', '-c', CONSOLE_SH, 'bds-console', cmd], { timeout: 30000 })
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

module.exports = {
  run,
  docker,
  commandExists,
  imageExists,
  listManaged,
  inspect,
  removeContainers,
  dataOwner,
  sendCommand,
  waitForLog,
  CONSOLE_SH
}
