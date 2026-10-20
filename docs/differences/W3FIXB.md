# Java ↔ Bedrock differences — W3-FIX-B (wave-3 fix-ups: inventory, entities, chat, world)

Fixes to wave-3 code found by the wave-3 review, observed against BDS 1.26.51.1 (protocol 2193). The entries of the
owning units were updated in place where their behaviour changed (U4 waterlogging / commands, U6 default chat
patterns / whisper, U7 player list / hurt and death / dropped items / positions / interact / fireworks, U8
click-window / resync / window types); the entries below describe what is new. Parity rows keep linking the owning
units' entries, which link here.

### Opening a window while another one is open  {#window-switch}
- **Affects:** `bot.openBlock`, `bot.openEntity`, `bot.openContainer` / `openChest` / `openDispenser`, the wave-4
  openers (`openFurnace`, `openAnvil`, `openEnchantmentTable`, `openVillager`, `craft` with a table),
  `bot.activateBlock` / `bot.activateEntity` / `bot.activateEntityAt`, `windowClose`.
- **Java:** `ServerPlayer.openMenu` closes the current menu first (`close_window` → mineflayer emits `windowClose`),
  then opens the new one; code that never closes a chest (mineflayer-collectblock's `emptyInventory`) works.
- **Bedrock:** BDS ignores an activation that would open a container while the player has one open — no
  `container_open`, no `container_close`, so `openBlock` would wait for once()'s 20 s and throw (verified live: chest
  then barrel, and the same chest twice). Other activations (a lever) are processed with a container open and the
  container stays open — like Java.
- **mineflayer-bedrock:** `openBlock` / `openEntity`, and `activateBlock` / `activateEntity(At)` of a container or
  station block (chests, barrels, shulker boxes, furnaces, crafting / enchanting / smithing tables, anvils, hoppers,
  dispensers, droppers, brewing stands, beacons, grindstones, stonecutters, looms, cartography tables, crafters,
  lecterns) or of a trading / storage entity (villagers, wandering traders, chest / hopper minecarts, chest boats)
  first close the open container window with `bot.closeWindow` (`windowClose` at once, carried and station items put
  back, `container_close`, the server's echo), then wait BDS's 100 ms reopen delay and activate. Other activations
  leave the window open.
- **Tests:** `test/unit/windows.test.js` › "opening a container while another one is open closes it first …";
  `test/external/inventoryConcurrency.test.js` › "opening chest B while chest A is open closes A first …".

### Overlapping item stack requests  {#overlapping-requests}
- **Affects:** `bot.clickWindow` and everything built on it when calls overlap (clicks not awaited, armor-manager /
  tool / auto-eat equips racing user code, `transfer` while tossing), window `deposit` / `withdraw`.
- **Java:** the client applies each click to its window at once (1.17+ prediction) and the server resyncs a wrong
  slot with `set_slot` / `window_items`, so overlapping clicks self-heal.
- **Bedrock:** each click is an `item_stack_request`; a request planned on an earlier request's prediction names the
  pending request id as the slot's stack id; BDS answers in send order; a rejected request (e.g. status 55 dirt into
  the off-hand, then 49 for the request that named it) gets only the error response — nothing is resent.
- **mineflayer-bedrock:** the inventory model keeps, per slot, the requests in flight that changed it. A settled
  request hands its result for the slot to the next request on that slot (the server's count and stack id, or its
  own starting state when rejected) instead of overwriting that request's prediction; only the last request on a slot
  writes the slot. Chained rejections therefore end at the state before the first request — or at what the server
  last sent for the slot while they were in flight (a pickup, `/give`; POLISH-LIB: a request planned on such a server
  update keeps it as its base, and a resend of the very state the requests were planned on leaves their predictions
  shown, [inventory resync](U8.md#inventory-resync)) — and late (timed-out) answers are applied in order. Answers for a container window that was closed meanwhile no longer touch the next
  window. A click's prediction is committed synchronously when the inventory screen is open (and re-planned after
  waiting for the screen otherwise), so clicks issued without awaiting the previous one build on it, like Java's
  client-side click.
- **Tests:** `test/unit/inventory.test.js` › "overlapping requests on the same slot …" (A ok / B rejected, both
  rejected, both ok, both late, the off-hand case, a closed window, back-to-back clicks);
  `test/external/inventoryConcurrency.test.js` › "a rejected click and a click planned on it …", "rapid clicks: …"
  (the model compared with the server's resent inventory).

### Commands without output  {#silent-commands}
- **Affects:** `bot._bedrock.commands.request(command, { timeout })` (internal hook used by later units and tests),
  `bot.chat('/…')` (fire and forget, unchanged).
- **Java:** no equivalent hook in mineflayer.
- **Bedrock:** `/say`, `/me`, a successful `/tellraw` — and every command while the `sendcommandfeedback` gamerule is
  off — get no `command_output` at all. For every successful command BDS sends `event { event_type:
  'command_executed', event_data: 08 02 00 <len> <name> 00 }`, right before the command's `command_output` (same
  batch) when it has one; a failed command never gets the event but always a `command_output` (even with feedback
  off: `output_type: 'silent'`).
- **mineflayer-bedrock:** the event is matched to the oldest request of that command name; when no `command_output`
  follows within 100 ms the request resolves with `{ origin, output_type: 'none', success_count: 1, output: [],
  has_data: false }`. A request still rejects after `timeout` (10 s) when neither arrives.
- **Tests:** `test/unit/chat.test.js` › "commands.request: a successful command without output …";
  `test/external/chatCommands.test.js` › "commands.request: say / tellraw / feedback-off commands …".

### The liquid layer of replaced blocks  {#liquid-layer}
- **Affects:** `bot.blockAt(…).isWaterlogged` / `.superimposed` / `.computedStates.waterlogged`, `blockUpdate`, the
  physics engine's water (U5 reads `isWaterlogged`).
- **Java:** `waterlogged` is a block state: every block update carries it.
- **Bedrock:** waterlogging is block layer 1, and BDS sends only the layer-0 change when a block replaces a water
  source or a waterlogged block (`update_block` layer 0, or `update_subchunk_blocks` with an empty `extra`); the
  client applies the liquid-layer rule itself. Observed live (a fresh join as ground truth): a fence, ladder, slab,
  carpet or wall placed into a water source is waterlogged, a waterlogged fence replaced by a slab / carpet / wall
  stays waterlogged, replaced by stone / glass it is dry, replaced by air or water it is plain water; flowing water
  (not a source) and lava never end up in layer 1. Bedrock's can-contain-liquid set differs from Java's
  `waterlogged` blocks (carpets are waterloggable) and no client data lists it.
- **mineflayer-bedrock:** a layer-0 update whose new block is air or a liquid clears layer 1, and the same block in
  another state (a trapdoor toggling, kelp growing) keeps its layer — both certain. Any other block replacing a water
  source or a waterlogged block is predicted (a full cube dry, any other block keeping / taking the water; one
  `blockUpdate` with both layers) and confirmed: the bot requests that sub-chunk again (one `subchunk_request` per
  sub-chunk at a time, sent again after 5 s without an answer, up to 3 times) and applies the server's layer 1 for
  those blocks (one more `blockUpdate` where the prediction was wrong; a block whose layer 0 changed again meanwhile is
  left to its own update, and a block changed while the request was out is asked for again).
- **Tests:** `test/unit/blocks.test.js` › "layer-0 updates apply Bedrock's liquid-layer rule …";
  `test/external/liquidLayer.test.js` (eleven replacements, the watching bot compared with a fresh join).
