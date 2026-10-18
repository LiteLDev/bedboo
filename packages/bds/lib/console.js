// owner: U1 (BDS harness & e2e infra)
'use strict'
const { EventEmitter } = require('events')
const crypto = require('crypto')

/**
 * Line-oriented BDS console: an input (write one command line) plus a stream of output lines with
 * sequence numbers, so a caller can wait for the output of the command it just wrote.
 *
 * Sources:
 * - {@link Console#attachProcess}: a long-lived `docker start -a -i` / `docker attach` child (stdin
 *   and stdout of the server together; used for containers the harness starts);
 * - {@link Console#setInput} + {@link Console#attachProcess} on a `docker logs -f` child (external
 *   containers: input through lib/docker.sendCommand, output from the log).
 *
 * BDS prints `[YYYY-MM-DD hh:mm:ss:mmm LEVEL] message`; continuation lines (e.g. the player list of
 * `list`, the file list of `save query`) have no prefix. Matchers see the message without prefix.
 */

const PREFIX_RE = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?::\d+)?) (\w+)\] ?/

/**
 * @typedef {{ seq: number, time: number, raw: string, message: string, level: string|null, stream: string }} ConsoleLine
 * @typedef {string|RegExp|((message: string, line: ConsoleLine) => any)} Matcher
 */

/** @returns {(line: ConsoleLine) => any} */
function compileMatcher (matcher) {
  if (typeof matcher === 'string') return (line) => line.message.includes(matcher) || line.raw.includes(matcher)
  if (matcher instanceof RegExp) {
    // a global/sticky RegExp keeps state between calls: always match from the start
    const re = new RegExp(matcher.source, matcher.flags.replace(/[gy]/g, ''))
    return (line) => line.message.match(re) ?? line.raw.match(re)
  }
  if (typeof matcher === 'function') return (line) => matcher(line.message, line)
  throw new TypeError('matcher must be a string, RegExp or function')
}

class Console extends EventEmitter {
  /**
   * @param {{ name?: string, maxLines?: number, echo?: boolean|((line: ConsoleLine) => void) }} [opts]
   */
  constructor (opts = {}) {
    super()
    this.setMaxListeners(0)
    this.name = opts.name ?? 'bds'
    this.maxLines = opts.maxLines ?? 5000
    /** @type {ConsoleLine[]} */
    this.lines = []
    this.seq = 0
    this.closed = false
    this._input = null
    this._queue = Promise.resolve()
    this._partial = {}
    this._echo = opts.echo === true ? (l) => process.stderr.write(`[${this.name}] ${l.raw}\n`) : (opts.echo || null)
  }

  /** Feed raw output (used by attachProcess; public for tests). */
  push (chunk, stream = 'stdout') {
    const text = (this._partial[stream] ?? '') + chunk.toString()
    const parts = text.split(/\r?\n/)
    this._partial[stream] = parts.pop()
    for (const raw of parts) this._line(raw, stream)
  }

  /** Flush partial lines (end of stream). */
  flush () {
    for (const [stream, rest] of Object.entries(this._partial)) {
      if (rest) this._line(rest, stream)
      this._partial[stream] = ''
    }
  }

  _line (raw, stream) {
    const m = PREFIX_RE.exec(raw)
    /** @type {ConsoleLine} */
    const line = {
      seq: ++this.seq,
      time: Date.now(),
      raw,
      message: m ? raw.slice(m[0].length) : raw,
      level: m ? m[2] : null,
      stream
    }
    this.lines.push(line)
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines)
    if (this._echo) this._echo(line)
    this.emit('line', line)
  }

  /**
   * Read output from a child process; if `useStdin`, commands are written to its stdin.
   * @param {import('child_process').ChildProcess} child
   * @param {{ useStdin?: boolean }} [opts]
   */
  attachProcess (child, opts = {}) {
    this.child = child
    this.closed = false
    child.stdout?.on('data', (c) => this.push(c, 'stdout'))
    child.stderr?.on('data', (c) => this.push(c, 'stderr'))
    if (opts.useStdin) {
      child.stdin.on('error', () => {}) // EPIPE after the container stopped: reported by write()
      this._input = (line) => new Promise((resolve, reject) => {
        if (!child.stdin.writable) return reject(new Error(`${this.name}: console stdin is closed`))
        child.stdin.write(line + '\n', (err) => (err ? reject(err) : resolve()))
      })
    }
    child.on('close', (code, signal) => {
      this.flush()
      if (this.child !== child) return
      this.closed = true
      this.emit('close', code, signal)
    })
    return this
  }

  /** @param {(line: string) => Promise<void>} fn custom command writer */
  setInput (fn) {
    this._input = fn
    return this
  }

  /** @returns {boolean} whether commands can be written */
  hasInput () {
    return this._input !== null
  }

  /** Detach (kill) the attached process without touching the container. */
  detach () {
    const child = this.child
    this.child = null
    this._input = null
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch {}
    }
  }

  /** @returns {ConsoleLine[]} lines with seq > `seq` */
  linesSince (seq) {
    return this.lines.filter((l) => l.seq > seq)
  }

  /** @returns {string[]} the last `n` raw lines */
  tail (n = 30) {
    return this.lines.slice(-n).map((l) => l.raw)
  }

  /**
   * Write one command line (no leading '/'). Resolves with the console seq just before the write;
   * output of this command has a greater seq.
   * @returns {Promise<number>}
   */
  async write (cmd) {
    if (typeof cmd !== 'string' || !cmd.trim()) throw new Error('console command must be a non-empty string')
    if (/[\r\n]/.test(cmd)) throw new Error('console commands must be a single line')
    if (!this._input) throw new Error(`${this.name}: console has no input`)
    const seq = this.seq
    await this._input(cmd.replace(/^\//, ''))
    return seq
  }

  /**
   * Wait for a line matching `matcher` with seq > `since` (default: lines from now on). Lines already
   * received are checked first.
   * @param {Matcher} matcher
   * @param {{ since?: number, timeout?: number, signal?: AbortSignal }} [opts]
   * @returns {Promise<{ line: ConsoleLine, match: any }>}
   */
  waitFor (matcher, opts = {}) {
    const test = compileMatcher(matcher)
    const since = opts.since ?? this.seq
    const timeout = opts.timeout ?? 30000
    return new Promise((resolve, reject) => {
      for (const line of this.linesSince(since)) {
        const match = test(line)
        if (match) return resolve({ line, match })
      }
      if (this.closed) return reject(new Error(`${this.name}: console closed while waiting for ${matcher}`))
      const cleanup = () => {
        clearTimeout(timer)
        this.removeListener('line', onLine)
        this.removeListener('close', onClose)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      const onLine = (line) => {
        if (line.seq <= since) return
        const match = test(line)
        if (!match) return
        cleanup()
        resolve({ line, match })
      }
      const onClose = () => {
        cleanup()
        reject(new Error(`${this.name}: console closed while waiting for ${matcher}\n${this.tail(15).join('\n')}`))
      }
      const onAbort = () => {
        cleanup()
        reject(opts.signal.reason ?? new Error('aborted'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`${this.name}: timed out after ${timeout} ms waiting for ${matcher}\nlast lines:\n${this.tail(15).join('\n')}`))
      }, timeout)
      this.on('line', onLine)
      this.on('close', onClose)
      opts.signal?.addEventListener('abort', onAbort)
    })
  }

  /** Run `fn` exclusively (commands whose output is awaited never interleave). */
  exclusive (fn) {
    const run = this._queue.then(fn, fn)
    this._queue = run.then(() => {}, () => {})
    return run
  }

  /**
   * Write a command and resolve with its first output line matching `matcher`.
   * Serialized with other commandWithOutput / marker calls.
   * @param {string} cmd
   * @param {Matcher} matcher
   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<{ line: ConsoleLine, match: any }>}
   */
  commandWithOutput (cmd, matcher, opts = {}) {
    return this.exclusive(async () => {
      const since = await this.write(cmd)
      return this.waitFor(matcher, { since, timeout: opts.timeout ?? 30000 })
    })
  }

  /**
   * Resolve once every command written before has been executed: writes a unique unknown command
   * (BDS answers `Unknown command: <marker>…` in order on its main thread) and waits for its echo.
   */
  async marker (opts = {}) {
    const id = `bedboo_marker_${crypto.randomBytes(5).toString('hex')}`
    await this.commandWithOutput(id, id, opts)
  }
}

module.exports = { Console, compileMatcher, PREFIX_RE }
