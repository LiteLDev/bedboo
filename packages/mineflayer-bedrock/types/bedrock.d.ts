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

// BEDD-1 (transport 'bedd'): `createBot({ transport: 'bedd', bedd })` and the bot's `_client.bedd`
// (lib/bedd/index.js). Other bedd units add their members in their own declarations.
export interface BeddOptions {
  /** control pipe path (default `\\.\pipe\BeDD`, or $BEDBOO_BEDD_PIPE) */
  pipe?: string
  /** tap pipe path (default `<pipe>-tap`) */
  tapPipe?: string
  /** stream factory for both pipes (default `net.connect`); tests pass a unix socket */
  connect?: (path: string) => import('stream').Duplex
  /** control request timeout in ms (default 5000; ops with a `timeoutMs` argument get that + 2000) */
  timeoutMs?: number
  /** optional lib/bedd modules to attach (default: authority, router, router_actions, follower, surface, inventory) */
  modules?: string[]
}

export type BeddCap = 'present' | 'disabled' | 'absent'
export interface BeddCaps { [op: string]: BeddCap }

export interface BeddRpc {
  /** `{ id, op, ...args }` → the reply (`ok: true`); rejects with an Error carrying `code` (BeDD's or ERR_BEDD_RPC*), `op`, `reply` */
  call (op: string, args?: object, opts?: { timeoutMs?: number }): Promise<{ ok: true, id: number, [key: string]: any }>
  /** call `op` with no arguments: ok → present, code 'disabled' → disabled, unknown op → absent */
  probe (op: string, opts?: { timeoutMs?: number }): Promise<BeddCap>
  supports (op: string): boolean
}

export interface BeddLink {
  state: 'unknown' | 'up' | 'down'
  type?: 'remote' | 'local'
  address?: string
  reason?: string
}

export interface BeddCapabilities {
  ownsLogin: true
  ownsLoadingScreen: true
  ownsChunkRequests: true
  ownsMovement: true
}

/** `_client.on('serverbound', packet)`: a packet the real client sent (tap echo) */
export interface BeddServerboundPacket {
  name: string
  params: any
  reserialized: boolean
  replay: boolean
  local: boolean
  seq: bigint
  tUs: bigint
  flags: number
}

/** `bot._client.bedd` when `transport: 'bedd'` */
export interface BeddClientApi {
  pipe: string
  tapPipe: string
  rpc: BeddRpc
  caps: BeddCaps
  supports (op: string): boolean
  /** resolves with the caps once the control pipe was negotiated (never rejects) */
  ready: Promise<BeddCaps>
  link: BeddLink
  hello: { m: 'HELLO', tap: number, mod: string, game: string, protocol: number, pid: number, link: BeddLink, journal: { frames: number, bytes: number, complete: boolean } } | null
  journal: { frames: number, bytes: number, complete: boolean } | null
  replayed: { complete: boolean } | null
  control: { protocol: number, pid: number } | null
  capabilities: BeddCapabilities
  /** what the bot would have sent; the default drops and counts (`dropped`), the router module replaces it */
  route (name: string, params: any): any
  dropped: { [name: string]: number }
  modules: { [name: string]: any }
  attach (bot: import('../index').Bot): void
}
