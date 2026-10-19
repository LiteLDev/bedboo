# Java ↔ Bedrock differences — U16b (transports, combat matrix)

Observed against BDS 1.26.51.1 (protocol 2193) with bedrock-protocol 3.60.1 + the wave-5 patches.

**How to read these documents.** Every entry names what it affects, what mineflayer does on Java, what Bedrock does
instead, what mineflayer-bedrock does about it and which test proves it. Most entries are invisible to a bot written
against mineflayer's API — they explain how the same API is implemented over Bedrock packets. The ones a bot author
notices are summarised in [docs/api.md](../api.md#bedrock-differences-in-short).

### Transports: RakNet by default, NetherNet on request  {#transport}
- **Affects:** `createBot` options `transport`, `nethernet`; `bot._client.connection`.
- **Java:** one transport (TCP, minecraft-protocol).
- **Bedrock:** BDS 1.26.51 offers two: **NetherNet** (its default; WebRTC data channels, with signalling over HTTP on
  `server-port` TCP — `POST /v1/join/<network id>` with the SDP offer, answered with the signed SDP answer —, over
  LAN discovery on UDP 7551, or through Xbox services) and **RakNet** (`transport=raknet`, the transport of every
  Bedrock version so far; BDS prints a `TRANSPORT TYPE ERROR` banner when it is selected, and Mojang announced its
  removal, possibly in BDS 26.60). A NetherNet server does not open its RakNet ports and vice versa.
- **mineflayer-bedrock:** `transport: 'raknet'` (default; raknet-native). `transport: 'nethernet'` joins with HTTP
  signalling on `host:port` unless `nethernet.signalling` says `'lan'` / `'services'`: bedrock-protocol#831 and
  node-nethernet#32 (unreleased) are backported as `patches/bedrock-protocol@3.60.1.patch` and
  `patches/nethernet@1.1.2.patch` (+ a `packageExtensions` entry for nethernet's new jsonwebtoken dependency). The
  server signs its answer with an identity key; plain HTTP cannot vouch for that key, so it is accepted unless
  `nethernet.serverKey` pins it (`'sha256:<hex of the DER SPKI>'`, a mismatch is refused with
  `Untrusted Nethernet server key …`) or `nethernet.onServerKey(fingerprint, url)` decides — the same trust as RakNet,
  whose handshake key is not pinned either. Everything above the transport (packets, plugins, events) is identical.
- **Tests:** `test/external/nethernet.test.js` (opt-in: `--grep nethernet` or `BEDBOO_NETHERNET=1`; join, spawn, chat
  both ways, a block update, walking without corrections, HTTP discovery, server-key pinning, quit),
  `test/unit/client_transport.test.js`.

### NetherNet: the server port must be free on TCP too  {#nethernet-port}
- **Affects:** servers run with `transport=nethernet` (test harness, `bds up --transport nethernet`).
- **Java:** n/a.
- **Bedrock:** with `transport=nethernet` BDS opens its HTTP signalling listener on TCP `server-port` and logs
  `Accepting clients on [::]:<port>`. If that TCP port is still held — e.g. by `TIME_WAIT` connections of the previous
  server on the same port, for about a minute — BDS starts **without** the listener and without any error; every
  client then gets `ECONNREFUSED`.
- **mineflayer-bedrock:** nothing in the library; the harness skips a slot whose TCP port is held (`/proc/net/tcp`) and
  treats a NetherNet start without the `Accepting clients` line as a busy port (next slot).
- **Tests:** `test/external/nethernet.test.js`.

### Who hit whom: `entityHurt` has no source  {#hurt-source}
- **Affects:** combat code that wants to know whether its own hit killed a mob (e.g. the agent's combat library).
- **Java:** `damage_event` carries the source entity (`entityHurt(entity, source)` in newer mineflayer).
- **Bedrock:** `entity_event hurt_animation` / `death_animation` carry no attacker (see
  [U7: hurt and death](U7.md#hurt-death)).
- **mineflayer-bedrock:** unchanged events. The combat matrix and `@bedboo/agent`'s combat library attribute a kill to
  the bot when the target's `entityDead` comes within 1.5 s of one of the bot's own `attack()`s (3 s of one of its
  arrows) after at least one `entityHurt`, with no other damage source in the arena.
- **Tests:** `test/external/combatMatrix.test.js`.

### Combat on Bedrock  {#combat}
- **Affects:** `bot.attack`, `bot.activateItem` / `deactivateItem` (bow, shield), mineflayer-pvp-style fighting.
- **Java:** since 1.9 an attack cooldown scales the damage of fast hits; a raised shield is an item use.
- **Bedrock:** no attack cooldown (every hit does full damage), but a hurt mob ignores damage for 10 ticks; a shield
  blocks while the player sneaks; arrows never hurt endermen (they teleport away); `/summon slime … minecraft:spawn_large`
  only sets the hitbox — the split count follows the size variant (1, 2 or 4).
- **mineflayer-bedrock:** the API is unchanged (`activateItem` with a shield sneaks: [U8: item use](U8.md#item-use)).
  The combat library attacks every 10 ticks, never shoots endermen, and the matrix re-summons slimes / magma cubes
  until their size variant is ≥ 2.
- **Tests:** `test/external/combatMatrix.test.js` (21 hostile mobs, ≥ 4/5 wins each with `BEDBOO_COMBAT_RUNS=5`).
