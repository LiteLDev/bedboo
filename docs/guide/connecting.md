# Connecting to a server

Server settings, versions, accounts and transports for a bot that joins a Bedrock Dedicated Server (BDS). A first bot
from zero (get the code, write it, run it): the tutorial
[Your first bedboo bot](https://levimc.org/tutorials/automate/first-bedboo-bot/).

## Server settings {#prepare-the-server}

A supported BDS from [minecraft.net](https://www.minecraft.net/download/server/bedrock) (1.26.51.1 is the default
version) needs these settings in `server.properties`:

```properties
# the bot joins over RakNet by default (BDS 1.26.51 and newer default to nethernet; see "Transports" below)
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

## Other versions {#versions}

For a server other than 1.26.51, pass its BDS build or protocol family to `createBot`:

```js
const bot = bedboo.createBot({ host: '127.0.0.1', port: 19132, username: 'Bot', version: '1.26.62.1' })
// bot.version === '1.26.60', bot.protocolVersion === 2225
```

The families, their BDS builds and the transport each BDS defaults to are listed in
[Supported versions](../reference/versions/index.md#matrix). A version bedboo does not know throws
`ERR_BEDBOO_VERSION`, listing the supported ones. The bot's code stays the same on every version.

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

BDS 1.26.51 and newer use **NetherNet** (WebRTC data channels) by default and keep RakNet behind `transport=raknet`;
1.26.40 and 1.26.45 still default to RakNet. Mojang has said RakNet will be removed; BDS 1.26.60 to 1.26.63.1 still
offer it. bedboo connects over RakNet unless told otherwise,
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
| kicked as outdated client / server | the server's family differs from the bot's `version` ([other versions](#versions)) |
| the RakNet backend fails to load | not on x64, or dependencies installed outside the workspace (the raknet-native patch is missing) |
| commands are refused | op the bot from the console, enable cheats (`allow-cheats=true`) |
| NetherNet: `Untrusted Nethernet server key` | a `serverKey` pin does not match the server's key (or `onServerKey` returned false) |
| NetherNet: `fetch failed` (`ECONNREFUSED`) | the server runs RakNet, or BDS could not open its TCP signalling listener (it then logs no `Accepting clients on …` line; another process held the port) |

More BDS behaviour worth knowing (join sequence, chunk loading, console output) is collected in
[BDS notes](../reference/bds.md).
