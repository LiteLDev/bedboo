// owner: U14 (survival interactions)
// Upstream: mineflayer 4.39.0 lib/plugins/book.js
// Surface: bot.writeBook(slot, pages), bot.signBook(slot, pages, author, title)
// Bedrock: book_edit {type: replace_page|add_page|delete_page|swap_pages|sign, slot, …}.
'use strict'
const { stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.writeBook = stubAsync('U14', 'bot.writeBook', 2)
  bot.signBook = stubAsync('U14', 'bot.signBook', 4)
}
