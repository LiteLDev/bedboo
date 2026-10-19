# Parity — U16b (mob combat matrix, NetherNet transport, user docs)

U16b (the second half of plan unit U16, wave 5) owns no upstream reference row: the parity rows of U16 (the
conformance test in failing mode, `digAndBuild`, review fixes) are U16a's. Everything U16b delivers is a Bedrock extra,
proved by these tests (all against BDS 1.26.51.1):

- **Mob combat matrix** — `packages/mineflayer-bedrock/test/external/combatMatrix.test.js` › "combat matrix: <mob>"
  for zombie, husk, drowned, skeleton, stray, spider, cave_spider, creeper, enderman (open ground), slime (+ splits),
  witch, pillager, blaze, piglin and hoglin (Nether arena), wither_skeleton, ghast, magma_cube (+ splits), shulker,
  endermite, phantom: a survival bot on difficulty normal (diamond sword, diamond armor, shield, bow) kills each mob
  by its own hand through the public API (`attack`, `lookAt`, `setControlState`, `activateItem`/`deactivateItem`,
  `equip`, `nearestEntity`, `entityHurt`/`entityDead`) and survives. Gate: ≥ 4/5 per mob with `BEDBOO_COMBAT_RUNS=5`
  (see [differences: combat](../differences/U16-transport.md#combat),
  [hurt source](../differences/U16-transport.md#hurt-source)). The fighting code is the reusable combat library in
  `packages/agent/src/skills/combat.js` (`packages/agent/test/combat.test.js`).
- **NetherNet transport** — `test/external/nethernet.test.js` (opt-in: `--grep nethernet`) › "the bot joined and
  spawned over NetherNet (not RakNet)", "chat both ways", "a block update reaches the bot, and the bot walks", "HTTP
  discovery answers on the server port", "the server key can be pinned (a wrong pin is refused)", "quit disconnects
  cleanly"; `test/unit/client_transport.test.js` (options, the bedrock-protocol and nethernet patches)
  (see [differences: transport](../differences/U16-transport.md#transport)).
- **README quick start** — `test/external/readmeQuickstart.test.js` › "the example echoes chat and comes to the player
  (pathfinder)": `examples/readme_quickstart.js` runs through `bot.test.runExample`; `test/unit/docs.test.js` keeps
  the README snippet, the `bot.bedrock.*` list of `docs/api.md` and the user docs' links in sync.
- **Chunk unloading fix** (`lib/plugins/blocks.js`, found by the quick-start test: columns BDS sent beyond its join
  publisher radius were dropped and never resent) — `test/unit/chunk_radius.test.js`.
