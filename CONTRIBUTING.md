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

## Rules

- **mineflayer's API, unchanged.** Keep upstream's names, arguments, return values, events and error messages.
  Bedrock-only additions go under `bot.bedrock.*` (typed in `types/bedrock.d.ts`), never as new top-level `bot`
  members. Java-only concepts keep their mineflayer property with an empty value.
- **Document differences.** Every inherent Java/Bedrock difference you introduce gets an entry in the matching
  `docs/reference/differences/<topic>.md` page (English and `docs/zh/`).
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

The documentation site (https://docs.levimc.org/bedboo/) is built from `docs/` with levimc-kit:

```sh
cd docs && npm ci && npm run dev    # npm run build && npm run linkcheck before a PR
```

English pages live at the root of `docs/`, Simplified Chinese in `docs/zh/`; Traditional Chinese is generated.
