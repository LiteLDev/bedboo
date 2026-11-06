# Chat, commands and HUD

How chat messages, commands, tab completion and the HUD (titles, action bar, boss bars, scoreboards, sounds,
particles) differ between Java and Bedrock, and how bedboo maps them onto the mineflayer API. Observed on BDS
1.26.51.1 (protocol 2193, bedrock-protocol 3.60.1), with packet probes of every command below on a live server.

## Chat messages and text types  {#chat-messages}

- **Affects:** `message`, `messagestr`, `chat`, `whisper`, `actionBar` (positions and rendering).
- **Java:** player chat (signed) and system chat as JSON components; `/tellraw` is system chat; the action bar is
  system chat with `overlay`.
- **Bedrock:** `text` packets: `chat` / `whisper` (`source_name` + § formatted text), `announcement` (`/say`:
  "[name] text"), `raw` / `system` / `tip` (§ text), `translation` / `popup` / `jukebox_popup` (`%key` + parameters),
  `json` / `json_whisper` / `json_announcement` (rawtext JSON). `/tellraw` arrives as `json_whisper`; `/me` as `chat`
  with an empty `source_name` and the message "* name action"; `/tell` as `whisper` to the target and a
  `commands.message.display.outgoing` command_output to the sender.
- **bedboo:** everything becomes a prismarine-chat `ChatMessage` (`lib/bedrock/text.js`):
  - chat → `{ translate: 'chat.type.text', with: [name, text] }` ("\<name> text"); whisper →
    `commands.message.display.incoming` ("name whispers to you: text"); `/me` → the message as sent;
  - `%key` and rawtext `translate` resolve through `registry.language` (literal rawtext formats: `%%s` / `%1`
    placeholders; see [language formats](#language-formats));
  - positions: chat / whisper / announcement → `chat`; raw / system / translation / json / json_whisper (tellraw) /
    json_announcement → `system`; tip / popup / jukebox_popup → `game_info` (+ [`actionBar`](#action-bar));
  - `verified` is always null (no chat signing on Bedrock). The sender uuid is passed when `bot.players` knows the
    sender.

## `§` formatting codes  {#formatting}

- **Affects:** `ChatMessage` styles of every Bedrock text (`toMotd`, `toAnsi`, `color`, …); `toString()` is the same.
- **Java:** `§0`–`§f` colours, `§k` `§l` `§m` (strikethrough) `§n` (underline) `§o`, `§r`; a colour code resets the
  formats.
- **Bedrock:** additional material colours `§g` `§h` `§i` `§j` `§m` `§n` `§p` `§q` `§s` `§t` `§u` `§v` (so `§m` and
  `§n` are colours, there is no strikethrough/underline), and colour codes do not reset bold/italic/obfuscated.
- **bedboo:** `lib/bedrock/text.js` parses § codes itself (no prismarine-chat patch): material colours become hex
  colours (`§g` → `#DDD605`, …), formats persist over colour codes, `§r` resets, unknown codes are dropped.

## Language formats  {#language-formats}

- **Affects:** every `ChatMessage` `toString()` of a Bedrock translation key.
- **Java:** `%s` / `%1$s` formats.
- **Bedrock:** the en_US language also uses `%1$d`, `%d`, `%.2f` and bare `%1`.
- **bedboo:** `bot.registry.language` is normalized to the `%s` / `%N$s` forms prismarine-chat substitutes
  (`lib/registry.js`), e.g. `commands.time.set` "Set the time to %1$s".

## Default chat patterns (`chat` / `whisper` events)  {#default-chat-patterns}

- **Affects:** `chat`, `whisper`, `bot.chatAddPattern`, `bot.addChatPattern`, `bot.removeChatPattern`.
- **Java:** mineflayer registers three deprecated regex patterns (two whisper formats and the legacy "\<name> text"
  chat format) and emits `chat` / `whisper` (username, message, translate, jsonMsg) when a `messagestr` matches.
- **Bedrock:** player chat, whispers and `/say` announcements (`source_name: name, message: '[name] text'`) name their
  sender in the packet; Bedrock gamertags may contain spaces, which `(\w+)` cannot capture.
- **bedboo:** the same three default patterns are registered (same names and indices, removable,
  `defaultChatPatterns: false` disables them). For a `chat` / `whisper` / `announcement` packet with a sender they take
  username and message from the packet (one event per packet); an announcement is the message
  `{ translate: 'chat.type.announcement', with: [name, text] }` ("[name] text") and its `chat` event carries that
  translate, like Java's say_command chat type. Every other message goes through the upstream regexes (e.g.
  `/tellraw` "\<U9G> Hello"). User patterns always use their regexes. Pattern bookkeeping (repeat, parse, sets, removal
  by name/number, return values) is upstream's code.

## `unmatchedMessage`  {#unmatched-message}

- **Affects:** `unmatchedMessage` event.
- **Java:** declared in mineflayer 4.39.0's `index.d.ts` (`(stringMsg, jsonMsg)`) but never emitted by its plugins.
- **Bedrock:** no difference on the wire.
- **bedboo:** emitted for every message that no chat pattern matched (the pre-4.x mineflayer meaning of the declared
  event), after `messagestr`.

## `bot.whisper`  {#whisper}

- **Affects:** `bot.whisper(username, message)`.
- **Java:** `chatWithHeader('/tell <username> ', message)`.
- **Bedrock:** `/tell <target> <message>` (aliases `/w`, `/msg`); a target with spaces must be quoted.
- **bedboo:** upstream's `/tell` header (sent as [command requests](#commands)), a player name quoted when it is not a
  plain word; a selector (`@p`, `@a[r=5]`, …) is sent verbatim like upstream (a quoted `"@p"` matches no target on
  BDS). When the header alone reaches `chatLengthLimit`, upstream splits forever; bedboo throws instead.

## Commands  {#commands}

- **Affects:** `bot.chat('/…')`.
- **Java:** chat commands (`chat_command` packet).
- **Bedrock:** `command_request { command, origin: { type: 'player', uuid, request_id, player_entity_id }, internal,
  version }` → `command_output` (the origin uuid is echoed).
- **bedboo:** `bot.chat('/…')` sends a `command_request` with a fresh origin uuid (never a chat message); every
  `command_output` line becomes a `message` (position `system`, `translate` = its message id).
  `bot._bedrock.commands.request(cmd)` (internal) resolves with the matching output; a successful command without
  output resolves with an empty one ([commands without output](#silent-commands)).

## Commands without output  {#silent-commands}

- **Affects:** `bot._bedrock.commands.request(command, { timeout })` (internal hook), `bot.chat('/…')` (fire and
  forget, unchanged).
- **Java:** no equivalent hook in mineflayer.
- **Bedrock:** `/say`, `/me`, a successful `/tellraw` — and every command while the `sendcommandfeedback` gamerule is
  off — get no `command_output` at all. For every successful command BDS sends `event { event_type:
  'command_executed', event_data: 08 02 00 <len> <name> 00 }`, right before the command's `command_output` (same
  batch) when it has one; a failed command never gets the event but always a `command_output` (even with feedback
  off: `output_type: 'silent'`).
- **bedboo:** the event is matched to the oldest request of that command name; when no `command_output` follows within
  100 ms the request resolves with `{ origin, output_type: 'none', success_count: 1, output: [], has_data: false }`.
  A request still rejects after `timeout` (10 s) when neither arrives.

## `/op` from a player  {#op-command}

- **Affects:** `bot.chat('/op …')` and code that waits for `commands.op.success` (e.g. the mineflayer examples).
- **Java:** an operator player may op others; the bot sees the "Opped" chat message.
- **Bedrock:** BDS answers `commands.generic.error.permissions` to players with the `operator` permission level; `/op`
  needs the console or a higher level. BDS never tells players about a console op in chat; the opped player only
  receives the `update_abilities` that announces it.
- **bedboo:** the error output is still a `message`. Op the bot through the server console and, if needed, wait for
  the `update_abilities` (the [`abilities`](survival.md#abilities) event) instead of a chat message.

## `bot.tabComplete`  {#tab-complete}

- **Affects:** `bot.tabComplete(str, assumeCommand, sendBlockInSight, timeout)`.
- **Java:** a `tab_complete` request answered by the server (brigadier suggestions for the last word, with the
  looked-at block for block positions).
- **Bedrock:** no tab-complete packet; the client completes from the `available_commands` tree (enums, soft enums
  updated by `update_soft_enum`, chained subcommands for `/execute`, command aliases).
- **bedboo:** completes client-side from `available_commands` (`lib/bedrock/commands.js`) with upstream's shape
  (`tabCompleteHasAToolTip` → `[{ match, tooltip: undefined }]`): command names/aliases, enum values, soft enums,
  player names + selectors (`@a @e @initiator @p @r @s`) for targets, `~` forms for coordinates, `/execute … run
  <command>` recursively; plain chat completes online player names. It waits up to `timeout` for `available_commands`
  (rejecting like upstream). `sendBlockInSight` has no effect. Results follow Bedrock's command set: `/weather ` →
  clear, **query**, rain, thunder.

## Titles  {#titles}

- **Affects:** `title`, `title_times`, `title_clear`.
- **Java:** `set_title_text` / `set_title_subtitle` (JSON components), `set_title_time`, `clear_titles`.
- **Bedrock:** `set_title { type: set_title | set_subtitle | set_title_json | set_subtitle_json | set_durations |
  clear | reset | action_bar_message(_json), text, fade_in_time, stay_time, fade_out_time }` (`/title` sends the rest
  of the line as text, `/titleraw` rawtext).
- **bedboo:** set_title / set_subtitle → `title(parseTitle(text), 'title'|'subtitle')` with upstream's parseTitle (so
  `/title @a title {"text":"Test Title"}` gives "Test Title"; plain text keeps its § codes like upstream's raw text);
  `*_json` → the rawtext rendered as plain text; set_durations → `title_times`; clear and reset → `title_clear`;
  action bar → `actionBar` ([below](#action-bar)).

## Action bar  {#action-bar}

- **Affects:** `actionBar` event.
- **Java:** system chat with `overlay` → `message` + `messagestr` (game_info) + `actionBar`; `/title … actionbar`
  (set_action_bar_text) emits nothing in mineflayer 4.39.0.
- **Bedrock:** `text` tip / popup / jukebox_popup and `set_title` action_bar_message(_json) all show on the action
  bar.
- **bedboo:** each of them → `message` + `messagestr` at `game_info`, then `actionBar(jsonMsg, null)`.

## Boss bars  {#boss-bars}

- **Affects:** `bot.bossBars`, `bossBarCreated`, `bossBarUpdated`, `bossBarDeleted`, `BossBar` fields.
- **Java:** `/bossbar` creates server-side bars (uuid, title, health, colour, style, flags); `boss_bar` actions add /
  remove / update.
- **Bedrock:** no `/bossbar`; bars belong to boss entities (wither, ender dragon). `boss_event { target_entity_id,
  type, title, progress, color, overlay }`: BDS sends `show_bar` when the boss appears and then again about once a
  second with the current progress; it never sent `hide_bar` in our probes — the client drops the bar with the entity
  (`remove_entity` after the death animation, or when the boss leaves the view). An unnamed boss's title is a
  translation key (`entity.wither.name`); a name tag replaces it (except the ender dragon's). Colours: pink, blue,
  red, green, yellow, purple, **rebecca_purple** (the wither), white. A wither despawns on peaceful.
- **bedboo:**
  - the first `show_bar` per boss → `bossBarCreated`; a later `show_bar` that changes a field (the once-a-second
    repeats usually do not, as Java only sends changes) and set_bar_progress / set_bar_title / update_properties /
    texture → `bossBarUpdated`; `hide_bar`, `remove_entity` of the boss and a dimension change → `bossBarDeleted`;
  - `entityUUID` = the boss's unique id (string), `title` a `ChatMessage` (translated), `health` = progress,
    `dividers` from the overlay (0, 6, 10, 12, 20), `color` = the Bedrock colour name (a `BossBar` subclass; typed in
    `index.d.ts`), flags from the boss type when the entity is known (wither: darken sky; ender dragon: dragon bar +
    fog), else 0.

## Scoreboards  {#scoreboards}

- **Affects:** `bot.scoreboards`, `bot.scoreboard`, `scoreboardCreated`, `scoreboardDeleted`,
  `scoreboardTitleChanged`, `scoreUpdated`, `scoreRemoved`, `scoreboardPosition`.
- **Java:** every objective is sent to every client (`scoreboard_objective`), scores by entity name, display slots
  0 list / 1 sidebar / 2 belowName (+ team sidebars).
- **Bedrock:** a client only learns about **displayed** objectives: `set_display_objective { display_slot: list |
  sidebar | belowname, objective_name, display_name, criteria_name, sort_order }` (an empty name clears the slot),
  then `set_score` with the objective's scores; `set_score` entries are keyed by a scoreboard id (player / entity:
  unique id; fake player: custom name; `remove` entries carry only the id); `remove_objective`. Only the `dummy`
  criterion exists; no team sidebars.
- **bedboo:**
  - an objective appears in `bot.scoreboards` when it is first displayed (`scoreboardCreated`; `title` = the plain
    display name, also when it looks like JSON, e.g. "2024"); a changed display name → `scoreboardTitleChanged`;
    `scoreboardPosition(position, scoreboard, previous)` with Java's slot numbers; clearing a slot empties it (no
    event);
  - an objective displayed in ascending order (`sort_order` 0) lists `items` lowest first, like the Bedrock client
    (Java has only descending);
  - scores: `scoreUpdated` / `scoreRemoved` with upstream's ScoreBoard items; item names = fake player name, player
    username (self, player_list, `bot.players`), or an entity's unique id;
  - `remove_objective` → `scoreboardDeleted` and clears its slots.

## Sounds  {#sounds}

- **Affects:** `soundEffectHeard`, `hardcodedSoundEffectHeard`.
- **Java:** `sound_effect` (registry id or named sound, category, position × 8, volume, pitch).
- **Bedrock:** `play_sound { name, coordinates (× 8), volume, pitch }` for `/playsound` (BDS forwards any name, e.g.
  `note.harp`, `gui.button.press`); `level_sound_event { sound_id (name, e.g. 'armor.equip_iron'), position,
  extra_data, entity_type, … }` for the game's own sounds, without volume or pitch.
- **bedboo:** play_sound → `soundEffectHeard(name, position, volume, pitch)`; level_sound_event →
  `soundEffectHeard(name, position, 1, pitch)` (pitch 1, or Java's note pitch for note blocks); an id that cannot be
  named → `hardcodedSoundEffectHeard(id, 'master', position, 1, pitch)` (no categories on Bedrock). `noteHeard` comes
  from block events: see [block actions](world.md#block-actions).

## Particles  {#particles}

- **Affects:** `particle` event, `Particle` export.
- **Java:** `world_particles` (particle type, position, offset, count, speed, long distance); `/particle <name> x y z
  dx dy dz speed count force`.
- **Bedrock:** `/particle <effect> [x y z]` only → `spawn_particle_effect { dimension, entity_id, position,
  particle_name, molang_variables }` (BDS forwards any effect name); particles the game spawns itself use
  `level_event` `add_particle_<type>` (0x4000 | type). No offset, count, speed or long-distance flag on the wire.
  Particle type ids start at 1.
- **bedboo:** `Particle` (export and event) is mineflayer's class extended with a Bedrock `fromNetwork`:
  - spawn_particle_effect → `id` = the effect name, resolved through `registry.particles` when it is a particle type
    name (`bubble` → id 1), else the identifier stays the `id` and becomes the `name` too
    (`minecraft:heart_particle`);
  - level_event `add_particle_*` → the type id and name (the two particle events outside the 0x4000 range,
    `add_particle_smash_attack_ground_dust` / `add_particle_creaking_heart_trail`, keep their name as id);
  - `offset` (0, 0, 0), `count` 1, `movementSpeed` 0, `longDistanceRender` false.

## No teams  {#no-teams}

- **Affects:** `bot.teams`, `bot.teamMap`, `teamCreated`, `teamRemoved`, `teamUpdated`, `teamMemberAdded`,
  `teamMemberRemoved`.
- **Java:** `/team` (or `/scoreboard teams`) and the `teams` packet.
- **Bedrock:** no teams at all: `/team` is an unknown command, `/scoreboard teams` a syntax error, no team packet.
- **bedboo:** `bot.teams = {}` and `bot.teamMap = {}` forever; team events are never emitted. ScoreBoard items'
  `displayName` falls back to the plain name (upstream's no-team path).

## No tab-list header / footer  {#no-tablist-header}

- **Affects:** `bot.tablist.header`, `bot.tablist.footer`.
- **Java:** `playerlist_header` sets the header and footer of the tab list.
- **Bedrock:** the player list has no header or footer (no such packet in protocol 2193).
- **bedboo:** `bot.tablist = { header, footer }` stay empty `ChatMessage`s.
