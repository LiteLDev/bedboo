// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/title.js (MIT, Copyright (c) 2013 Andrew Kelley) against BDS 1.26.51.1.
 * Verbatim: Bedrock's /title takes the rest of the line as the text, so `/title @a title {"text":"Test Title"}`
 * sends `{"text":"Test Title"}` and upstream's parseTitle extracts "Test Title" like on Java.
 * Bedrock extra: /titleraw (rawtext titles) and /title reset.
 */
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('title', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => env.bot.test.resetState())

  it('title', async () => {
    const { bot } = env
    bot.test.sayEverywhere('### Starting title')
    // Test title
    bot.chat('/title @a title {"text":"Test Title"}')
    const [title, type] = await once(bot, 'title', 2000)
    if (title !== 'Test Title' || type !== 'title') {
      throw new Error(`Title test failed: expected "Test Title" but got "${title}" with type "${type}"`)
    }

    // Test subtitle
    bot.chat('/title @a subtitle {"text":"Test Subtitle"}')
    const [subtitle, subtitleType] = await once(bot, 'title', 20000)
    if (subtitle !== 'Test Subtitle' || subtitleType !== 'subtitle') {
      throw new Error(`Subtitle test failed: expected "Test Subtitle" but got "${subtitle}" with type "${subtitleType}"`)
    }

    // Test title_times event
    bot.chat('/title @a times 10 20 30')
    const [fadeIn, stay, fadeOut] = await once(bot, 'title_times', 20000)
    if (fadeIn !== 10 || stay !== 20 || fadeOut !== 30) {
      throw new Error(`title_times event failed: expected (10,20,30) but got (${fadeIn},${stay},${fadeOut})`)
    }

    // Test combined title and subtitle
    bot.chat('/title @a title {"text":"Test Title"}')
    const [combinedTitle, combinedTitleType] = await once(bot, 'title', 20000)
    if (combinedTitle !== 'Test Title' || combinedTitleType !== 'title') {
      throw new Error(`Combined title test failed: expected "Test Title" but got "${combinedTitle}" with type "${combinedTitleType}"`)
    }

    bot.chat('/title @a subtitle {"text":"Test Subtitle"}')
    const [combinedSubtitle, combinedSubtitleType] = await once(bot, 'title', 20000)
    if (combinedSubtitle !== 'Test Subtitle' || combinedSubtitleType !== 'subtitle') {
      throw new Error(`Combined subtitle test failed: expected "Test Subtitle" but got "${combinedSubtitle}" with type "${combinedSubtitleType}"`)
    }

    // Test clearing title
    bot.chat('/title @a clear')
    await once(bot, 'title_clear', 2000)
  })

  it('titleraw (rawtext) titles and /title reset (Bedrock extra)', async () => {
    const { bot } = env
    bot.chat('/titleraw @s title {"rawtext":[{"text":"Raw "},{"translate":"entity.wither.name"}]}')
    assert.deepStrictEqual(await once(bot, 'title', 5000), ['Raw Wither', 'title'])
    bot.chat('/titleraw @s subtitle {"rawtext":[{"text":"§aGreen"}]}')
    assert.deepStrictEqual(await once(bot, 'title', 5000), ['Green', 'subtitle'])
    bot.chat('/title @s reset')
    await once(bot, 'title_clear', 5000)
  })
})
