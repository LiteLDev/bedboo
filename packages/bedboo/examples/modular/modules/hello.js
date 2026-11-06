const bedboo = require('bedboo') // eslint-disable-line

/**
 * @param {bedboo.Bot} bot // to enable intellisense
 */

module.exports = bot => {
  bot.addChatPattern('hello', /<(.+)> (?:Hello|hello)/, { parse: true })

  bot.on('chat:hello', ([[playerIgn]]) => {
    bot.chat(`Hi, ${playerIgn}`)
  })
}
