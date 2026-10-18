'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const config = require('../lib/config')
const slots = require('../lib/slots')
const { reap, clean } = require('../lib/reaper')

const L = config.LABELS

function deadPid () {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout)
}

/** In-memory docker double: listManaged / removeContainers. */
function fakeDocker (containers) {
  const removed = []
  return {
    removed,
    containers,
    async listManaged () { return containers.filter((c) => !removed.includes(c.name)) },
    async removeContainers (names) { removed.push(...names) }
  }
}

describe('reaper', function () {
  this.timeout(20000)
  let cache, env, p
  beforeEach(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bedboo-reaper-'))
    env = { BEDBOO_CACHE: cache }
    p = config.paths(env)
    fs.mkdirSync(p.instances, { recursive: true })
    fs.mkdirSync(p.slots, { recursive: true })
  })
  afterEach(() => fs.rmSync(cache, { recursive: true, force: true }))

  /** container + instance dir + slot lock owned by `identity` */
  function server (name, slot, identity, { persistent = false, owner = 'w1' } = {}) {
    const dir = path.join(p.instances, name)
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify({ ...identity, persistent, container: name }))
    fs.writeFileSync(slots.lockPath(p.slots, slot), JSON.stringify({ slot, token: `t-${name}`, ...identity, owner, container: name, persistent, createdAt: new Date(0).toISOString() }))
    return {
      name,
      state: 'running',
      labels: {
        [L.managed]: '1',
        [L.owner]: owner,
        [L.pid]: persistent ? '' : String(identity.pid),
        [L.pidStart]: persistent ? '' : String(identity.pidStart ?? ''),
        [L.host]: identity.host,
        [L.boot]: identity.boot,
        [L.slot]: String(slot),
        [L.dir]: dir,
        [L.persistent]: persistent ? '1' : '0'
      }
    }
  }

  it('removes containers, dirs and slots of dead owners only', async () => {
    const me = config.selfIdentity()
    const dead = { ...me, pid: deadPid(), pidStart: '1' }
    const docker = fakeDocker([
      server('bedboo-alive', 0, me),
      server('bedboo-dead', 1, dead),
      server('bedboo-persistent', 2, { ...me, pid: null }, { persistent: true }),
      server('bedboo-otherhost', 3, { ...dead, host: 'some-other-host' })
    ])
    const res = await reap({ docker, env })
    assert.deepStrictEqual(res.containers, ['bedboo-dead'])
    assert.deepStrictEqual(res.slots, [1], 'slots whose ports the removed containers bound')
    assert.deepStrictEqual(docker.removed, ['bedboo-dead'])
    assert.ok(!fs.existsSync(path.join(p.instances, 'bedboo-dead')))
    assert.ok(fs.existsSync(path.join(p.instances, 'bedboo-alive')))
    assert.strictEqual(slots.readLock(p.slots, 1), null)
    assert.ok(slots.readLock(p.slots, 0))
    assert.ok(slots.readLock(p.slots, 2))
  })

  it('removes orphan instance dirs of dead owners, never dirs outside the instances root', async () => {
    const me = config.selfIdentity()
    fs.mkdirSync(path.join(p.instances, 'bedboo-orphan'))
    fs.writeFileSync(path.join(p.instances, 'bedboo-orphan/instance.json'), JSON.stringify({ ...me, pid: deadPid(), pidStart: '1' }))
    fs.mkdirSync(path.join(p.instances, 'bedboo-mine'))
    fs.writeFileSync(path.join(p.instances, 'bedboo-mine/instance.json'), JSON.stringify(me))
    fs.mkdirSync(path.join(p.instances, 'bedboo-creating')) // no meta yet, fresh
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bedboo-outside-'))
    const evil = server('bedboo-evil', 4, { ...me, pid: deadPid(), pidStart: '1' })
    evil.labels[L.dir] = outside
    const res = await reap({ docker: fakeDocker([evil]), env })
    assert.ok(fs.existsSync(outside), 'label pointing outside the instances root is ignored')
    fs.rmSync(outside, { recursive: true, force: true })
    assert.ok(res.dirs.includes(path.join(p.instances, 'bedboo-orphan')))
    assert.ok(!fs.existsSync(path.join(p.instances, 'bedboo-orphan')))
    assert.ok(fs.existsSync(path.join(p.instances, 'bedboo-mine')))
    assert.ok(fs.existsSync(path.join(p.instances, 'bedboo-creating')))
  })

  it('removes the dir of a persistent server whose container was removed outside the harness', async () => {
    const me = config.selfIdentity()
    for (const [name, age] of [['bedboo-up-old', 3600e3], ['bedboo-up-new', 0]]) {
      fs.mkdirSync(path.join(p.instances, name))
      fs.writeFileSync(path.join(p.instances, name, 'instance.json'), JSON.stringify({ ...me, pid: null, persistent: true, createdAt: new Date(Date.now() - age).toISOString() }))
    }
    await reap({ docker: fakeDocker([]), env })
    assert.ok(!fs.existsSync(path.join(p.instances, 'bedboo-up-old')))
    assert.ok(fs.existsSync(path.join(p.instances, 'bedboo-up-new')), 'container may still be being created')
  })

  it('clean removes this owner\'s containers (or all with --all) and stale locks', async () => {
    const me = config.selfIdentity()
    const containers = [
      server('bedboo-a', 0, me, { owner: 'w1' }),
      server('bedboo-b', 1, me, { owner: 'w2' }),
      server('bedboo-c', 2, { ...me, pid: null }, { owner: 'w1', persistent: true })
    ]
    // stale lock without container
    fs.writeFileSync(slots.lockPath(p.slots, 5), JSON.stringify({ slot: 5, token: 'x', pid: deadPid(), pidStart: '1', boot: me.boot, host: me.host, owner: 'w9', container: 'gone' }))
    // files moved aside / pinned by mutex stealers, and a steal lock (left to the next stealer)
    const leftovers = ['registry.lock.steal', 'registry.lock.steal.dead-1-ab-pin', 'registry.lock.dead-2-cd']
    for (const f of leftovers) fs.writeFileSync(path.join(p.slots, f), 'x')
    const registryFiles = () => fs.readdirSync(p.slots).filter((f) => f.startsWith('registry.')).sort()
    const docker = fakeDocker(containers)
    const res = await clean({ docker, env, owner: 'w1' })
    assert.deepStrictEqual(res.containers.sort(), ['bedboo-a', 'bedboo-c'])
    assert.deepStrictEqual(res.slots.sort(), [0, 2])
    assert.strictEqual(slots.readLock(p.slots, 5), null, 'stale lock released')
    assert.ok(slots.readLock(p.slots, 1), 'other worker untouched')
    assert.deepStrictEqual(registryFiles(), [...leftovers].sort(), 'files moved aside less than a minute ago may be in use')
    await clean({ docker: fakeDocker([]), env, owner: 'w1', now: Date.now() + 120e3 })
    assert.deepStrictEqual(registryFiles(), ['registry.lock.steal'], 'old junk removed; the steal lock is never removed by path')
    const all = await clean({ docker, env, owner: 'w1', all: true })
    assert.deepStrictEqual(all.containers, ['bedboo-b'])
    assert.deepStrictEqual(fs.readdirSync(p.instances), [])
  })
})
