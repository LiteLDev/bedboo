# mineflayer-bedrock

[mineflayer](https://github.com/PrismarineJS/mineflayer) for Minecraft: Bedrock Edition. Same API as mineflayer
4.39.0 — `createBot()`, every `bot.*` property, method and event, the TypeScript types and the plugin system — but it
connects to a Bedrock Dedicated Server (BDS 1.26.51.x, protocol 2193) over RakNet or NetherNet.

```js
const mineflayer = require('mineflayer-bedrock')

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 19132, username: 'Bot', auth: 'offline' })
bot.on('chat', (username, message) => {
  if (username !== bot.username) bot.chat(message)
})
```

Part of the [bedboo](https://github.com/LiteLDev/bedboo) monorepo, which it relies on for small patches of its
dependencies (`patches/`): see the repository [README](https://github.com/LiteLDev/bedboo#readme) for installation,
[getting started](https://github.com/LiteLDev/bedboo/blob/main/docs/getting-started.md), the
[API reference](https://github.com/LiteLDev/bedboo/blob/main/docs/api.md) (mineflayer's API plus the Bedrock
differences) and `examples/readme_quickstart.js`.

Licensed under LGPL-3.0-only (see `COPYING` and `COPYING.LESSER`); includes code adapted from mineflayer (MIT,
Copyright (c) 2013 Andrew Kelley) and PrismarineJS packages (MIT), with attribution in the adapted files.
