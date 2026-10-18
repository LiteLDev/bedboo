'use strict'
const assert = require('assert')
const { spawn } = require('child_process')
const { Console } = require('../lib/console')

/** A fake BDS console: answers known commands like BDS 1.26.51.1 does (in order, asynchronously). */
function fakeBds () {
  const con = new Console({ name: 'fake' })
  const answers = {
    list: ['[2026-10-18 15:26:51:505 INFO] There are 1/10 players online:', 'flatbot'],
    'gamerule domobspawning false': ['[2026-10-18 15:26:53:546 INFO] Game rule domobspawning has been updated to false'],
    'say hi': []
  }
  const written = []
  con.setInput(async (line) => {
    written.push(line)
    setTimeout(() => {
      const out = answers[line] ?? [`[2026-10-18 15:26:52:846 ERROR] Unknown command: ${line.split(' ')[0]}. Please check that the command exists and that you have permission to use it.`]
      for (const l of out) con.push(l + '\n')
    }, 5)
  })
  return { con, written }
}

describe('Console', () => {
  it('splits chunks into lines, strips the BDS prefix and keeps the level', () => {
    const con = new Console()
    con.push('[2026-10-18 15:26:49:887 INFO] Server sta')
    assert.strictEqual(con.lines.length, 0)
    con.push('rted.\r\nplain continuation\n[2026-10-18 15:26:49:887 ERROR] boom\n')
    assert.deepStrictEqual(con.lines.map((l) => [l.seq, l.message, l.level]), [
      [1, 'Server started.', 'INFO'],
      [2, 'plain continuation', null],
      [3, 'boom', 'ERROR']
    ])
    con.push('tail without newline', 'stderr')
    con.flush()
    assert.strictEqual(con.lines[3].message, 'tail without newline')
    assert.strictEqual(con.lines[3].stream, 'stderr')
    assert.deepStrictEqual(con.tail(2), ['[2026-10-18 15:26:49:887 ERROR] boom', 'tail without newline'])
  })

  it('waitFor: string / RegExp / function matchers, history since a seq, timeout', async () => {
    const con = new Console({ maxLines: 3 })
    con.push('[2026-10-18 15:26:49:887 INFO] Server started.\n')
    // already received lines after `since` count
    assert.strictEqual((await con.waitFor('started', { since: 0 })).line.seq, 1)
    const p = con.waitFor(/^Game rule (\w+) has been updated/g)
    con.push('[x INFO] ignored\n[2026-10-18 15:26:53:546 INFO] Game rule doinsomnia has been updated to false\n')
    const { match } = await p
    assert.strictEqual(match[1], 'doinsomnia')
    assert.ok((await con.waitFor(/^Game rule/g, { since: 0 })).line, 'global RegExp state does not leak between calls')
    const fn = con.waitFor((msg, line) => line.level === 'ERROR')
    con.push('[2026-10-18 15:26:53:546 ERROR] nope\n')
    assert.strictEqual((await fn).line.message, 'nope')
    assert.strictEqual(con.lines.length, 3, 'ring buffer')
    await assert.rejects(con.waitFor('never', { timeout: 50 }), /timed out after 50 ms waiting for never/)
    assert.throws(() => con.waitFor(42), /matcher must be/)
  })

  it('commandWithOutput serializes commands and returns their own output', async () => {
    const { con, written } = fakeBds()
    const [a, b] = await Promise.all([
      con.commandWithOutput('list', /players online/),
      con.commandWithOutput('gamerule domobspawning false', /^Game rule/)
    ])
    assert.match(a.line.message, /There are 1\/10 players online/)
    assert.match(b.line.message, /domobspawning/)
    assert.deepStrictEqual(written, ['list', 'gamerule domobspawning false'])
    await assert.rejects(con.write('a\nb'), /single line/)
    await assert.rejects(con.write(''), /non-empty/)
    await con.write('/say hi')
    assert.strictEqual(written[2], 'say hi', 'leading slash stripped')
  })

  it('marker resolves after the earlier commands executed', async () => {
    const { con, written } = fakeBds()
    await con.write('say hi')
    await con.marker()
    assert.match(written[1], /^bedboo_marker_[0-9a-f]+$/)
    assert.match(con.lines.at(-1).message, /Unknown command: bedboo_marker_/)
  })

  it('attachProcess: reads stdout/stderr, writes stdin, rejects waiters when the process exits', async () => {
    const con = new Console({ name: 'child' })
    // a tiny "server": echoes every stdin line as an INFO log line, exits on "stop"
    const child = spawn(process.execPath, ['-e', `
      const rl = require('readline').createInterface({ input: process.stdin })
      rl.on('line', (l) => { if (l === 'stop') process.exit(0); console.log('[2026-10-18 00:00:00:000 INFO] echo ' + l) })
      console.error('ready on stderr')
    `], { stdio: ['pipe', 'pipe', 'pipe'] })
    con.attachProcess(child, { useStdin: true })
    await con.waitFor('ready on stderr', { since: 0, timeout: 5000 })
    const { line } = await con.commandWithOutput('hello world', /^echo/, { timeout: 5000 })
    assert.strictEqual(line.message, 'echo hello world')
    const pending = con.waitFor('never', { timeout: 5000 })
    await con.write('stop')
    await assert.rejects(pending, /console closed/)
    assert.strictEqual(con.closed, true)
    await assert.rejects(con.waitFor('x'), /console closed/)
  })
})
