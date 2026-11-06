# Your first bot

This page connects a bedboo bot to a Bedrock Dedicated Server (BDS) you run yourself. If you have written a mineflayer
bot before, only the first three steps are new: the bot code is the same as for mineflayer.

## Requirements {#requirements}

- Node.js **24** or newer. The RakNet backend (raknet-native) ships **x64** prebuilds only (Linux, Windows, macOS on
  Intel); NetherNet is pure JavaScript and works anywhere Node does.
- A BDS **1.26.51.x** (or 1.26.52.x, which speaks the same protocol 2193). Other versions are refused at login.

## Get the code {#get-the-code}

bedboo is not published to npm yet. A few small fixes to its dependencies (bedrock-protocol, nethernet,
raknet-native, prismarine-*) are pnpm patches that apply only inside its workspace, so use it from the monorepo:

```sh
git clone https://github.com/LiteLDev/bedboo
cd bedboo
corepack enable   # pnpm is pinned in package.json (packageManager)
pnpm install
```

Put your bot in a workspace package so it gets its own dependencies, plugins included:

```sh
mkdir -p packages/my-bot
cat > packages/my-bot/package.json <<'EOF'
{
  "name": "my-bot",
  "private": true,
  "dependencies": {
    "bedboo": "workspace:*",
    "mineflayer-pathfinder": "2.4.5"
  }
}
EOF
pnpm install
```

To vendor bedboo into another pnpm project, copy `patches/`, the `overrides`, `packageExtensions` and
`patchedDependencies` of `pnpm-workspace.yaml`, and the `bedboo` and `bedrock-data` packages. Without the patched
dependencies a bot cannot join a server.

## Prepare the server {#prepare-the-server}

Install BDS 1.26.51.x from [minecraft.net](https://www.minecraft.net/download/server/bedrock) and set in
`server.properties`:

```properties
# the bot joins over RakNet by default (BDS 1.26.51 defaults to nethernet; see "Transports" below)
transport=raknet
# offline bots (auth: 'offline') have no Xbox Live identity
online-mode=false
# or keep it true and add the bot's name to allowlist.json
allow-list=false
server-port=19132
# optional: lets the bot run commands (bot.chat('/time set day'))
allow-cheats=true
```

| property | value | why |
|---|---|---|
| `transport` | `raknet`, or `nethernet` with `transport: 'nethernet'` in `createBot` | RakNet is the default client transport |
| `online-mode` | `false` for `auth: 'offline'`; `true` needs `auth: 'microsoft'` | offline bots have no Xbox Live identity |
| `allow-list` | `false`, or add the bot's name to `allowlist.json` | otherwise the bot is kicked |
| `server-port` | the `port` you pass to `createBot` | |

`online-mode=false` lets anybody join under any name: keep such a server on a private network, or use
`online-mode=true` with a [Microsoft account](#microsoft-accounts). With `transport=raknet` and
`enable-lan-visibility=true` BDS additionally binds 19132/19133; turn it off when you run several servers on one host.

Start the server and wait for `Server started.` in its log. A `TRANSPORT TYPE ERROR … not set to NetherNet` block
right after it is BDS warning that vanilla clients may soon need NetherNet; RakNet clients connect fine.

## Write the bot {#write-the-bot}

`packages/my-bot/index.js` is written exactly as for mineflayer:

```js
const bedboo = require('bedboo') // instead of require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const bot = bedboo.createBot({
  host: process.argv[2] ?? '127.0.0.1',
  port: parseInt(process.argv[3] ?? '19132'),
  username: 'Bot',
  auth: 'offline'
})
bot.loadPlugin(pathfinder)

bot.once('spawn', () => {
  console.log(`spawned at ${bot.entity.position} in ${bot.game.dimension} (${bot.game.gameMode})`)
  bot.chat('hello!')
})

bot.on('chat', async (username, message) => {
  if (username === bot.username) return
  if (message === 'come') {
    const target = bot.players[username]?.entity
    if (!target) return bot.chat("I can't see you")
    bot.pathfinder.setMovements(new Movements(bot))
    try {
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1))
      bot.chat('here!')
    } catch (err) {
      bot.chat(`I can't get there: ${err.message}`) // no path, or a new "come" changed the goal
    }
  } else if (message === 'inventory') {
    bot.chat(bot.inventory.items().map((item) => `${item.count} ${item.name}`).join(', ') || 'empty')
  } else {
    bot.chat(message)
  }
})

bot.on('kicked', (reason) => console.log('kicked:', reason))
bot.on('error', (err) => console.log('error:', err))
bot.on('end', (reason) => console.log('disconnected:', reason))
```

Names are Bedrock's: `bot.registry` is the Bedrock 1.26.51 registry (`grass_block`, `oak_log`, `stone_bricks`, …), so
`bot.registry.blocksByName.oak_log` and `bot.inventory.items()[0].name` give Bedrock names. Everything else (events,
`bot.dig`, `bot.placeBlock`, `bot.craft`, windows, `bot.attack`, physics) is mineflayer's API. What differs is listed
in the [Bedrock differences](../reference/differences/index.md).

## Run it {#run-it}

```sh
node packages/my-bot/index.js 127.0.0.1 19132
```

Join the server with a Bedrock client (or another bot), say `come` in chat and the bot walks to you. The same file
works with `require('mineflayer')` against a Java server, minus the Bedrock block names.

The library's `examples/` folder holds mineflayer's examples ported to Bedrock
(`node examples/<name>.js <host> <port> [<name>]`), and a script you drop there resolves the library and
mineflayer-pathfinder without any setup.

## Permissions, cheats and commands {#commands}

- `bot.chat('/…')` sends a command request (Bedrock has no chat-typed commands). Commands need `allow-cheats=true`
  and an operator: on BDS a player cannot op itself, so op the bot from the server console (`op Bot`), or set
  `default-player-permission-level=operator`.
- Command results arrive as `message` events (Bedrock's `command_output`, one per line).
- `/give`, `/replaceitem`, `/tp` and the like are visible to the bot as on Java (`playerCollect`, `forcedMove`, …).

## Microsoft (Xbox Live) accounts {#microsoft-accounts}

For `online-mode=true` servers use a Microsoft account that owns Minecraft:

```js
const bot = bedboo.createBot({
  host: 'my.server.example',
  port: 19132,
  username: 'me@example.com', // a name for the token cache
  auth: 'microsoft',
  profilesFolder: './.auth-cache' // optional; same options as mineflayer (prismarine-auth)
})
```

The first run prints a device-code link (`onMsaCode` lets you handle it yourself); tokens are cached afterwards. The
in-game name is the account's gamertag. `auth: 'mojang'` does not exist on Bedrock and throws.

## Transports: RakNet or NetherNet {#transports}

BDS 1.26.51 uses **NetherNet** (WebRTC data channels) by default and keeps RakNet behind `transport=raknet`. Mojang
has said RakNet will be removed, possibly as soon as BDS 26.60. bedboo connects over RakNet unless told otherwise,
because bedrock-protocol has supported it for years. To use NetherNet, start BDS with `transport=nethernet` and pass
the transport to `createBot`:

```js
const bot = bedboo.createBot({ host: '127.0.0.1', port: 19132, username: 'Bot', transport: 'nethernet' })
```

- Signalling is **HTTP on the server port** (`POST http://<host>:<port>/v1/join/<id>`), so it works with
  `enable-lan-visibility=false` and through port forwarding of `server-port` (TCP); the media then flows over UDP
  (BDS's `server-udp-ports`). bedrock-protocol's other signalling modes are passed through but less tested: LAN
  discovery (UDP 7551, needs `enable-lan-visibility=true`) with `nethernet: { signalling: 'lan' }`, and Xbox
  signalling with `nethernet: { signalling: 'services', networkId }` + `auth: 'microsoft'`.
- **Server key.** BDS signs its answer with an identity key. Over plain HTTP nothing vouches for that key, so by
  default any key is accepted, the same trust RakNet gives you. Pin it to refuse impostors:
  `nethernet: { serverKey: 'sha256:<hex>' }`; `nethernet: { onServerKey: (fingerprint, url) => true | false }` lets
  you decide (and shows you the fingerprint to pin). HTTPS signalling URLs (`nethernet: { url: 'https://…' }`) are
  trusted through TLS.
- The bot's API is identical on both transports. Details: [Connection and versions](../reference/differences/connection.md#transport).

## Troubleshooting {#troubleshooting}

| symptom | cause |
|---|---|
| `Connect timed out` | wrong host/port, the server's `transport` differs from the bot's, or a firewall drops UDP (RakNet) / TCP (NetherNet signalling) |
| `kicked` right after login | `allow-list=true` without the bot in `allowlist.json`, or `online-mode=true` with `auth: 'offline'` (the `reason` says which) |
| kicked as outdated client / server | the server is not 1.26.51.x / 1.26.52.x |
| the RakNet backend fails to load | not on x64, or dependencies installed outside the workspace (the raknet-native patch is missing) |
| commands are refused | op the bot from the console, enable cheats (`allow-cheats=true`) |
| NetherNet: `Untrusted Nethernet server key` | a `serverKey` pin does not match the server's key (or `onServerKey` returned false) |
| NetherNet: `fetch failed` (`ECONNREFUSED`) | the server runs RakNet, or BDS could not open its TCP signalling listener (it then logs no `Accepting clients on …` line; another process held the port) |

More BDS behaviour worth knowing (join sequence, chunk loading, console output) is collected in
[BDS notes](../reference/bds.md).
