# API

**bedboo's API is mineflayer's API.** Every class, property, method and event documented in mineflayer 4.39.0's
[API reference](https://github.com/PrismarineJS/mineflayer/blob/4.39.0/docs/api.md) exists with the same name,
arguments, return value, error messages and event order, and bedboo's TypeScript definitions (`index.d.ts`) are
mineflayer's with the protocol client swapped. Read upstream's document for the reference; this page lists only what
is different or extra. Behaviour that differs because Bedrock differs is in the
[Bedrock differences](differences/index.md).

## Module exports {#module-exports}

`require('bedboo')` exports what `require('mineflayer')` exports:

| export | value |
|---|---|
| `createBot(options)` | see [below](#createbot-options) |
| `Location`, `Painting`, `ScoreBoard`, `BossBar` | mineflayer's classes, unchanged |
| `Particle` | mineflayer's class, extended for Bedrock particle packets ([particles](differences/chat.md#particles)) |
| `latestSupportedVersion`, `oldestSupportedVersion` | `'1.26.60'`, `'1.26.40'` |
| `testedVersions` | `['1.26.40', '1.26.45', '1.26.51', '1.26.60']`, the tested protocol families, oldest first ([supported versions](versions/index.md)) |
| `supportFeature(feature, version)` | answers from the Bedrock feature table ([feature table](differences/data.md#feature-table)) |

## createBot options {#createbot-options}

`createBot(options)` takes mineflayer's options plus bedrock-protocol's
[`ClientOptions`](https://github.com/PrismarineJS/bedrock-protocol/blob/master/docs/API.md) (`BotOptions` extends
them in `index.d.ts`). Defaults differ where Bedrock needs it:

| option | default | |
|---|---|---|
| `host` | `'127.0.0.1'` | BDS address |
| `port` | `19132` | BDS `server-port` (UDP for RakNet, TCP + UDP for NetherNet) |
| `username` | `'Player'` | offline: the player name; microsoft: the token-cache key (the in-game name is the gamertag) |
| `auth` | `'offline'` | `'offline'` (no Xbox Live; the server needs `online-mode=false`) or `'microsoft'` (Xbox Live through prismarine-auth: `profilesFolder`, `onMsaCode`, `authTitle`, `flow`, `deviceType` as in mineflayer). `'mojang'` throws. |
| `version` | `'1.26.51'` | a tested family (`'1.26.60'`) or one of its BDS builds (`'1.26.62.1'`); `false` (auto) means 1.26.51 (the server's version is not detected); anything else throws `ERR_BEDBOO_VERSION` ([supported versions](versions/index.md#choosing)) |
| `transport` | `'raknet'` | `'nethernet'` for NetherNet ([transports](differences/connection.md#transport)); `'bedd'` drives a real client ([BeDD](../guide/bedd.md#options)) |
| `nethernet` | `{ signalling: 'http' }` | NetherNet only: `signalling` (`'http'` = HTTP on the server port, `'lan'` = UDP 7551 discovery, `'services'` = Xbox), `url` (signalling origin, default `http://host:port`), `serverKey` (`'sha256:<hex>'` pin of the server's identity key), `onServerKey(fingerprint, url) → boolean` (approve an unpinned key; by default any key is accepted), `networkId`, `webrtcBackend`, `signallingConnectTimeout` |
| `bedd` | | `transport: 'bedd'` only: `url` + `token`, `pid` or `instance` (the BeDD v2 game; `{}` = the only running one), `home`, `timeoutMs`, `modules` ([BeDD options](../guide/bedd.md#options)) |
| `raknetBackend` | `'raknet-native'` | `'jsp-raknet'` is refused by BDS (RakNet protocol 10 vs 11) |
| `skipPing` | `true` | BDS with LAN visibility off does not answer pings |
| `conLog` | `null` | bedrock-protocol's console logging (`console.log` to see connection messages) |
| `viewDistance` | `'far'` | mineflayer's names or a chunk count; sent as `request_chunk_radius` |
| `maxCatchupTicks` | `4` | *extra:* how many missed `player_auth_input` ticks the bot sends at once after a stall |
| `respawn`, `physicsEnabled`, `plugins`, `loadInternalPlugins`, `chat`, `colorsEnabled`, `hideErrors`, `logErrors`, `defaultChatPatterns`, `chatLengthLimit`, `mainHand`, `client`, `brand` | as mineflayer | `client`: any bedrock-protocol `Client` (`createClient` result); `brand` is ignored (Bedrock has no brand channel) |

## Bedrock extras: `bot.bedrock` {#bedrock-extras}

Bedrock-only additions live under `bot.bedrock`, never as new top-level `bot` members, and are typed in
`types/bedrock.d.ts` (`BedrockExtras`):

| member | type | |
|---|---|---|
| `bot.bedrock.gameRules` | `{ [name: string]: boolean \| number }` | the server's game rules by Bedrock name (`doDayLightCycle`, `keepInventory`, `randomTickSpeed`, …), from `start_game` and `game_rules_changed` ([game rules](differences/world.md#game-rules)) |
| `bot.bedrock.blockVariants(block)` | `(block: string \| number) => number[]` | the ids of the Bedrock blocks Java models as one block with a state. A burning furnace is `lit_furnace`: `bot.findBlock({ matching: bot.bedrock.blockVariants('furnace') })` also finds it ([block variants](differences/world.md#block-variants)) |
| `bot.bedrock.resyncInventory()` | `() => Promise<boolean>` | asks the server for its copy of the player's inventory (inventory, armor, cursor, off-hand); resolves `true` once it was applied, `false` when no answer came within 2 s. The bot does this by itself when it finds a slot out of date ([inventory resync](differences/inventory.md#inventory-resync)) |
| `bot.bedrock.bedd` | `{ caps, supports(name), observed } \| undefined` | only with `transport: 'bedd'` (a real client hosted by Be.D.D.): `caps` maps each BeDD op to `'present'`, `'disabled'` or `'absent'`; `supports(name)` tells whether a bot API (`'dig'`, `'craft'`, …) works with them. An item stack or screen-level API (`clickWindow`, `craft`, `equip` from outside the hotbar, `creative`, `writeBook`, `updateSign`, …) whose op is missing throws / rejects a `BeddUnsupportedError` (`code: 'ERR_BEDD_UNSUPPORTED'`, `feature`, `missing`) ([BeDD](../guide/bedd.md#options)) |
| `bot.bedrock.bedd.observed` | `{ yaw: number, pitch: number, tick: number \| null } \| null` | transport `'bedd'` only: the rotation (Bedrock degrees) and tick of the last `player_auth_input` the real client sent; `null` until the first one. `bot.entity` follows the same echo ([self state](differences/bedd.md#self-state-from-echo)) |

## Internals {#internals}

Not part of the API (they may change), but useful for debugging:

- `bot._client`: the bedrock-protocol `Client` (`on(packetName, …)`, `queue`, `write`; packet names and fields are
  Bedrock's, see the [protocol docs](https://prismarinejs.github.io/minecraft-data/?v=bedrock_1.26.51&d=protocol)).
- `bot._bedrock`: shared Bedrock state of the plugins (input queue, lifecycle, item stack requests, windows, …).
