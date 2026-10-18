'use strict'
// Test helper process: enters the registry critical section $ITER times. Inside, it creates `inside` with
// O_EXCL (failure = another process is inside too: mutual exclusion broken), holds it ~1 ms and removes it.
// After each section it plants the mutex of a holder that died while holding it ($DEAD identity, O_EXCL so
// only when no mutex exists), so every process keeps racing to steal dead mutexes at the same time.
// Moving the mutex aside is slowed down (2 ms before and after the rename) to widen the windows a stealer
// acting on a stale read would need. Prints `{"overlaps": n, "sections": n}`.
const fs = require('fs')
const path = require('path')
const slots = require(process.env.SLOTS_MODULE || '../../lib/slots')

const dir = process.env.DIR
const iterations = Number(process.env.ITER || 50)
const dead = JSON.parse(process.env.DEAD)
const inside = path.join(dir, 'inside')
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const mutex = path.join(dir, slots.MUTEX)
const renameSync = fs.renameSync
fs.renameSync = function (from, to) {
  if (from !== mutex) return renameSync.call(this, from, to)
  sleepSync(2)
  const result = renameSync.call(this, from, to)
  sleepSync(2)
  return result
}

async function main () {
  let overlaps = 0
  let sections = 0
  for (let i = 0; i < iterations; i++) {
    await slots.withRegistry(dir, () => {
      sections++
      let fd
      try {
        fd = fs.openSync(inside, 'wx')
      } catch {
        overlaps++
        return
      }
      fs.closeSync(fd)
      sleepSync(1)
      fs.rmSync(inside, { force: true })
    })
    try {
      const fd = fs.openSync(path.join(dir, slots.MUTEX), 'wx')
      fs.writeSync(fd, JSON.stringify({ ...dead, token: `dead-${process.pid}-${i}` }))
      fs.closeSync(fd)
    } catch {}
  }
  process.stdout.write(JSON.stringify({ overlaps, sections }) + '\n')
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err.message }) + '\n')
  process.exit(1)
})
