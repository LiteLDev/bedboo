# Connection and versions

How bedboo connects to a Bedrock server, which versions it speaks, and how the join, the spawn and dimension changes
map onto mineflayer's events. Observed on BDS 1.26.51.1 (protocol 2193) with bedrock-protocol 3.60.1.

## Versions  {#versions}

- **Affects:** `bot.version`, `bot.majorVersion`, `bot.protocolVersion`, the exports `testedVersions`,
  `latestSupportedVersion`, `oldestSupportedVersion`, `supportFeature(feature, version)`.
- **Java:** Java versions ('1.21.4', protocol 769); several are supported.
- **Bedrock:** Bedrock protocol families (a minecraft-data version key such as '1.26.51', one protocol number,
  several BDS builds); bedboo supports the recent stable ones.
- **bedboo:** `bot.version` is the family (`'1.26.51'`), `majorVersion = '1.26'`, `protocolVersion` its protocol
  (2193); `testedVersions` lists every family `@bedboo/bedrock-data` ships data for (`'1.26.40'`, `'1.26.51'`, …;
  see [Bedrock 1.26.40](../versions/1.26.40.md) for what differs there). `createBot({ version })` accepts a tested
  family, one of its BDS builds (`'1.26.44.3'`) or `false` (auto = 1.26.51) and, like mineflayer, throws for anything
  else. The module-level `supportFeature(feature, version)` answers from the Bedrock
  [feature table](data.md#feature-table) of a tested family / build / 'bedrock_' key / no version (1.26.51), without
  building a registry, and from minecraft-data for other versions (as upstream).

## Protocol client and `connect`  {#client}

- **Affects:** `bot._client`, `connect` event, `createBot` options `auth`, `host`, `port`, `profilesFolder`,
  `onMsaCode`.
- **Java:** a minecraft-protocol client; `connect` fires when the TCP socket connects.
- **Bedrock:** a bedrock-protocol `Client` (RakNet). There is no `connect` event: `loggingIn` fires once the RakNet
  connection and the network settings are done, when the login packet is sent.
- **bedboo:** `bot._client` is the bedrock-protocol client (`on`, `queue`, `write`); `connect` is emitted once on
  `loggingIn`. Defaults: host 127.0.0.1, port 19132, RakNet (raknet-native), `skipPing`, `conLog: null`.
  `auth: 'offline'` is the default; `auth: 'microsoft'` is Xbox Live with prismarine-auth (`profilesFolder`,
  `onMsaCode`, `authTitle`, `flow` are passed through); `auth: 'mojang'` throws (there are no Mojang accounts on
  Bedrock). An explicit bedrock-protocol `offline` option wins. See [createBot options](../api.md#createbot-options).

## Transports: RakNet by default, NetherNet on request  {#transport}

- **Affects:** `createBot` options `transport`, `nethernet`; `bot._client.connection`.
- **Java:** one transport (TCP, minecraft-protocol).
- **Bedrock:** BDS 1.26.51 offers two:
  - **NetherNet** (its default): WebRTC data channels, with signalling over HTTP on `server-port` TCP
    (`POST /v1/join/<network id>` with the SDP offer, answered with the signed SDP answer), over LAN discovery on
    UDP 7551, or through Xbox services.
  - **RakNet** (`transport=raknet`): the transport of every Bedrock version so far. BDS prints a
    `TRANSPORT TYPE ERROR` banner when it is selected, and Mojang announced its removal, possibly in BDS 26.60.

  A NetherNet server does not open its RakNet ports and vice versa.
- **bedboo:** `transport: 'raknet'` is the default (raknet-native). `transport: 'nethernet'` joins with HTTP
  signalling on `host:port` unless `nethernet.signalling` says `'lan'` / `'services'`. bedrock-protocol#831 and
  node-nethernet#32 (unreleased) are backported as `patches/bedrock-protocol@3.61.0.patch` and
  `patches/nethernet@1.1.2.patch` (plus a `packageExtensions` entry for nethernet's new jsonwebtoken dependency).
  The server signs its answer with an identity key; plain HTTP cannot vouch for that key, so it is accepted unless
  `nethernet.serverKey` pins it (`'sha256:<hex of the DER SPKI>'`; a mismatch is refused with
  `Untrusted Nethernet server key …`) or `nethernet.onServerKey(fingerprint, url)` decides. This is the same trust
  as RakNet, whose handshake key is not pinned either. Everything above the transport (packets, plugins, events) is
  identical.

## NetherNet: the server port must be free on TCP too  {#nethernet-port}

- **Affects:** servers run with `transport=nethernet`.
- **Java:** n/a.
- **Bedrock:** with `transport=nethernet` BDS opens its HTTP signalling listener on TCP `server-port` and logs
  `Accepting clients on [::]:<port>`. If that TCP port is still held (e.g. by `TIME_WAIT` connections of the previous
  server on the same port, for about a minute), BDS starts **without** the listener and without any error; every
  client then gets `ECONNREFUSED`.
- **bedboo:** nothing in the library. When a NetherNet join fails with `ECONNREFUSED`, check that the server log has
  the `Accepting clients` line and that the TCP port was free when BDS started.

## Kick reason  {#kick-reason}

- **Affects:** `kicked` event.
- **Java:** `reason` is a JSON chat component (a string, or an object since 1.20.3); `loggedIn` tells the play state
  from the login state.
- **Bedrock:** `disconnect { reason: <code>, hide_disconnect_reason, message }`; the message is free text or a
  translation key (`disconnectionScreen.serverFull`), often empty (then only the code says why, e.g.
  `server_id_conflict`, `missing_client`).
- **bedboo:** `reason` = the message, or the reason code name when the message is empty or hidden; `loggedIn` =
  start_game was received. bedrock-protocol closes the connection after a kick, so `end` follows.

## Keep-alive  {#keep-alive}

- **Affects:** the connection's keep-alive (no API).
- **Java:** `ping` → `pong`, keep-alive packets.
- **Bedrock:** `network_stack_latency { timestamp, needs_response }`.
- **bedboo:** bedrock-protocol answers `network_stack_latency` with the same timestamp; the game plugin needs no
  handler.

## Resource packs  {#resource-packs}

- **Affects:** `resourcePack` event, `bot.acceptResourcePack()`, `bot.denyResourcePack()`.
- **Java:** one pack per `resource_pack_send` / `add_resource_pack` (url + hash or uuid); the client answers
  ACCEPTED + SUCCESSFULLY_LOADED or DECLINED; the server decides what a decline means.
- **Bedrock:** all packs come in `resource_packs_info` during login (before start_game), with uuid, version and an
  optional CDN url, no hash. The client answers `resource_pack_client_response` with a status name BDS checks:
  - 'completed': join;
  - 'have_all_packs': join without downloading (BDS sends `resource_pack_stack`, answered 'completed');
  - 'refused' / 'cancel': BDS disconnects (`missing_client`), also for optional packs.
- **bedboo:** `resourcePack(url, hash, uuid)` is emitted per pack with url = the CDN url or '' and hash = the Bedrock
  pack id `<uuid>_<version>`. Without a listener the packs are accepted at once; with one, the answer waits for
  `acceptResourcePack()` ('completed') or `denyResourcePack()` ('have_all_packs' for optional packs = join without
  them; 'refused' for required packs = BDS kicks, `kicked('missing_client', false)`). Packs are never downloaded.
  This needs the bedrock-protocol patch (`client.holdResourcePacks` / `client.respondToResourcePacks`).

## Client settings  {#settings}

- **Affects:** `bot.settings.*`, `bot.setSettings()`, `bot.game.serverViewDistance`.
- **Java:** a `settings` packet (locale, view distance, chat mode, colours, skin parts, main hand, filtering, server
  listing, particles).
- **Bedrock:** only the chunk radius is negotiated (`request_chunk_radius` → `chunk_radius_update`); skin parts, main
  hand etc. are part of the login skin data or not configurable.
- **bedboo:** the same `bot.settings` object, defaults and validation errors as upstream. `viewDistance` ('far' 12,
  'normal' 10, 'short' 8, 'tiny' 6 chunks, or a number) is the only setting sent: the join request is
  bedrock-protocol's (it reads `client.viewDistance`, kept in sync), later `setSettings` calls send
  `request_chunk_radius { chunk_radius, max_radius }`. `bot.game.serverViewDistance` is the radius granted by the
  server (`chunk_radius_update`). Every other setting is kept locally only.

## Server brand  {#server-brand}

- **Affects:** `bot.game.serverBrand`.
- **Java:** the `minecraft:brand` plugin channel ('vanilla', 'Paper', …).
- **Bedrock:** no brand channel; start_game has an optional `server_identifier` (empty on BDS).
- **bedboo:** `server_identifier` when set, else `'vanilla'` (BDS is the vanilla Bedrock server).

## No player limit on the client  {#max-players}

- **Affects:** `bot.game.maxPlayers`.
- **Java:** the login packet carries the server's max players.
- **Bedrock:** start_game has no player limit; it is only in the unconnected pong, which BDS does not send with
  `enable-lan-visibility=false` (and the bot connects without a ping).
- **bedboo:** `bot.game.maxPlayers` stays `undefined`.

## Level type  {#level-type}

- **Affects:** `bot.game.levelType`.
- **Java:** `'default'`, `'flat'`, `'largeBiomes'`, `'amplified'`, …
- **Bedrock:** `start_game.generator`: 0 legacy, 1 infinite, 2 flat, 3 nether, 4 the end, 5 void.
- **bedboo:** 1 → `'default'`, 2 → `'flat'`, 0 → `'legacy'`, 5 → `'void'`, 3 / 4 → `'nether'` / `'the_end'`.

## Entity id at login  {#entity-id-login}

- **Affects:** `bot.entity.id`, `bot.entity.uniqueId`.
- **Java:** a proxy may send a second login packet with a new entity id.
- **Bedrock:** start_game is sent once per connection; a server transfer is a new connection.
- **bedboo:** `bot.entity.id = Number(start_game.runtime_entity_id)` and `bot.entity.uniqueId =
  start_game.entity_id`; a re-login with a new entity id on the same connection cannot happen.

## Offline players keep their saved data  {#offline-player-data}

- **Affects:** `createBot({ auth: 'offline' })`: the player's inventory, position, spawn point, … across reconnects and
  server restarts.
- **Java:** an offline-mode player's UUID is `nameUUIDFromBytes("OfflinePlayer:" + name)`: a rejoin is the same player,
  and the server restores its saved data.
- **Bedrock:** BDS keys an offline (xuid 0) player's saved data by the login's `SelfSignedId`, which bedrock-protocol
  randomizes for every connection. Measured on BDS 1.26.51.1: give items, quit, rejoin (same server, or a server
  started from a snapshot of the world) → empty inventory at the world spawn. With a fixed `SelfSignedId` the rejoin
  gets its inventory and position back.
- **bedboo:** for offline auth the `SelfSignedId` defaults to Java's offline-mode UUID of the username
  (`offlineSelfSignedId`, `lib/client.js`); `skinData.SelfSignedId` overrides it; Xbox Live logins are untouched.

## Spawn  {#spawn}

- **Affects:** `spawn` event.
- **Java:** emitted on the first health update after login / after a respawn.
- **Bedrock:** the join is start_game (spawn search height, y 32769.62) → `respawn` state 0 ×2 → `respawn` state 1
  (the real position) → client `respawn` state 2 → `play_status player_spawn` → client `serverbound_loading_screen`
  1 and 2 (without them BDS does not simulate the player).
- **bedboo:** `spawn` comes from the lifecycle (`lib/bedrock/lifecycle.js`, its only emitter) once the real position is
  known and the loading screen is acked, after `login` and `game`, like mineflayer. It is emitted again after a
  [dimension change](#dimensions) and after a [respawn](survival.md#respawn).

## `spawn` and the spawn search height  {#spawn-search-height}

- **Affects:** `spawn` after the End exit portal and after a respawn into another dimension; `bot.spawnPoint` on a
  default (non-flat) world.
- **Java:** the server sends the position before the health update that makes mineflayer emit `spawn`; the spawn
  position packet carries the real spawn block.
- **Bedrock:** Bedrock uses a placeholder height (the spawn search height) while the server has not found the real
  one:
  - The End exit's `change_dimension` carries y 32767; BDS answers the dimension ack at once and sends the real
    position ~50 ms later in `respawn` state 1.
  - In a respawn into another dimension BDS often corrects the respawning player to the search height
    (`correct_player_move_prediction` y 32768.62, before or after the real `respawn` state 1; seen in 4 of 6 deaths in
    the nether) and to the real position ~300 ms later.
  - `start_game.spawn_position` has y = 32767 until the server fixed the height (BDS searches the highest safe block
    when a player spawns there). A pathfinder goal at that y makes a bot pillar upwards.
- **bedboo:**
  - The `change_dimension` / `respawn` search heights are not applied (no `move` / `forcedMove` there). While the
    bot's last server position is the search height, `spawn` waits for the real one (the next `forcedMove` below it,
    emitted first), at most 2 s; meanwhile the input clock stays suspended (End exit) or the bot stays in the
    respawning state.
  - `bot.spawnPoint` (`lib/plugins/spawn_point.js`): a 32767 height is replaced by the spawn column's highest solid
    block + 1 as soon as that overworld column is loaded (`chunkColumnLoad` / `spawn`); x and z are kept, a real
    height (`/setworldspawn`) is never touched, and nothing is resolved while the bot is in another dimension. The
    resolution during the join (the spawn column loads before `spawn`) emits no `game` of its own: it is part of
    start_game's spawn position, covered by the login's `game` (mineflayer's order connect → login → game → spawn). A
    later resolution emits `game` like upstream on a spawn point change. See also
    [spawn point](survival.md#spawn-point).

## Dimensions  {#dimensions}

- **Affects:** `bot.game.dimension`, `bot.game.minY`, `bot.game.height`, `bot._getDimensionName()`.
- **Java:** dimension types and heights come from the registry codec; world names `minecraft:overworld`,
  `minecraft:the_nether`, `minecraft:the_end`; a `respawn` packet switches the dimension.
- **Bedrock:** no codec: dimension ids 0 / 1 / 2 (start_game maps them to 'overworld' / 'nether' / 'end'), fixed
  heights (overworld -64..319, nether 0..127, end 0..255). A dimension change is `change_dimension
  { dimension, position (FEET level), loading_screen_id }`; the client acks with `player_action
  dimension_change_ack`; BDS answers with its own `dimension_change_ack` (no play_status) once the new dimension is
  ready, then the client sends `serverbound_loading_screen` 1 and 2.
- **bedboo:** `bot.game.dimension` uses mineflayer's names ('overworld', 'the_nether', 'the_end'), minY / height
  come from the fixed table, and `_getDimensionName()` returns `minecraft:<dimension>`. On `change_dimension` the
  world is reset (every column unloaded → `chunkColumnUnload`, per-position `blockUpdate:` listeners called with
  `null, null` and removed, like upstream's switchWorld), `game` is emitted, and the lifecycle emits `spawn` again
  once the server acked (mineflayer emits `spawn` after a dimension change too, through health). The rest of the
  dimension flow (`respawn` event, End credits, portals) is described in
  [dimension change](survival.md#dimension-change).
