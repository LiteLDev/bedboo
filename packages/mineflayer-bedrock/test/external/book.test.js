// owner: U14 (survival interactions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/book.js against BDS 1.26.51.1. Verbatim flow (book in the main
 * inventory slot 30, writeBook, signBook); adapted assertion (docs/differences/U14.md#books): a Bedrock book's pages
 * are `[{ text, photoname }]` compounds (Java: plain strings), so the page texts are compared. Bedrock extras: the
 * written book's xuid / generation, a held book, rewriting fewer pages (delete_page), argument errors.
 */
const assert = require('assert')
const { useBot } = require('./common')
const { pagesOf } = require('../../lib/plugins/book')

describe('book', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('book', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    const usesComponents = bot.supportFeature('itemsWithComponents')

    const pages = [
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
      'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
      'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
      'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'
    ].map(page => page
      .split(' ')
      .map((word, i) => `§${(i % 13 + 1).toString(16)}${i % 2 ? '§l' : ''}${word}`)
      .join(' '))

    await bot.test.setInventorySlot(30, new Item(bot.registry.itemsByName.writable_book.id, 1, 0))

    await bot.writeBook(30, pages)
    let book = bot.inventory.slots[30]
    assert.ok(!usesComponents)
    // Bedrock: pages are [{ text, photoname }] (Java: a list of strings)
    assert.deepStrictEqual(book.nbt.value.pages.value.value.map(page => page.text.value), pages)

    await bot.signBook(30, pages, bot.username, 'My Very First Book')
    book = bot.inventory.slots[30]
    assert.strictEqual(book.type, bot.registry.itemsByName.written_book.id)
    assert.strictEqual(book.nbt.value.author.value, bot.username)
    assert.strictEqual(book.nbt.value.title.value, 'My Very First Book')
    // Bedrock extras: the written book keeps the pages, xuid ('' offline) and generation 0 (original)
    assert.deepStrictEqual(pagesOf(book), pages)
    assert.strictEqual(book.nbt.value.generation.value, 0)
    assert.strictEqual(book.nbt.value.xuid.value, '')
    // the book went back to slot 30 and the held slot was restored
    assert.strictEqual(bot.inventory.slots[36], null)
    assert.strictEqual(bot.quickBarSlot, 0)
  })

  it('held book: write, rewrite with fewer pages (delete_page), sign (Bedrock extra)', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(38, new Item(bot.registry.itemsByName.writable_book.id, 1, 0))
    bot.setQuickBarSlot(4)
    await bot.writeBook(38, ['one', 'two', 'three'])
    assert.deepStrictEqual(pagesOf(bot.inventory.slots[38]), ['one', 'two', 'three'])
    assert.strictEqual(bot.quickBarSlot, 4, 'the held slot is restored')
    await bot.writeBook(38, ['uno'])
    assert.deepStrictEqual(pagesOf(bot.inventory.slots[38]), ['uno'])
    await bot.writeBook(38, ['uno']) // unchanged: nothing to send
    await bot.signBook(38, ['uno', 'dos'], bot.username, 'Short')
    const book = bot.inventory.slots[38]
    assert.strictEqual(book.name, 'written_book')
    assert.deepStrictEqual(pagesOf(book), ['uno', 'dos'])
    assert.strictEqual(book.nbt.value.title.value, 'Short')
  })

  it('argument errors like upstream', async () => {
    const { bot } = ctx
    await assert.rejects(bot.writeBook(50, ['x']), /slot out of inventory range/)
    await assert.rejects(bot.writeBook(30, ['x']), /no book found in slot 30/)
  })
})
