# bedboo

The bedboo library: a Minecraft Bedrock Edition bot library with a mineflayer-compatible API. It offers mineflayer
4.39.0's `createBot()`, every `bot.*` property, method and event, the TypeScript types and the plugin system, and it
connects to a Bedrock Dedicated Server (BDS 1.26.51.x, protocol 2193) over RakNet or NetherNet.

```js
const bedboo = require('bedboo')

const bot = bedboo.createBot({ host: '127.0.0.1', port: 19132, username: 'Bot', auth: 'offline' })
bot.on('chat', (username, message) => {
  if (username !== bot.username) bot.chat(message)
})
```

Part of the [bedboo](https://github.com/LiteLDev/bedboo) monorepo, which it relies on for small patches of its
dependencies (`patches/`). Documentation: https://docs.levimc.org/bedboo/ ([getting started](https://docs.levimc.org/bedboo/guide/getting-started),
[API](https://docs.levimc.org/bedboo/reference/api)); a runnable example is `examples/readme_quickstart.js`.

Licensed under LGPL-3.0-only (see `COPYING` and `COPYING.LESSER`); includes code adapted from mineflayer (MIT,
Copyright (c) 2013 Andrew Kelley) and PrismarineJS packages (MIT), with attribution in the adapted files.
