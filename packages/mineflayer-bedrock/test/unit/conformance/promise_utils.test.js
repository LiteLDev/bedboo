'use strict'
// owner: U3 (parity tooling)
// mineflayer's test/internalTest.js `onceWithCleanup` cases, ported verbatim (mineflayer 4.39.0, MIT,
// Copyright (c) 2013 Andrew Kelley; pinned copy in docs/upstream/internalTest.js). They test the helper
// module itself: docs/CONTRIBUTING.md has mineflayer-bedrock reuse the unmodified
// `mineflayer/lib/promise_utils` (deep require) in its vendored plugins instead of a copy. If a unit ever
// replaces it with its own helper, point these tests at that helper. Mapped in
// docs/parity/U3-internal-tests.md.
const assert = require('assert')
const { EventEmitter } = require('events')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')

describe('internalTest › onceWithCleanup', () => {
  it('rejects instead of throwing out of emit when checkCondition throws', async () => {
    // A condition that throws used to unwind whatever was emitting. For a
    // client event that is the socket read path, which then stops delivering
    // packets entirely and the bot dies on the next keepalive.
    const emitter = new EventEmitter()
    const boom = new Error('condition blew up')
    const promise = onceWithCleanup(emitter, 'thing', {
      checkCondition: () => { throw boom }
    })
    assert.doesNotThrow(() => emitter.emit('thing'))
    await assert.rejects(promise, err => err === boom)
    assert.strictEqual(emitter.listenerCount('thing'), 0)
  })

  it('rejects and removes the listener when the signal is aborted', async () => {
    const emitter = new EventEmitter()
    const abort = new AbortController()
    const reason = new Error('no longer interested')
    const promise = onceWithCleanup(emitter, 'thing', { signal: abort.signal })
    abort.abort(reason)
    await assert.rejects(promise, err => err === reason)
    assert.strictEqual(emitter.listenerCount('thing'), 0)
  })
})
