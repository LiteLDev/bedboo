# API reference

**The API of mineflayer-bedrock is mineflayer's API.** Every class, property, method and event documented in
mineflayer 4.39.0's [`api.md`](upstream/api.md) (pinned copy; upstream:
[PrismarineJS/mineflayer docs/api.md](https://github.com/PrismarineJS/mineflayer/blob/4.39.0/docs/api.md)) exists
with the same name, arguments, return value, error messages and event order, and the TypeScript definitions
([`packages/mineflayer-bedrock/index.d.ts`](../packages/mineflayer-bedrock/index.d.ts)) are mineflayer's with the
protocol client swapped. Read upstream's document for the reference; this page lists only what is different or extra:

- [Module exports](#module-exports)
- [createBot options](#createbot-options) (connection, transports, authentication)
- [Bedrock differences in short](#bedrock-differences-in-short)
- [Bedrock extras: `bot.bedrock`](#bedrock-extras-botbedrock)
- [Internals](#internals)

Every difference is documented in full in [differences.md](differences.md) (assembled from
[differences/](differences)); the [parity matrix](parity.md) lists every upstream member and the test proving it.

## Module exports

`require('mineflayer-bedrock')` exports what `require('mineflayer')` exports:

| export | value |
|---|---|
| `createBot(options)` | see below |
| `Location`, `Painting`, `ScoreBoard`, `BossBar` | mineflayer's classes, unchanged |
| `Particle` | mineflayer's class, extended for Bedrock particle packets ([U6](differences/U6.md#particles)) |
| `latestSupportedVersion`, `oldestSupportedVersion` | `'1.26.51'` |
| `testedVersions` | `['1.26.51']` |
| `supportFeature(feature, version)` | answers from the Bedrock feature table ([U2](differences/U2.md#feature-table)) |

## createBot options

`createBot(options)` takes mineflayer's options plus bedrock-protocol's
[`ClientOptions`](https://github.com/PrismarineJS/bedrock-protocol/blob/master/docs/API.md) (`BotOptions` extends
them in `index.d.ts`). Defaults differ where Bedrock needs it:

| option | default | |
|---|---|---|
| `host` | `'127.0.0.1'` | BDS address |
| `port` | `19132` | BDS `server-port` (UDP for RakNet, TCP + UDP for NetherNet) |
| `username` | `'Player'` | offline: the player name; microsoft: the token-cache key (the in-game name is the gamertag) |
| `auth` | `'offline'` | `'offline'` (no Xbox Live; the server needs `online-mode=false`) or `'microsoft'` (Xbox Live through prismarine-auth: `profilesFolder`, `onMsaCode`, `authTitle`, `flow`, `deviceType` as in mineflayer). `'mojang'` throws. |
| `version` | `'1.26.51'` | `false` (auto) means 1.26.51; anything else throws — only the latest Bedrock is supported ([U4](differences/U4.md#versions)) |
| `transport` | `'raknet'` | `'nethernet'` for NetherNet ([U16b](differences/U16-transport.md#transport)) |
| `nethernet` | `{ signalling: 'http' }` | NetherNet only: `signalling` (`'http'` = HTTP on the server port, `'lan'` = UDP 7551 discovery, `'services'` = Xbox), `url` (signalling origin, default `http://host:port`), `serverKey` (`'sha256:<hex>'` pin of the server's identity key), `onServerKey(fingerprint, url) → boolean` (approve an unpinned key; by default any key is accepted), `networkId`, `webrtcBackend`, `signallingConnectTimeout` |
| `raknetBackend` | `'raknet-native'` | `'jsp-raknet'` is refused by BDS (RakNet protocol 10 vs 11) |
| `skipPing` | `true` | BDS with LAN visibility off does not answer pings |
| `conLog` | `null` | bedrock-protocol's console logging (`console.log` to see connection messages) |
| `viewDistance` | `'far'` | mineflayer's names or a chunk count; sent as `request_chunk_radius` |
| `maxCatchupTicks` | `4` | *extra:* how many missed `player_auth_input` ticks the bot sends at once after a stall |
| `respawn`, `physicsEnabled`, `plugins`, `loadInternalPlugins`, `chat`, `colorsEnabled`, `hideErrors`, `logErrors`, `defaultChatPatterns`, `chatLengthLimit`, `mainHand`, `client`, `brand` | as mineflayer | `client`: any bedrock-protocol `Client` (`createClient` result); `brand` is ignored (Bedrock has no brand channel) |

## Bedrock differences in short

What a bot author may notice. Everything not listed behaves like mineflayer on Java.

**Connection and versions**
- Only BDS 1.26.51.x / 1.26.52.x (protocol 2193): `bot.version` `'1.26.51'`, `bot.protocolVersion` 2193
  ([U4](differences/U4.md#versions)). RakNet by default, NetherNet on request
  ([U16b](differences/U16-transport.md#transport)).
- No `connect` before login: it fires when the login packet is sent ([U4](differences/U4.md#client)); `kicked` reasons
  are Bedrock disconnect messages or reason codes ([U4](differences/U4.md#kick-reason)).
- `bot.game.serverBrand` is `'vanilla'` ([U4](differences/U4.md#server-brand)); `bot.game.maxPlayers` is undefined
  ([U4](differences/U4.md#max-players)); of `bot.settings` only the view distance reaches the server
  ([U4](differences/U4.md#settings)).

**Names, ids and data**
- `bot.registry` is the Bedrock 1.26.51 registry: Bedrock block, item, entity, effect, biome and enchantment names and
  ids (`grass_block`, `oak_log`, `villager_v2`, …) ([U2](differences/U2.md#registry)). Recipes come from the server
  ([U12](differences/U12.md#recipes)); item tags from pmmp/BedrockData ([U12](differences/U12.md#item-tags)).
- `block.stateId` is the index into `registry.blockStates`, not the network runtime id (a hash on Bedrock)
  ([U2](differences/U2.md#state-ids)).
- Entities: `entity.id` is the runtime id as a number, `entity.uniqueId` / `entity.runtimeId` are BigInts
  ([U7](differences/U7.md#entity-ids)); `entity.metadata` is keyed by Bedrock metadata names (`flags`, `variant`,
  `boundingbox_width`, …) ([U7](differences/U7.md#metadata)); players have no `skinData`
  ([U7](differences/U7.md#skin-data)).

**World**
- Waterlogged blocks: `blockAt()` returns the block, with the water layer in `block.superimposed` /
  `block.isWaterlogged` ([U4](differences/U4.md#waterlogging)).
- `bot.time` comes from Bedrock's world clocks ([U9](differences/U9.md#world-time)); game rules are in
  `bot.bedrock.gameRules` ([U9](differences/U9.md#game-rules)).

**Chat, commands, HUD**
- `bot.chat('/…')` sends a command request; its output arrives as `message` events, one per line
  ([U4](differences/U4.md#commands)). A player cannot `/op` itself on BDS ([U4](differences/U4.md#op-command)).
- `bot.tabComplete` completes from the server's command list, client side ([U6](differences/U6.md#tab-complete)).
- No teams (`bot.teams` stays `{}`) and no tab-list header/footer ([U6](differences/U6.md#no-teams),
  [U6](differences/U6.md#no-tablist-header)); boss bars only exist for bosses ([U6](differences/U6.md#boss-bars)).

**Movement**
- Movement is server-authoritative: the bot sends one `player_auth_input` per tick and the server corrects it; a
  correction rewinds and replays the inputs since ([U5](differences/U5.md#corrections)). `look()` takes effect in the
  next input, not gradually ([U5](differences/U5.md#look)).
- A sneak/sprint change is sent with the next tick: clicks right after `setControlState('sneak')` wait for it
  ([W3-FIX-A](differences/W3FIX.md#controls-before-clicks)).

**Entities and combat**
- `entityHurt(entity)` has no source entity ([U7](differences/U7.md#hurt-death),
  [U16b](differences/U16-transport.md#hurt-source)); `entityHandSwap` never fires ([U7](differences/U7.md#hand-swap)).
- `bot.attack()` does not turn the bot (like upstream); Bedrock has no attack cooldown, a hurt mob is invulnerable for 10
  ticks ([U16b](differences/U16-transport.md#combat)).

**Inventory and windows**
- The inventory is server-authoritative: `clickWindow` and everything built on it (`equip`, `transfer`, `craft`, …) are
  item stack requests, with the same results and errors as on Java ([U8](differences/U8.md#click-window)).
- `bot.creative.setInventorySlot` can create only items of the server's creative catalogue — no arbitrary NBT
  ([U8](differences/U8.md#creative)). The off-hand takes only off-hand items ([U8](differences/U8.md#offhand)).
- Using a shield is sneaking (`activateItem` raises it) ([U8](differences/U8.md#item-use)); windows are reported with
  Java window types ([U8](differences/U8.md#window-types)).

**Digging and placing**
- Block breaking is server-authoritative: `dig()` resolves on the server's confirmation; dig times use Bedrock's effect
  factors ([U10](differences/U10.md#protocol), [U10](differences/U10.md#dig-speed)). In creative, swords, tridents and
  maces cannot break blocks ([U10](differences/U10.md#creative-weapons)).
- No block placement from the off-hand ([U11](differences/U11.md#offhand)); placing against an interactive block sneaks
  ([U11](differences/U11.md#sneak-placing)).

**Stations and survival**
- Furnaces, enchanting tables, anvils and villagers work through Bedrock requests with mineflayer's window API
  ([U13](differences/U13.md#furnace), [enchanting](differences/U13.md#enchanting),
  [anvil](differences/U13.md#anvil), [trading](differences/U13.md#trading)); fishing, books, beds and riding as upstream
  with Bedrock packets ([U14](differences/U14.md#fishing), [books](differences/U14.md#books),
  [beds](differences/U14.md#beds), [riding](differences/U14.md#riding)).
- Respawn, dimension changes and the End credits follow Bedrock's handshakes with mineflayer's events
  ([U9](differences/U9.md#respawn), [U9](differences/U9.md#dimension-change)); creative players cannot die
  ([U9](differences/U9.md#creative-death)).

## Bedrock extras: `bot.bedrock`

Bedrock-only additions live under `bot.bedrock` — never as new top-level `bot` members — and are typed in
[`types/bedrock.d.ts`](../packages/mineflayer-bedrock/types/bedrock.d.ts) (`BedrockExtras`):

| member | type | |
|---|---|---|
| `bot.bedrock.gameRules` | `{ [name: string]: boolean \| number }` | the server's game rules by Bedrock name (`doDayLightCycle`, `keepInventory`, `randomTickSpeed`, …), from `start_game` and `game_rules_changed` ([U9](differences/U9.md#game-rules)) |
| `bot.bedrock.blockVariants(block)` | `(block: string \| number) => number[]` | the ids of the Bedrock blocks Java models as one block with a state — a burning furnace is `lit_furnace`: `bot.findBlock({ matching: bot.bedrock.blockVariants('furnace') })` also finds it ([U16a](differences/U16a.md#block-variants)) |
| `bot.bedrock.resyncInventory()` | `() => Promise<boolean>` | asks the server for its copy of the player's inventory (inventory, armor, cursor, off-hand); resolves `true` once it was applied. The bot does this by itself when it finds a slot out of date ([U8](differences/U8.md#inventory-resync)) |
| `bot.bedrock.bedd.observed` | `{ yaw: number, pitch: number, tick: number \| null } \| null` | transport `'bedd'` only (`bot.bedrock.bedd` is undefined otherwise): the rotation (Bedrock degrees) and tick of the last `player_auth_input` the real Minecraft client sent; `null` until the first one. `bot.entity` follows the same echo (BEDD-4) |

## Internals

Not part of the API (they may change), but useful for debugging:

- `bot._client` — the bedrock-protocol `Client` (`on(packetName, …)`, `queue`, `write`; packet names and fields are
  Bedrock's, see bedrock-protocol's [protocol docs](https://prismarinejs.github.io/minecraft-data/?v=bedrock_1.26.51&d=protocol)).
- `bot._bedrock` — shared Bedrock state of the plugins (input queue, lifecycle, item stack requests, windows, …),
  documented for contributors in [CONTRIBUTING.md](CONTRIBUTING.md#cross-unit-contracts).
