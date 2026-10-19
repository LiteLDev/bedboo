# Getting started: a bot on your own BDS

This walks through connecting a mineflayer-bedrock bot to a Bedrock Dedicated Server (BDS) you run yourself. If you
have written a mineflayer bot before, only steps 1–3 are new: the bot code is mineflayer code.

- [1. Requirements](#1-requirements)
- [2. Get the code](#2-get-the-code)
- [3. Prepare the server](#3-prepare-the-server)
- [4. Write the bot](#4-write-the-bot)
- [5. Run it](#5-run-it)
- [6. Permissions, cheats and commands](#6-permissions-cheats-and-commands)
- [7. Microsoft (Xbox Live) accounts](#7-microsoft-xbox-live-accounts)
- [NetherNet](#nethernet)
- [Troubleshooting](#troubleshooting)

## 1. Requirements

- Node.js **24** or newer, on **x64** (Linux, Windows or macOS on Intel). The RakNet backend (raknet-native) ships x64
  prebuilds only; NetherNet is pure JavaScript and works anywhere Node does.
- A BDS **1.26.51.x** (or 1.26.52.x, which speaks the same protocol 2193). Other versions are refused at login.
- Docker, only if you want the repository's throw-away test servers (`corepack pnpm bds …`).

## 2. Get the code

mineflayer-bedrock is used from its monorepo (its dependency fixes are pnpm patches that apply inside the workspace):

```sh
git clone https://github.com/LiteLDev/bedboo
cd bedboo
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install
```

Put your bot in a workspace package so it gets its own dependencies (plugins included):

```sh
mkdir -p packages/my-bot
cat > packages/my-bot/package.json <<'EOF'
{
  "name": "my-bot",
  "private": true,
  "dependencies": {
    "mineflayer-bedrock": "workspace:*",
    "mineflayer-pathfinder": "2.4.5"
  }
}
EOF
corepack pnpm install
```

(For a quick experiment you can also drop a script into `packages/mineflayer-bedrock/examples/`: `mineflayer-bedrock`
and `mineflayer-pathfinder` resolve there.)

## 3. Prepare the server

### Option A — a local test server with Docker

```sh
corepack pnpm bds pull                                  # once: image + BDS 1.26.51.1 (sha256-verified download)
corepack pnpm bds up --name mybds --gamemode survival --difficulty normal --world default
# bedboo-mybds ready on 127.0.0.1:41000 (slot 0, …)
# BDS_HOST=127.0.0.1 BDS_PORT=41000 BDS_CONTAINER=bedboo-mybds
```

The harness writes a `server.properties` that suits bots: `online-mode=false`, `allow-list=false`,
`transport=raknet`, `allow-cheats=true`, operators by default, LAN visibility off. `--transport nethernet` starts a
NetherNet server instead; `--property key=value` sets anything else. Use `corepack pnpm bds cmd mybds <command>` for
the console, `bds logs mybds -f` for the log and `bds down mybds` to remove it (world included). See
[testing.md](testing.md#bds-cli).

### Option B — your own BDS

Install BDS 1.26.51.x from [minecraft.net](https://www.minecraft.net/download/server/bedrock) and set in
`server.properties`:

```properties
# the bot joins over RakNet by default (BDS 1.26.51 defaults to nethernet; see "NetherNet" below)
transport=raknet
# offline bots (auth: 'offline') have no Xbox Live identity
online-mode=false
# or keep it true and add the bot's name to allowlist.json
allow-list=false
server-port=19132
# optional: lets the bot run commands (bot.chat('/time set day'))
allow-cheats=true
```

`online-mode=false` lets anybody join under any name: keep such a server on a private network, or use
`online-mode=true` with a Microsoft account (step 7). With `transport=raknet` and `enable-lan-visibility=true` BDS
additionally binds 19132/19133; turn it off when you run several servers on one host.

Start the server and wait for `Server started.` in its log. (A `TRANSPORT TYPE ERROR … not set to NetherNet` block
right after it is BDS warning that vanilla clients may soon need NetherNet; RakNet clients connect fine.)

## 4. Write the bot

`packages/my-bot/index.js` — plain mineflayer code:

```js
const mineflayer = require('mineflayer-bedrock')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const bot = mineflayer.createBot({
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
`bot.registry.blocksByName.oak_log` and `bot.inventory.items()[0].name` give Bedrock names. Everything else — events,
`bot.dig`, `bot.placeBlock`, `bot.craft`, windows, `bot.attack`, physics — is mineflayer's API. The full list of what
differs is in [api.md](api.md#bedrock-differences-in-short).

## 5. Run it

```sh
node packages/my-bot/index.js 127.0.0.1 19132        # or the port `bds up` printed
```

Join the server with a Bedrock client (or another bot), say `come` in chat and the bot walks to you. The same file
works with `require('mineflayer')` against a Java server, minus the Bedrock block names.

## 6. Permissions, cheats and commands

- `bot.chat('/…')` sends a command request (Bedrock has no chat-typed commands). Commands need
  `allow-cheats=true` and an operator: on BDS a player cannot op itself, so op the bot from the console
  (`op Bot`, or `bds cmd mybds op Bot`), or set `default-player-permission-level=operator`.
- Command results arrive as `message` events (Bedrock's `command_output`, one per line).
- `/give`, `/replaceitem`, `/tp` etc. are visible to the bot like on Java (`playerCollect`, `forcedMove`, …).

## 7. Microsoft (Xbox Live) accounts

For `online-mode=true` servers use a Microsoft account that owns Minecraft:

```js
const bot = mineflayer.createBot({
  host: 'my.server.example',
  port: 19132,
  username: 'me@example.com',     // a name for the token cache
  auth: 'microsoft',
  profilesFolder: './.auth-cache' // optional; same options as mineflayer (prismarine-auth)
})
```

The first run prints a device-code link (`onMsaCode` lets you handle it yourself); tokens are cached afterwards. The
in-game name is the account's gamertag. `auth: 'mojang'` does not exist on Bedrock and throws.

## NetherNet

BDS 1.26.51 uses **NetherNet** (WebRTC data channels) by default and keeps RakNet behind `transport=raknet`. Mojang
has said RakNet will be removed, possibly as soon as BDS 26.60. mineflayer-bedrock connects over RakNet unless told
otherwise, because that is the transport bedrock-protocol has supported for years and the one the whole test suite
runs on. To use NetherNet, start BDS with `transport=nethernet` and pass the transport to `createBot`:

```js
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 19132, username: 'Bot', transport: 'nethernet' })
```

- Signalling is **HTTP on the server port** (`POST http://<host>:<port>/v1/join/<id>`), so it works with
  `enable-lan-visibility=false` and through port forwarding of `server-port` (TCP) — the media then flows over UDP
  (BDS's `server-udp-ports`). bedrock-protocol's other signalling modes are passed through but not covered by the
  test suite: LAN discovery (UDP 7551, needs `enable-lan-visibility=true`) with `nethernet: { signalling: 'lan' }`,
  and Xbox signalling with `nethernet: { signalling: 'services', networkId }` + `auth: 'microsoft'`.
- **Server key.** BDS signs its answer with an identity key. Over plain HTTP nothing vouches for that key, so by
  default any key is accepted — the same trust RakNet gives you. Pin it to refuse impostors:
  `nethernet: { serverKey: 'sha256:<hex>' }`; `nethernet: { onServerKey: (fingerprint, url) => true | false }` lets you
  decide (and shows you the fingerprint to pin). HTTPS signalling URLs (`nethernet: { url: 'https://…' }`) are
  trusted through TLS.
- The bot's API is identical on both transports. With the Docker harness: `corepack pnpm bds up --name nn --transport
  nethernet`.

## Troubleshooting

| symptom | cause |
|---|---|
| `Connect timed out` | wrong host/port, the server's `transport` differs from the bot's, or a firewall drops UDP (RakNet) / TCP (NetherNet signalling) |
| `kicked` right after login | `allow-list=true` without the bot in `allowlist.json`, or `online-mode=true` with `auth: 'offline'` (the `reason` says which) |
| kicked as outdated client / server | the server is not 1.26.51.x / 1.26.52.x |
| the RakNet backend fails to load | not on x64, or dependencies installed outside the workspace (the raknet-native patch is missing) |
| commands are refused | op the bot from the console, enable cheats (`allow-cheats=true`) |
| NetherNet: `Untrusted Nethernet server key` | a `serverKey` pin does not match the server's key (or `onServerKey` returned false) |
| NetherNet: `fetch failed` (`ECONNREFUSED`) | the server runs RakNet, or BDS could not open its TCP signalling listener (it then logs no `Accepting clients on …` line; another process held the port) |

More BDS behaviour worth knowing (join sequence, chunk loading, quirks) is collected in [testing.md](testing.md#bds-126511-quirks-seen).
