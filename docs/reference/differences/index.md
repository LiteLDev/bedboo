# Bedrock differences

bedboo behaves like mineflayer. The only deviations are inherent Java/Bedrock differences: things the Bedrock
protocol, data or game rules make impossible or different. Each of them is documented in the topic pages of this
section, entry by entry (what mineflayer does on Java, what Bedrock does instead, what bedboo does). Facts were
observed on BDS 1.26.51.1 (protocol 2193), the default version; what differs on the other supported versions is on
their [version pages](../versions/index.md).

| page | covers |
|---|---|
| [Connection and versions](connection.md) | versions, transports, login, spawn, kicks, settings, dimensions |
| [Names, ids and data](data.md) | the Bedrock registry, block states, items on the wire, data sources |
| [World and blocks](world.md) | waterlogging, block variants, time, weather, game rules, signs, explosions |
| [Player state and survival](survival.md) | respawn, dimension changes, experience, abilities, beds, fishing, books |
| [Chat, commands and HUD](chat.md) | chat, commands, titles, boss bars, scoreboards, sounds, particles, teams |
| [Entities and players](entities.md) | entity ids, metadata, player list, hurt and death, combat, vehicles |
| [Movement and physics](movement.md) | the movement engine, server corrections, looking, sprinting, flight, elytra |
| [Inventory and windows](inventory.md) | item stack requests, windows, resync, off-hand, creative inventory |
| [Crafting and stations](crafting.md) | recipes, crafting, furnaces, enchanting, anvils, trading |
| [Digging and placing](digging.md) | server-authoritative block breaking, dig speed, placement |
| [Ecosystem plugin patches](plugins.md) | what each plugin patch changes and why |
| [BeDD mode](bedd.md) | `transport: 'bedd'`, a real client hosted by Be.D.D. |

## In short {#in-short}

What a bot author may notice. Everything not listed behaves like mineflayer on Java.

**Connection and versions**
- Bedrock versions are protocol families: `bot.version` is `'1.26.40'`, `'1.26.45'`, `'1.26.51'` (default) or
  `'1.26.60'`, with BDS 1.26.42.1 to 1.26.63.1 ([supported versions](../versions/index.md),
  [versions](connection.md#versions)). RakNet by default, NetherNet on request ([transports](connection.md#transport)).
- No `connect` before login: it fires when the login packet is sent ([client](connection.md#client)); `kicked`
  reasons are Bedrock disconnect messages or reason codes ([kick reason](connection.md#kick-reason)).
- `bot.game.serverBrand` is `'vanilla'` ([server brand](connection.md#server-brand)); `bot.game.maxPlayers` is
  undefined ([max players](connection.md#max-players)); of `bot.settings` only the view distance reaches the server
  ([settings](connection.md#settings)).

**Names, ids and data**
- `bot.registry` is the Bedrock registry of the bot's version: Bedrock block, item, entity, effect, biome and
  enchantment names and ids (`grass_block`, `oak_log`, `villager_v2`, …) ([registry](data.md#registry)). Recipes come from the server
  ([recipes](crafting.md#recipes)); item tags from pmmp/BedrockData ([item tags](data.md#item-tags)).
- `block.stateId` is the index into `registry.blockStates`, not the network runtime id (a hash on Bedrock)
  ([state ids](data.md#state-ids)).
- Entities: `entity.id` is the runtime id as a number, `entity.uniqueId` / `entity.runtimeId` are BigInts
  ([entity ids](entities.md#entity-ids)); `entity.metadata` is keyed by Bedrock metadata names (`flags`, `variant`,
  `boundingbox_width`, …) ([metadata](entities.md#metadata)); players have no `skinData` ([skins](entities.md#skin-data)).

**World**
- Waterlogged blocks: `blockAt()` returns the block, with the water layer in `block.superimposed` /
  `block.isWaterlogged` ([waterlogging](world.md#waterlogging)).
- A burning furnace is a separate block (`lit_furnace`); `bot.bedrock.blockVariants()` finds both
  ([block variants](world.md#block-variants)).
- `bot.time` comes from Bedrock's world clocks ([world time](world.md#world-time)); game rules are in
  `bot.bedrock.gameRules` ([game rules](world.md#game-rules)).

**Chat, commands, HUD**
- `bot.chat('/…')` sends a command request; its output arrives as `message` events, one per line
  ([commands](chat.md#commands)). A player cannot `/op` itself on BDS ([op](chat.md#op-command)).
- `bot.tabComplete` completes from the server's command list, client side ([tab complete](chat.md#tab-complete)).
- No teams (`bot.teams` stays `{}`) and no tab-list header/footer ([no teams](chat.md#no-teams),
  [no header](chat.md#no-tablist-header)); boss bars only exist for bosses ([boss bars](chat.md#boss-bars)).

**Movement**
- Movement is server-authoritative: the bot sends one `player_auth_input` per tick and the server corrects it; a
  correction rewinds and replays the inputs since ([corrections](movement.md#corrections)). `look()` takes effect in
  the next input, not gradually ([look](movement.md#look)).
- A sneak/sprint change is sent with the next tick: clicks right after `setControlState('sneak')` wait for it
  ([controls before clicks](movement.md#controls-before-clicks)). A sprint lasts while `forward` is held
  ([sticky sprint](movement.md#sticky-sprint)).

**Entities and combat**
- `entityHurt(entity)` has no source entity ([hurt and death](entities.md#hurt-death),
  [hurt source](entities.md#hurt-source)); `entityHandSwap` never fires ([hand swap](entities.md#hand-swap)).
- `bot.attack()` does not turn the bot (like upstream); Bedrock has no attack cooldown, a hurt mob is invulnerable for
  10 ticks ([combat](entities.md#combat)).

**Inventory and windows**
- The inventory is server-authoritative: `clickWindow` and everything built on it (`equip`, `transfer`, `craft`, …)
  are item stack requests, with the same results and errors as on Java ([click window](inventory.md#click-window)).
- `bot.creative.setInventorySlot` can create only items of the server's creative catalogue, no arbitrary NBT
  ([creative](inventory.md#creative)). The off-hand takes only off-hand items ([off-hand](inventory.md#offhand)).
- Using a shield is sneaking (`activateItem` raises it) ([item use](inventory.md#item-use)); windows are reported
  with Java window types ([window types](inventory.md#window-types)).

**Digging and placing**
- Block breaking is server-authoritative: `dig()` resolves on the server's confirmation; dig times use Bedrock's
  effect factors ([protocol](digging.md#protocol), [dig speed](digging.md#dig-speed)). In creative, swords, tridents
  and maces cannot break blocks ([creative weapons](digging.md#creative-weapons)).
- No block placement from the off-hand ([off-hand placing](digging.md#offhand-placing)); placing against an
  interactive block sneaks ([sneak placing](digging.md#sneak-placing)).

**Stations and survival**
- Furnaces, enchanting tables, anvils and villagers work through Bedrock requests with mineflayer's window API
  ([furnace](crafting.md#furnace), [enchanting](crafting.md#enchanting), [anvil](crafting.md#anvil),
  [trading](crafting.md#trading)); fishing, books, beds and riding as upstream with Bedrock packets
  ([fishing](survival.md#fishing), [books](survival.md#books), [beds](survival.md#beds),
  [riding](movement.md#riding-control)).
- Respawn, dimension changes and the End credits follow Bedrock's handshakes with mineflayer's events
  ([respawn](survival.md#respawn), [dimension change](survival.md#dimension-change)); creative players cannot die
  ([creative death](survival.md#creative-death)).
