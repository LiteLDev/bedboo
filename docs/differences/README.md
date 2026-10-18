# Java ↔ Bedrock differences

mineflayer-bedrock must behave exactly like mineflayer. The only allowed deviations are **inherent**
Java/Bedrock differences — things the Bedrock protocol, data or game rules make impossible or different —
and every one of them is documented here.

## Fragment scheme

Each unit writes `docs/differences/<unit>.md` (only the owner edits it); U3's tooling assembles the fragments
into `docs/differences.md` at wave gates, next to `docs/parity.md`. Every `adapted` / `n.a.` parity row links
an entry here.

## Entry format

```md
### <short title>  {#<anchor>}
- **Affects:** `bot.teams`, `teamCreated` event, test `team` (parity rows)
- **Java:** what mineflayer does
- **Bedrock:** what exists instead (packet / data / gameplay facts, with the BDS version observed)
- **mineflayer-bedrock:** what we do (empty value kept, event never emitted, name mapping, `bot.bedrock.*` extra, …)
- **Tests:** how the ported test was adapted / which `this.skip()` covers it
```

## Known up front (to be written up by the owners)

| Topic | Owner |
|---|---|
| Bedrock block/item names and ids in `bot.registry` (`bedrock_1.26.51`) | U2 |
| No teams (`bot.teams`, `bot.teamMap` stay empty, team events never fire) | U6 |
| No tab-list header/footer (`bot.tablist` stays empty) | U6 |
| No brand channel (`bot.game.serverBrand` undefined) | U4 |
| Only view distance from `bot.settings` reaches the server | U4 |
| World time from `sync_world_clocks` (no `set_time`) | U9 |
| Bedrock-only extras under `bot.bedrock.*` | each unit |
