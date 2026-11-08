# Supported versions

bedboo supports every stable Bedrock Dedicated Server (BDS) from 1.26.42.1 (August 7, 2026) to 1.26.63.1
(November 6, 2026): eleven builds in four protocol families. A **family** is a minecraft-data / bedrock-protocol
Bedrock version key such as `'1.26.51'`. All builds of a family answer the same network protocol and share one set of
game data (`@bedboo/bedrock-data` `data/<family>/`). `bot.version` is the family. The table lives in
`packages/bedboo/lib/bedrock/versions.js` (`FAMILIES`). A family counts as tested, that is, it is in `testedVersions`
and `createBot` accepts it, when it has a `FAMILIES` entry and `@bedboo/bedrock-data` ships data for it.

## Version matrix {#matrix}

| family (`bot.version`) | protocol | BDS builds (release date) | BDS default `transport` | notes |
|---|---|---|---|---|
| `'1.26.40'` | 2168 | 1.26.42.1 (Aug 7, 2026), 1.26.43.1 (Aug 7, 2026), 1.26.44.3 (Aug 14, 2026) | `raknet` | [Bedrock 1.26.40](1.26.40.md) |
| `'1.26.45'` | 2169 | 1.26.45.1 (Aug 28, 2026) | `raknet` | [Bedrock 1.26.45](1.26.45.md) |
| `'1.26.51'` (default) | 2193 | 1.26.50.5 (Sep 15, 2026), 1.26.51.1 (Sep 15, 2026), 1.26.52.3 (Sep 25, 2026) | `nethernet` | [Bedrock 1.26.51](1.26.51.md) |
| `'1.26.60'` | 2225 | 1.26.60.6 (Oct 27, 2026), 1.26.61.1 (Oct 29, 2026), 1.26.62.1 (Nov 4, 2026), 1.26.63.1 (Nov 6, 2026) | `nethernet` | [Bedrock 1.26.60](1.26.60.md) |

Each of these builds was started natively and joined by a bot before its family was marked tested. The bot checked
spawn, blocks and items, inventory, chat, walking, digging and placing, entities and the command tree. CI runs the unit
tests once per family. The rest of this reference (the [Bedrock differences](../differences/index.md) and the
[BDS notes](../bds.md)) was observed on BDS 1.26.51.1, the default. The page of each family lists what differs there.

Previews, betas and builds older than 1.26.42.1 are not supported. A server whose build is not in the table may still
speak one of these protocols, but bedboo has not been checked against it.

## Choosing a version {#choosing}

Pass the server's version to `createBot`. Either the family or the exact BDS build is accepted; both give the same
bot:

```js
const bot = bedboo.createBot({
  host: '127.0.0.1',
  port: 19132,
  username: 'Bot',
  version: '1.26.62.1', // or '1.26.60'
  transport: 'nethernet' // BDS 1.26.51 and newer default to transport=nethernet
})
bot.once('spawn', () => console.log(bot.version, bot.protocolVersion)) // 1.26.60 2225
```

- **Default:** without `version`, or with `version: false`, the bot uses **1.26.51**. bedboo does not detect the
  server's version (by default it joins without a ping, because BDS does not answer pings with LAN visibility off).
  A bot for another family has to name it.
- **Accepted values:** a family in `testedVersions`, one of its BDS builds, or either form with a `bedrock_` prefix.
  Anything else throws an `Error` with `code: 'ERR_BEDBOO_VERSION'` that lists the supported families and builds,
  like mineflayer for an unsupported version.
- **Wrong family:** BDS refuses a login with another protocol, and the bot is `kicked` as an outdated client or
  outdated server.
- **What follows the version:** `bot.version` (the family), `bot.protocolVersion`, `bot.majorVersion` (`'1.26'`),
  `bot.registry` (minecraft-data `bedrock_<family>` with that family's `@bedboo/bedrock-data` overlay) and
  `bot.supportFeature(...)`. The feature table has per-family values, for example `actionPacketsHaveHand` on 1.26.60
  and `defaultTransportIsNethernet`.
- **Module exports:** `testedVersions` lists the tested families, oldest first (`['1.26.40', '1.26.45', '1.26.51',
  '1.26.60']`). `oldestSupportedVersion` is `'1.26.40'` and `latestSupportedVersion` is `'1.26.60'`.
  `supportFeature(feature, version)` takes a family, a build or nothing (1.26.51).

The families differ in a few block, item and entity additions, in some packet fields, in the numbering of command
parameter types and in the default transport. bedboo handles these per family, so a bot's code does not change. The
family pages list the differences.

## Testing against a version {#testing}

The unit tests use 1.26.51 by default. `BEDBOO_VERSION` selects another family or build:

```sh
pnpm test                              # 1.26.51
BEDBOO_VERSION=1.26.60 pnpm test       # a family
BEDBOO_VERSION=1.26.44.3 pnpm test     # a BDS build, mapped to its family (1.26.40)
```

Fakes, serializers, registries and packet captures (`packages/bedboo/test/fixtures/<family>/`) follow the selected
version. A test that needs a capture the family does not have is skipped and prints the reason. Only 1.26.51 has a
join capture so far, so on the other families the join-replay tests are skipped. A live join of every build covered
that ground instead. CI (`.github/workflows/ci.yml`) runs lint, the unit tests and the typecheck once per family in
its `bedrock` matrix. A manual run of the workflow takes a `version` input.

## Adding a version {#adding}

**A new build of a known family** (same protocol): add the build to the family's `bds` list in
`packages/bedboo/lib/bedrock/versions.js` and in the fallback table of `packages/bedboo/test/version.js`. Check that
its join data matches the family's data, as the [1.26.51 page](1.26.51.md#builds) does for 1.26.50.5 and 1.26.52.3.
Then list the build in the matrix above and on the family's page, and update the other places that name the newest
build or the supported range: `git grep -n '<previous newest build>'` finds them (README files, `package.json`
descriptions, the docs in English and `docs/zh/`).

**A new family:**

1. minecraft-data and bedrock-protocol have to know the version. Update them (`packages/*/package.json` and the
   `overrides` of `pnpm-workspace.yaml`) and refresh the pnpm patches in `patches/` if needed.
2. `@bedboo/bedrock-data`: add `PINS['<family>']` to `scripts/sources.js` and run
   `scripts/fetch-sources.js --version <family> --update-lock`. Record the facts observed on a running BDS in
   `scripts/probe/<family>.json`, put table differences in `scripts/tables.js` `VERSION_TABLES` and run
   `scripts/generate.js --version <family>`. Feature differences go in `data/<family>/features.js`. List the sources
   in `NOTICE.md`. Its "Adding a data version" section describes each step.
3. bedboo: add a `FAMILIES` entry (family, protocol, BDS builds) to `lib/bedrock/versions.js` and to
   `test/version.js`. The family is tested as soon as both this entry and its data exist. Compare the protocol with
   the previous family. Handle wire differences behind a feature in `data/<family>/features.js` and
   `bot.supportFeature`. Check the command parameter type ids (`VALUE_TYPE_KINDS_BY_VERSION` in
   `lib/bedrock/commands.js`).
4. CI: add the family to the `bedrock` matrix of `.github/workflows/ci.yml`. Run
   `BEDBOO_VERSION=<family> pnpm test`, and join every build of the family with a live bot.
5. Docs: add a `docs/reference/versions/<family>.md` page (English and `docs/zh/`), add it to the nav in
   `docs/docs.config.ts`, and add a row to the matrix above. Update the other lists of families and builds, as for a new
   build (`git grep -n '<previous newest family>'`).
