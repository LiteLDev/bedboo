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
  // BEDD-5: only with `transport: 'bedd'` (a real client hosted by Be.D.D.): the BeDD ops this instance offers and
  // whether a bot API works with them (lib/bedd/surface.js, docs/bedd.md)
  bedd?: BeddExtras
}

// BEDD-5: `bot.bedrock.bedd` (an interface so other bedd units add their members by declaration merging)
export type BeddCapability = 'present' | 'disabled' | 'absent'
export interface BeddExtras {
  // the BeDD control ops by name (`look`, `input`, `button`, `stack`, …) and whether this instance offers them
  readonly caps: { [op: string]: BeddCapability }
  // whether a bot API (`'dig'`, `'craft'`, `'creative.setInventorySlot'`) or a BeDD op works with these caps
  supports: (name: string) => boolean
}

// BEDD-5: thrown / rejected by an API the real client owns when no BeDD op does it (lib/bedd/errors.js)
export interface BeddUnsupportedError extends Error {
  code: 'ERR_BEDD_UNSUPPORTED'
  bedd: true
  feature: string
  missing: string[]
}
