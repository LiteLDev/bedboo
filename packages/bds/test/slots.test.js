'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const slots = require('../lib/slots')
const config = require('../lib/config')

const HOLDER = path.join(__dirname, 'fixtures/slot-holder.js')

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bedboo-slots-'))
}

/** pid + start time of a process that already exited */
function deadIdentity () {
  const res = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return { pid: Number(res.stdout), pidStart: '1', boot: config.bootId(), host: os.hostname() }
}

/** Spawn a holder process; resolves with { child, result } once it printed its result line. */
function holder (env) {
  const child = spawn(process.execPath, [HOLDER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
  const result = new Promise((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i >= 0) resolve(JSON.parse(buf.slice(0, i)))
    })
    child.on('error', reject)
    child.on('exit', (code) => { if (!buf) reject(new Error(`holder exited ${code} without output`)) })
  })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  return { child, result, release: () => { child.stdin.end(); return exited }, exited }
}

describe('slot registry', function () {
  this.timeout(60000)
  let cache

  beforeEach(() => { cache = tmpDir() })
  afterEach(() => fs.rmSync(cache, { recursive: true, force: true }))

  const dir = () => path.join(cache, 'slots')
  const lim = (o = {}) => ({ maxServers: 3, workerSlots: 3, portBase: 41000, ...o })

  it('hands out distinct slots with ports 41000+2n and releases them', async () => {
    const a = await slots.acquire({ dir: dir(), limits: lim(), container: 'a', log: () => {} })
    const b = await slots.acquire({ dir: dir(), limits: lim(), container: 'b', log: () => {} })
    assert.deepStrictEqual([a.slot, b.slot], [0, 1])
    assert.deepStrictEqual(a.ports, { v4: 41000, v6: 41001 })
    assert.deepStrictEqual(b.ports, { v4: 41002, v6: 41003 })
    const lock = slots.readLock(dir(), 0)
    assert.strictEqual(lock.pid, process.pid)
    assert.strictEqual(lock.container, 'a')
    assert.strictEqual(lock.owner, config.ownerKey())
    a.release()
    assert.strictEqual(slots.readLock(dir(), 0), null)
    const c = await slots.acquire({ dir: dir(), limits: lim(), log: () => {} })
    assert.strictEqual(c.slot, 0)
    a.release() // idempotent, must not remove c's lock
    assert.ok(slots.readLock(dir(), 0))
    b.release()
    c.release()
  })

  it('update() rewrites the lock keeping the token', async () => {
    const a = await slots.acquire({ dir: dir(), limits: lim(), log: () => {} })
    a.update({ container: 'later' })
    const lock = slots.readLock(dir(), a.slot)
    assert.strictEqual(lock.container, 'later')
    assert.strictEqual(lock.token, a.token)
    a.release()
  })

  it('queues when full and times out naming the holders', async () => {
    const held = []
    for (let i = 0; i < 3; i++) held.push(await slots.acquire({ dir: dir(), limits: lim(), container: `c${i}`, log: () => {} }))
    const t0 = Date.now()
    await assert.rejects(slots.acquire({ dir: dir(), limits: lim(), timeout: 1500, log: () => {} }), (err) => {
      assert.match(err.message, /No BDS slot after/)
      assert.match(err.message, /c0 pid/)
      return true
    })
    assert.ok(Date.now() - t0 >= 1400)
    // a slot freed while queueing is picked up
    const waiting = slots.acquire({ dir: dir(), limits: lim(), timeout: 10000, log: () => {} })
    setTimeout(() => held[1].release(), 300)
    assert.strictEqual((await waiting).slot, 1)
    for (const h of held) h.release()
  })

  it('enforces the per-worker cap (BEDBOO_WORKER_SLOTS) per owner key', async () => {
    const opts = { dir: dir(), limits: lim({ workerSlots: 1 }), log: () => {} }
    const a = await slots.acquire({ ...opts, identity: { owner: 'worker-a' } })
    await assert.rejects(slots.acquire({ ...opts, identity: { owner: 'worker-a' }, timeout: 1200 }), /already holds 1\/1 slots/)
    const b = await slots.acquire({ ...opts, identity: { owner: 'worker-b' } })
    assert.notStrictEqual(a.slot, b.slot)
    a.release()
    b.release()
  })

  it('persistent (bds up) locks count against the host cap only', async () => {
    const opts = { dir: dir(), limits: lim({ workerSlots: 1 }), log: () => {}, identity: { owner: 'w' } }
    const up = await slots.acquire({ ...opts, persistent: true, container: 'bedboo-dbg' })
    assert.strictEqual(slots.readLock(dir(), up.slot).persistent, true)
    assert.strictEqual(slots.readLock(dir(), up.slot).pid, null)
    const test = await slots.acquire(opts) // the worker's one non-persistent slot is still free
    assert.notStrictEqual(test.slot, up.slot)
    await assert.rejects(slots.acquire({ ...opts, timeout: 1100 }), /already holds 1\/1/)
    up.release()
    test.release()
  })

  it('reclaims locks of dead owners', async () => {
    fs.mkdirSync(dir(), { recursive: true })
    const dead = deadIdentity()
    fs.writeFileSync(slots.lockPath(dir(), 0), JSON.stringify({ slot: 0, token: 'stale-1', ...dead, owner: 'gone', container: 'old' }))
    assert.strictEqual(await slots.isLockAlive(slots.readLock(dir(), 0)), false)
    const a = await slots.acquire({ dir: dir(), limits: lim(), log: () => {} })
    assert.strictEqual(a.slot, 0)
    assert.notStrictEqual(slots.readLock(dir(), 0).token, 'stale-1')
    a.release()
  })

  it('the registry mutex serializes changes; a dead holder\'s mutex is stolen', async () => {
    fs.mkdirSync(dir(), { recursive: true })
    const mutex = path.join(dir(), slots.MUTEX)
    // held by a live process (us, pretending to be another holder): acquire waits for it
    fs.writeFileSync(mutex, JSON.stringify({ ...config.selfIdentity(), token: 'other' }))
    let done = false
    const p = slots.acquire({ dir: dir(), limits: lim(), log: () => {} }).then((h) => { done = true; return h })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.strictEqual(done, false, 'waits while the mutex is held')
    fs.rmSync(mutex)
    const a = await p
    assert.ok(!fs.existsSync(mutex), 'mutex released after acquire')
    // held by a dead process: stolen
    fs.writeFileSync(mutex, JSON.stringify({ ...deadIdentity(), token: 'dead' }))
    const b = await slots.acquire({ dir: dir(), limits: lim(), log: () => {} })
    assert.notStrictEqual(a.slot, b.slot)
    assert.deepStrictEqual(fs.readdirSync(dir()).filter((f) => f.includes('registry')), [])
    a.release()
    b.release()
  })

  it('a stealer acting on a stale read never moves a live holder\'s mutex (steal lock + re-check)', () => {
    fs.mkdirSync(dir(), { recursive: true })
    const mutex = path.join(dir(), slots.MUTEX)
    fs.writeFileSync(mutex, JSON.stringify({ ...deadIdentity(), token: 'dead' }))
    const live = JSON.stringify({ ...config.selfIdentity(), token: 'live' })
    const renamed = []
    const renameSync = fs.renameSync
    fs.renameSync = function (from, to) {
      renamed.push(from)
      return renameSync.call(this, from, to)
    }
    try {
      // A saw the dead holder; before it acts, B steals the dead mutex and a live process takes a new one
      slots.stealDeadMutex(mutex, {
        beforeSteal () {
          slots.stealDeadMutex(mutex)
          assert.ok(!fs.existsSync(mutex), 'B stole the dead mutex')
          fs.writeFileSync(mutex, live, { flag: 'wx' })
          renamed.length = 0
        }
      })
    } finally {
      fs.renameSync = renameSync
    }
    assert.deepStrictEqual(renamed.filter((f) => f === mutex), [], 'A did not move the live mutex aside')
    assert.strictEqual(fs.readFileSync(mutex, 'utf8'), live)
    assert.deepStrictEqual(fs.readdirSync(dir()).sort(), [slots.MUTEX], 'no steal lock or junk left behind')
  })

  it('a steal lock left by a crashed stealer is removed once stale; a fresh one blocks stealing', () => {
    fs.mkdirSync(dir(), { recursive: true })
    const mutex = path.join(dir(), slots.MUTEX)
    const steal = `${mutex}.steal`
    fs.writeFileSync(mutex, JSON.stringify({ ...deadIdentity(), token: 'dead' }))
    fs.writeFileSync(steal, 'other-stealer')
    slots.stealDeadMutex(mutex)
    assert.ok(fs.existsSync(mutex), 'a fresh steal lock means someone else is stealing right now')
    assert.ok(fs.existsSync(steal))
    const old = new Date(Date.now() - slots.STEAL_STALE_MS - 1000)
    fs.utimesSync(steal, old, old)
    slots.stealDeadMutex(mutex) // removes the stale steal lock (this attempt backs off)
    assert.ok(!fs.existsSync(steal))
    slots.stealDeadMutex(mutex)
    assert.ok(!fs.existsSync(mutex), 'dead mutex stolen')
    assert.deepStrictEqual(fs.readdirSync(dir()), [])
  })

  it('concurrent processes stealing dead mutexes never share the critical section', async function () {
    this.timeout(60000)
    fs.mkdirSync(dir(), { recursive: true })
    const hammer = path.join(__dirname, 'fixtures/mutex-hammer.js')
    const env = { ...process.env, DIR: dir(), ITER: '40', DEAD: JSON.stringify(deadIdentity()) }
    const runs = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hammer], { env, stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.on('error', reject)
      child.on('close', () => { // after stdout was drained ('exit' may come first)
        try { resolve(JSON.parse(out)) } catch { reject(new Error(`hammer printed ${JSON.stringify(out)}`)) }
      })
    }))
    const results = await Promise.all(runs)
    for (const r of results) assert.strictEqual(r.error, undefined, r.error)
    assert.strictEqual(results.reduce((n, r) => n + r.sections, 0), 6 * 40)
    assert.deepStrictEqual(results.map((r) => r.overlaps), [0, 0, 0, 0, 0, 0])
  })

  it('a dead owner\'s slot is not reused while its container exists (it may still bind the ports)', async () => {
    fs.mkdirSync(dir(), { recursive: true })
    const dead = deadIdentity()
    const write = (slot, info) => fs.writeFileSync(slots.lockPath(dir(), slot), JSON.stringify({ slot, owner: 'me', createdAt: new Date(0).toISOString(), ...info }))
    write(0, { token: 'dead-with-container', ...dead, container: 'bedboo-old' })
    write(1, { token: 'dead-container-gone', ...dead, container: 'bedboo-gone' })
    const existing = new Set(['bedboo-old'])
    const deps = { containerExists: async (name) => existing.has(name) }
    const opts = { dir: dir(), limits: lim({ maxServers: 2, workerSlots: 1 }), log: () => {}, identity: { owner: 'me' }, deps }
    assert.strictEqual(await slots.isLockAlive(slots.readLock(dir(), 0), deps), true)
    assert.strictEqual(await slots.isLockAlive(slots.readLock(dir(), 1), deps), false)
    const listed = await slots.listSlots({ dir: dir(), limits: lim({ maxServers: 2 }), deps })
    assert.deepStrictEqual(listed.map((s) => [s.alive, s.ownerGone]), [[true, true], [false, true]])
    assert.match(slots.describeHolders(listed), /bedboo-old pid \d+ owner me \[owner gone, container not reaped yet\]/)
    // slot 1 is free; the leftover container does not count against the worker cap of its (dead) owner
    const a = await slots.acquire(opts)
    assert.strictEqual(a.slot, 1)
    a.release()
    write(1, { token: 'live-other', ...config.selfIdentity(), owner: 'other', container: 'bedboo-other' })
    // all busy: queue until the reaper (onWait) removes the container and releases its lock
    let waits = 0
    const onWait = async () => {
      if (++waits < 2) return
      existing.delete('bedboo-old')
      slots.releaseSlot(dir(), 0, 'dead-with-container')
    }
    const b = await slots.acquire({ ...opts, onWait, timeout: 10000 })
    assert.strictEqual(b.slot, 0)
    assert.ok(waits >= 2)
    b.release()
    // without the reaper, a lock whose container is gone is replaced
    write(0, { token: 'dead-again', ...dead, container: 'bedboo-old' })
    const c = await slots.acquire({ ...opts, timeout: 3000 })
    assert.strictEqual(c.slot, 0)
    c.release()
  })

  it('persistent locks live as long as their container', async () => {
    const young = { persistent: true, container: 'bedboo-x', createdAt: new Date().toISOString(), token: 't' }
    assert.strictEqual(await slots.isLockAlive(young, { containerExists: async () => false }), true, 'grace period')
    const old = { ...young, createdAt: new Date(Date.now() - 3600e3).toISOString() }
    assert.strictEqual(await slots.isLockAlive(old, { containerExists: async () => true }), true)
    assert.strictEqual(await slots.isLockAlive(old, { containerExists: async () => false }), false)
    assert.strictEqual(await slots.isLockAlive({ corrupt: true }), false)
    assert.strictEqual(await slots.isLockAlive({ pid: process.pid, pidStart: config.processStartTime(process.pid), boot: config.bootId() }), true)
  })

  it('concurrent processes never share a slot; queued ones get freed slots', async () => {
    const env = (i) => ({ BEDBOO_CACHE: cache, BEDBOO_MAX_SERVERS: '6', BEDBOO_WORKER_SLOTS: '6', BEDBOO_OWNER: `w${i}`, HOLD_TIMEOUT: '20000' })
    const holders = Array.from({ length: 8 }, (_, i) => holder(env(i)))
    // the first 6 results arrive; 2 processes queue
    const first = await Promise.race([
      new Promise((resolve) => {
        const got = []
        holders.forEach((h, i) => h.result.then((r) => { got.push({ i, ...r }); if (got.length === 6) resolve(got) }))
      }),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('holders did not start')), 20000))
    ])
    assert.deepStrictEqual(first.map((r) => r.slot).sort(), [0, 1, 2, 3, 4, 5])
    const waiting = holders.filter((h, i) => !first.some((r) => r.i === i))
    assert.strictEqual(waiting.length, 2)
    // the other two are queueing
    let lateResult = false
    for (const h of waiting) h.result.then(() => { lateResult = true })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    assert.strictEqual(lateResult, false, 'no slot while all 6 are held')
    // free two slots: the queued processes take exactly those
    const freed = first.slice(0, 2)
    await Promise.all(freed.map((r) => holders[r.i].release()))
    const late = await Promise.all(waiting.map((h) => h.result))
    assert.deepStrictEqual(late.map((r) => r.slot).sort(), freed.map((r) => r.slot).sort())
    await Promise.all(holders.map((h) => h.release()))
    assert.deepStrictEqual(fs.readdirSync(dir()).filter((f) => f.endsWith('.lock')), [])
  })

  it('concurrent processes of one worker respect the worker cap', async () => {
    const env = { BEDBOO_CACHE: cache, BEDBOO_MAX_SERVERS: '6', BEDBOO_WORKER_SLOTS: '2', BEDBOO_OWNER: 'same-worker', HOLD_TIMEOUT: '2500' }
    const holders = Array.from({ length: 5 }, () => holder(env))
    const results = await Promise.all(holders.map((h) => h.result))
    const ok = results.filter((r) => r.slot !== undefined)
    assert.strictEqual(ok.length, 2, JSON.stringify(results))
    assert.ok(results.filter((r) => r.error).every((r) => /already holds 2\/2 slots/.test(r.error)))
    await Promise.all(holders.map((h) => h.release()))
  })

  it('a killed holder\'s lock is reclaimed by the next process', async () => {
    const env = { BEDBOO_CACHE: cache, BEDBOO_MAX_SERVERS: '1', BEDBOO_WORKER_SLOTS: '1', BEDBOO_OWNER: 'k', HOLD_TIMEOUT: '15000' }
    const a = holder(env)
    assert.strictEqual((await a.result).slot, 0)
    a.child.kill('SIGKILL')
    await a.exited
    assert.ok(slots.readLock(dir(), 0), 'lock left behind')
    const b = holder(env)
    assert.strictEqual((await b.result).slot, 0)
    await b.release()
  })
})

describe('config', () => {
  it('slot ports, limits from env, owner key', () => {
    assert.deepStrictEqual(config.slotPorts(3, 41000), { v4: 41006, v6: 41007 })
    assert.deepStrictEqual(config.limits({ BEDBOO_MAX_SERVERS: '4', BEDBOO_WORKER_SLOTS: '1', BEDBOO_PORT_BASE: '42000' }).maxServers, 4)
    assert.throws(() => config.limits({ BEDBOO_MAX_SERVERS: '-1' }), /Invalid BEDBOO_MAX_SERVERS/)
    assert.strictEqual(config.ownerKey({ BEDBOO_OWNER: 'me' }), 'me')
    assert.strictEqual(config.ownerKey({}, __dirname), path.resolve(__dirname, '../../..'))
    assert.strictEqual(config.paths({ BEDBOO_CACHE: '/x/y' }).slots, '/x/y/slots')
    assert.strictEqual(config.paths({ XDG_CACHE_HOME: '/c' }).golden, `/c/bedboo/bds/${config.BDS_VERSION}`)
  })

  it('process liveness uses pid + start time + boot id', () => {
    const self = config.selfIdentity()
    assert.strictEqual(config.isProcessAlive(self), true)
    assert.strictEqual(config.isProcessAlive({ ...self, pidStart: '1' }), false, 'pid reused by another process')
    assert.strictEqual(config.isProcessAlive({ ...self, boot: 'another-boot' }), false)
    assert.strictEqual(config.isProcessAlive(deadIdentity()), false)
    assert.strictEqual(config.isProcessAlive({ pid: null }), false)
  })
})
