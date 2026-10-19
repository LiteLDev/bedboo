'use strict'
// owner: U16b — createBot transport options (lib/client.js) and the NetherNet HTTP signalling patches
// (bedrock-protocol#831 + node-nethernet#32 backports), without a server
const assert = require('assert')
const http = require('http')
const path = require('path')
const { once } = require('events')

/** a module as bedrock-protocol's own dependency sees it (nethernet is not a direct dependency of this package) */
function requireFrom (pkg, request) {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`, { paths: [path.dirname(require.resolve('bedrock-protocol/package.json'))] }))
  return require(require.resolve(request, { paths: [dir] }))
}

describe('transport options (U16b): raknet default, nethernet over HTTP signalling', function () {
  this.timeout(20000)

  function capture (fn) {
    const bedrock = require('bedrock-protocol')
    const original = bedrock.createClient
    const calls = []
    bedrock.createClient = (opts) => { calls.push(opts); return opts }
    try {
      fn(require('../../lib/client').createClient)
    } finally {
      bedrock.createClient = original
    }
    return calls
  }

  it('raknet stays the default; nethernet gets HTTP signalling and accepts the server key unless pinned', () => {
    const [raknet, nethernet, pinned, custom, lan, lanWithId, unset] = capture((createClient) => {
      createClient({ username: 'a' })
      createClient({ username: 'b', transport: 'nethernet', port: 41000 })
      createClient({ username: 'c', transport: 'nethernet', nethernet: { serverKey: 'sha256:00' } })
      createClient({ username: 'd', transport: 'nethernet', nethernet: { onServerKey: () => false, url: 'https://example.org' } })
      createClient({ username: 'e', transport: 'nethernet', nethernet: { signalling: 'lan' } })
      createClient({ username: 'f', transport: 'nethernet', nethernet: { signalling: 'lan', networkId: 5n } })
      createClient({ username: 'g', transport: 'nethernet', nethernet: { signalling: undefined, serverKey: null } })
    })
    assert.strictEqual(raknet.transport, 'raknet')
    assert.strictEqual(raknet.nethernet, undefined)
    assert.strictEqual(raknet.raknetBackend, 'raknet-native')

    assert.strictEqual(nethernet.transport, 'nethernet')
    assert.strictEqual(nethernet.nethernet.signalling, 'http')
    assert.strictEqual(nethernet.port, 41000)
    assert.strictEqual(nethernet.skipPing, true, 'HTTP signalling needs no discovery')
    assert.strictEqual(typeof nethernet.nethernet.onServerKey, 'function')
    assert.strictEqual(nethernet.nethernet.onServerKey('sha256:ab', 'http://127.0.0.1:41000'), true, 'unpinned keys are accepted (like RakNet)')

    assert.strictEqual(pinned.nethernet.serverKey, 'sha256:00')
    assert.strictEqual(pinned.nethernet.onServerKey, undefined, 'a pin is never overridden by the default approval')
    assert.strictEqual(custom.nethernet.onServerKey(), false, "the caller's onServerKey is kept")
    assert.strictEqual(custom.nethernet.url, 'https://example.org')

    assert.strictEqual(lan.nethernet.signalling, 'lan')
    assert.strictEqual(unset.nethernet.signalling, 'http', 'an explicit undefined keeps the default')
    assert.strictEqual(unset.nethernet.serverKey, undefined)
    assert.strictEqual(unset.nethernet.onServerKey('sha256:ab'), true, 'a null pin is no pin')
    assert.strictEqual(lan.skipPing, false, 'LAN signalling discovers the network id')
    assert.strictEqual(lanWithId.skipPing, true)
  })

  it('rejects unknown transports and signalling modes', () => {
    const { createClient } = require('../../lib/client')
    assert.throws(() => createClient({ username: 'x', transport: 'tcp' }), /unsupported transport 'tcp'/)
    assert.throws(() => createClient({ username: 'x', transport: 'nethernet', nethernet: { signalling: 'carrier-pigeon' } }), /unsupported nethernet.signalling/)
  })

  it('bedrock-protocol patch: ping over HTTP signalling, NetherNet client in HTTP mode needs no network id', async () => {
    require('@bedboo/bedrock-data').install()
    const { ping } = require('bedrock-protocol')
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/join') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ name: 'bedboo', protocol: 2193, version: '1.26.51', level: 'w', players: 1, maxPlayers: 10, gameType: 0 }))
      }
      res.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const ad = await ping({ host: '127.0.0.1', port: server.address().port, transport: 'nethernet', nethernet: { signalling: 'http' }, timeout: 3000 })
      assert.strictEqual(ad.transport, 'nethernet')
      assert.strictEqual(ad.signalling, 'http')
      assert.strictEqual(ad.motd, 'bedboo')
      assert.strictEqual(ad.protocol, 2193)
      assert.strictEqual(ad.playersMax, 10)
    } finally {
      server.close()
    }

    const { NethernetClient } = require('bedrock-protocol/src/nethernet')
    const client = new NethernetClient({ host: '127.0.0.1', port: 41000, signalling: 'http', serverKey: 'sha256:00' })
    try {
      assert.strictEqual(client.nethernet.http.url.origin, 'http://127.0.0.1:41000')
      assert.strictEqual(client.nethernet.http.serverKey, 'sha256:00')
      assert.strictEqual(client.nethernet._externalSignaling, true, 'no LAN discovery in HTTP mode')
      assert.strictEqual(client.nethernet.pingInterval, undefined, 'no LAN discovery broadcasts')
    } finally {
      client.close()
    }
  })

  it('nethernet patch: jsonwebtoken is nethernet\'s own dependency (packageExtensions), not a hoisting accident', () => {
    const nethernetDir = path.dirname(require.resolve('nethernet/package.json', { paths: [path.dirname(require.resolve('bedrock-protocol/package.json'))] }))
    const jwt = require.resolve('jsonwebtoken', { paths: [nethernetDir] })
    assert.ok(!jwt.includes(`${path.sep}.pnpm${path.sep}node_modules${path.sep}`), `resolved through pnpm's hoisted fallback: ${jwt}`)
  })

  it('nethernet patch: verifyServerIdentity checks the answer signature and returns the key fingerprint', () => {
    const crypto = require('crypto')
    const { attachIdentity, verifyServerIdentity } = requireFrom('nethernet', 'nethernet/src/identity')
    const JWT = requireFrom('nethernet', 'jsonwebtoken')
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
    const cpk = publicKey.export({ format: 'jwk' })
    const token = JWT.sign({ cpk }, privateKey, { algorithm: 'ES384' })
    const sdp = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 'a=fingerprint:sha-256 AA:BB', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', ''].join('\r\n')
    const signed = attachIdentity(sdp, { privateKey, token })
    const verified = verifyServerIdentity(signed)
    const expected = 'sha256:' + crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
    assert.strictEqual(verified.fingerprint, expected)
    assert.ok(!verified.sdp.includes('a=identity:'), 'the identity line is stripped from the answer')
    // a tampered fingerprint no longer matches the signature
    assert.throws(() => verifyServerIdentity(signed.replace('AA:BB', 'AA:BC')), /invalid signature/)
    assert.throws(() => verifyServerIdentity(sdp), /Expected one Nethernet server identity assertion/)
  })
})
