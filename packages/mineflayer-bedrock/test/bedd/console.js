// owner: BEDD-6 (real-client e2e + docs)
'use strict'
// BDS console for the real-client e2e: `commandOutput(cmd) → string[]` (the messages a console command printed, log
// prefix stripped), like @bedboo/bds's BdsServer.
//
// - Default: @bedboo/bds `attachServer(BDS_CONTAINER)` (the harness's exec console), which runs `docker` directly.
// - `BEDBOO_BEDD_DOCKER` set (e.g. `wsl -d Debian -e docker`): the test process runs on Windows (it needs BeDD's named
//   pipes) while docker only runs inside WSL, which @bedboo/bds cannot reach. One `docker exec` writes a console
//   marker, the command and a second marker to the server's stdin (as the server's uid, like @bedboo/bds
//   lib/docker.js sendCommand); `docker logs --since 60s` (relative, so the daemon's own clock counts) is then polled
//   until both markers' "Unknown command" lines are there. Every docker argument is a plain token (the command goes
//   through stdin as base64), so no quoting has to survive wsl.exe's command-line handling.
const { execFile } = require('child_process')
const crypto = require('crypto')
const { PREFIX_RE, MARKER_PREFIX } = require('@bedboo/bds/lib/console')

/** @returns {Promise<{ commandOutput (cmd: string): Promise<string[]>, close (): Promise<void> }>} */
async function createConsole (container, { docker = process.env.BEDBOO_BEDD_DOCKER } = {}) {
  if (!docker) {
    const server = await require('@bedboo/bds').attachServer(container)
    return {
      commandOutput: (cmd) => server.commandOutput(cmd, { timeout: 15000 }),
      close: async () => server.detach()
    }
  }
  return new ProxyConsole(container, docker.trim().split(/\s+/))
}

class ProxyConsole {
  constructor (container, prefix) {
    this.container = container
    this.prefix = prefix
    this.user = null
    this.queue = Promise.resolve()
  }

  run (args, input) {
    return new Promise((resolve, reject) => {
      const child = execFile(this.prefix[0], [...this.prefix.slice(1), ...args], { timeout: 30000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`${this.prefix.join(' ')} ${args.join(' ')} failed: ${(stderr || err.message).trim()}`))
        resolve({ stdout, stderr })
      })
      if (input !== undefined) child.stdin.end(input)
    })
  }

  /** write `lines` to the server's stdin, in order, with one docker exec */
  async write (lines) {
    if (lines.some((l) => /[\r\n]/.test(l))) throw new Error('console commands must be a single line')
    if (!this.user) this.user = (await this.run(['exec', this.container, 'stat', '-c', '%u:%g', '/data'])).stdout.trim()
    const decode = lines.map((l, i) => `L${i}=$(printf %s ${Buffer.from(l, 'utf8').toString('base64')} | base64 -d)\n`).join('')
    const print = lines.map((l, i) => `printf "%s\\n" "$L${i}" > "$p/fd/0"; `).join('')
    const script = decode +
      'for p in /proc/[0-9]*; do case "$(readlink "$p/exe" 2>/dev/null)" in ' +
      `/data/bedrock_server*) ${print}exit 0;; esac; done\n` +
      'echo "no bedrock_server process" >&2; exit 2\n'
    await this.run(['exec', '-i', '-u', this.user, this.container, 'sh', '-s'], script)
  }

  /** messages (prefix stripped) between two markers around `cmd`; serialized */
  commandOutput (cmd, { timeout = 15000 } = {}) {
    const next = this.queue.then(() => this._commandOutput(cmd, timeout))
    this.queue = next.catch(() => {})
    return next
  }

  async _commandOutput (cmd, timeout) {
    const before = MARKER_PREFIX + crypto.randomBytes(6).toString('hex')
    const after = MARKER_PREFIX + crypto.randomBytes(6).toString('hex')
    await this.write([before, cmd, after])
    const end = Date.now() + timeout
    for (;;) {
      const { stdout, stderr } = await this.run(['logs', '--since', '60s', this.container])
      const messages = (stdout + '\n' + stderr).split(/\r?\n/).map((l) => l.replace(PREFIX_RE, ''))
      const a = messages.findIndex((m) => m.includes(`Unknown command: ${before}`))
      const b = messages.findIndex((m) => m.includes(`Unknown command: ${after}`))
      if (a !== -1 && b > a) return messages.slice(a + 1, b).filter((m) => m.trim() !== '' && !m.includes(MARKER_PREFIX))
      if (Date.now() > end) throw new Error(`no console output for "${cmd}" within ${timeout} ms`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  async close () {}
}

module.exports = { createConsole }
