# Differences — BEDD (`transport: 'bedd'`, a real client hosted by Be.D.D.)

Only the `bedd` transport is concerned: with `raknet` / `nethernet` nothing here applies. Setup, the authority table
and the coverage matrix are in [../bedd.md](../bedd.md). Entry format: [README.md](README.md).

### The real client owns its serverbound packets  {#client-owned-packets}
- **Affects:** every API that sends a packet; `bot._client.queue` / `write`
- **Java:** mineflayer is the client and writes every packet itself.
- **Bedrock:** the BeDD-hosted client logs in, answers the loading screen, requests chunks and sends
  `player_auth_input`, block actions, inventory transactions and item stack requests itself, every tick.
- **mineflayer-bedrock:** bedboo never forges those packets. A router turns what bedboo would have sent into BeDD
  control ops (`input`, `look`, `slot`, `button`, `action`, `send`, `stack`); client-owned packets are dropped
  (authority table in [../bedd.md](../bedd.md#authority-table)).
- **Tests:** `test/bedd/*.e2e.js` (opt-in, Windows), `test/unit/bedd/*.test.js`.

### `bot.entity` follows the client, 1-2 ticks behind  {#self-state-from-echo}
- **Affects:** `bot.entity.position` / `velocity` / `yaw` / `pitch` / `onGround`, `physicsTick`, `move`,
  `bot.physicsEnabled`, mineflayer-pathfinder
- **Java:** mineflayer's physics engine predicts the player every tick.
- **Bedrock (bedd):** the client's own physics moves the player; the tap echoes each `player_auth_input` it sends.
- **mineflayer-bedrock:** the physics provider does not step; it copies the echo (eye − 1.62), emits `physicsTick`
  and `move` once per client tick, and `look` / `lookAt` resolve when the echo is within 0.5° of the target.
  Pathfinder works with 1-2 ticks of lag.
- **Tests:** `test/bedd/02-movement.e2e.js` (walk, pathfinder goal, lookAt).

### Clicks go where the client's crosshair is  {#client-raycast}
- **Affects:** `dig`, `placeBlock`, `activateBlock`, `activateEntity`, `attack`
- **Java:** mineflayer names the block / face / entity in the packet.
- **Bedrock (bedd):** the client turns to the target and clicks; its own raycast decides what is hit.
- **mineflayer-bedrock:** look, wait for convergence, then `button`; the result is read from `update_block` and entity
  events, so a click that lands on a neighbour is visible as such.
- **Tests:** `test/bedd/03-actions.e2e.js` (dig dirt, place a block, chest, eat).

### Screen-level actions are unsupported  {#screen-actions}
- **Affects:** `bot.writeBook`, `bot.updateSign`, `bot.respawn`, sleeping / waking through the bed UI
- **Java:** packets bedboo can send itself.
- **Bedrock (bedd):** they are screens of the real client; BeDD has no op for them yet (v2).
- **mineflayer-bedrock:** they throw or reject with `BeddUnsupportedError` (`code: 'ERR_BEDD_UNSUPPORTED'`,
  `bedd: true`, `feature`, `missing`); the user clicks Respawn on the client.
- **Tests:** `test/bedd/01-core.e2e.js` "an unsupported API rejects with ERR_BEDD_UNSUPPORTED".

### Inventory needs the `stack` op  {#inventory-stack}
- **Affects:** `clickWindow`, `moveSlotItem`, `transfer`, `deposit`, `withdraw`, `putAway`, `craft`, `equip` from the
  main inventory / armor / off-hand, `unequip`, `tossStack`, `creative.setInventorySlot`, anvil / enchanting /
  villager / smithing
- **Java:** window clicks.
- **Bedrock (bedd):** item stack requests must go through the client's ItemStackNetManager, or the client's request
  ids and predicted inventory go out of sync.
- **mineflayer-bedrock:** with BeDD's `stack` op (`allowStack: true`) they work, bedboo's request ids mapped to the
  client's; without it they reject with `ERR_BEDD_UNSUPPORTED`.
- **Tests:** `test/bedd/04-inventory.e2e.js` (craft planks, deposit into a chest).

### Connection options belong to the client  {#ignored-options}
- **Affects:** `createBot` options `auth`, `username`, `host`, `port`, `viewDistance`, `skipPing`;
  `holdResourcePacks`; `bot.end`, `bot.quit`
- **Java:** mineflayer connects, authenticates and disconnects.
- **Bedrock (bedd):** the client is already logged in and in a world.
- **mineflayer-bedrock:** those options are ignored with one warning each, `holdResourcePacks` is a no-op, and
  `bot.end` / `quit` only detach (the client stays in its world). A world change on the client (`LINK_DOWN`) ends the
  bot.
- **Tests:** `test/unit/bedd/surface.test.js`.
