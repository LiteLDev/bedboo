#!/usr/bin/env node
// owner: U1 (BDS harness & e2e infra)
'use strict'
// `pnpm bds <command>` — Docker BDS harness CLI (docs/testing.md).

const USAGE = `Usage: bds <command> [options]

  pull [--force]                 pull the image and extract the golden BDS ${require('../lib/config').BDS_VERSION} cache (idempotent)
  up [--name <n>] [options]      start a persistent BDS (container bedboo-<n>); prints BDS_HOST/BDS_PORT/BDS_CONTAINER
       --world flat|default      world generator (default flat)    --seed <seed>     seeded world
       --gamemode <m>            survival|creative|adventure (default creative)
       --difficulty <d>          peaceful|easy|normal|hard (default peaceful)
       --profile <p>             deterministic|none (default deterministic)
       --gamerule <rule>=<v>     gamerule override (repeatable)
       --property <key>=<v>      server.properties override (repeatable)
       --snapshot <s>            start from a world snapshot
  cmd <n> <command…>             run a console command and print its output
  logs <n> [-f] [--tail <k>]     server log (follow with -f)
  down <n>…                      stop and remove instances (container, data dir, slot)
  ls                             slots and harness containers on this host
  snapshot <n> <s> [--overwrite] save the world of <n> as snapshot <s> (restarts <n>)
  restore <n> <s>                replace the world of <n> with snapshot <s> (restarts <n>)
  snapshots [--delete <s>]       list (or delete) snapshots
  clean [--all]                  reap dead owners; remove this worktree's containers (--all: every bedboo container)

<n> is the instance name (container bedboo-<n>) or the container name. Env: BEDBOO_CACHE,
BEDBOO_MAX_SERVERS (6), BEDBOO_WORKER_SLOTS (2), BEDBOO_PORT_BASE (41000), BEDBOO_SLOT_TIMEOUT.`

function parseArgs (argv) {
  const positional = []
  const flags = {}
  const multi = new Set(['gamerule', 'property'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-f') { flags.follow = true; continue }
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const eq = arg.indexOf('=')
    const key = (eq > 0 ? arg.slice(2, eq) : arg.slice(2))
    let value
    if (eq > 0) value = arg.slice(eq + 1)
    else if (['force', 'all', 'overwrite', 'follow'].includes(key)) value = true
    else value = argv[++i]
    if (value === undefined) throw new Error(`--${key} needs a value`)
    if (multi.has(key)) (flags[key] ??= []).push(value)
    else flags[key] = value
  }
  return { positional, flags }
}

function keyValues (list, what) {
  const out = {}
  for (const item of list ?? []) {
    const i = item.indexOf('=')
    if (i <= 0) throw new Error(`--${what} expects <key>=<value>, got ${item}`)
    out[item.slice(0, i)] = item.slice(i + 1)
  }
  return out
}

function gameruleValues (list) {
  const out = {}
  for (const [k, v] of Object.entries(keyValues(list, 'gamerule'))) {
    const value = v.trim().toLowerCase()
    if (value === 'true' || value === 'false') out[k] = value === 'true'
    else if (/^-?\d+$/.test(value)) out[k] = Number(value)
    else throw new Error(`--gamerule ${k}: expected true, false or an integer, got ${JSON.stringify(v)}`)
  }
  return out
}

async function main () {
  // pnpm forwards a literal `--` (`pnpm bds -- up`); ignore it.
  const argv = process.argv.slice(2).filter((arg, i) => !(arg === '--' && i === 0))
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE)
    return command ? 0 : 1
  }
  const { positional, flags } = parseArgs(rest)
  const bds = require('..')
  const server = require('../lib/server')
  const docker = require('../lib/docker')

  switch (command) {
    case 'pull':
      await bds.pull({ force: !!flags.force })
      return 0

    case 'up': {
      const name = flags.name ?? positional[0] ?? `${require('os').userInfo().username}-dbg`
      const srv = await bds.startServer({
        name,
        persistent: true,
        useExternal: false,
        world: flags.world,
        seed: flags.seed,
        gamemode: flags.gamemode,
        difficulty: flags.difficulty,
        profile: flags.profile,
        snapshot: flags.snapshot,
        gamerules: gameruleValues(flags.gamerule),
        properties: keyValues(flags.property, 'property')
      })
      srv.detach()
      console.log(`${srv.container} ready on ${srv.host}:${srv.port} (slot ${srv.slot}, data ${srv.dataDir})`)
      console.log(`BDS_HOST=${srv.host} BDS_PORT=${srv.port} BDS_CONTAINER=${srv.container}`)
      return 0
    }

    case 'cmd': {
      const [name, ...words] = positional
      if (!name || !words.length) throw new Error('usage: bds cmd <name> <command…>')
      const srv = await bds.attachServer(name)
      try {
        const lines = await srv._console().commandOutput(words.join(' '), { timeout: Number(flags.timeout ?? 30000) })
        for (const line of lines) console.log(line.raw)
      } finally {
        srv.detach()
      }
      return 0
    }

    case 'logs': {
      const [name] = positional
      if (!name) throw new Error('usage: bds logs <name> [-f] [--tail <k>]')
      const args = ['logs']
      if (flags.follow) args.push('-f')
      if (flags.tail) args.push('--tail', String(flags.tail))
      args.push(server.containerName(name))
      const child = require('child_process').spawn('docker', args, { stdio: 'inherit' })
      return new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)))
    }

    case 'down': {
      if (!positional.length) throw new Error('usage: bds down <name>…')
      for (const name of positional) {
        const { container, removed } = await server.downServer(name)
        console.log(removed ? `removed ${container}` : `${container} was already gone: removed its data dir and slot`)
      }
      return 0
    }

    case 'ls':
    case 'status': {
      const slotList = await bds.listSlots()
      console.log('slots:')
      for (const s of slotList) {
        const i = s.info
        console.log(`  ${s.slot}  port ${s.ports.v4}  ${i ? `${i.container ?? '?'}  ${i.persistent ? 'persistent' : `pid ${i.pid}`}  ${i.owner}${s.alive ? '' : '  [stale]'}` : 'free'}`)
      }
      const containers = await docker.listManaged()
      console.log('containers:')
      if (!containers.length) console.log('  (none)')
      for (const c of containers) {
        const l = c.labels
        console.log(`  ${c.name}  ${c.state}  slot ${l['bedboo.slot']}  ${l['bedboo.persistent'] === '1' ? 'persistent' : `pid ${l['bedboo.pid']}`}  ${l['bedboo.owner']}`)
      }
      return 0
    }

    case 'snapshot': {
      const [name, snap] = positional
      if (!name || !snap) throw new Error('usage: bds snapshot <name> <snapshot> [--overwrite]')
      const srv = await bds.attachServer(name)
      try {
        const meta = await srv.snapshot(snap, { overwrite: !!flags.overwrite })
        console.log(`snapshot ${meta.name}: ${meta.files} files in ${meta.dir}`)
      } finally {
        srv.detach()
      }
      return 0
    }

    case 'restore': {
      const [name, snap] = positional
      if (!name || !snap) throw new Error('usage: bds restore <name> <snapshot>')
      const srv = await bds.attachServer(name)
      try {
        await srv.restore(snap)
        console.log(`${srv.container} restarted with snapshot ${snap}`)
      } finally {
        srv.detach()
      }
      return 0
    }

    case 'snapshots': {
      if (flags.delete) {
        bds.deleteSnapshot(flags.delete)
        console.log(`deleted snapshot ${flags.delete}`)
        return 0
      }
      const list = bds.listSnapshots()
      if (!list.length) console.log('(no snapshots)')
      for (const s of list) console.log(`${s.name}  ${s.createdAt}  ${s.levelType ?? '?'}${s.seed ? ` seed ${s.seed}` : ''}  ${s.files} files  ${s.description ?? ''}`)
      return 0
    }

    case 'clean': {
      const res = await bds.clean({ all: !!flags.all, log: (m) => console.log(m) })
      console.log(`removed ${res.containers.length} container(s), ${res.dirs.length} dir(s)`)
      return 0
    }

    default:
      console.error(`bds: unknown command ${command}\n\n${USAGE}`)
      return 1
  }
}

main().then((code) => process.exit(code), (err) => {
  console.error(`bds: ${err.message}`)
  process.exit(1)
})
