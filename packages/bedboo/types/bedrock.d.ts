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

// `bot.bedrock.bedd`, one interface for every bedd module: caps/supports/sendAllow (lib/bedd/surface.js), observed
// (lib/bedd/follower.js), screens (lib/bedd/screens.js)
export interface BeddExtras {
  // the BeDD control ops by name (`look`, `input`, `button`, `stack`, …) and whether this instance offers them (a live
  // view of `bot._client.bedd.caps`)
  readonly caps: BeddCaps
  // whether a bot API (`'dig'`, `'craft'`, `'creative.setInventorySlot'`) or a BeDD op works with these caps
  supports: (name: string) => boolean
  // the packet ids BeDD's `send` accepts (config `sendAllow`); null before the probe or without `send`
  readonly sendAllow: number[] | null
  // the last player_auth_input the real client echoed; null until the client's first echo
  observed: BeddObserved | null
  // the client's screens through BeDD's `ui` op
  screens?: BeddScreens
}

// a node of a BeDD `ui` snapshot
export interface BeddUiNode {
  role?: string
  name?: string
  text?: string
  value?: any
  state?: { [flag: string]: boolean }
  bounds?: { x: number, y: number, w: number, h: number }
  actions?: Array<'click' | 'setText' | 'scroll'>
  children?: string[]
  [key: string]: any
}

// a BeDD `ui` read
export interface BeddUiSnapshot {
  snapshot: string
  screens: string[]
  active: string
  roots: string[]
  nodes: { [ref: string]: BeddUiNode }
  truncated?: boolean
}

export type BeddUiMatcher = (node: BeddUiNode, ctx: { ref: string, screen: string, snapshot: BeddUiSnapshot }) => boolean

// `bot.bedrock.bedd.screens` (lib/bedd/screens.js): act on the real client's screens by node (role, name, text)
export interface BeddScreens {
  read (args?: { depth?: number, scope?: string, includeInvisible?: boolean, maxNodes?: number }): Promise<BeddUiSnapshot>
  find (snapshot: BeddUiSnapshot, matcher: BeddUiMatcher): { ref: string, node: BeddUiNode, screen: string } | null
  click (matcher: BeddUiMatcher, opts?: { timeoutMs?: number, what?: string }): Promise<{ ref: string, node: BeddUiNode, screen: string, reply: any }>
  setText (matcher: BeddUiMatcher, text: string, opts?: { timeoutMs?: number, what?: string }): Promise<{ ref: string, node: BeddUiNode, screen: string, reply: any }>
  /** click the death screen's Respawn button */
  respawn (): Promise<any>
  /** click the bed screen's wake-up button */
  wake (): Promise<any>
  /** type into the sign editor of the sign at `position` (opened with a use click when it is not showing) */
  editSign (position: { x: number, y: number, z: number }, text: string, opts?: { back?: boolean }): Promise<void>
  /** settles once every screen step queued so far is done */
  idle (): Promise<void>
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
// The endpoint: `{ url, token }`, or `{ pid }` / `{ instance }` looked up in BeDD's run files
// (`%LOCALAPPDATA%\BeDD\run\<pid>.json`, $BEDD_HOME moves the folder), or `{}` for the only running game.
// BeDD v2 has no named pipes: `pipe`, `tapPipe` and `connect` throw.
export interface BeddOptions {
  /** the game's WebSocket endpoint (`ws://127.0.0.1:<port>/v1`, the `url` of its run file); needs `token` */
  url?: string
  /** the endpoint's token (the `token` of its run file) */
  token?: string
  /** the pid of the BeDD game to drive */
  pid?: number
  /** the instance folder name of the BeDD game to drive (e.g. '1.26.60.05-2') */
  instance?: string
  /** BeDD's home folder (default $BEDD_HOME, else %LOCALAPPDATA%\BeDD) */
  home?: string
  /** WebSocket class (default Node's global WebSocket) */
  WebSocket?: any
  /** control request timeout in ms (default 5000; ops with a `timeoutMs` argument get that + 2000) */
  timeoutMs?: number
  /** optional lib/bedd modules to attach (default: authority, router, router_actions, follower, surface, inventory, screens) */
  modules?: string[]
  /** how long createBot's `host` / `port` may take to join (BeDD `join` op; default 60000 ms) */
  joinTimeoutMs?: number
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
  /** the game's WebSocket endpoint (without its token); undefined when no game was found */
  url: string | undefined
  endpoint: { url: string, pid?: number, instance?: string, label?: string } | null
  rpc: BeddRpc
  caps: BeddCaps
  /** the packet ids BeDD's `send` accepts (its probe's `allow`); null without `send` */
  sendAllow: number[] | null
  /** the `join` reply when createBot's `host` made the client join that server first */
  joined: { joined?: boolean, already?: boolean, host?: string, port?: number, [key: string]: any } | null
  supports (op: string): boolean
  /** resolves with the caps once the control connection was negotiated (never rejects) */
  ready: Promise<BeddCaps>
  link: BeddLink
  hello: { m: 'HELLO', tap: number, mod: string, game: string, protocol: number, pid: number, link: BeddLink, journal: { frames: number, bytes: number, complete: boolean } } | null
  journal: { frames: number, bytes: number, complete: boolean } | null
  replayed: { complete: boolean } | null
  /** `ping`: protocol 2, the game's pid, its operation modes (`modes.bedboo`, `modes.input`, `modes.ui`: op names) */
  control: { protocol: number, pid: number, defaultMode?: string, modes?: { [mode: string]: string[] } } | null
  capabilities: BeddCapabilities
  /** what the bot would have sent; the default drops and counts (`dropped`), the router module replaces it */
  route (name: string, params: any): any
  dropped: { [name: string]: number }
  modules: { [name: string]: any }
  attach (bot: import('../index').Bot): void
}
