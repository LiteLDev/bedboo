// Bedrock-only extras exposed as `bot.bedrock.*` (not part of mineflayer's API).
// Each unit that adds an extra declares it here (one member block per unit, comment with the owner)
// and documents it in docs/differences/<unit>.md.

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface BedrockExtras {
  // U9 (player state): the server's game rules, Bedrock names as sent (start_game.gamerules + game_rules_changed),
  // e.g. `doDayLightCycle`, `keepInventory`, `randomTickSpeed` (docs/differences/U9.md#game-rules)
  gameRules: { [name: string]: boolean | number }
  // U16 (parity hardening): ids of the Bedrock blocks Java models as one block with a state (`furnace` →
  // [furnace, lit_furnace]), for findBlock/findBlocks `matching` (docs/differences/U16a.md#block-variants)
  blockVariants: (block: string | number) => number[]
  // POLISH-LIB: ask the server for its copy of the player's inventory (BDS resends the inventory, armor, cursor and
  // off-hand); resolves true once it was applied, false when no answer came within 2 s
  // (docs/differences/U8.md#inventory-resync)
  resyncInventory: () => Promise<boolean>
  // BEDD-4 (bedd physics follower): transport 'bedd' only (undefined otherwise). Other bedd units add their members
  // to the same object (interface BeddExtras below)
  bedd?: BeddExtras
}

// BEDD-4: the last player_auth_input the real client echoed (yaw/pitch in Bedrock degrees, as on the wire)
export interface BeddObserved {
  yaw: number
  pitch: number
  tick: number | null
}

export interface BeddExtras {
  // BEDD-4: null until the client's first echoed player_auth_input
  observed: BeddObserved | null
}
