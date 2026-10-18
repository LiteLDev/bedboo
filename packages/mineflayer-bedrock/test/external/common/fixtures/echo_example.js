// owner: U1 (BDS harness & e2e infra)
'use strict'
/**
 * Tiny "example" used by helpers.test.js to exercise bot.test.runExample: joins as `echobot`
 * (`node echo_example.js <host> <port>`), answers `loaded` with `Ready!` and echoes every other chat
 * message from another player as `echo: <message>`. Raw client only (no plugins needed).
 */
const path = require('path')
const { createRawBot, inject } = require(path.join(__dirname, '..'))

const [host = '127.0.0.1', port = '19132'] = process.argv.slice(2)
const bot = createRawBot({ host, port: Number(port), username: 'echobot' })
const server = { port: Number(port), host, command: async () => {}, commandWithOutput: async () => '' }
const ctx = inject(bot, server)
let readySent = false
bot._client.on('text', (p) => {
  if (p.type !== 'chat') return
  const from = ctx.stripFormatting(p.source_name)
  if (from === 'echobot') return
  if (p.message === 'loaded') {
    if (!readySent) ctx.chat('Ready!')
    readySent = true
  } else if (readySent) {
    ctx.chat(`echo: ${p.message}`)
  }
})
bot.on('end', () => process.exit(0))
process.on('SIGTERM', () => { bot.end('bye'); setTimeout(() => process.exit(0), 200) })
