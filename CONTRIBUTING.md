# Contributing to bedboo

Questions and bug reports go to [GitHub issues](https://github.com/LiteLDev/bedboo/issues); pull requests are welcome.
By contributing, you agree that your contributions are licensed under the project's license (LGPL-3.0-only).

## Setup

Node.js ≥ 24 and pnpm through corepack (the version is pinned in `package.json`):

```sh
corepack enable && pnpm install
pnpm lint        # standard style (pnpm fix to auto-fix)
pnpm test        # unit tests, against recorded BDS packets; no server needed
pnpm typecheck   # index.d.ts
```

A change in behaviour comes with a unit test.

The unit tests target Bedrock 1.26.51 by default. `BEDBOO_VERSION=<family>` (e.g. `1.26.60`) or a BDS build (e.g.
`1.26.62.1`, mapped to its family) runs them against another version: the fake clients, serializers, registries and
the packet captures under `packages/bedboo/test/fixtures/<family>/` follow it (`packages/bedboo/test/version.js`).
Tests that need a capture the family does not have yet are skipped with the reason. CI runs the unit tests once per
family in its `bedrock` matrix; a manual run of the CI workflow takes a `version` input.

The supported versions are listed in [Supported versions](https://levimc.org/bedboo/reference/versions/); [Adding a
version](#adding-a-version) below has the steps to add one.

## Adding a version

**A new build of a known family** (same protocol): add the build to the family's `bds` list in
`packages/bedboo/lib/bedrock/versions.js` and in the fallback table of `packages/bedboo/test/version.js`. Check that
its join data matches the family's data, as the
[1.26.51 page](https://levimc.org/bedboo/reference/versions/1.26.51#builds) does for 1.26.50.5 and 1.26.52.3. Then
list the build in the [version matrix](https://levimc.org/bedboo/reference/versions/#matrix) and on the family's
page, and update the other places that name the newest build or the supported range:
`git grep -n '<previous newest build>'` finds them here (README files, `package.json` descriptions) and in the
[docs](#docs) (English and Chinese).

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
5. [Docs](#docs): add a `reference/versions/<family>.md` page (English and Chinese), add it to the nav, and add a
   row to the version matrix. Update the other lists of families and builds, as for a new build
   (`git grep -n '<previous newest family>'`).

## Rules

- **mineflayer's API, unchanged.** Keep upstream's names, arguments, return values, events and error messages.
  Bedrock-only additions go under `bot.bedrock.*` (typed in `types/bedrock.d.ts`), never as new top-level `bot`
  members. Java-only concepts keep their mineflayer property with an empty value.
- **Document differences.** Every inherent Java/Bedrock difference you introduce gets an entry in the matching
  `reference/differences/<topic>.md` page of the [docs](#docs) (English and Chinese).
- **Attribution.** Code adapted from mineflayer or another project keeps a header naming its source and license,
  e.g. `// Adapted from mineflayer 4.39.0 lib/plugins/x.js (MIT, Copyright (c) 2013 Andrew Kelley)`. Never
  `pnpm patch mineflayer`: vendor the plugin into `lib/plugins/` instead.

## Patches

Small fixes to dependencies are pnpm patches in `patches/`. Every patched package is pinned in the `overrides` of
`pnpm-workspace.yaml` so exactly one copy resolves everywhere; add the override before patching a new package. Data
fixes go to `@bedboo/bedrock-data`, never into a minecraft-data patch. Large changes belong in this repository, not
in a patch.

```sh
pnpm patch <pkg>@<version> --edit-dir /tmp/<pkg>   # re-applies an existing patch, if any
# edit the files
pnpm patch-commit /tmp/<pkg>                        # writes patches/<pkg>@<version>.patch + patchedDependencies
rm -rf node_modules && pnpm install --frozen-lockfile
```

## Docs

The documentation site is part of levimc.org: English at https://levimc.org/bedboo/, Simplified Chinese at
https://levimc.org/zh-Hans/bedboo/ (Traditional Chinese, at https://levimc.org/zh-Hant/bedboo/, is generated). Its
pages are edited in the levimc.org repository, under
[`docs/bedboo`](https://github.com/LiteLDev/liteldev.github.io/tree/main/docs/bedboo), not in this repository: a
change here that the docs describe (a `bot.bedrock.*` extra, a difference, a version) comes with a pull request
there. Newcomer tutorials (a first bot) live on levimc.org/tutorials/.
