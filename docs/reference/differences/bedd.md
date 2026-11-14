# BeDD mode (transport: 'bedd')

What changes when bedboo drives a real Bedrock client hosted by Be.D.D. (`transport: 'bedd'`) instead of speaking the
protocol itself. Only the `bedd` transport is concerned: with `raknet` / `nethernet` nothing here applies. Setup, the
authority table and the coverage matrix are in the [BeDD guide](../../guide/bedd.md).

## The real client owns its serverbound packets  {#client-owned-packets}

- **Affects:** every API that sends a packet; `bot._client.queue` / `write`
- **Java:** mineflayer is the client and writes every packet itself.
- **Bedrock:** the BeDD-hosted client logs in, answers the loading screen, requests chunks and sends
  `player_auth_input`, block actions, inventory transactions and item stack requests itself, every tick.
- **bedboo:** never forges those packets. A router turns what bedboo would have sent into BeDD control ops (`input`,
  `look`, `slot`, `button`, `action`, `send`, `stack`); client-owned packets are dropped (see the
  [authority table](../../guide/bedd.md#authority-table)).

## `bot.entity` follows the client, 1-2 ticks behind  {#self-state-from-echo}

- **Affects:** `bot.entity.position` / `velocity` / `yaw` / `pitch` / `onGround`, `physicsTick`, `move`,
  `bot.physicsEnabled`, mineflayer-pathfinder
- **Java:** mineflayer's physics engine predicts the player every tick.
- **Bedrock (bedd):** the client's own physics moves the player; the tap echoes each `player_auth_input` it sends.
- **bedboo:** the physics provider does not step; it copies the echo (eye − 1.62), emits `physicsTick` and `move` once
  per client tick, and `look` / `lookAt` resolve when the echo is within 0.5° of the target. Walking, pathfinder goals
  and `lookAt` work; pathfinder runs with 1-2 ticks of lag.

## Clicks go where the client's crosshair is  {#client-raycast}

- **Affects:** `dig`, `placeBlock`, `activateBlock`, `activateEntity`, `attack`
- **Java:** mineflayer names the block / face / entity in the packet.
- **Bedrock (bedd):** the client turns to the target and clicks; its own raycast decides what is hit.
- **bedboo:** look, wait for convergence, then `button`; the result is read from `update_block` and entity events, so
  a click that lands on a neighbour is visible as such.

## Screen-level actions go through the client's screens  {#screen-actions}

- **Affects:** `bot.respawn` (and the `respawn` option), `bot.wake`, `bot.updateSign`, `bot.writeBook`, `bot.signBook`
- **Java:** packets bedboo can send itself.
- **Bedrock (bedd):** they are screens of the real client: the death screen, the bed screen, the sign editor, the book.
- **bedboo:** through BeDD's `ui` op it clicks Respawn and Leave Bed and types into the sign editor (opening it with a
  use click; it edits the side the client faces) and presses Done. A book's pages go out as book_edit (97, in BeDD's
  default `sendAllow`) and the book screen is closed with ESC; `setCommandBlock` sends command_block_update (78, also
  default). After the End exit the credits screen is skipped with ESC, as headless bedboo answers show_credits at once. With the packet's id
  in `sendAllow` (56 block_entity_data, 36 player_action) `updateSign` / `wake` send it as is instead. Without either
  they throw or reject with `BeddUnsupportedError` (`code: 'ERR_BEDD_UNSUPPORTED'`, `missing` e.g.
  `['send:56', 'ui']`); without `ui` `bot.respawn()` only warns (the user clicks Respawn). See
  [Screens](../../guide/bedd.md#screens) and [sendAllow](../../guide/bedd.md#send-allow).

## Packets nothing translates need `sendAllow`  {#send-allow}

- **Affects:** `bot._client.write` / `queue` of packets bedboo has no translation for (a plugin's own packets,
  set_default_game_type, crafting_event, …)
- **Java:** mineflayer writes any packet.
- **Bedrock (bedd):** the real client sends its own packets; BeDD's `send` sends others only when their id is in
  `sendAllow`.
- **bedboo:** such a packet goes out through `send` when its id is listed (`bot.bedrock.bedd.sendAllow`), otherwise it
  throws `BeddUnsupportedError` naming the id to add. block_pick_request is translated (look, then the pick button).
  Client-owned packets are dropped whatever the list says.

## Inventory needs the `stack` op  {#inventory-stack}

- **Affects:** `clickWindow`, `moveSlotItem`, `transfer`, `deposit`, `withdraw`, `putAway`, `craft`, `equip` from the
  main inventory / armor / off-hand, `unequip`, `tossStack`, `creative.setInventorySlot`, anvil / enchanting /
  villager / smithing
- **Java:** window clicks.
- **Bedrock (bedd):** item stack requests must go through the client's ItemStackNetManager, or the client's request
  ids and predicted inventory go out of sync.
- **bedboo:** with BeDD's `stack` op (`allowStack: true`) they work, bedboo's request ids mapped to the client's;
  without it they reject with `ERR_BEDD_UNSUPPORTED`.

## Connection options belong to the client  {#ignored-options}

- **Affects:** `createBot` options `auth`, `username`, `host`, `port`, `viewDistance`, `skipPing`;
  `holdResourcePacks`; `bot.end`, `bot.quit`
- **Java:** mineflayer connects, authenticates and disconnects.
- **Bedrock (bedd):** the client is already logged in (its own account) and in a world.
- **bedboo:** `host` / `port` make the client join that server first (BeDD's `join` op; `ERR_BEDD_JOIN` when it
  cannot); `viewDistance` (and `setSettings`) sets the client's render distance (`settings`); `bot.quit` makes the
  client leave its world (`join host:null`) and detaches, `bot.end` only detaches (the client stays in its world);
  `auth` and `username` are ignored with one warning each (the client is signed in with its own account), and
  `holdResourcePacks` is a no-op. A world change on the client (`LINK_DOWN`) ends the bot. The bot
  connects to the game instead: `bedd: { url, token }`, `{ pid }`, `{ instance }` or `{}` (the only running game)
  names a BeDD v2 game by its WebSocket endpoint, announced in BeDD's run files
  (`%LOCALAPPDATA%\BeDD\run\<pid>.json`); see [options](../../guide/bedd.md#options).
