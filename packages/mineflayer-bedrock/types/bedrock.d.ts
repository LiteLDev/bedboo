// Bedrock-only extras exposed as `bot.bedrock.*` (not part of mineflayer's API).
// Each unit that adds an extra declares it here (one member block per unit, comment with the owner)
// and documents it in docs/differences/<unit>.md.

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface BedrockExtras {
  // U9 (player state): the server's game rules, Bedrock names as sent (start_game.gamerules + game_rules_changed),
  // e.g. `doDayLightCycle`, `keepInventory`, `randomTickSpeed` (docs/differences/U9.md#game-rules)
  gameRules: { [name: string]: boolean | number }
}
