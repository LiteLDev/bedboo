# Inventory and windows

How bedboo keeps mineflayer's Java-layout inventory API (`bot.inventory`, `bot.currentWindow`, slot numbers,
`clickWindow`, `transfer`, `deposit` / `withdraw`, events) on top of Bedrock's server-authoritative inventory, and the
few visible consequences. Observed on BDS 1.26.51.1 (protocol 2193).

## clickWindow is emulated with item stack requests  {#click-window}

- **Affects:** `bot.clickWindow`, and everything built on it (`transfer`, `putAway`, `moveSlotItem`,
  `putSelectedItemRange`, `toss`, `tossStack`, `equip`, `unequip`, `simpleClick`, window `deposit` / `withdraw`)
- **Java:** the client sends `window_click` (slot, button, mode); the server runs the click and syncs the window.
- **Bedrock:** there is no click packet. The client sends `item_stack_request` actions (`take`, `place`, `swap`,
  `drop`, `destroy`, `craft_creative`, …) between explicit container slots (`hotbar`, `inventory`, `armor`, `offhand`,
  `cursor`, `container`, `barrel`, `shulker`, furnace / brewing / station ui slots) and the server answers with an
  `item_stack_response` (ok + resulting counts / stack ids, or an error code). It does not resend the inventory after
  a request. Cursor and cross-container moves and `craft_creative` are only accepted while a screen is open
  (status 7 / 50 otherwise).
- **bedboo:** `lib/bedrock/click.js` plans the Java (vanilla 1.21 `doClick` / `quickMoveStack`) result of each click
  mode as stack request steps:
  - mode 0 (left / right, outside = drop), mode 1 (shift, with Java's per-menu rules including armor → armor slot;
    the station rules — furnace fuel vs ingredient, brewing bottles / ingredient / fuel, enchanting lapis, loom,
    cartography, smithing, beacon — come from the window specs and use item-name lists, as there is no smelting /
    brewing recipe data), mode 2 (number keys, 40 = off-hand), mode 3 (creative clone) and mode 4 (drop key).
  - The model predicts the result (one `updateSlot` per changed slot, like Java 1.17+), sends one request per click and
    waits for the response, which updates counts and stack ids (an answer that arrives after the 5 s timeout is still
    applied). Clicks may overlap: see [overlapping requests](#overlapping-requests).
  - A rejected request is rolled back and `clickWindow` throws mineflayer's own message
    `Server rejected transaction for clicking on slot <s>, on window with id <id>.` (no response:
    `Server didn't respond to transaction …`).
  - Clicks on `bot.inventory` open the player's own inventory screen (`interact open_inventory`) and close it 100 ms
    after the last click when the cursor is empty.
  - Modes 5 (drag) and 6 (double click) throw "not implemented", as prismarine-windows does. Clicking a crafting /
    trade result slot needs the craft request of `bot.craft` ([crafting](crafting.md#craft-request)) and throws.
  - Java's server silently ignores an invalid placement (e.g. dirt into an armor slot); the planner applies Java's
    `Slot.mayPlace` for armor slots and result slots, and anything else BDS refuses surfaces as the rejection error.

## Overlapping item stack requests  {#overlapping-requests}

- **Affects:** `bot.clickWindow` and everything built on it when calls overlap (clicks not awaited, armor-manager /
  tool / auto-eat equips racing user code, `transfer` while tossing), window `deposit` / `withdraw`
- **Java:** the client applies each click to its window at once (1.17+ prediction) and the server resyncs a wrong
  slot with `set_slot` / `window_items`, so overlapping clicks self-heal.
- **Bedrock:** each click is an `item_stack_request`; a request planned on an earlier request's prediction names the
  pending request id as the slot's stack id; BDS answers in send order; a rejected request (e.g. status 55 dirt into
  the off-hand, then 49 for the request that named it) gets only the error response — nothing is resent.
- **bedboo:** the inventory model keeps, per slot, the requests in flight that changed it.
  - A settled request hands its result for the slot to the next request on that slot (the server's count and stack
    id, or its own starting state when rejected) instead of overwriting that request's prediction; only the last
    request on a slot writes the slot.
  - Chained rejections therefore end at the state before the first request — or at what the server last sent for the
    slot while they were in flight (a pickup, `/give`). A request planned on such a server update keeps it as its
    base, and a resend of the very state the requests were planned on leaves their predictions shown
    ([inventory resync](#inventory-resync)).
  - Late (timed-out) answers are applied in order. Answers for a container window that was closed meanwhile no longer
    touch the next window.
  - A click's prediction is committed synchronously when the inventory screen is open (and re-planned after waiting
    for the screen otherwise), so clicks issued without awaiting the previous one build on it, like Java's client-side
    click.

## A click raced by a server-side change of its slots is planned again  {#raced-requests}

- **Affects:** `bot.clickWindow` and everything built on it (`transfer`, `deposit` / `withdraw`, `moveSlotItem`,
  `equip`, `toss` / `tossStack`, `putAway`, crafting) while drops are picked up, `/give` runs, or a hopper or another
  player changes a slot the request touches
- **Java:** `window_click` is applied by the server to its own current state (and resynced); it never fails.
- **Bedrock:** an item stack request names each slot's stack id as the client knows it; when the server changed the
  slot meanwhile (a pickup: `inventory_transaction` normal with a new stack id) BDS rejects the whole request (status
  49 stack id mismatch / 50). Measured: a chest deposit / withdraw loop with a console `/give` every 400 ms gave 6
  rejections in 88 operations ("Server rejected transaction for clicking on slot 27 …").
- **bedboo:** a server packet that sets a slot of a request in flight to another stack than the one the request was
  planned on marks it raced (`lib/bedrock/inventory_model.js`); a raced request that BDS rejects is planned again once
  on the server's state and sent again (item stack requests are atomic: the rejected one changed nothing). Requests
  chained on it (planned on its prediction) are retried the same way. A rejection without such a change still throws
  mineflayer's message.

## Closing a window puts the carried item and station inputs back  {#close-window}

- **Affects:** `bot.closeWindow`, window `close()`
- **Java:** on close the server returns the carried item (and crafting grid / anvil / enchanting inputs) to the
  player inventory (`placeItemBackInInventory`).
- **Bedrock:** BDS keeps them: the carried item stays in the `cursor` (ui slot 0), station inputs stay in their ui
  slots (observed after `container_close`). Java \< 1.17 follows `close_window` with a no-op click; Bedrock has
  neither.
- **bedboo:** like upstream, `closeWindow` clears `bot.currentWindow` and emits `windowClose` at once. It then moves
  those items with one stack request following Java's rule (selected hotbar slot, off-hand and stacks with room first,
  then the first empty slot, the rest is dropped) and sends `container_close { window_id, window_type, server: false }`
  (with nothing to put back, only `container_close`). The returned promise resolves on the server's echo, and openers
  wait for it plus 100 ms (2 ticks) before activating the next container: BDS silently drops a container activation
  that arrives in the tick its previous container closed (no `container_open`, no resync). Block entities (chests,
  furnaces, brewing stands, …) keep their contents as on Java. `bot.closeWindow(bot.inventory)` closes the inventory
  screen if the bot opened it.

## Opening a window while another one is open  {#window-switch}

- **Affects:** `bot.openBlock`, `bot.openEntity`, `bot.openContainer` / `openChest` / `openDispenser`, the station
  openers (`openFurnace`, `openAnvil`, `openEnchantmentTable`, `openVillager`, `craft` with a table),
  `bot.activateBlock` / `bot.activateEntity` / `bot.activateEntityAt`, `windowClose`
- **Java:** `ServerPlayer.openMenu` closes the current menu first (`close_window` → mineflayer emits `windowClose`),
  then opens the new one; code that never closes a chest (mineflayer-collectblock's `emptyInventory`) works.
- **Bedrock:** BDS ignores an activation that would open a container while the player has one open — no
  `container_open`, no `container_close` — so `openBlock` would wait for `once()`'s 20 s and throw (verified live:
  chest then barrel, and the same chest twice). Other activations (a lever) are processed with a container open and
  the container stays open, like Java.
- **bedboo:** `openBlock` / `openEntity`, the station openers, and `activateBlock` / `activateEntity(At)` of a
  container or station block (chests, barrels, shulker boxes, furnaces, crafting / enchanting / smithing tables,
  anvils, hoppers, dispensers, droppers, brewing stands, beacons, grindstones, stonecutters, looms, cartography tables,
  crafters, lecterns) or of a trading / storage entity (villagers, wandering traders, chest / hopper minecarts, chest
  boats) first close the open container window with `bot.closeWindow` (`windowClose` at once, carried and station
  items put back, `container_close`, the server's echo), then wait BDS's 100 ms reopen delay and activate. Other
  activations leave the window open.

## A container whose entity or block is gone  {#container-gone}

- **Affects:** `windowClose`, `bot.currentWindow`, trading (`bot.openVillager`, `bot.trade`) and station windows
  (anvil, enchanting table, furnace, …) whose trader dies or despawns or whose block is broken
- **Java:** the server closes the menu (`stillValid` fails) and returns the items in the input slots.
- **Bedrock:** BDS sends only `remove_entity` (or the block update): no `container_close`, nothing returned. Items in
  the trade / station input slots are in the player's `ui` container; BDS refuses to move them out of that dead screen
  (status 49, invalid source slot) and keeps them there — the next window using those slots shows them.
- **bedboo:** the inventory plugin treats the container's entity going away (`entityGone` of the window's entity) or
  its block becoming another block (a lit furnace is still a furnace, a chipped anvil still an anvil) like a server
  close: `windowClose`, `currentWindow` null, then `container_close` (no doomed return request; the next opener waits
  for its echo). Moving out of range does not close a window (BDS sends nothing; not handled). `openVillager` returns
  items it finds in the trade input slots at once (a fresh Java trade window is empty), so a dead trader's payment
  comes back with the next trade window. `update_trade.villager_unique_id` is a zigzag varint that bedrock-protocol
  3.60.1 reads unsigned; it is decoded in `inventory.js`.

## Window types: Java types for Bedrock containers  {#window-types}

- **Affects:** `windowOpen`, `bot.currentWindow`, `bot.openBlock`, `bot.openEntity`, `bot.openContainer`
  (`openChest`, `openDispenser`), the station openers
- **Java:** `open_window` carries the Java window type; `window_items` the slots.
- **Bedrock:** `container_open { window_id, window_type, coordinates, runtime_entity_id }` + `inventory_content` of
  that window id; every chest-like block (chest, trapped / ender / copper chest, barrel, shulker box) is
  `window_type: 'container'` and is told apart by the block at `coordinates`; station inputs (crafting grid, anvil,
  enchanting, grindstone, stonecutter, loom, cartography, smithing, beacon, trading) live in the `ui` container.
  Bedrock sends a window's contents with its own window id right after `container_open`, and syncs the player
  inventory as its own container (`inventory`).
- **bedboo:** the registry `bot._bedrock.windows` maps every container type to the Java window type and slot layout
  of Java 1.21 (`minecraft:generic_9x3` / `9x6` / `3x3`, `hopper`, `shulker_box`, `crafting`, `furnace`,
  `blast_furnace`, `smoker`, `brewing_stand`, `enchantment`, `anvil`, `merchant`, `beacon`, `grindstone`,
  `stonecutter`, `loom`, `cartography`, `smithing` (1.20+ template / base / addition / result), `crafter_3x3`,
  `lectern`, `HorseWindow`), so `openContainer`'s and the station openers' type checks pass unchanged. The player part
  of a window mirrors `bot.inventory`. An early content for a reused window id is buffered and used, and a trailing
  update after a close always reaches `bot.inventory`. `openContainer` also accepts the Bedrock block names
  `undyed_shulker_box` and the copper chests. The horse and lectern windows are not verified on BDS yet. Opening a
  window while a container window is open closes that one first, like Java's server
  ([window switching](#window-switch)).

## updateSlot fires on changes only  {#update-slot}

- **Affects:** window `updateSlot` / `updateSlot:<n>` events, `heldItemChanged`
- **Java:** every `set_slot` / `window_items` calls `updateSlot` (even for unchanged slots).
- **Bedrock:** there is no `set_slot`. BDS resends every inventory window (`inventory_content` × 4) after each command,
  gamemode change and rejected transaction.
- **bedboo:** a resend that only changes stack ids replaces the Item silently; `updateSlot` (and thus
  `heldItemChanged`) fires when type, count, metadata or NBT change. `inventory_slot` / `inventory_content` of the
  held slot emit `heldItemChanged`.

## No window resync request like Java's  {#resync}

- **Affects:** `bot._syncWindow` (internal)
- **Java (1.17.1+):** an impossible click makes the server resend the window.
- **Bedrock:** BDS does not resend anything after a rejected item stack request (verified live: only the error
  response arrives), and every request is answered.
- **bedboo:** `_syncWindow` resolves at once; the model rolls the rejected prediction back itself (see
  [overlapping requests](#overlapping-requests)). A slot found out of date is healed by an
  [inventory resync](#inventory-resync).

## Inventory resync (inventory_mismatch)  {#inventory-resync}

- **Affects:** `bot.inventory` after a desync, `clickWindow` (and everything built on it), the Bedrock extra
  `bot.bedrock.resyncInventory()` ([`bot.bedrock`](../api.md#bedrock-extras))
- **Java:** the server resends a window whenever the client's view is stale (state ids).
- **Bedrock (measured on BDS 1.26.51.1):** a client `inventory_transaction { transaction_type: 'inventory_mismatch' }`
  makes BDS resend the player's whole inventory — `inventory_content` of the inventory, armor, ui (cursor) and
  off-hand windows, then `player_hotbar` — within a tick, with no other effect. Nothing else does: not (re)opening the
  inventory screen, not a rejected request (status 49 for a slot whose stack id the server does not have, and the
  slot stays rejected for every later request), not `/clear <player> <item> -1 0`.
- **bedboo:** server packets always win (`inventory_content`, `inventory_slot`, server transactions are applied as
  they come).
  - When the model finds a player slot out of date it asks for the server's copy (automatic resyncs at most once per
    second — one asked for sooner goes out when the second is over). Triggers:
    - a request rejected with status 49 that no server packet explains (not raced, not planned on another request that
      was rejected). When the resent copy differs from what the request was planned on, a planned request
      (`clickWindow`, `returnItems`, craft) is planned again once on it, else the rejection stands (a request that
      cannot be planned again rejects at once, the resync runs meanwhile);
    - a server `inventory_transaction` (pickup, `/give`) whose `old_item` is neither the local item nor the new one,
      for a slot no request is changing;
    - a response that counts items in a slot the model holds nothing in.
  - A resync settles on the answer's `player_hotbar { select_slot: true }` (a command's resend ends with
    `select_slot: false`). `bot.bedrock.resyncInventory()` → `Promise<boolean>` asks explicitly (true once applied,
    false without an answer within 2 s); diagnostics in `bot._bedrock.inventoryModel.resyncs`.
  - A resend that arrives while requests are in flight and only repeats the server's known copy of a slot (stack id,
    type, count, metadata, NBT) does not replace their predictions: the server applies them to that state, so a click
    planned meanwhile builds on the prediction and the responses complete the predicted items (otherwise a swap
    answered after such a resend would show the old item with the new count).
- **Pickups:** pickups arrive as `take_item_entity` + a server `inventory_transaction` (normal: the container slot's
  old and new item, then a `world_interaction` action), never as `inventory_slot`. Item counts stay right for plain
  digging and pickups (merging into hotbar and main-inventory stacks, a full inventory, a chest open, mineflayer-collectblock).
  A desync (about 1 round in 40) came from a coal stack moved back and forth by overlapping `moveSlotItem`s while
  pickups merged into it: a pickup landed on the stack while a take from it and a click planned on that take were in
  flight; BDS rejected both (49: the stack changed / the request it named was rejected) and the rollbacks wrote the
  pre-pickup stack back — `bot.inventory` showed 28 coal (stack 236) while the server had 29 (stack 237), and every
  later click on that stack was rejected. The per-slot chains ([overlapping requests](#overlapping-requests)) fix
  this: a rejected request goes back to what the server last sent for the slot, and a request planned on a server
  update keeps it as its base. The resync above heals any desync that remains.

## The inventory screen after a nether portal trip  {#inventory-screen-after-portal}

- **Affects:** `bot.equip` (armor, off-hand), `bot.toss`, crafting from the inventory grid, `bot.moveSlotItem` — every
  request that needs the player's inventory screen (`lib/bedrock/inventory_model.js` `screen.open()`)
- **Java:** inventory clicks need no screen.
- **Bedrock:** item stack requests on the player's inventory need the inventory screen open (`interact open_inventory`
  → `container_open window_type inventory`). Measured on BDS 1.26.51.1: while the player stands in a nether portal,
  and for about 1–2 s after it stepped out of the arrival portal, BDS silently drops `open_inventory` (no
  `container_open`, nothing else). A command teleport (`/execute in nether run tp`) does not do this.
- **bedboo:** `screen.open()` repeats the `open_inventory` request every 1.5 s until the screen opens (timeout 8 s).
  Without this the first equip after a portal trip failed with "the server did not open the inventory screen".
  Standing inside a portal still fails (vanilla behaviour): step out of the arrival portal first.

## Held item selection  {#held-item}

- **Affects:** `bot.quickBarSlot`, `bot.setQuickBarSlot`, `heldItemChanged`
- **Java:** `held_item_slot` both ways.
- **Bedrock:** the server selects with `player_hotbar { selected_slot, select_slot }` (`select_slot: false` is only
  informative); the client announces its selection with `mob_equipment` carrying the exact held item.
- **bedboo:** as described; `bot._bedrock.heldNetworkItem()` returns the exact wire item of the held slot from the
  inventory model (used by every `inventory_transaction`).

## A server hotbar select can be older than the bot's own selection  {#hotbar-select}

- **Affects:** `bot.quickBarSlot`, `bot.heldItem`, `heldItemChanged` right after `setQuickBarSlot`
- **Java:** `held_item_slot` from the server and the client's `held_item_change` do not cross in practice.
- **Bedrock:** BDS answers console commands (`/clear`, `/replaceitem`, `/give`) with
  `player_hotbar { select_slot: true }` carrying its selected slot. When such a command runs before BDS has read the
  bot's latest `mob_equipment` selection, the select is stale: following it switches the bot back to the previous slot
  while BDS then applies the bot's selection — client and server stay out of sync.
- **bedboo:** a server select (`player_hotbar` or the bot's own `mob_equipment`) that contradicts a selection the bot
  sent less than 1 s ago is ignored and the bot's selection sent again (the window is not extended by the resend).

## Off-hand: only off-hand items  {#offhand}

- **Affects:** `bot.equip(item, 'off-hand')`, `bot.clickWindow` on slot 45, the `inventory` example
- **Java:** any item can be put into the off-hand slot.
- **Bedrock:** the off-hand only takes items with the off-hand component (shield, totem, arrows, firework rockets,
  maps, nautilus shell, …); BDS rejects anything else (status 50). On the wire the off-hand slot is `offhand` slot
  **1** for stack requests (slot 0 is rejected) while `inventory_content` / `inventory_slot` use index 0.
- **bedboo:** slot 45 maps to `offhand` 1; equipping a non-off-hand item rejects with the click error. With
  `examples/inventory.js`, `equip off-hand dirt` is therefore refused; `equip off-hand arrow` works (the item lists
  then end with `arrow x 16`, as slot 45 is listed last).

## Creative inventory: craft_creative instead of set_creative_slot  {#creative}

- **Affects:** `bot.creative.setInventorySlot`, `bot.creative.clearSlot`, `bot.creative.clearInventory`
- **Java:** `set_creative_slot` writes any item (with any NBT) into a player slot.
- **Bedrock:** a creative player creates items with an item stack request in the inventory screen:
  `craft_creative { item_id: <creative_content entry id> }` (+ `place` from `creative_output` slot 50 with the request
  id as stack id); `destroy` deletes. Only the items of the server's creative inventory (`creative_content`: every base
  item plus the listed NBT variants, e.g. enchanted books) can be created — arbitrary NBT (custom names, other
  enchantments, damage) cannot; a legacy creative `inventory_transaction` is rejected by BDS (it resends the
  inventory). `craft_creative` is refused while a container is open (status 7).
- **bedboo:** same signature and guards as upstream (same item → no-op, a second concurrent call on the slot →
  `Setting slot <n> cancelled …`). Replacing an occupied slot is `destroy` + `craft_creative` + `place` in one request;
  slot 45 (off-hand) is accepted too; an item not in the creative inventory, slot 0 (crafting result) or an open window
  reject with an explanatory error. `waitTimeout` is unused (the server always answers). The creative index is
  `bot._bedrock.creativeItems`. Plain items whose creative entries all carry NBT: see
  [creative defaults](#creative-defaults).

## Plain items from the creative inventory  {#creative-defaults}

- **Affects:** `bot.creative.setInventorySlot` with a plain `firework_rocket`, `firework_star` or `banner`
- **Java:** any item, any NBT.
- **Bedrock:** the creative inventory lists these only with NBT (rockets `Fireworks {Flight: 1, Explosions: []}`,
  banners `Type: 0`, stars per colour).
- **bedboo:** an item without NBT that has no exact entry gets the entry with the fewest NBT tags when exactly one has
  the fewest (the default variant); the slot then holds that NBT. Enchanted books (all variants alike) stay refused.

## Item use, eating and the shield  {#item-use}

- **Affects:** `bot.activateItem`, `bot.deactivateItem`, `bot.consume`, `bot.usingHeldItem`
- **Java:** `use_item` (hand, sequence, rotation) / `block_dig` status 5; eating ends with `entity_status` 9.
- **Bedrock:** `inventory_transaction item_use click_air` (held item = the server's exact copy; no rotation field —
  the direction is the yaw / pitch of the same tick's `player_auth_input`), `item_release release`; one click_air
  eats: after 32 ticks the server sends `completed_using_item { use_method: 'eat' }` and the shrunk stack. Shields
  have no use action: a Bedrock player blocks while sneaking with a shield in either hand. On peaceful the food level
  never drops (a hunger effect only empties the saturation).
- **bedboo:** `activateItem(offHand)` sends click_air (`hand: off_hand` + the off-hand item for `offHand`); with a
  shield it holds sneak instead (`deactivateItem` releases it). That sneak is the shield's own: `clearControlStates()`
  or a sneak-control release — mineflayer-pathfinder does both under mineflayer-pvp — leave it, as they leave a raised
  shield on Java; `getControlState('sneak')` reports it. `completed_using_item` (or a held-stack change, like upstream)
  finishes `consume()` and clears `usingHeldItem`. Java's `set_cooldown` handling has no counterpart: Bedrock item
  cooldowns are client side (no server packet in protocol 2193).

## Buckets stack  {#stacked-buckets}

- **Affects:** bucket handling (picking up lava / water), `bot.heldItem` after `bot.activateBlock` with a bucket
- **Java:** a bucket stack of 1; using an empty bucket on a source turns the held item into the filled bucket.
- **Bedrock:** empty buckets stack (16). `bot.activateBlock(<lava source>)` with a stack of 3 buckets in the hand
  leaves 2 empty buckets in the hand and puts the `lava_bucket` into another slot.
- **bedboo:** nothing changes in the library (the server's inventory update is mirrored); count `lava_bucket` /
  `water_bucket` items instead of checking the held item.
