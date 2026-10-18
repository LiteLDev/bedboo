'use strict'
// Test helper process: acquires a slot from the registry in $BEDBOO_CACHE, prints
// `{"slot": n}` (or `{"error": "..."}`), holds the slot until stdin closes, then releases it.
const slots = require('../../lib/slots')

slots.acquire({ container: `holder-${process.pid}`, timeout: Number(process.env.HOLD_TIMEOUT ?? 10000), log: () => {} }).then((handle) => {
  process.stdout.write(JSON.stringify({ slot: handle.slot, at: Date.now() }) + '\n')
  process.stdin.resume()
  process.stdin.on('end', () => {
    handle.release()
    process.exit(0)
  })
}, (err) => {
  process.stdout.write(JSON.stringify({ error: err.message }) + '\n')
  process.exit(0)
})
