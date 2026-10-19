// owner: U14 (survival interactions)
// Adapted from mineflayer 4.39.0 lib/plugins/book.js (MIT, Copyright (c) 2013 Andrew Kelley): the same argument
//   checks and messages, the book is moved to the first hotbar slot and held while it is edited, then the held slot
//   and the book's slot are restored; the call resolves once the server's copy of the book reflects the edit.
// Surface: bot.writeBook(slot, pages), bot.signBook(slot, pages, author, title)
// Bedrock (BDS 1.26.51.1, verified live — docs/differences/U14.md#books):
// - the book must be opened first: item use click_air with the held writable_book (BDS gives a new book an empty
//   `pages` list then); edits sent before that are ignored;
// - book_edit { inventory_slot: hotbar slot, type: replace_page | add_page | delete_page, page_number, text,
//   photo_name } per page (Bedrock edits pages one by one; Java sends the whole book), sign { title, author, xuid }
//   turns it into a written_book;
// - BDS sends nothing back for an edit: closing the book (item_release, what the client does when the book screen
//   closes) makes it send the edited book (inventory_content, new stack id), which is the acknowledgement;
// - item NBT: writable_book `pages: [{ text, photoname }]`; written_book adds `author`, `title`, `xuid`,
//   `generation` (Java: pages are plain strings).
'use strict'
const assert = require('assert')
const { onceWithCleanup, sleep } = require('mineflayer/lib/promise_utils')

module.exports = inject

/**
 * Edit sessions (ms): the delay between opening the book and the first edit, and how long to wait for the server's
 * copy of the edited book; a second session (longer delay) resends what the first one lost. 20 s in total, upstream's
 * acknowledgement timeout.
 */
const ATTEMPTS = [{ openDelay: 150, ackTimeout: 5000 }, { openDelay: 500, ackTimeout: 15000 }]
/** ms to wait for the page list BDS gives a new book when it is opened */
const OPEN_TIMEOUT = 2000
/**
 * BDS 1.26.51.1 keeps at most 50 pages (Java: 100) and drops the rest, so a longer book could never be acknowledged
 * (U16a): rejected up front like upstream's argument checks.
 */
const MAX_PAGES = 50

/** page texts of a Bedrock book item (`pages: [{ text, photoname }]`; plain strings accepted too) */
function pagesOf (item) {
  const list = item?.nbt?.value?.pages?.value?.value
  if (!Array.isArray(list)) return []
  return list.map((page) => typeof page === 'string' ? page : String(page?.text?.value ?? ''))
}

function samePages (item, pages) {
  const current = pagesOf(item)
  return current.length === pages.length && current.every((text, i) => text === pages[i])
}

/** book_edit packets that turn the book's `current` pages into `pages` */
function pageEdits (inventorySlot, current, pages) {
  const edits = []
  pages.forEach((text, page) => {
    if (page < current.length && current[page] === text) return
    const type = page < current.length ? 'replace_page' : 'add_page'
    edits.push({ inventory_slot: inventorySlot, type, page_number: page, text, photo_name: '' })
  })
  for (let page = current.length - 1; page >= pages.length; page--) {
    edits.push({ inventory_slot: inventorySlot, type: 'delete_page', page_number: page })
  }
  return edits
}

function inject (bot) {
  async function write (slot, pages, author, title, signing) {
    assert.ok(slot >= 0 && slot <= 44, 'slot out of inventory range')
    const book = bot.inventory.slots[slot]
    assert.ok(book && book.type === bot.registry.itemsByName.writable_book.id, `no book found in slot ${slot}`)
    assert.ok(Array.isArray(pages) && pages.length <= MAX_PAGES, `too many pages: a Bedrock book holds at most ${MAX_PAGES} pages`)
    const quickBarSlot = bot.quickBarSlot
    const moveToQuickBar = slot < 36

    if (moveToQuickBar) {
      await bot.moveSlotItem(slot, 36)
      await bot._syncWindow(bot.inventory)
    }

    let failure = null
    try {
      bot.setQuickBarSlot(moveToQuickBar ? 0 : slot - 36)

      const bookSlot = moveToQuickBar ? 36 : slot
      // nothing to change (writeBook with the book's own pages): no session, BDS would not send the book again
      if (signing || pageEdits(bookSlot - 36, pagesOf(bot.inventory.slots[bookSlot]), pages).length > 0) {
        try {
          await editSession(bookSlot, pages, author, title, signing, ATTEMPTS[0])
        } catch (err) {
          if (!err.retry) throw err
          // an edit BDS handled before it had opened the book is dropped: open it again and resend what is missing
          await editSession(bookSlot, pages, author, title, signing, ATTEMPTS[1])
        }
      }
    } catch (err) {
      failure = err
    }

    // restore the held slot and the book's slot also when the edit failed (U16a)
    bot.setQuickBarSlot(quickBarSlot)

    if (moveToQuickBar) {
      if (failure) await bot.moveSlotItem(36, slot).catch(() => {})
      else await bot.moveSlotItem(36, slot)
    }
    if (failure) throw failure
  }

  /**
   * One open → edit (→ sign) → close session on the held book. Resolves when the server's copy reflects the edit;
   * rejects with `err.retry` when it did not within `ackTimeout`.
   */
  async function editSession (bookSlot, pages, author, title, signing, { openDelay, ackTimeout }) {
    const hotbarSlot = bookSlot - 36
    const writtenBook = bot.registry.itemsByName.written_book.id
    const done = (item) => !!item && (!signing || item.type === writtenBook) && samePages(item, pages)
    // Only an update that already reflects the edit counts as the acknowledgement (opening the book first sends a
    // new book back with an empty page list).
    const acknowledged = onceWithCleanup(bot.inventory, `updateSlot:${bookSlot}`, {
      timeout: ackTimeout,
      checkCondition: (oldItem, newItem) => done(newItem)
    })
    acknowledged.catch(() => {})

    // open: a book without a page list gets one from the server (that update tells the book is open); otherwise
    // the edits must still reach the server in a later tick than the use
    const fresh = !Array.isArray(bot.inventory.slots[bookSlot]?.nbt?.value?.pages?.value?.value)
    const opened = fresh
      ? onceWithCleanup(bot.inventory, `updateSlot:${bookSlot}`, { timeout: OPEN_TIMEOUT, checkCondition: (o, n) => !!n?.nbt?.value?.pages })
      : null
    opened?.catch(() => {})
    bot.activateItem()
    await sleep(openDelay)
    if (opened) await opened.catch(() => {})

    for (const edit of pageEdits(hotbarSlot, pagesOf(bot.inventory.slots[bookSlot]), pages)) {
      bot._client.queue('book_edit', edit)
    }
    if (signing) {
      bot._client.queue('book_edit', { inventory_slot: hotbarSlot, type: 'sign', title, author, xuid: xuidOf() })
    }
    // close: BDS sends the edited book back
    bot.deactivateItem()
    try {
      await acknowledged
    } catch (err) {
      if (done(bot.inventory.slots[bookSlot])) return
      err.retry = true
      throw err
    }
  }

  /** the player's xuid as Bedrock writes it into a signed book ('' when offline) */
  function xuidOf () {
    const xuid = bot._client.profile?.xuid
    return xuid && String(xuid) !== '0' ? String(xuid) : ''
  }

  bot.writeBook = async (slot, pages) => {
    await write(slot, pages, null, null, false)
  }

  bot.signBook = async (slot, pages, author, title) => {
    await write(slot, pages, author, title, true)
  }
}

module.exports.pagesOf = pagesOf
module.exports.pageEdits = pageEdits
