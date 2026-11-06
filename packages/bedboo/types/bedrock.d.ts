// Bedrock-only extras exposed as `bot.bedrock.*` (not part of mineflayer's API).

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface BedrockExtras {
  // the server's game rules, Bedrock names as sent (start_game.gamerules + game_rules_changed),
  // e.g. `doDayLightCycle`, `keepInventory`, `randomTickSpeed`
  gameRules: { [name: string]: boolean | number }
  // ids of the Bedrock blocks Java models as one block with a state (`furnace` →
  // [furnace, lit_furnace]), for findBlock/findBlocks `matching`
  blockVariants: (block: string | number) => number[]
  // ask the server for its copy of the player's inventory (BDS resends the inventory, armor, cursor and
  // off-hand); resolves true once it was applied, false when no answer came within 2 s
  resyncInventory: () => Promise<boolean>
  // only with `transport: 'bedd'` (a real client hosted by Be.D.D.): the BeDD ops this instance offers and
  // whether a bot API works with them (lib/bedd/surface.js, https://docs.levimc.org/bedboo/guide/bedd)
  bedd?: BeddExtras
}

// `bot.bedrock.bedd`, one interface for every bedd module: caps/supports (lib/bedd/surface.js), observed
// (lib/bedd/follower.js)
export interface BeddExtras {
  // the BeDD control ops by name (`look`, `input`, `button`, `stack`, …) and whether this instance offers them (a live
  // view of `bot._client.bedd.caps`)
  readonly caps: BeddCaps
  // whether a bot API (`'dig'`, `'craft'`, `'creative.setInventorySlot'`) or a BeDD op works with these caps
  supports: (name: string) => boolean
  // the last player_auth_input the real client echoed; null until the client's first echo
  observed: BeddObserved | null
}

// the last player_auth_input the real client echoed (yaw/pitch in Bedrock degrees, as on the wire)
export interface BeddObserved {
  yaw: number
  pitch: number
  tick: number | null
}

// thrown / rejected by an API the real client owns when no BeDD op does it (lib/bedd/errors.js)
export interface BeddUnsupportedError extends Error {
  code: 'ERR_BEDD_UNSUPPORTED'
  bedd: true
  feature: string
  missing: string[]
}

// transport 'bedd': `createBot({ transport: 'bedd', bedd })` and the bot's `_client.bedd`
// (lib/bedd/index.js).
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
