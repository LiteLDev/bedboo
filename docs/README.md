# bedboo documentation

**Using mineflayer-bedrock**

| document | |
|---|---|
| [getting-started.md](getting-started.md) | connect a bot to your own BDS, step by step (server settings, auth, NetherNet, troubleshooting) |
| [api.md](api.md) | API reference: mineflayer's API, `createBot` options, the Bedrock differences in short, `bot.bedrock.*` extras |
| [upstream/api.md](upstream/api.md) | mineflayer 4.39.0's own API reference (pinned copy) — the API mineflayer-bedrock implements |
| [differences.md](differences.md) | every Java ↔ Bedrock difference in detail (generated from [differences/](differences)) |
| [bedd.md](bedd.md) | `transport: 'bedd'`: drive a real Bedrock client hosted by Be.D.D. (setup, coverage matrix, security) |
| [parity.md](parity.md) | parity matrix: every mineflayer export, member, event and external test, with its status and asserting test |
| [../packages/agent/README.md](../packages/agent/README.md) | `@bedboo/agent`: the scripted survival agent and its skill interface |

**Testing and contributing**

| document | |
|---|---|
| [testing.md](testing.md) | the Docker BDS harness (`bds` CLI, `@bedboo/bds` API), writing e2e tests, `bot.test.*` helpers, BDS quirks |
| [CONTRIBUTING.md](CONTRIBUTING.md) | conventions, cross-unit contracts, ownership, workflow |
| [parity/](parity) · [differences/](differences) | per-unit fragments of the parity matrix and of the differences (`corepack pnpm parity` assembles them) |
| [upstream/](upstream) | pinned mineflayer 4.39.0 references: `api.md`, `index.d.ts`, the external tests |
| [../packages/bedrock-data/NOTICE.md](../packages/bedrock-data/NOTICE.md) | data sources, licenses and how to regenerate the Bedrock data overlay |
