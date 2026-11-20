# CodeStudio (Desktop)

An AI-native IDE for builders. Bring your own keys, work in a fast desktop app, let agents reason over your codebase.

> This is the **desktop** repository (Electron IDE + agent runtime + indexer). The
> former monorepo has been decomposed into three independent repositories — see
> [docs/REPO_SPLIT.md](docs/REPO_SPLIT.md) for the full topology and runbook.

## Related repositories

| Repository | What it holds | Location |
| --- | --- | --- |
| **codestudio-desktop** (this one) | Electron shell, React dashboard, TypeScript agent runtime, indexer, bundled providers/plugins | `D:\MCP` |
| **codestudio-cloud** | Cloudflare Workers (cloud-api + worker-market), cloud bounded contexts (`@cloudstudio/cloud-*`), account-portal SPA | `D:\repos\codestudio-cloud` |
| **codestudio-unity** | Unity Editor plugin (`com.maicon.scene-analyzer`) — Scene Analyzer / Asset Modeler | `D:\repos\codestudio-unity` |
| **codestudio-web** | Public React/Vite institutional and product website | `D:\repos\codestudio-web` |

> Status: **alpha**. Active development on the `feature/ide-mvp` branch (this branch). The Electron shell, file tree, Monaco editor, terminal, agent chat, snapshots, and git tool windows are wired end-to-end. Billing/auth, packaging, and the marketing surface are the next milestones.

## What's in the box

- **Workspace** — JetBrains-style IDE shell with two activity rails (Files · Search · Snapshots · Git on the left, Agent chat · Sessions · Inbox on the right), a Monaco editor with multi-tab editing + LSP completion / hover / Ctrl+Click / diagnostics, a bottom panel hosting an integrated terminal (PTY rooted at the project), and a status bar.
- **Agent chat** — multi-provider (Claude · OpenAI · Gemini · ZAI · DeepSeek · Bedrock · Kimi-Code · Cloudflare) with extended thinking, compaction, smart reducers, tool calling, sub-agent spawning. BYOK — your tokens, your costs.
- **Project understanding** — built on the MCP Code Indexer: hybrid FTS5 + vector search over the codebase, dependency graph, symbol hierarchy, snapshots (curated project notes), and a docs RAG corpus (Pro feature).
- **Local first** — Electron runs the backend in-process and uses IPC for native operations. Compatibility routes use `mcp://app` inside Electron. `MCP_DEV_HTTP=1` opens the optional loopback listener for development.
- **Multi-platform** — Windows, macOS, Linux via `electron-builder` (release pipeline in progress).
- **Plugins** — extend the agent + workspace with installable plugins: agent tools (run isolated in a worker thread), MCP servers, skills, sandboxed webview tool windows, command-palette commands, and themes. Authored with a typed SDK + CLI, Claude Code-compatible, and distributed through a hosted Market (Cloudflare Worker + D1 + R2, Ed25519-signed bundles). See [docs/PLUGINS.md](docs/PLUGINS.md).

## Quick start

```bash
# 1. Install dependencies and prepare SQLite for Electron
pnpm electron:setup

# 2. Run the dashboard in Electron (dev mode)
pnpm electron:dev
```

The Electron window opens at the project list. Pick a project to enter the Workspace — the legacy analytics view is still reachable at `/projects/:id/analytics`.

Starting Electron in development builds and installs the bundled providers, Angular, Figma and the JavaScript debugger. Restart the dev app after editing a bundled plugin. Windows development data lives in `%LOCALAPPDATA%\CodeStudio-dev\data`. Set `MCP_DATA_DIR` to reuse a specific development profile.

### Figma, Copilot and offline search

- Open **Figma** in the workspace’s right rail and connect a Figma personal access token with `current_user:read` and `file_content:read`. The agent can read layers and design tokens, render previews and get asset URLs. Enterprise variables need `file_variables:read`. The project cache survives restarts. Use `cache_only` for offline reads or `refresh` to request the latest design. A later message in the same chat can reopen a saved image by its attachment ID.
- Connect **GitHub Copilot** in **Settings → Providers & Models**. Open its card or the chat’s **Usage quotas** side panel to see the quota returned by GitHub. Existing token-based connections can reconnect to enable the quota panel.
- The default semantic index uses the bundled IBM Granite Multilingual R2 model. The installer and checkout contain the q8 weights and tokenizer. Rebuild an existing E5 index when you want to switch its active vectors to Granite.
- Turn off **Sync model prices online** in **Settings → App settings → Models and prices** to use stored prices. Set `MODEL_PRICING_REMOTE_ENABLED=0` to disable OpenRouter and LiteLLM price requests from the first launch.

**Don't have a project yet?** Click `+ New project` on the home screen, point at any folder on your disk, and hit `Index`. The agent + Monaco LSP both work against that path.

### Other entry points

| Command | What it runs |
| --- | --- |
| `pnpm dev` | Vite dashboard (`:7317`) and Node HTTP API (`:7333`) in the browser |
| `pnpm dev:server` | Backend only (`:7333`) — handy when developing the API surface |
| `pnpm dev:dashboard` | Dashboard only — pairs with `electron:dev` or `dev:server` |
| `pnpm start:api` | Production backend (`node dist/apps/http-api/server.js`) |
| `pnpm start` | CLI (`node dist/apps/cli/index.js`) |

See [docs/ELECTRON_DEV.md](docs/ELECTRON_DEV.md) for the full Electron dev setup, including how to swap native modules between Node and Electron ABIs.

## Keyboard shortcuts (Workspace)

| Action | Shortcut |
| --- | --- |
| Quick Open file | `Ctrl/Cmd+P` |
| Command Palette | `Ctrl/Cmd+Shift+P` |
| Save active file | `Ctrl/Cmd+S` |
| Save all | `Ctrl/Cmd+Shift+S` |
| Close active tab | `Ctrl/Cmd+W` |
| Toggle left tool rail | `Ctrl/Cmd+B` |
| Toggle right tool rail | `Ctrl/Cmd+Alt+B` |
| Toggle terminal | `Ctrl/Cmd+J` |
| Toggle bottom panel | `Ctrl/Cmd+`` ` |
| Rename file in tree | `F2` |
| Reload window | `Ctrl/Cmd+R` |

`Ctrl/Cmd+Shift+P` opens the Command Palette where every action is searchable + shows its shortcut.

## Architecture (one-paragraph version)

`apps/dashboard` is the React SPA (Vite + Tailwind + Radix). `apps/electron` starts the renderer and hosts the backend in-process. `apps/http-api` exposes Fetch routes for browser development and external clients. `packages/api-bus` defines the RPC contract, `packages/api-handlers` implements the handlers and `packages/store` owns SQLite persistence. `packages/code-agent` runs the coding agent. See [Architecture](docs/ARCHITECTURE.md).

## Repo layout

```
apps/
  dashboard/           React SPA (Vite + Tailwind + Radix)
  electron/            Electron main + preload + IPC bridge
  http-api/            Fetch routes and standalone HTTP entry point
  cli/                 mcp-code-indexer CLI
  landing/             marketing surface (in progress)
packages/
  api-bus/             Transport-agnostic RPC contract (types only)
  api-handlers/        Pure handler implementations
  worker-pool/         Dynamic per-kind worker_threads pool
  store/               SQLite schema + DAOs + migrations
  services/            Providers, sandbox, chrome, qa, auth
  code-agent/          CoderRunner + tools + LSP + agent presets
  company/             Multi-agent orchestrator (master + subordinates)
  docs-agent/          Documentation RAG + DocsResearchBridge
  indexer/             Indexing pipeline + hybrid search
  shared/              Types + utilities shared across packages
  candidate-pipeline/  ML classifiers (quality, tool-selection)
  orchestrator-host/   Host orchestration
worker-license/        Cloudflare Worker — auth + billing (planned, Week 3)
docs/                  Internal + user docs
```

## Documentation

- [Architecture overview](docs/ARCHITECTURE.md) — package boundaries, IPC bridge, Electron lifecycle.
- [Workspace user guide](docs/IDE_WORKSPACE.md) — every tool window, every shortcut, the mental model.
- [Electron dev setup](docs/ELECTRON_DEV.md) — pnpm gotchas, native rebuild flow, debugging tips.
- [Indexer (legacy README)](docs/INDEXER.md) — the original v3.11 release notes for the code indexer + coder agent.
- [Project plan](https://github.com/) — see `C:/Users/maico/.claude/plans/projeto-ambiciso-criar-uma-cheerful-rabin.md` for the 5-week IDE Freemium roadmap.

## License

MIT — see [LICENSE](LICENSE).
